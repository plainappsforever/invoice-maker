// Dev-only helpers (V1_PLAN rule 14): reset, fixtures and the on-device probes of the write queue and the
// migration-3 trigger. Reached only from Settings → Debug and the `invoicemaker-dev://debug/...` links, which exist in
// development builds only; nothing here is called by the production UI.
import { TAX_RATE_SEEDS } from './seed-rates';
import { updateBusiness } from './business';
import { createClient, updateClient } from './clients';
import { getCounter } from './counters';
import { deleteDocument, getDocument, listDocuments, updateDraft } from './documents';
import { patchDraft, saveDraftLine } from './editing';
import { createCatalogItem } from './items';
import { checkStoredDocument, duplicateDocument, issueDocument, IssueBlockedError, newDraft, reopenQuote } from './lifecycle';
import { LATEST_VERSION, migrate } from './migrations';
import { openInvoices } from './summary';
import { withTransaction } from './transaction';
import type { Db } from './types';
import { addDays, todayLocal } from '@/engine/dates';
import { computeTotals } from '@/engine/totals';

export type FixtureName = 'business' | 'repeat' | 'examples' | 'issued' | 'overdue' | 'quote';
export const FIXTURES: readonly FixtureName[] = ['business', 'repeat', 'examples', 'issued', 'overdue', 'quote'];

/**
 * Deletes every row of every table (lock triggers dropped and recreated) and restores the factory state. The setting
 * "asked about reminders" is set afterwards (so no in-app question interrupts a flow) unless `askReminders` is true.
 */
export function resetAll(db: Db, options: { askReminders?: boolean } = {}): Promise<void> {
  return withTransaction(db, async (db) => {
    const triggers = await db.getAllAsync<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name");
    for (const t of triggers) await db.execAsync(`DROP TRIGGER "${t.name}";`);
    for (const table of ['payments', 'document_lines', 'documents', 'catalog_items', 'clients', 'number_counters', 'tax_rates', 'settings', 'business']) {
      await db.runAsync(`DELETE FROM ${table}`);
    }
    await db.runAsync("DELETE FROM sqlite_sequence"); // ids restart at 1: flows may rely on them
    await db.runAsync('INSERT INTO business (id, updated_at) VALUES (1, 0)');
    let sort = 0;
    for (const r of TAX_RATE_SEEDS) {
      await db.runAsync('INSERT INTO tax_rates (label, rate_bp, is_default, sort) VALUES (?, ?, ?, ?)', r.label, r.rateBp, r.isDefault ? 1 : 0, sort++);
    }
    if (!options.askReminders) await db.runAsync("INSERT INTO settings (key, value) VALUES ('notif_asked', '1')");
    for (const t of triggers) await db.execAsync(`${t.sql};`);
  });
}

async function seedBusiness(db: Db) {
  await updateBusiness(db, {
    name: 'Muster Design', street: 'Musterstraße 1', postalCode: '10115', city: 'Berlin', countryCode: 'DE',
    email: 'info@muster-design.example', phone: '030 1234567', taxNumber: '12/345/67890', vatId: 'DE123456789',
    iban: 'DE89370400440532013000', bic: 'COBADEFFXXX', bankName: 'Commerzbank', accountHolder: 'Muster Design',
  });
}

async function seedRepeat(db: Db) {
  await seedBusiness(db);
  const client = await createClient(db, { name: 'Müller GmbH', street: 'Hauptstraße 5', postalCode: '80331', city: 'München', countryCode: 'DE', email: 'einkauf@mueller.example' });
  await createCatalogItem(db, { name: 'Webdesign', unitCode: 'HUR', priceE4: 850_000, taxRateBp: 1900 });
  await createCatalogItem(db, { name: 'Hosting', unitCode: 'MON', priceE4: 1_190_000, taxRateBp: 1900 });
  await createCatalogItem(db, { name: 'Fachbuch', unitCode: 'C62', priceE4: 249_000, taxRateBp: 700, taxCategory: 'S' });
  return client;
}

const line = (name: string, qtyMilli: number, priceE4: number, rateBp: number, extra: Partial<Parameters<typeof saveDraftLine>[3]> = {}) => ({
  name, description: '', qtyMilli, unitCode: 'C62', priceE4, rateBp, discountKind: 'none' as const, discountValue: 0, ...extra,
});

/** SPEC §5 Example A (net, mixed rates, line and document discounts → 1.330,29) as a draft. */
async function seedExampleA(db: Db, clientId: number, today = todayLocal()) {
  const id = await newDraft(db, { type: 'invoice', clientId, today });
  await saveDraftLine(db, id, null, line('Webdesign', 12_500, 850_000, 1900, { unitCode: 'HUR', discountKind: 'percent', discountValue: 1000 }));
  await saveDraftLine(db, id, null, line('Hosting (12 Monate)', 1000, 1_190_000, 1900));
  await saveDraftLine(db, id, null, line('Fachbuch', 2000, 249_000, 700));
  await saveDraftLine(db, id, null, line('Druck Flyer', 500_000, 1234, 1900, { discountKind: 'amount', discountValue: 500 }));
  await patchDraft(db, id, { discountKind: 'percent', discountValue: 500 });
  return id;
}

/** SPEC §5 Example B (gross prices, mixed rates, fixed discount → 75,97) as a draft. */
async function seedExampleB(db: Db) {
  const id = await newDraft(db, { type: 'invoice', today: todayLocal() });
  await patchDraft(db, id, { pricesIncludeVat: true });
  await saveDraftLine(db, id, null, line('Haarschnitt', 1000, 350_000, 1900));
  await saveDraftLine(db, id, null, line('Pflegeprodukt', 2000, 129_900, 1900));
  await saveDraftLine(db, id, null, line('Buch', 1000, 199_900, 700));
  await patchDraft(db, id, { discountKind: 'amount', discountValue: 500 });
  return id;
}

export async function seedFixture(db: Db, name: FixtureName): Promise<void> {
  if (name === 'business') return seedBusiness(db);
  const client = await seedRepeat(db);
  if (name === 'repeat') return;
  if (name === 'examples') {
    await seedExampleA(db, client);
    await seedExampleB(db);
    return;
  }
  if (name === 'overdue') {
    // Example A issued 8 days ago with a 7-day term: due YESTERDAY, so the overdue reminder (due + 1 day) falls on today.
    const past = addDays(todayLocal(), -8);
    const id = await seedExampleA(db, client, past);
    await patchDraft(db, id, { paymentDays: 7 });
    await issueDocument(db, id, { today: past });
    return;
  }
  if (name === 'quote') {
    // V1.5 P1: an issued quote for Müller GmbH (AN-…-0001), for "Accept with signature".
    const id = await newDraft(db, { type: 'quote', clientId: client, today: todayLocal() });
    await saveDraftLine(db, id, null, line('Webdesign', 10_000, 850_000, 1900, { unitCode: 'HUR' }));
    await issueDocument(db, id, { today: todayLocal() });
    return;
  }
  const id = await seedExampleA(db, client);
  await issueDocument(db, id, { today: todayLocal() });
}

// ---------------------------------------------------------------------------------------------
// On-device probes (P3.5 note for P4/P5): the same checks as src/db/write-queue.test.ts, on real expo-sqlite.
// ---------------------------------------------------------------------------------------------

export type ProbeResult = { name: string; ok: boolean; detail: string };

async function probe(name: string, fn: () => Promise<string>): Promise<ProbeResult> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (e) {
    return { name, ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

function expect(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

/** Resets the database, runs every probe and returns the results. Destroys the data of the dev build. */
export async function runProbes(db: Db): Promise<ProbeResult[]> {
  const today = todayLocal();
  const clock = { today };
  await resetAll(db);
  const clientId = await seedRepeat(db);
  const mk = async (withLine: boolean) => {
    const id = await newDraft(db, { type: 'invoice', clientId, today });
    if (withLine) await saveDraftLine(db, id, null, line('Probe', 1000, 1_000_000, 1900));
    return id;
  };
  const out: ProbeResult[] = [];
  out.push(
    await probe('autosave survives a rolled-back Issue', async () => {
      const blocked = await mk(false);
      const other = await mk(true);
      const [issue, save] = await Promise.allSettled([issueDocument(db, blocked, clock), patchDraft(db, other, { notes: 'typed while issuing' })]);
      expect(issue.status === 'rejected' && issue.reason instanceof IssueBlockedError, 'Issue of a draft without lines must be blocked');
      expect(save.status === 'fulfilled', 'the autosave must succeed');
      expect((await getDocument(db, other))?.notes === 'typed while issuing', 'the typed text must be stored');
      const c = await getCounter(db, `invoice:${today.slice(0, 4)}`);
      expect(c.nextValue === 1 && c.maxUsed === 0, 'the counter must be untouched');
      return 'typed text kept, counter untouched';
    })
  );
  out.push(
    await probe('Issue + Duplicate + Issue together', async () => {
      const a = await mk(true);
      const b = await mk(true);
      const [x, copy, y] = await Promise.all([issueDocument(db, a, clock), duplicateDocument(db, a, clock), issueDocument(db, b, clock)]);
      expect(x.number.endsWith('0001') && y.number.endsWith('0002'), `numbers ${x.number}, ${y.number}`);
      expect((await getDocument(db, copy))?.status === 'draft', 'the copy is a draft');
      return `${x.number}, ${y.number}, copy #${copy}`;
    })
  );
  out.push(
    await probe('many concurrent saves and Issues', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 6; i++) ids.push(await mk(i % 3 !== 0));
      const ops: Promise<unknown>[] = [];
      for (const id of ids) {
        ops.push(issueDocument(db, id, clock));
        ops.push(patchDraft(db, id, { notes: `n${id}` }));
      }
      const res = await Promise.allSettled(ops);
      const numbers: string[] = [];
      for (let i = 0; i < ids.length; i++) {
        const doc = (await getDocument(db, ids[i]))!;
        if (i % 3 === 0) expect(res[2 * i].status === 'rejected' && doc.status === 'draft' && doc.notes === `n${ids[i]}`, `blocked draft ${i} lost its text`);
        else {
          expect(res[2 * i].status === 'fulfilled', `Issue ${i} failed`);
          numbers.push(doc.number!);
        }
      }
      const sorted = [...numbers].sort();
      expect(new Set(numbers).size === 4 && sorted[0].endsWith('0003') && sorted[3].endsWith('0006'), `numbers ${numbers.join(',')}`);
      return numbers.join(', ');
    })
  );
  out.push(
    await probe('nested transaction = savepoint', async () => {
      const id = await mk(true);
      await withTransaction(db, async (tx) => {
        await updateDraft(tx, id, { notes: 'outer' });
        try {
          await withTransaction(tx, async (inner) => {
            await updateDraft(inner, id, { notes: 'inner' });
            throw new Error('inner fails');
          });
        } catch {
          // the outer transaction decides
        }
      });
      expect((await getDocument(db, id))?.notes === 'outer', 'inner change must be undone, outer kept');
      return 'inner undone, outer kept';
    })
  );
  out.push(
    await probe('foreign keys are ON', async () => {
      const row = await db.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys');
      expect(row?.foreign_keys === 1, 'PRAGMA foreign_keys is not 1');
      let refused = false;
      try {
        await db.runAsync("INSERT INTO payments (document_id, date, amount_cents, created_at) VALUES (99999, '2026-01-01', 1, 0)");
      } catch {
        refused = true;
      }
      expect(refused, 'a payment for a missing document was accepted');
      return 'orphan payment refused';
    })
  );
  const issued = (await listDocuments(db, { status: 'issued' }))[0];
  out.push(
    await probe('lock triggers refuse edits of an issued document', async () => {
      expect(!!issued, 'no issued document');
      let msg = '';
      try {
        await db.runAsync("UPDATE documents SET notes = 'x' WHERE id = ?", issued.id);
      } catch (e) {
        msg = String((e as Error).message);
      }
      expect(msg.includes('document_locked'), `expected document_locked, got "${msg}"`);
      return 'document_locked';
    })
  );
  out.push(
    await probe('migration 3 trigger: status never back to draft (reopened database)', async () => {
      const t = await db.getFirstAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'documents_locked_status'");
      const v = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      expect(!!t && v?.user_version === LATEST_VERSION, `trigger ${t ? 'present' : 'missing'}, user_version ${v?.user_version}`);
      let msg = '';
      try {
        await db.runAsync("UPDATE documents SET status = 'draft' WHERE id = ?", issued.id);
      } catch (e) {
        msg = String((e as Error).message);
      }
      expect(msg.includes('document_locked'), `status back to draft was not refused ("${msg}")`);
      const q = await newDraft(db, { type: 'quote', clientId, today });
      await saveDraftLine(db, q, null, line('Angebot', 1000, 1_000_000, 1900));
      await issueDocument(db, q, clock);
      await reopenQuote(db, q); // the one allowed way back (D38)
      expect((await getDocument(db, q))?.status === 'draft', 'reopen quote failed');
      return `trigger present, user_version ${LATEST_VERSION}, reopen quote ok`;
    })
  );
  out.push(
    await probe('migrations 3 to 5 run on a database that is at version 2', async () => {
      const before = (await listDocuments(db)).length;
      await withTransaction(db, async (tx) => {
        // Undo 5 (V1.5 P1: tables, then columns; DROP COLUMN needs SQLite 3.35+), then 3 and 4.
        await tx.execAsync(
          `DROP TABLE signatures; DROP TABLE attachments;
           ${['clients ship_name', 'clients ship_street', 'clients ship_postal_code', 'clients ship_city', 'clients ship_country_code', 'catalog_items image_file', 'document_lines image_file', 'business signature']
             .map((c) => `ALTER TABLE ${c.split(' ')[0]} DROP COLUMN ${c.split(' ')[1]};`)
             .join(' ')}
           DROP TRIGGER documents_locked_status; DROP TRIGGER documents_status_moves; PRAGMA user_version = 2;`
        );
      });
      await migrate(db);
      const t = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('documents_locked_status', 'documents_status_moves')");
      const v = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      expect(t.length === 2 && v?.user_version === LATEST_VERSION, `after migrate: ${t.length}/2 triggers, user_version ${v?.user_version}`);
      expect((await listDocuments(db)).length === before, 'rows changed');
      return `v2 -> v${LATEST_VERSION}: triggers created, rows intact`;
    })
  );
  out.push(
    await probe('migration 4 trigger: raw status flip and line delete on an issued invoice refused', async () => {
      const refused = async (sql: string) => {
        try {
          await db.runAsync(sql, issued.id);
          return false;
        } catch (e) {
          return String((e as Error).message).includes('document_locked');
        }
      };
      expect(await refused("UPDATE documents SET status = 'accepted' WHERE id = ?"), "status 'accepted' on an issued invoice was not refused");
      expect(await refused('DELETE FROM document_lines WHERE document_id = ?'), 'deleting the lines of an issued invoice was not refused');
      return 'status flip and line delete refused';
    })
  );
  out.push(
    await probe('json_extract (JSON1) for the client name of a snapshot', async () => {
      const x = await db.getFirstAsync<{ v: string }>(`SELECT json_extract('{"a":{"b":"x"}}', '$.a.b') AS v`);
      expect(x?.v === 'x', `json_extract gave ${x?.v}`);
      const before = (await openInvoices(db)).find((i) => i.id === issued.id);
      expect(before?.clientName === 'Müller GmbH', `snapshot name ${before?.clientName}`);
      await updateClient(db, clientId, { name: 'Umbenannt AG' });
      const after = (await openInvoices(db)).find((i) => i.id === issued.id);
      expect(after?.clientName === 'Müller GmbH', `after renaming the client the invoice shows ${after?.clientName}`);
      return 'snapshot name survives a rename';
    })
  );
  out.push(
    await probe('Hermes: BigInt totals and Intl time zones', async () => {
      const t = computeTotals({
        lines: [{ qtyMilli: 999_999_999_999, priceE4: 9_999_999, category: 'S', rateBp: 1900, discount: { kind: 'none', value: 0 } }],
        pricesIncludeVat: false, discount: { kind: 'none', value: 0 }, payments: [],
      });
      expect(typeof t.gross === 'number' && t.gross > 0, 'BigInt path failed');
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.UTC(2026, 9, 1, 12)));
      const hour = parts.find((p) => p.type === 'hour')?.value;
      expect(hour === '14', `Berlin hour at 12:00 UTC (CEST) was ${hour}`);
      return `gross ${t.gross}, Berlin hour ${hour}`;
    })
  );
  return out;
}

/**
 * P5 device check of the D56 refusal: a draft whose line description is taller than a page gets `line_too_tall`
 * (blocking) and Issue refuses it; a 1 500-character description (the editor's cap) does not. The probe drafts are
 * deleted again (drafts leave no number gap).
 */
export async function tallRowProbe(db: Db): Promise<ProbeResult[]> {
  const today = todayLocal();
  const make = async (chars: number) => {
    const id = await newDraft(db, { type: 'invoice', today });
    await saveDraftLine(db, id, null, line('Tall', 1000, 1_000_000, 1900, { description: 'Lange Beschreibung mit Umlauten (Größe, Übergabe). '.repeat(Math.ceil(chars / 52)).slice(0, chars) }));
    return id;
  };
  const out: ProbeResult[] = [];
  out.push(
    await probe('6 000-character line is refused', async () => {
      const id = await make(6000);
      try {
        const items = await checkStoredDocument(db, id, today);
        expect(items.some((i) => i.id === 'line_too_tall' && i.severity === 'error' && i.line === 0), 'line_too_tall error on line 1 expected');
        const issued = await issueDocument(db, id, { today }).then(() => true, (e) => (e instanceof IssueBlockedError ? false : Promise.reject(e)));
        expect(!issued, 'Issue must be refused');
        expect((await getDocument(db, id))?.status === 'draft', 'still a draft');
        return 'line_too_tall, Issue refused';
      } finally {
        await deleteDocument(db, id);
      }
    })
  );
  out.push(
    await probe('1 500-character line is accepted', async () => {
      const id = await make(1500);
      try {
        const items = await checkStoredDocument(db, id, today);
        expect(!items.some((i) => i.id === 'line_too_tall' || i.id === 'text_too_tall'), 'no too-tall item expected');
        return `no too-tall item (${items.map((i) => i.id).join(', ') || 'no items'})`;
      } finally {
        await deleteDocument(db, id);
      }
    })
  );
  return out;
}
