/**
 * @jest-environment node
 */
// A11: backup → wipe → restore gives identical rows (count + hash) and identical document text; broken files and
// a failure in the middle of a restore leave the data exactly as it was; the lock triggers of issued documents
// (D34) are dropped for the restore and come back (V1_PLAN P3, P1 finding).
import { updateBusiness } from '@/db/business';
import { getCounter } from '@/db/counters';
import { updateDraft } from '@/db/documents';
import { issueDocument, newDraft, renderModelFor } from '@/db/lifecycle';
import { addLine } from '@/db/lines';
import { LATEST_VERSION } from '@/db/migrations';
import { dataFingerprint, exportBackup, previewRestore, readAllData, replaceAllData, restoreBackup, restoreFromText } from '@/db/restore';
import { isLockedError, type Db } from '@/db/types';
import { renderHtml } from '@/render/html';

import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupFileName,
  buildBackup,
  columnNames,
  countsOf,
  DEVICE_SETTINGS,
  hashData,
  MAX_BACKUP_CHARS,
  mergeCounters,
  MIN_BACKUP_SCHEMA,
  parseBackup,
  referencedLogoFiles,
  serializeBackup,
  TABLE_ORDER,
  type BackupErrorCode,
  type BackupFile,
} from './backup';
import { dump, emptyDb, NOW, seededDb, triggerNames } from './test-data';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const withoutDeviceSettings = (d: Record<string, unknown[]>) => ({
  ...d,
  settings: (d.settings as { key: string; value: string }[]).filter((s) => !DEVICE_SETTINGS.includes(s.key)),
});

async function backupText(db: Db, files?: Record<string, string>) {
  return serializeBackup(await exportBackup(db, { exportedAt: '2026-10-01T09:00:00.000Z', app: '1.0.0', files }));
}

/** Every issued document rendered from its snapshot, in every template: the "PDF text" of A11. */
async function renderedDocuments(db: Db) {
  const ids = (await db.getAllAsync<{ id: number }>("SELECT id FROM documents WHERE status <> 'draft' ORDER BY id")).map((r) => r.id);
  const out: string[] = [];
  for (const id of ids) {
    const model = await renderModelFor(db, id);
    for (const template of ['classic', 'modern', 'compact'] as const) out.push(renderHtml(model, { template, embedFonts: false }));
  }
  return out;
}

describe('A11 round trip', () => {
  it('back up → restore into a brand-new install gives identical rows, counts and hash', async () => {
    const { db: source } = await seededDb();
    const text = await backupText(source);
    const target = await emptyDb();
    const result = await restoreFromText(target, text);
    expect(result.ok).toBe(true);
    expect(withoutDeviceSettings(await dump(target))).toEqual(withoutDeviceSettings(await dump(source)));
    const a = await readAllData(source);
    const b = await readAllData(target);
    expect(hashData(b)).toBe(hashData(a));
    expect(countsOf(b)).toEqual(countsOf(a));
    if (result.ok) {
      expect(result.plan.hash).toBe(hashData(a));
      expect(result.plan.counts).toEqual({ invoices: 4, cancellations: 1, quotes: 1, receipts: 2, drafts: 1, clients: 5, items: 3, payments: 2, lines: expect.any(Number) });
    }
  });

  it('back up → wipe → restore into the SAME database replaces everything, issued documents included', async () => {
    const { db } = await seededDb();
    const before = withoutDeviceSettings(await dump(db));
    const text = await backupText(db);
    // wipe: a different, empty state (the triggers forbid deleting issued documents, so use a second database for "wipe")
    const other = await emptyDb();
    await updateBusiness(other, { name: 'Anderes Unternehmen' }, NOW);
    expect((await restoreFromText(other, text)).ok).toBe(true);
    expect(withoutDeviceSettings(await dump(other))).toEqual(before);
    // restoring over the very same data changes nothing
    expect((await restoreFromText(db, text)).ok).toBe(true);
    expect(withoutDeviceSettings(await dump(db))).toEqual(before);
  });

  it('identical document text: every issued document renders to the same HTML after the restore', async () => {
    const { db: source } = await seededDb();
    const target = await emptyDb();
    await restoreFromText(target, await backupText(source));
    const a = await renderedDocuments(source);
    const b = await renderedDocuments(target);
    expect(a.length).toBe(8 * 3); // 8 issued documents × 3 templates
    expect(b).toEqual(a);
  });

  it('snapshots are restored byte for byte (not recomputed) and counters continue the numbering', async () => {
    const { db: source, ids } = await seededDb();
    const target = await emptyDb();
    await restoreFromText(target, await backupText(source));
    const snap = (db: Db) => db.getAllAsync<{ id: number; snapshot: string }>("SELECT id, snapshot FROM documents WHERE snapshot IS NOT NULL ORDER BY id");
    expect(await snap(target)).toEqual(await snap(source));
    expect(await getCounter(target, 'invoice:2026')).toEqual(await getCounter(source, 'invoice:2026'));
    expect(await getCounter(target, 'quote:2026')).toMatchObject({ nextValue: 40 }); // the raised counter survives
    // the next invoice continues the sequence, exactly as it would have on the old phone
    const clientId = ids.kunde;
    const next = async (db: Db) => {
      const id = await newDraft(db, { type: 'invoice', clientId, today: '2026-10-01', now: NOW });
      await addLine(db, id, { name: 'Nach dem Restore', qtyMilli: 1000, priceE4: 10_000, taxRateBp: 1900 });
      return issueDocument(db, id, { today: '2026-10-01', now: NOW });
    };
    const issuedOnTarget = await next(target);
    expect(issuedOnTarget).toEqual(await next(source));
    expect(issuedOnTarget.number).toBe('RE-2026-0005');
  });

  it("this phone's own settings (theme, notification state, last backup) are neither backed up nor overwritten", async () => {
    const { db } = await seededDb();
    const file = await exportBackup(db);
    for (const key of DEVICE_SETTINGS) expect(file.data.settings[key]).toBeUndefined();
    expect(file.data.settings.default_template).toBe('modern');
    const target = await emptyDb();
    await target.runAsync("INSERT INTO settings (key, value) VALUES ('theme', 'light'), ('notif_asked', '0'), ('stale', 'x')");
    expect((await restoreBackup(target, file)).ok).toBe(true);
    const settings = Object.fromEntries((await target.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM settings')).map((s) => [s.key, s.value]));
    expect(settings).toMatchObject({ theme: 'light', notif_asked: '0', default_template: 'modern' });
    expect(settings.stale).toBeUndefined();
  });

  it('pdf_file is not part of the backup and stays empty after a restore (PDFs are rendered again)', async () => {
    const { db, ids } = await seededDb();
    await db.runAsync("UPDATE documents SET pdf_file = 'pdf/1.pdf' WHERE id = ?", ids.inv1);
    const file = await exportBackup(db);
    expect(JSON.stringify(file)).not.toContain('pdf_file');
    const target = await emptyDb();
    await restoreBackup(target, file);
    expect(await target.getAllAsync("SELECT id FROM documents WHERE pdf_file IS NOT NULL")).toEqual([]);
  });

  it('logo files travel with the backup: the business logo and every logo a snapshot refers to', async () => {
    const { db } = await seededDb();
    const data = await readAllData(db);
    expect(referencedLogoFiles(data)).toEqual(['logo/abc123.png']);
    await updateBusiness(db, { logoFile: 'logo/new.png' }, NOW + 5); // later logo; old snapshots still refer to the first
    expect(referencedLogoFiles(await readAllData(db))).toEqual(['logo/abc123.png', 'logo/new.png']);
    const text = await backupText(db, { 'logo/abc123.png': PNG, 'logo/new.png': PNG });
    const parsed = parseBackup(text, LATEST_VERSION);
    expect(parsed.ok && parsed.plan.logoFiles).toEqual(['logo/abc123.png', 'logo/new.png']);
    expect(parsed.ok && parsed.file.files['logo/new.png']).toBe(PNG);
  });

  it('backup file name, format and version', async () => {
    expect(backupFileName('2026-10-01')).toBe('invoice-maker-backup-2026-10-01.zip');
    const { db } = await seededDb();
    const file = await exportBackup(db, { exportedAt: '2026-10-01T09:00:00.000Z' });
    expect(file).toMatchObject({ format: BACKUP_FORMAT, version: BACKUP_VERSION, schemaVersion: LATEST_VERSION, exportedAt: '2026-10-01T09:00:00.000Z' });
    expect(Object.keys(file.data)).toEqual(['settings', ...TABLE_ORDER]);
    expect(serializeBackup(file)).toBe(serializeBackup(buildBackup(await readAllData(db), { schemaVersion: LATEST_VERSION, exportedAt: '2026-10-01T09:00:00.000Z', app: 'invoice-maker' })));
  });

  it('the hash changes when any single value changes', async () => {
    const { db } = await seededDb();
    const data = await readAllData(db);
    const h = hashData(data);
    expect(hashData(JSON.parse(JSON.stringify(data)))).toBe(h);
    const changed = JSON.parse(JSON.stringify(data));
    changed.clients[0].name += 'x';
    expect(hashData(changed)).not.toBe(h);
    const changed2 = JSON.parse(JSON.stringify(data));
    changed2.number_counters[0].next_value += 1;
    expect(hashData(changed2)).not.toBe(h);
  });
});

describe('restore never hands out a number twice (P3.5 F3, D52, review #3)', () => {
  const issueOne = async (db: Db, clientId: number, today = '2026-10-01') => {
    const id = await newDraft(db, { type: 'invoice', clientId, today, now: NOW });
    await addLine(db, id, { name: 'Leistung', qtyMilli: 1000, priceE4: 10_000, taxRateBp: 1900 });
    return (await issueDocument(db, id, { today, now: NOW })).number;
  };

  it('review probe: back up after 0001, issue 0002, restore the old backup → the next number is 0003, and the summary says why', async () => {
    const db = await emptyDb();
    await updateBusiness(db, { name: 'Muster' }, NOW);
    const clientId = (await db.runAsync("INSERT INTO clients (name, created_at, updated_at) VALUES ('Kunde', 0, 0)")).lastInsertRowId;
    expect(await issueOne(db, clientId)).toBe('RE-2026-0001');
    const text = await backupText(db);
    expect(await issueOne(db, clientId)).toBe('RE-2026-0002'); // sent to the client, not in the backup

    const preview = await previewRestore(db, text);
    expect(preview.ok && preview.plan.phone).toEqual({
      countersKept: [{ seriesKey: 'invoice:2026', fileNext: 2, phoneNext: 3 }],
      phoneOnlyNumbers: ['RE-2026-0002'],
    });
    expect(await getCounter(db, 'invoice:2026')).toMatchObject({ nextValue: 3 }); // preview changes nothing

    const result = await restoreFromText(db, text);
    expect(result.ok && result.plan.phone?.phoneOnlyNumbers).toEqual(['RE-2026-0002']);
    expect(await getCounter(db, 'invoice:2026')).toEqual({ seriesKey: 'invoice:2026', nextValue: 3, maxUsed: 2 });
    const restoredClient = (await db.getFirstAsync<{ id: number }>('SELECT id FROM clients'))!.id;
    expect(await issueOne(db, restoredClient)).toBe('RE-2026-0003');
  });

  it('a newer backup over an older phone takes the file counters; counters only on the phone are kept', async () => {
    const source = await emptyDb();
    const clientId = (await source.runAsync("INSERT INTO clients (name, created_at, updated_at) VALUES ('Kunde', 0, 0)")).lastInsertRowId;
    await issueOne(source, clientId);
    await issueOne(source, clientId);
    const target = await emptyDb();
    const otherClient = (await target.runAsync("INSERT INTO clients (name, created_at, updated_at) VALUES ('K', 0, 0)")).lastInsertRowId;
    await issueOne(target, otherClient, '2025-12-30'); // RE-2025-0001: a key the file does not have
    const result = await restoreFromText(target, await backupText(source));
    expect(result.ok && result.plan.phone).toEqual({ countersKept: [{ seriesKey: 'invoice:2025', fileNext: 1, phoneNext: 2 }], phoneOnlyNumbers: ['RE-2025-0001'] });
    expect(await getCounter(target, 'invoice:2026')).toMatchObject({ nextValue: 3, maxUsed: 2 });
    expect(await getCounter(target, 'invoice:2025')).toMatchObject({ nextValue: 2, maxUsed: 1 });
  });

  it('mergeCounters: per key the maximum of next value and highest used', () => {
    const f = [{ series_key: 'invoice:2026', next_value: 5, max_used: 4 }, { series_key: 'quote', next_value: 40, max_used: 3 }];
    const p = [{ series_key: 'invoice:2026', next_value: 7, max_used: 6 }, { series_key: 'quote', next_value: 4, max_used: 3 }, { series_key: 'receipt', next_value: 2, max_used: 1 }];
    expect(mergeCounters(f, p)).toEqual([
      { series_key: 'invoice:2026', next_value: 7, max_used: 6 },
      { series_key: 'quote', next_value: 40, max_used: 3 },
      { series_key: 'receipt', next_value: 2, max_used: 1 },
    ]);
    expect(mergeCounters(f, [])).toEqual(f);
  });
});

describe('lock triggers (D34): dropped for the restore, created again', () => {
  it('the triggers really forbid what the restore does: inserting lines into an issued document', async () => {
    const { db, ids } = await seededDb();
    const error = await db.runAsync("INSERT INTO document_lines (document_id, position, name, qty_milli, price_e4, tax_rate_bp) VALUES (?, 99, 'x', 1000, 100, 1900)", ids.inv1).then(() => null, (e: unknown) => e);
    expect(isLockedError(error)).toBe(true);
    const del = await db.runAsync('DELETE FROM documents WHERE id = ?', ids.inv1).then(() => null, (e: unknown) => e);
    expect(isLockedError(del)).toBe(true);
  });

  it('a restore into a database full of issued documents works, and the same triggers exist afterwards', async () => {
    const { db: source } = await seededDb();
    const { db: target } = await seededDb();
    const before = await triggerNames(target);
    expect(before.length).toBe(10);
    const result = await restoreFromText(target, await backupText(source));
    expect(result.ok).toBe(true);
    expect(await triggerNames(target)).toEqual(before);
    // and they work: an issued document is locked again
    const issued = (await target.getFirstAsync<{ id: number }>("SELECT id FROM documents WHERE status = 'issued' AND type = 'invoice'"))!.id;
    await expect(updateDraft(target, issued, { notes: 'x' })).rejects.toThrow();
    const raw = await target.runAsync("UPDATE documents SET notes = 'hack' WHERE id = ?", issued).then(() => null, (e: unknown) => e);
    expect(isLockedError(raw)).toBe(true);
    const sql = (db: Db) => db.getAllAsync<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name");
    expect(await sql(target)).toEqual(await sql(source)); // identical definitions
  });

  it('without the drop the same restore would fail: restoring with the triggers in place is refused by SQLite', async () => {
    const { db: source } = await seededDb();
    const { db: target } = await seededDb();
    const data = await readAllData(source);
    let failed = false;
    try {
      await target.execAsync('BEGIN IMMEDIATE;');
      await target.runAsync('DELETE FROM payments');
      await target.runAsync('DELETE FROM document_lines');
      await target.runAsync('DELETE FROM documents');
    } catch (e) {
      failed = isLockedError(e);
    } finally {
      await target.execAsync('ROLLBACK;');
    }
    expect(failed).toBe(true);
    expect(data.documents.length).toBeGreaterThan(0);
  });

  it('a draft-only database (no issued documents) restores too, and triggers stay', async () => {
    const source = await emptyDb();
    const id = await newDraft(source, { type: 'invoice', today: '2026-10-01', now: NOW });
    await addLine(source, id, { name: 'x', qtyMilli: 1000, priceE4: 100, taxRateBp: 1900 });
    const target = await emptyDb();
    expect((await restoreFromText(target, await backupText(source))).ok).toBe(true);
    expect(await triggerNames(target)).toHaveLength(10);
  });
});

describe('a broken file changes nothing (three deliberately broken files + more)', () => {
  const cases: [string, BackupErrorCode, (text: string, file: BackupFile) => string][] = [
    ['cut off half way', 'notJson', (t) => t.slice(0, Math.floor(t.length / 2))],
    ['made by a newer app (schema)', 'newerVersion', (_t, f) => JSON.stringify({ ...f, schemaVersion: LATEST_VERSION + 1 })],
    ['a payment of a document that is not in the file', 'reference', (_t, f) => JSON.stringify({ ...f, data: { ...f.data, payments: [{ ...f.data.payments[0], document_id: 9999 }, ...f.data.payments.slice(1)] } })],
  ];
  it.each(cases)('%s → %s, data untouched', async (_label, code, breakIt) => {
    const { db: source } = await seededDb();
    const file = await exportBackup(source);
    const text = breakIt(await backupText(source), file);
    const { db: target } = await seededDb();
    await updateBusiness(target, { name: 'Zielunternehmen' }, NOW + 9); // different data than the file, so a partial restore would show
    const before = await dump(target);
    const triggers = await triggerNames(target);
    const result = await restoreFromText(target, text);
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(await dump(target)).toEqual(before);
    expect(await triggerNames(target)).toEqual(triggers);
  });

  it('a failure in the middle of the restore transaction rolls everything back, triggers included', async () => {
    const { db: source } = await seededDb();
    const text = await backupText(source);
    const { db: target } = await seededDb();
    await updateBusiness(target, { name: 'Zielunternehmen' }, NOW + 9);
    const before = await dump(target);
    const triggers = await triggerNames(target);
    const total = (await readAllData(source)).documents.length;
    expect(total).toBeGreaterThan(5);
    // Count the writes of a complete restore, then fail at the first, the last and several points in between.
    const { db: scratch } = await seededDb();
    let counted = 0;
    const counting = {
      execAsync: scratch.execAsync.bind(scratch),
      getAllAsync: scratch.getAllAsync.bind(scratch),
      getFirstAsync: scratch.getFirstAsync.bind(scratch),
      runAsync: (...args: Parameters<Db['runAsync']>) => {
        counted++;
        return scratch.runAsync(...args);
      },
    } as unknown as Db;
    expect((await restoreFromText(counting, text)).ok).toBe(true);
    expect(counted).toBeGreaterThan(30);
    const restoredState = before;
    const restoredTriggers = triggers;
    for (const failAt of [1, 2, 3, 8, Math.floor(counted / 3), Math.floor(counted / 2), counted - 1, counted]) {
      let writes = 0;
      const flaky = {
        execAsync: target.execAsync.bind(target),
        getAllAsync: target.getAllAsync.bind(target),
        getFirstAsync: target.getFirstAsync.bind(target),
        runAsync: (...args: Parameters<Db['runAsync']>) => {
          if (++writes === failAt) return Promise.reject(new Error(`disk full at write ${failAt}`));
          return target.runAsync(...args);
        },
      } as unknown as Db;
      const result = await restoreFromText(flaky, text);
      expect([failAt, result.ok]).toEqual([failAt, false]);
      expect(result).toMatchObject({ error: { code: 'database' } });
      expect(await dump(target)).toEqual(restoredState);
      expect(await triggerNames(target)).toEqual(restoredTriggers);
    }
    // a failure while the lock triggers are created again (the last step before COMMIT) rolls back as well
    const triggerFail = {
      execAsync: (sql: string) => (/CREATE TRIGGER/.test(sql) ? Promise.reject(new Error('cannot create trigger')) : target.execAsync(sql)),
      getAllAsync: target.getAllAsync.bind(target),
      getFirstAsync: target.getFirstAsync.bind(target),
      runAsync: target.runAsync.bind(target),
    } as unknown as Db;
    expect(await restoreFromText(triggerFail, text)).toMatchObject({ ok: false, error: { code: 'database', detail: 'cannot create trigger' } });
    expect(await dump(target)).toEqual(restoredState);
    expect(await triggerNames(target)).toEqual(restoredTriggers);
    // and afterwards a normal restore still works
    expect((await restoreFromText(target, text)).ok).toBe(true);
  });

  it('a file that passes validation but breaks the database (a foreign key) is rolled back too', async () => {
    const { db: source } = await seededDb();
    const file = await exportBackup(source);
    // pass the validator, then break a reference only the database can see: tamper after parse
    const parsed = parseBackup(serializeBackup(file), LATEST_VERSION);
    if (!parsed.ok) throw new Error('setup');
    const target = await emptyDb();
    const bad = JSON.parse(JSON.stringify(parsed.file)) as BackupFile;
    bad.data.documents[0].client_id = 424242;
    const before = await dump(target);
    await expect(replaceAllData(target, bad.data)).rejects.toThrow(/point at missing rows|FOREIGN KEY/);
    expect(await dump(target)).toEqual(before);
    expect(await triggerNames(target)).toHaveLength(10);
  });
});

describe('strict validation (parseBackup never throws)', () => {
  let good: BackupFile;
  let ourText: string;
  beforeAll(async () => {
    const { db } = await seededDb();
    good = await exportBackup(db, { exportedAt: '2026-10-01T09:00:00.000Z', files: { 'logo/abc123.png': PNG } });
    ourText = serializeBackup(good);
  });
  const clone = (): BackupFile => JSON.parse(ourText) as BackupFile;
  const parse = (file: unknown) => parseBackup(typeof file === 'string' ? file : JSON.stringify(file), LATEST_VERSION);

  it('the good file is accepted, with and without a BOM', () => {
    expect(parse(ourText).ok).toBe(true);
    expect(parse(`﻿${ourText}`).ok).toBe(true);
  });

  const mutate = (fn: (f: BackupFile) => void) => {
    const f = clone();
    fn(f);
    return f;
  };
  const bad: [string, BackupErrorCode, () => unknown][] = [
    ['empty', 'notJson', () => ''],
    ['JSON array', 'notInvoiceMaker', () => '[]'],
    ['JSON null', 'notInvoiceMaker', () => 'null'],
    ['another app', 'notInvoiceMaker', () => ({ app: 'price-book', backupVersion: 1 })],
    ['wrong format string', 'notInvoiceMaker', () => mutate((f) => ((f as { format: string }).format = 'x'))],
    ['version missing', 'shape', () => mutate((f) => delete (f as Partial<BackupFile>).version)],
    ['version 0', 'shape', () => mutate((f) => (f.version = 0))],
    ['version from the future', 'newerVersion', () => mutate((f) => (f.version = BACKUP_VERSION + 1))],
    ['schema from the future', 'newerVersion', () => mutate((f) => (f.schemaVersion = LATEST_VERSION + 1))],
    ['schema before the tables existed', 'unsupported', () => mutate((f) => (f.schemaVersion = MIN_BACKUP_SCHEMA - 1))],
    ['unknown top-level field', 'shape', () => mutate((f) => ((f as unknown as Record<string, unknown>).extra = 1))],
    ['exportedAt not a date', 'shape', () => mutate((f) => (f.exportedAt = 'yesterday'))],
    ['data missing a table', 'shape', () => mutate((f) => delete (f.data as Partial<BackupFile['data']>).payments)],
    ['data with an unknown table', 'shape', () => mutate((f) => ((f.data as unknown as Record<string, unknown>).secrets = []))],
    ['table is not a list', 'shape', () => mutate((f) => ((f.data as unknown as Record<string, unknown>).clients = {}))],
    ['row is not an object', 'shape', () => mutate((f) => ((f.data.clients as unknown[])[0] = 'x'))],
    ['row has an unknown field', 'shape', () => mutate((f) => ((f.data.clients[0] as Record<string, unknown>).extra = 1))],
    ['row misses a field', 'shape', () => mutate((f) => delete f.data.clients[0].name)],
    ['text where a number belongs', 'shape', () => mutate((f) => (f.data.documents[0].gross_cents = '100'))],
    ['fractional cents', 'shape', () => mutate((f) => (f.data.documents[0].net_cents = 1.5))],
    ['unsafe integer', 'shape', () => mutate((f) => (f.data.payments[0].amount_cents = 2 ** 60))],
    ['null where null is not allowed', 'shape', () => mutate((f) => (f.data.documents[0].issue_date = null))],
    ['bad enum', 'shape', () => mutate((f) => (f.data.documents[0].status = 'paid'))],
    ['bad document type', 'shape', () => mutate((f) => (f.data.documents[0].type = 'offer'))],
    ['date not a calendar date', 'shape', () => mutate((f) => (f.data.documents[0].issue_date = '2026-02-30'))],
    ['date in the wrong format', 'shape', () => mutate((f) => (f.data.payments[0].date = '01.10.2026'))],
    ['currency not 3 capital letters', 'shape', () => mutate((f) => (f.data.documents[0].currency = 'eur'))],
    ['accent not a colour', 'shape', () => mutate((f) => (f.data.documents[0].accent = 'red'))],
    ['custom fields not JSON', 'shape', () => mutate((f) => (f.data.documents[0].custom_fields = '{oops'))],
    ['custom fields not an array', 'shape', () => mutate((f) => (f.data.documents[0].custom_fields = '{}'))],
    ['snapshot not JSON', 'shape', () => mutate((f) => (f.data.documents.find((d) => d.snapshot)!.snapshot = 'not json'))],
    ['empty client name', 'shape', () => mutate((f) => (f.data.clients[0].name = '  '))],
    ['no business row', 'shape', () => mutate((f) => (f.data.business = []))],
    ['two business rows', 'shape', () => mutate((f) => f.data.business.push({ ...f.data.business[0] }))],
    ['business row with another id', 'shape', () => mutate((f) => (f.data.business[0].id = 2))],
    ['setting that is not text', 'shape', () => mutate((f) => ((f.data.settings as unknown as Record<string, unknown>).x = 5))],
    ['duplicate client id', 'duplicate', () => mutate((f) => (f.data.clients[1].id = f.data.clients[0].id))],
    ['duplicate document id', 'duplicate', () => mutate((f) => (f.data.documents[1].id = f.data.documents[0].id))],
    ['duplicate number in a series', 'duplicate', () => mutate((f) => { const issued = f.data.documents.filter((d) => d.series === 'invoice'); issued[1].number = issued[0].number; })],
    ['duplicate counter', 'duplicate', () => mutate((f) => f.data.number_counters.push({ ...f.data.number_counters[0] }))],
    ['document names a missing client', 'reference', () => mutate((f) => (f.data.documents[0].client_id = 777))],
    ['document refers to a missing source', 'reference', () => mutate((f) => (f.data.documents[0].source_id = 777))],
    ['document refers to itself', 'reference', () => mutate((f) => (f.data.documents[0].source_id = f.data.documents[0].id))],
    ['line of a missing document', 'reference', () => mutate((f) => (f.data.document_lines[0].document_id = 777))],
    ['line names a missing catalog item', 'reference', () => mutate((f) => (f.data.document_lines[0].catalog_item_id = 777))],
    ['payment of a missing document', 'reference', () => mutate((f) => (f.data.payments[0].document_id = 777))],
    ['issued document without a number', 'inconsistent', () => mutate((f) => { const d = f.data.documents.find((x) => x.status === 'issued')!; d.number = null; d.series = null; })],
    ['issued document without a snapshot', 'inconsistent', () => mutate((f) => (f.data.documents.find((d) => d.status === 'issued')!.snapshot = null))],
    ['number without series', 'inconsistent', () => mutate((f) => (f.data.documents.find((d) => d.status === 'issued')!.series = null))],
    ['series that does not fit the type', 'inconsistent', () => mutate((f) => (f.data.documents.find((d) => d.type === 'invoice' && d.status === 'issued')!.series = 'quote'))],
    ['net + VAT is not the total', 'inconsistent', () => mutate((f) => (f.data.documents.find((d) => d.status === 'issued')!.gross_cents = 1))],
    ['total differs from the snapshot', 'inconsistent', () => mutate((f) => { const d = f.data.documents.find((x) => x.status === 'issued')!; d.net_cents = (d.net_cents as number) + 1; d.gross_cents = (d.gross_cents as number) + 1; })],
    ['snapshot of another number', 'inconsistent', () => mutate((f) => { const d = f.data.documents.find((x) => x.status === 'issued' && x.type === 'invoice')!; const s = JSON.parse(d.snapshot as string); s.number = 'RE-9999'; d.snapshot = JSON.stringify(s); })],
    ['snapshot with another line count', 'inconsistent', () => mutate((f) => { const d = f.data.documents.find((x) => x.status === 'issued' && x.type === 'invoice')!; const s = JSON.parse(d.snapshot as string); s.lines.pop(); d.snapshot = JSON.stringify(s); })],
    ['snapshot from a newer renderer', 'newerVersion', () => mutate((f) => { const d = f.data.documents.find((x) => x.snapshot)!; const s = JSON.parse(d.snapshot as string); s.modelVersion = 99; d.snapshot = JSON.stringify(s); })],
    ['receipt kind on an invoice', 'inconsistent', () => mutate((f) => (f.data.documents.find((d) => d.type === 'invoice')!.receipt_kind = 'cash'))],
    ['cancelled receipt', 'inconsistent', () => mutate((f) => { const d = f.data.documents.find((x) => x.type === 'receipt')!; d.status = 'cancelled'; })],
    ['accepted invoice', 'inconsistent', () => mutate((f) => (f.data.documents.find((d) => d.type === 'invoice' && d.status === 'issued')!.status = 'accepted'))],
    ['counter whose next value is not above the highest used', 'inconsistent', () => mutate((f) => (f.data.number_counters[0].next_value = f.data.number_counters[0].max_used))],
    ['negative counter', 'shape', () => mutate((f) => (f.data.number_counters[0].next_value = 0))],
    ['logo path outside logo/', 'shape', () => mutate((f) => (f.files['../evil.png'] = PNG))],
    ['logo with a wrong extension', 'shape', () => mutate((f) => (f.files['logo/x.svg'] = PNG))],
    ['logo that is not base64', 'shape', () => mutate((f) => (f.files['logo/abc123.png'] = 'not base64!!'))],
    ['files not an object', 'shape', () => mutate((f) => ((f as unknown as Record<string, unknown>).files = []))],
  ];
  it.each(bad)('%s → %s', (_label, code, make) => {
    const result = parse(make());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(code);
      expect(result.error.detail.length).toBeGreaterThan(3);
    }
  });

  it('something that is not text is refused', () => {
    for (const value of [42, null, undefined, {}, []]) expect(parseBackup(value, LATEST_VERSION)).toMatchObject({ ok: false, error: { code: 'notJson' } });
  });

  it('a file over the size limit is refused before parsing', () => {
    const result = parseBackup('x'.repeat(MAX_BACKUP_CHARS + 1), LATEST_VERSION);
    expect(result).toMatchObject({ ok: false, error: { code: 'tooLarge' } });
  });

  it('device settings inside a hand-made file are ignored, not restored', () => {
    const f = clone();
    f.data.settings.theme = 'dark';
    const parsed = parse(f);
    expect(parsed.ok && parsed.file.data.settings.theme).toBeUndefined();
  });

  it('every table has its columns checked: each column of each table is required', () => {
    for (const table of TABLE_ORDER) {
      for (const name of columnNames(table)) {
        const f = clone();
        if (f.data[table].length === 0) continue;
        delete f.data[table][0][name];
        const result = parse(f);
        expect([table, name, result.ok]).toEqual([table, name, false]);
      }
    }
  });
});

describe('versioning', () => {
  it('this app writes backup version 2 for schema 5 and restores schema 2, 3 and 4 files too', async () => {
    expect(BACKUP_VERSION).toBe(2);
    expect(LATEST_VERSION).toBe(5);
    expect(MIN_BACKUP_SCHEMA).toBe(2);
    const { db: source } = await seededDb();
    const file = await exportBackup(source);
    expect(file.schemaVersion).toBe(5);
    const target = await emptyDb();
    expect((await restoreBackup(target, { ...file, schemaVersion: 2 })).ok).toBe(true);
    expect(await triggerNames(target)).toContain('documents_locked_status');
    expect((await restoreBackup(target, { ...file, schemaVersion: 3 })).ok).toBe(true); // a v1.0 backup
    expect(await triggerNames(target)).toContain('documents_status_moves');
  });

  it('a real v1.1 file (format 1, schema 4: no shipping, photo or signature columns, no new tables) restores with defaults', async () => {
    const { db: source } = await seededDb();
    const json = JSON.parse(await backupText(source)) as { version: number; schemaVersion: number; data: Record<string, Record<string, unknown>[] | Record<string, string>> };
    json.version = 1;
    json.schemaVersion = 4;
    delete json.data.attachments;
    delete json.data.signatures;
    const drop = (table: string, cols: string[]) => (json.data[table] as Record<string, unknown>[]).forEach((r) => cols.forEach((c) => delete r[c]));
    drop('clients', ['ship_name', 'ship_street', 'ship_postal_code', 'ship_city', 'ship_country_code']);
    drop('catalog_items', ['image_file']);
    drop('document_lines', ['image_file']);
    drop('business', ['signature']);
    const target = await emptyDb();
    const result = await restoreFromText(target, JSON.stringify(json));
    expect(result.ok).toBe(true);
    expect(await dataFingerprint(target)).toBe(await dataFingerprint(source));
    // ...but a schema-5 file must have every column.
    json.schemaVersion = 5;
    const strict = parseBackup(JSON.stringify(json), LATEST_VERSION);
    expect(strict.ok || strict.error.code).toBe('shape');
  });
});
