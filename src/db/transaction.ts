// One serialised write queue per database connection (P3.5, D50; review finding #1).
//
// expo-sqlite (and the Node fake) run every statement on ONE shared connection. Without a queue, an autosave
// that runs between another operation's BEGIN and ROLLBACK joins that transaction and is silently rolled back,
// and a second BEGIN fails with "cannot start a transaction within a transaction". So every write function
// in src/db runs as one unit through `exclusive`: units run strictly one after another, in call order.
//
// A unit receives a *handle* (a Db bound to the connection that marks "inside the queue"). Everything a unit
// does — including nested write functions and nested transactions — must use that handle; a nested call with
// a handle runs at once instead of queueing behind itself. Write callbacks therefore name their parameter
// `db`, shadowing the outer connection, so the outer one cannot be used by mistake. A handle stops working
// when its unit ends. Reads outside the queue stay direct (they may see a running unit's uncommitted rows).
import { afterDataChange } from './changes';
import type { Db } from './types';

const ROOT = Symbol('write-queue-root');
type HandleState = { root: Db; open: boolean; depth: number };
type Handle = Db & { [ROOT]: HandleState };

const tails = new WeakMap<object, Promise<unknown>>();
const files = new Map<string, object>(); // database file -> the one queue key for every JS handle on it

/**
 * The queue belongs to the CONNECTION, not to the JS object: expo-sqlite gives every `openDatabaseAsync(name)` with the
 * same options the same cached native connection but a new JS object (e.g. SQLiteProvider's handle and a background
 * task's handle; warranty-wallet D110). So handles that name a database file (`databasePath`) share that file's queue;
 * a handle without one (the Node test fake) is its own queue.
 */
function queueKey(db: Db): object {
  const path = (db as { databasePath?: unknown }).databasePath;
  if (typeof path !== 'string' || path === '') return db;
  let key = files.get(path);
  if (!key) files.set(path, (key = {}));
  return key;
}
const noop = () => undefined;
const CLOSED = 'write handle used after its queue slot ended';

function stateOf(db: Db): HandleState | undefined {
  return (db as Partial<Handle>)[ROOT];
}

function makeHandle(root: Db): Handle {
  const state: HandleState = { root, open: true, depth: 0 };
  const guard = () => {
    if (!state.open) throw new Error(CLOSED);
  };
  const execAsync: Db['execAsync'] = (...args) => (guard(), root.execAsync(...args));
  const runAsync = ((...args: Parameters<Db['runAsync']>) => (guard(), root.runAsync(...args))) as Db['runAsync'];
  const getAllAsync = ((...args: Parameters<Db['getAllAsync']>) => (guard(), root.getAllAsync(...args))) as Db['getAllAsync'];
  const getFirstAsync = ((...args: Parameters<Db['getFirstAsync']>) => (guard(), root.getFirstAsync(...args))) as Db['getFirstAsync'];
  return { execAsync, runAsync, getAllAsync, getFirstAsync, [ROOT]: state };
}

/** True while `db` is the handle of a running queue unit. */
export function isWriteHandle(db: Db): boolean {
  return stateOf(db)?.open === true;
}

/**
 * Runs `fn` as one unit of the connection's write queue. Called with a handle (from inside a unit) it runs
 * immediately as part of that unit.
 */
export function exclusive<T>(db: Db, fn: (db: Db) => Promise<T>): Promise<T> {
  const state = stateOf(db);
  if (state) return state.open ? fn(db) : Promise.reject(new Error(CLOSED));
  const key = queueKey(db);
  const previous = tails.get(key) ?? Promise.resolve();
  const result = previous.then(async () => {
    const handle = makeHandle(db);
    try {
      return await fn(handle);
    } finally {
      handle[ROOT].open = false;
    }
  });
  tails.set(key, result.then(noop, noop));
  return result;
}

/**
 * Runs a read behind the write queue (and joins the running unit when given its handle): it never sees the
 * uncommitted rows of a running transaction. Template mobile-starter 40eb231 `withRead`; the UI's loaders use it.
 */
export function withRead<T>(db: Db, fn: (db: Db) => Promise<T>): Promise<T> {
  return exclusive(db, fn);
}

/** Wraps a data function `(db, ...args)` so that each call is one unit of the write queue. */
export function queued<A extends unknown[], R>(fn: (db: Db, ...args: A) => Promise<R>): (db: Db, ...args: A) => Promise<R> {
  return (db, ...args) => announce(db, exclusive(db, (handle) => fn(handle, ...args)));
}

/** A finished outermost write unit tells the app that data changed (reminder re-plan, D73). Nested units do not. */
function announce<T>(db: Db, result: Promise<T>): Promise<T> {
  if (!stateOf(db)) result.then(afterDataChange, noop);
  return result;
}

async function quietly(db: Db, sql: string) {
  try {
    await db.execAsync(sql);
  } catch {
    // SQLite may already have rolled back by itself (e.g. SQLITE_FULL); the original error is what matters.
  }
}

/**
 * Runs `fn` inside BEGIN IMMEDIATE … COMMIT as one queue unit; rolls back and rethrows on error. `fn` gets the
 * unit's handle and must use it for every statement. Nested inside another transaction it becomes a
 * SAVEPOINT, so an inner failure undoes only the inner part and the outer transaction decides.
 */
export function withTransaction<T>(db: Db, fn: (db: Db) => Promise<T>): Promise<T> {
  return announce(db, exclusive(db, async (tx) => {
    const state = stateOf(tx) as HandleState;
    if (state.depth > 0) {
      const name = `sp${state.depth}`;
      state.depth++;
      await tx.execAsync(`SAVEPOINT ${name};`);
      try {
        const result = await fn(tx);
        await tx.execAsync(`RELEASE ${name};`);
        return result;
      } catch (error) {
        await quietly(tx, `ROLLBACK TO ${name}; RELEASE ${name};`);
        throw error;
      } finally {
        state.depth--;
      }
    }
    state.depth = 1;
    await tx.execAsync('BEGIN IMMEDIATE;');
    try {
      const result = await fn(tx);
      await tx.execAsync('COMMIT;');
      return result;
    } catch (error) {
      await quietly(tx, 'ROLLBACK;');
      throw error;
    } finally {
      state.depth = 0;
    }
  }));
}
