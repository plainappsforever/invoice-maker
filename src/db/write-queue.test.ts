/**
 * @jest-environment node
 */
// The serialised write queue (P3.5 F1, D50; review finding #1 and #16). The first two tests are the
// review's probes on the shared-connection Node fake, which interleaves exactly as described there.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createTestDb } from '../../test/node-sqlite-db';

import { updateBusiness } from './business';
import { createClient } from './clients';
import { getCounter } from './counters';
import { getDocument, listDocuments, updateDraft } from './documents';
import { duplicateDocument, issueDocument, IssueBlockedError, newDraft } from './lifecycle';
import { addLine } from './lines';
import { migrate, openDatabase } from './migrations';
import { getSetting, setSetting } from './settings';
import { exclusive, isWriteHandle, withTransaction } from './transaction';
import type { Db } from './types';

const NOW = 1_790_000_000_000;
const TODAY = '2026-10-01';
const clock = { today: TODAY, now: NOW };

async function setup() {
  const db = createTestDb();
  await openDatabase(db);
  await updateBusiness(db, { name: 'Muster Design', street: 'Hauptstr. 1', postalCode: '10115', city: 'Berlin', taxNumber: '12/345/67890' }, NOW);
  const clientId = await createClient(db, { name: 'Kunde GmbH', street: 'Weg 2', postalCode: '20095', city: 'Hamburg' }, NOW);
  return { db, clientId };
}

async function draft(db: Db, clientId: number, withLine = true) {
  const id = await newDraft(db, { type: 'invoice', clientId, ...clock });
  if (withLine) await addLine(db, id, { name: 'Webdesign', qtyMilli: 1000, priceE4: 1_000_000, taxRateBp: 1900 });
  return id;
}

describe('write queue (review finding #1)', () => {
  it('an autosave during an Issue that rolls back survives (review probe)', async () => {
    const { db, clientId } = await setup();
    const blocked = await draft(db, clientId, false); // no lines → Issue fails and rolls back
    const other = await draft(db, clientId);
    const [issue, save] = await Promise.allSettled([
      issueDocument(db, blocked, clock),
      updateDraft(db, other, { notes: 'typed while issuing' }, NOW),
    ]);
    expect(issue.status).toBe('rejected');
    expect((issue as PromiseRejectedResult).reason).toBeInstanceOf(IssueBlockedError);
    expect(save.status).toBe('fulfilled');
    expect((await getDocument(db, other))!.notes).toBe('typed while issuing');
    expect(await getCounter(db, 'invoice:2026')).toMatchObject({ nextValue: 1, maxUsed: 0 });
  });

  it('a second transaction during Issue waits instead of failing (Issue + Duplicate)', async () => {
    const { db, clientId } = await setup();
    const a = await draft(db, clientId);
    const b = await draft(db, clientId);
    const [issued, copy, issuedB] = await Promise.all([
      issueDocument(db, a, clock),
      duplicateDocument(db, a, clock),
      issueDocument(db, b, clock),
    ]);
    expect(issued.number).toBe('RE-2026-0001');
    expect(issuedB.number).toBe('RE-2026-0002');
    expect((await getDocument(db, copy))!).toMatchObject({ status: 'draft', number: null, grossCents: 11_900 });
    expect((await listDocuments(db)).length).toBe(3);
  });

  it('many concurrent autosaves and Issues: every write lands, numbers are unique and gapless', async () => {
    const { db, clientId } = await setup();
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await draft(db, clientId, i % 3 !== 0)); // every third has no line
    const ops: Promise<unknown>[] = [];
    for (const id of ids) {
      ops.push(issueDocument(db, id, clock));
      ops.push(updateDraft(db, id, { notes: `note ${id}` }, NOW)); // after the Issue: refused only if issued
    }
    const results = await Promise.allSettled(ops);
    const numbers: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const doc = (await getDocument(db, ids[i]))!;
      if (i % 3 === 0) {
        expect(results[2 * i].status).toBe('rejected');
        expect(results[2 * i + 1].status).toBe('fulfilled');
        expect(doc).toMatchObject({ status: 'draft', notes: `note ${ids[i]}` });
      } else {
        expect(results[2 * i].status).toBe('fulfilled');
        expect(results[2 * i + 1].status).toBe('rejected'); // queued after Issue → locked, never lost silently
        numbers.push(doc.number!);
      }
    }
    expect(numbers).toEqual(['RE-2026-0001', 'RE-2026-0002', 'RE-2026-0003', 'RE-2026-0004']);
  });

  it('units run one at a time in call order; a failing unit does not stop the queue', async () => {
    const db = createTestDb();
    await openDatabase(db);
    const log: string[] = [];
    const slow = exclusive(db, async () => {
      log.push('a start');
      await new Promise((r) => setTimeout(r, 20));
      log.push('a end');
    });
    const failing = exclusive(db, async () => {
      log.push('b');
      throw new Error('boom');
    });
    const last = exclusive(db, async (h) => {
      log.push('c');
      await setSetting(h, 'k', 'v');
    });
    await Promise.allSettled([slow, failing, last]);
    await expect(failing).rejects.toThrow('boom');
    expect(log).toEqual(['a start', 'a end', 'b', 'c']);
    expect(await getSetting(db, 'k')).toBe('v');
  });

  it('a handle is only valid inside its unit', async () => {
    const db = createTestDb();
    await openDatabase(db);
    let leaked: Db | null = null;
    await exclusive(db, async (h) => {
      expect(isWriteHandle(h)).toBe(true);
      leaked = h;
    });
    expect(isWriteHandle(db)).toBe(false);
    await expect(setSetting(leaked as unknown as Db, 'x', '1')).rejects.toThrow(/after its queue slot/);
  });

  it('a nested transaction is a savepoint: an inner failure the outer one catches undoes only the inner part', async () => {
    const db = createTestDb();
    await openDatabase(db);
    await withTransaction(db, async (db) => {
      await setSetting(db, 'outer', '1');
      await expect(
        withTransaction(db, async (db) => {
          await setSetting(db, 'inner', '1');
          throw new Error('inner failed');
        })
      ).rejects.toThrow('inner failed');
    });
    expect(await getSetting(db, 'outer')).toBe('1');
    expect(await getSetting(db, 'inner')).toBeNull();
  });
});

describe('migrate (review finding #16)', () => {
  it('a failing migration rolls back and leaves no transaction open', async () => {
    const db = createTestDb();
    // Pretend migration 1 ran, and make migration 2 fail half-way: DROP TABLE items succeeds, CREATE TABLE business clashes.
    await db.execAsync(
      'CREATE TABLE items (id INTEGER PRIMARY KEY); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE business (x INTEGER); PRAGMA user_version = 1;'
    );
    await expect(migrate(db)).rejects.toThrow(/already exists/);
    expect(await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version')).toEqual({ user_version: 1 });
    expect(await db.getFirstAsync("SELECT name FROM sqlite_master WHERE name = 'items'")).toEqual({ name: 'items' });
    await setSetting(db, 'after', 'ok'); // would join a dangling transaction otherwise
    await db.execAsync('BEGIN; COMMIT;'); // "cannot start a transaction within a transaction" if one were open
    expect(await getSetting(db, 'after')).toBe('ok');
  });
});

describe('writes go through src/db only', () => {
  it('no source file outside src/db calls runAsync/execAsync directly (they would bypass the queue)', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !path.includes(join('src', 'db'))) {
          if (/\.(runAsync|execAsync)\(/.test(readFileSync(path, 'utf8'))) offenders.push(path);
        }
      }
    };
    walk(join(__dirname, '..'));
    expect(offenders).toEqual([]);
  });
});
