// "Delete all data" (SPEC F10, §11): every row of every table goes in ONE transaction, the lock triggers of issued
// documents (D34) are dropped for it and created again from their saved SQL. Business data, rates and settings return
// to the factory state; this phone's own preferences (theme, language, "asked about reminders") stay. The number
// counters STAY (v1.1 D81, review #4): invoices already sent keep their numbers at the clients, so RE-2026-0001 must
// never be issued a second time. Resetting them is the separate, warned `resetNumbering`.
// Files (logo, PDFs, caches) are removed by `src/lib/data-files.ts` after this succeeded.
import { TAX_RATE_SEEDS } from './seed-rates';
import { queued, withTransaction } from './transaction';
import type { Db } from './types';

const KEEP_SETTINGS = ['theme', 'ui_language', 'notif_asked'];

export function eraseAllData(db: Db): Promise<void> {
  return withTransaction(db, async (db) => {
    const triggers = await db.getAllAsync<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name");
    for (const t of triggers) await db.execAsync(`DROP TRIGGER "${t.name.replace(/"/g, '""')}";`);
    for (const table of ['signatures', 'attachments', 'payments', 'document_lines', 'documents', 'catalog_items', 'clients', 'tax_rates', 'business']) {
      await db.runAsync(`DELETE FROM ${table}`);
    }
    await db.runAsync(`DELETE FROM settings WHERE key NOT IN (${KEEP_SETTINGS.map(() => '?').join(', ')})`, ...KEEP_SETTINGS);
    await db.runAsync('DELETE FROM sqlite_sequence');
    await db.runAsync('INSERT INTO business (id, updated_at) VALUES (1, 0)');
    let sort = 0;
    for (const r of TAX_RATE_SEEDS) {
      await db.runAsync('INSERT INTO tax_rates (label, rate_bp, is_default, sort) VALUES (?, ?, ?, ?)', r.label, r.rateBp, r.isDefault ? 1 : 0, sort++);
    }
    for (const t of triggers) await db.execAsync(`${t.sql};`);
  });
}

/**
 * "Reset numbering" (D81): every counter starts again at 1. Numbers that already exist on this phone are still
 * skipped at Issue (D53); numbers of deleted documents that were sent are NOT known any more — the UI warns.
 */
export const resetNumbering = queued(async (db: Db): Promise<void> => {
  await db.runAsync('DELETE FROM number_counters');
});
