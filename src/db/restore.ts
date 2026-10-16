// Backup and replace-restore on the database (SPEC §9, D28, D34). Reading is plain SELECTs. Restoring validates
// first (src/data/backup.ts), then replaces every table in ONE transaction: the lock triggers of issued
// documents (D34) are read from sqlite_master, dropped, the tables are replaced, the triggers are created again
// from the saved SQL, and the foreign keys are checked before COMMIT. Any error rolls everything back — SQLite
// DDL is transactional, so the old rows AND the triggers are as they were.
import {
  buildBackup,
  hashData,
  columnNames,
  compareWithPhone,
  mergeCounters,
  DEVICE_SETTINGS,
  parseBackup,
  parseBackupBytes,
  TABLE_ORDER,
  type BackupData,
  type BackupError,
  type BackupFile,
  type PhoneComparison,
  type RestorePlan,
  type Row,
  type TableName,
} from '@/data/backup';

import { LATEST_VERSION } from './migrations';
import { withRead, withTransaction } from './transaction';
import type { Db } from './types';

/** Every row of every table (documents without pdf_file), ordered by id; settings minus this phone's own. */
export async function readAllData(db: Db): Promise<BackupData> {
  const settingRows = await db.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM settings ORDER BY key');
  const settings: Record<string, string> = {};
  for (const r of settingRows) if (!DEVICE_SETTINGS.includes(r.key)) settings[r.key] = r.value;
  const data = { settings } as BackupData;
  for (const table of TABLE_ORDER) {
    const order = table === 'number_counters' ? 'series_key' : table === 'signatures' ? 'document_id' : 'id';
    data[table] = await db.getAllAsync<Row>(`SELECT ${columnNames(table).join(', ')} FROM ${table} ORDER BY ${order}`);
  }
  return data;
}

export async function exportBackup(
  db: Db,
  options: { exportedAt?: string; app?: string; files?: Record<string, string> } = {}
): Promise<BackupFile> {
  return buildBackup(await readAllData(db), {
    schemaVersion: LATEST_VERSION,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    app: options.app ?? 'invoice-maker',
    files: options.files,
  });
}

const DELETE_ORDER: readonly TableName[] = [...TABLE_ORDER].reverse().filter((t) => t !== 'business');

async function phoneNumbering(db: Db): Promise<Pick<BackupData, 'number_counters' | 'documents'>> {
  return {
    number_counters: await db.getAllAsync<Row>('SELECT series_key, next_value, max_used FROM number_counters ORDER BY series_key'),
    documents: await db.getAllAsync<Row>('SELECT series, number FROM documents WHERE number IS NOT NULL ORDER BY id'),
  };
}

/**
 * Replaces everything with `data` in one transaction (this phone's own settings are kept). Number counters are
 * the maximum of this phone's and the file's, so no number is handed out twice (D52). Throws — after rolling
 * back — if anything fails. Returns what the phone had beyond the file.
 */
export async function replaceAllData(db: Db, data: BackupData): Promise<PhoneComparison> {
  return withTransaction(db, async (db) => {
    const phone = await phoneNumbering(db);
    const comparison = compareWithPhone(data, phone);
    data = { ...data, number_counters: mergeCounters(data.number_counters, phone.number_counters) };
    // Foreign keys are checked at COMMIT (self references and insert order do not matter), and the lock
    // triggers are out of the way while the tables are replaced.
    await db.execAsync('PRAGMA defer_foreign_keys = ON;');
    const triggers = await db.getAllAsync<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name");
    for (const t of triggers) await db.execAsync(`DROP TRIGGER "${t.name.replace(/"/g, '""')}";`);

    for (const table of DELETE_ORDER) await db.runAsync(`DELETE FROM ${table}`);
    const keep = DEVICE_SETTINGS.map(() => '?').join(', ');
    await db.runAsync(`DELETE FROM settings WHERE key NOT IN (${keep})`, ...DEVICE_SETTINGS);
    for (const [key, value] of Object.entries(data.settings)) {
      if (DEVICE_SETTINGS.includes(key)) continue;
      await db.runAsync('INSERT INTO settings (key, value) VALUES (?, ?)', key, value);
    }

    const business = data.business[0];
    const bizCols = columnNames('business').filter((c) => c !== 'id');
    await db.runAsync(`UPDATE business SET ${bizCols.map((c) => `${c} = ?`).join(', ')} WHERE id = 1`, ...bizCols.map((c) => business[c]));

    for (const table of TABLE_ORDER) {
      if (table === 'business') continue;
      const cols = columnNames(table);
      const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      for (const row of data[table]) await db.runAsync(sql, ...cols.map((c) => row[c]));
    }

    for (const t of triggers) await db.execAsync(`${t.sql};`);
    const broken = await db.getAllAsync('PRAGMA foreign_key_check');
    if (broken.length) throw new Error(`${broken.length} rows point at missing rows`);
    return comparison;
  });
}

/** Validates a backup and says what restoring it here would do, without changing anything (the confirm step). */
export async function previewRestore(db: Db, text: string) {
  const parsed = parseBackup(text, LATEST_VERSION);
  if (!parsed.ok) return parsed;
  const phone = compareWithPhone(parsed.file.data, await phoneNumbering(db));
  return { ...parsed, plan: { ...parsed.plan, phone } };
}

/** Same for a picked file's bytes: a V1.5 ZIP (format 2) or a v1.x JSON. The ZIP's files come back in `binaries`. */
export async function previewRestoreBytes(db: Db, bytes: Uint8Array) {
  const parsed = parseBackupBytes(bytes, LATEST_VERSION);
  if (!parsed.ok) return parsed;
  const phone = compareWithPhone(parsed.file.data, await phoneNumbering(db));
  return { ...parsed, plan: { ...parsed.plan, phone } };
}

export type RestoreResult =
  | { ok: true; plan: RestorePlan }
  | { ok: false; error: BackupError | { code: 'database'; detail: string } };

/** Restores an already validated backup (the UI shows `plan.counts` and asks once before calling this). */
export async function restoreBackup(db: Db, file: BackupFile): Promise<RestoreResult> {
  const parsed = parseBackup(JSON.stringify(file), LATEST_VERSION);
  if (!parsed.ok) return parsed;
  try {
    const phone = await replaceAllData(db, parsed.file.data);
    return { ok: true, plan: { ...parsed.plan, phone } };
  } catch (e) {
    return { ok: false, error: { code: 'database', detail: e instanceof Error ? e.message : String(e) } };
  }
}

/** Validate + restore in one call (tests, debug tools). Nothing changes unless it returns ok. */
export async function restoreFromText(db: Db, text: string): Promise<RestoreResult> {
  const parsed = parseBackup(text, LATEST_VERSION);
  if (!parsed.ok) return parsed;
  try {
    const phone = await replaceAllData(db, parsed.file.data);
    return { ok: true, plan: { ...parsed.plan, phone } };
  } catch (e) {
    return { ok: false, error: { code: 'database', detail: e instanceof Error ? e.message : String(e) } };
  }
}

/** What "Delete all data" will remove, for its first confirmation. */
export function dataCounts(db: Db): Promise<{ documents: number; clients: number }> {
  return withRead(db, async (db) => ({
    documents: (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM documents'))?.n ?? 0,
    clients: (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM clients'))?.n ?? 0,
  }));
}

/** Hash over every row a backup carries (A11 "count + hash"); the Backup screen shows it in development builds. */
export function dataFingerprint(db: Db): Promise<string> {
  return withRead(db, async (db) => hashData(await readAllData(db)));
}
