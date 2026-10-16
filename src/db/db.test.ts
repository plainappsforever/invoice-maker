/**
 * @jest-environment node
 */
import examples from '@/engine/__fixtures__/worked-examples.json';
import type { TaxCategory } from '@/engine/totals';

import { createTestDb } from '../../test/node-sqlite-db';

import {
  addAttachment,
  AttachmentLimitError,
  deleteAttachment,
  getDocumentSignature,
  listAttachments,
  MAX_PAGE_ATTACHMENTS,
  renameAttachment,
  setAttachmentUse,
  setDocumentSignature,
} from './attachments';
import { addTaxRate, getBusiness, listTaxRates, setDefaultTaxRate, setTaxRateArchived, updateBusiness } from './business';
import { createClient, getClient, listClients, setClientArchived, updateClient } from './clients';
import { getCounter, NextNumberError, setNextValue, takeNumber } from './counters';
import {
  createDraft,
  deleteDocument,
  getDocument,
  listDocuments,
  refreshDraftTotals,
  updateDocumentState,
  updateDraft,
} from './documents';
import { addCatalogLine } from './editing';
import { createCatalogItem, listCatalogItems, setCatalogItemArchived, updateCatalogItem } from './items';
import { addLine, deleteLine, listLines, reorderLines, updateLine } from './lines';
import { LATEST_VERSION, migrate, MIGRATIONS, openDatabase } from './migrations';
import { addPayment, listPayments, PaymentNotAllowedError } from './payments';
import { getNumberPattern, getThemePreference, setNumberPattern, setThemePreference } from './settings';
import { withTransaction } from './transaction';
import { DocumentLockedError, isLockedError, type Db } from './types';

const NOW = 1_790_000_000_000;

async function freshDb() {
  const db = createTestDb();
  await openDatabase(db);
  return db;
}

/** Test stand-in for P2's issueDocument: number + status in one transaction. */
async function issue(db: Db, id: number, pattern = 'RE-{YYYY}-{NNNN}') {
  return withTransaction(db, async (db) => {
    const doc = (await getDocument(db, id))!;
    const n = await takeNumber(db, doc.type, pattern, doc.issueDate);
    await db.runAsync(
      "UPDATE documents SET status = 'issued', series = ?, number = ?, issued_at = ? WHERE id = ? AND status = 'draft'",
      n.series,
      n.number,
      NOW,
      id
    );
    return n.number;
  });
}

async function draftWithLine(db: Db, type: 'invoice' | 'quote' | 'receipt' = 'invoice', issueDate = '2026-10-01') {
  const id = await createDraft(db, { type, issueDate }, NOW);
  await addLine(db, id, { name: 'Webdesign', qtyMilli: 1000, priceE4: 850_000, taxRateBp: 1900 });
  return id;
}

describe('migrations', () => {
  it('reaches the latest version and is safe to run again', async () => {
    const db = await freshDb();
    await migrate(db);
    const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(row?.user_version).toBe(LATEST_VERSION);
    expect(LATEST_VERSION).toBe(5);
  });

  it('migration 2 drops the template demo table and creates the v1 tables', async () => {
    const db = await freshDb();
    const tables = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    const names = tables.map((t) => t.name);
    expect(names).not.toContain('items');
    for (const t of ['business', 'tax_rates', 'clients', 'catalog_items', 'documents', 'document_lines', 'payments', 'number_counters', 'settings']) {
      expect(names).toContain(t);
    }
  });

  it('upgrades a version-1 database that has template demo rows and settings', async () => {
    const db = createTestDb();
    await db.execAsync(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      INSERT INTO items (title, created_at) VALUES ('demo', 1); INSERT INTO settings VALUES ('theme', 'dark');
      PRAGMA user_version = 1;`);
    await openDatabase(db);
    expect(await getThemePreference(db)).toBe('dark');
    expect((await getBusiness(db)).countryCode).toBe('DE');
  });

  it('foreign keys are on', async () => {
    const db = await freshDb();
    expect((await db.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys'))?.foreign_keys).toBe(1);
    await expect(createDraft(db, { type: 'invoice', issueDate: '2026-10-01', clientId: 999 }, NOW)).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe('business and VAT rates', () => {
  it('starts with an empty German business profile', async () => {
    const db = await freshDb();
    expect(await getBusiness(db)).toMatchObject({ name: '', countryCode: 'DE', currency: 'EUR', language: 'de', vatMode: 'standard', paymentDays: 14, logoFile: null });
  });

  it('updates fields and refuses unknown ones', async () => {
    const db = await freshDb();
    await updateBusiness(db, { name: 'Muster Design', iban: 'DE89370400440532013000', vatMode: 'small_business' }, NOW);
    expect(await getBusiness(db)).toMatchObject({ name: 'Muster Design', vatMode: 'small_business', updatedAt: NOW });
    await expect(updateBusiness(db, { hack: 'x' } as never)).rejects.toThrow(/unknown/);
    await expect(db.runAsync("UPDATE business SET vat_mode = 'other'")).rejects.toThrow(/CHECK/);
    await expect(db.runAsync('INSERT INTO business (id, updated_at) VALUES (2, 0)')).rejects.toThrow(/CHECK/);
  });

  it('seeds the German rates 19 % (default), 7 %, 0 %', async () => {
    const db = await freshDb();
    const rates = await listTaxRates(db);
    expect(rates.map((r) => [r.label, r.rateBp, r.isDefault])).toEqual([
      ['19 %', 1900, true],
      ['7 %', 700, false],
      ['0 %', 0, false],
    ]);
  });

  it('adds, defaults and archives rates', async () => {
    const db = await freshDb();
    const id = await addTaxRate(db, '20 %', 2000);
    await setDefaultTaxRate(db, id);
    let rates = await listTaxRates(db);
    expect(rates.filter((r) => r.isDefault).map((r) => r.rateBp)).toEqual([2000]);
    expect(rates[rates.length - 1].rateBp).toBe(2000);
    await setTaxRateArchived(db, id, true);
    rates = await listTaxRates(db);
    expect(rates.map((r) => r.rateBp)).not.toContain(2000);
    expect((await listTaxRates(db, { includeArchived: true })).map((r) => r.rateBp)).toContain(2000);
    await expect(addTaxRate(db, 'bad', 10_001)).rejects.toThrow(RangeError);
  });
});

describe('clients and catalog items', () => {
  it('creates, searches, updates and archives clients', async () => {
    const db = await freshDb();
    const a = await createClient(db, { name: 'Beispiel GmbH', city: 'Berlin', vatId: 'DE123456789', buyerReference: '991-12345-67' }, NOW);
    await createClient(db, { name: 'anna Schmidt', kind: 'person', email: 'anna@example.org' }, NOW);
    expect((await listClients(db)).map((c) => c.name)).toEqual(['anna Schmidt', 'Beispiel GmbH']);
    expect((await listClients(db, { search: 'berl' })).map((c) => c.id)).toEqual([a]);
    await updateClient(db, a, { treatment: 'reverse_charge', language: 'en' }, NOW + 1);
    expect(await getClient(db, a)).toMatchObject({ treatment: 'reverse_charge', language: 'en', archived: false, updatedAt: NOW + 1 });
    await setClientArchived(db, a, true);
    expect((await listClients(db)).map((c) => c.id)).not.toContain(a);
    expect((await listClients(db, { includeArchived: true })).map((c) => c.id)).toContain(a);
    await expect(updateClient(db, a, { treatment: 'nonsense' as never })).rejects.toThrow(/CHECK/);
  });

  it('creates, searches and archives catalog items with integer prices', async () => {
    const db = await freshDb();
    const id = await createCatalogItem(db, { name: 'Druck Flyer', unitCode: 'C62', priceE4: 1234, sku: 'FLY-1' }, NOW);
    await createCatalogItem(db, { name: 'Beratung', unitCode: 'HUR', priceE4: 850_000, taxRateBp: 1900 }, NOW);
    expect((await listCatalogItems(db, { search: 'fly' })).map((i) => [i.name, i.priceE4, i.priceIncludesVat])).toEqual([['Druck Flyer', 1234, false]]);
    await updateCatalogItem(db, id, { priceIncludesVat: true });
    expect((await listCatalogItems(db, { search: 'FLY-1' }))[0].priceIncludesVat).toBe(true);
    await setCatalogItemArchived(db, id, true);
    expect((await listCatalogItems(db)).map((i) => i.name)).toEqual(['Beratung']);
  });
});

describe('documents, lines and the draft-only guard', () => {
  it('drafts have no number and keep editable fields', async () => {
    const db = await freshDb();
    const id = await createDraft(db, { type: 'invoice', issueDate: '2026-10-01', pricesIncludeVat: true, customFields: '[{"label":"PO","value":"7"}]' }, NOW);
    const doc = await getDocument(db, id);
    expect(doc).toMatchObject({ status: 'draft', number: null, series: null, pricesIncludeVat: true, currency: 'EUR', language: 'de', paper: 'A4', showGirocode: true });
    await updateDraft(db, id, { reference: 'PO 7', discountKind: 'percent', discountValue: 500 }, NOW + 1);
    expect(await getDocument(db, id)).toMatchObject({ reference: 'PO 7', discountKind: 'percent', discountValue: 500, updatedAt: NOW + 1 });
  });

  it('refuses read-only fields in a draft patch', async () => {
    const db = await freshDb();
    const id = await createDraft(db, { type: 'invoice', issueDate: '2026-10-01' }, NOW);
    await expect(updateDraft(db, id, { number: 'X' } as never)).rejects.toThrow(/read-only/);
    await expect(updateDraft(db, id, { status: 'issued' } as never)).rejects.toThrow(/read-only/);
  });

  it('adds, updates, reorders and deletes lines of a draft', async () => {
    const db = await freshDb();
    const id = await draftWithLine(db);
    const second = await addLine(db, id, { name: 'Hosting', qtyMilli: 1000, priceE4: 1_190_000, taxRateBp: 1900, unitCode: 'MON' });
    let lines = await listLines(db, id);
    expect(lines.map((l) => [l.name, l.position])).toEqual([['Webdesign', 0], ['Hosting', 1]]);
    await updateLine(db, second, { qtyMilli: 12_000 });
    await reorderLines(db, id, [second, lines[0].id]);
    lines = await listLines(db, id);
    expect(lines.map((l) => [l.name, l.qtyMilli])).toEqual([['Hosting', 12_000], ['Webdesign', 1000]]);
    await expect(reorderLines(db, id, [second])).rejects.toThrow(/do not match/);
    await deleteLine(db, second);
    expect((await listLines(db, id)).map((l) => l.name)).toEqual(['Webdesign']);
  });

  it('refreshDraftTotals reproduces worked example A from stored rows', async () => {
    const db = await freshDb();
    const a = examples.examples[0];
    const id = await createDraft(db, { type: 'invoice', issueDate: '2026-10-01', discountKind: 'percent', discountValue: 500 }, NOW);
    for (const l of a.input!.lines) {
      await addLine(db, id, {
        name: l.name, qtyMilli: l.qtyMilli, priceE4: l.priceE4, taxCategory: l.category as TaxCategory, taxRateBp: l.rateBp,
        discountKind: l.discount.kind as 'none', discountValue: l.discount.value,
      });
    }
    const totals = await refreshDraftTotals(db, id, NOW);
    expect(totals?.gross).toBe(133029);
    expect(await getDocument(db, id)).toMatchObject({ netCents: 112266, taxCents: 20763, grossCents: 133029 });
    expect((await listLines(db, id)).map((l) => l.netCents)).toEqual([95625, 11900, 4980, 5670]);
  });

  it('locks an issued invoice: fields, lines and deletion are refused (JS guard and SQLite triggers)', async () => {
    const db = await freshDb();
    const id = await draftWithLine(db);
    await issue(db, id);
    const [line] = await listLines(db, id);

    await expect(updateDraft(db, id, { notes: 'changed' })).rejects.toBeInstanceOf(DocumentLockedError);
    await expect(addLine(db, id, { name: 'x', qtyMilli: 1000, priceE4: 1, taxRateBp: 0 })).rejects.toBeInstanceOf(DocumentLockedError);
    await expect(updateLine(db, line.id, { priceE4: 1 })).rejects.toBeInstanceOf(DocumentLockedError);
    await expect(deleteLine(db, line.id)).rejects.toBeInstanceOf(DocumentLockedError);
    await expect(deleteDocument(db, id)).rejects.toBeInstanceOf(DocumentLockedError);
    await expect(refreshDraftTotals(db, id)).rejects.toBeInstanceOf(DocumentLockedError);

    // Direct SQL is stopped by the triggers too.
    for (const sql of [
      `UPDATE documents SET notes = 'x' WHERE id = ${id}`,
      `UPDATE documents SET number = 'RE-2026-0099' WHERE id = ${id}`,
      `UPDATE documents SET gross_cents = 1 WHERE id = ${id}`,
      `UPDATE document_lines SET price_e4 = 1 WHERE id = ${line.id}`,
      `INSERT INTO document_lines (document_id, position, name, qty_milli, price_e4, tax_rate_bp) VALUES (${id}, 9, 'x', 1000, 1, 0)`,
      `DELETE FROM document_lines WHERE id = ${line.id}`,
      `DELETE FROM documents WHERE id = ${id}`,
    ]) {
      const error = await db.runAsync(sql).then(() => null, (e: unknown) => e);
      expect([sql, isLockedError(error)]).toEqual([sql, true]);
    }
    expect((await getDocument(db, id))?.number).toBe('RE-2026-0001');
    expect(await listLines(db, id)).toHaveLength(1);
  });

  it('migration 3: the status of a locked document never goes back to draft, except reopening an issued quote (review #10)', async () => {
    const db = await freshDb();
    const id = await draftWithLine(db);
    await issue(db, id);
    // the review probe: status back to draft, then edit everything
    const error = await db.runAsync(`UPDATE documents SET status = 'draft' WHERE id = ${id}`).then(() => null, (e: unknown) => e);
    expect(isLockedError(error)).toBe(true);
    await expect(db.runAsync(`UPDATE documents SET gross_cents = 1, number = 'X' WHERE id = ${id}`)).rejects.toThrow(/document_locked/);
    expect(await getDocument(db, id)).toMatchObject({ status: 'issued', number: 'RE-2026-0001' });
    // cancelled, accepted/declined/invoiced quotes stay locked too
    await db.runAsync(`UPDATE documents SET status = 'cancelled' WHERE id = ${id}`);
    await expect(db.runAsync(`UPDATE documents SET status = 'draft' WHERE id = ${id}`)).rejects.toThrow(/document_locked/);
    const quote = await draftWithLine(db, 'quote');
    await issue(db, quote, 'AN-{NNNN}');
    await db.runAsync(`UPDATE documents SET status = 'draft' WHERE id = ${quote}`); // reopen (D38)
    await db.runAsync(`UPDATE documents SET status = 'issued' WHERE id = ${quote}`); // it keeps its number
    await db.runAsync(`UPDATE documents SET status = 'accepted' WHERE id = ${quote}`);
    await expect(db.runAsync(`UPDATE documents SET status = 'draft' WHERE id = ${quote}`)).rejects.toThrow(/document_locked/);
  });

  it('migration 4: raw status flips outside the transition table are refused; lines of issued invoices never deleted (review #12, D86)', async () => {
    const db = await freshDb();
    const id = await draftWithLine(db);
    await issue(db, id);
    // the review probe: status='accepted' on an issued invoice, then delete its lines, then back to issued
    await expect(db.runAsync(`UPDATE documents SET status = 'accepted' WHERE id = ${id}`)).rejects.toThrow(/document_locked/);
    await expect(db.runAsync(`DELETE FROM document_lines WHERE document_id = ${id}`)).rejects.toThrow(/document_locked/);
    expect(await listLines(db, id)).toHaveLength(1);
    // Storno is allowed, and final: a cancelled invoice never goes back to issued
    await db.runAsync(`UPDATE documents SET status = 'cancelled' WHERE id = ${id}`);
    await expect(db.runAsync(`UPDATE documents SET status = 'issued' WHERE id = ${id}`)).rejects.toThrow(/document_locked/);
    await expect(db.runAsync(`DELETE FROM document_lines WHERE document_id = ${id}`)).rejects.toThrow(/document_locked/);
    // a draft can only be issued; an issued receipt keeps its status
    const draft = await draftWithLine(db);
    await expect(db.runAsync(`UPDATE documents SET status = 'cancelled' WHERE id = ${draft}`)).rejects.toThrow(/document_locked/);
    const receipt = await draftWithLine(db, 'receipt');
    await issue(db, receipt, 'QU-{NNNN}');
    await expect(db.runAsync(`UPDATE documents SET status = 'cancelled' WHERE id = ${receipt}`)).rejects.toThrow(/document_locked/);
    // quotes: issued → accepted → invoiced → accepted (convert undone) are allowed, declined is final
    const quote = await draftWithLine(db, 'quote');
    await issue(db, quote, 'AN-{NNNN}');
    for (const to of ['accepted', 'invoiced', 'accepted']) await db.runAsync(`UPDATE documents SET status = '${to}' WHERE id = ${quote}`);
    await expect(db.runAsync(`UPDATE documents SET status = 'declined' WHERE id = ${quote}`)).rejects.toThrow(/document_locked/);
    const quote2 = await draftWithLine(db, 'quote');
    await issue(db, quote2, 'AN-{NNNN}');
    await db.runAsync(`UPDATE documents SET status = 'declined' WHERE id = ${quote2}`);
    await expect(db.runAsync(`UPDATE documents SET status = 'accepted' WHERE id = ${quote2}`)).rejects.toThrow(/document_locked/);
    // same status (e.g. "Mark as sent" writes the row) and deleting an issued quote with its lines still work
    await updateDocumentState(db, receipt, { sentAt: NOW + 1 }, NOW + 1);
    await deleteDocument(db, quote2);
    expect(await getDocument(db, quote2)).toBeNull();
  });

  it('migration 4 upgrades a version-3 database with issued documents without touching their rows', async () => {
    const db = createTestDb();
    await db.execAsync('PRAGMA foreign_keys = ON;');
    await db.execAsync(`${MIGRATIONS.slice(0, 3).join('\n')} PRAGMA user_version = 3;`);
    const id = await draftWithLine(db);
    await issue(db, id);
    const before = await getDocument(db, id);
    await openDatabase(db);
    expect((await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version).toBe(LATEST_VERSION);
    expect(await getDocument(db, id)).toEqual(before);
    await expect(db.runAsync(`UPDATE documents SET status = 'accepted' WHERE id = ${id}`)).rejects.toThrow(/document_locked/);
  });

  it('still allows status, sent/cancelled timestamps, the PDF path and payments after Issue', async () => {
    const db = await freshDb();
    const id = await draftWithLine(db);
    await issue(db, id);
    await updateDocumentState(db, id, { sentAt: NOW + 5, pdfFile: 'pdf/1-RE-2026-0001.pdf' }, NOW + 5);
    await addPayment(db, id, { date: '2026-10-05', amountCents: 30_000, method: 'bank' }, NOW + 6);
    await updateDocumentState(db, id, { status: 'cancelled', cancelledAt: NOW + 7 }, NOW + 7);
    expect(await getDocument(db, id)).toMatchObject({ status: 'cancelled', sentAt: NOW + 5, cancelledAt: NOW + 7, pdfFile: 'pdf/1-RE-2026-0001.pdf' });
    expect((await listPayments(db, id)).map((p) => p.amountCents)).toEqual([30_000]);
    await expect(updateDocumentState(db, id, { number: 'X' } as never)).rejects.toThrow(/read-only/);
  });

  it('payments only on issued invoices and receipts', async () => {
    const db = await freshDb();
    const draft = await draftWithLine(db);
    await expect(addPayment(db, draft, { date: '2026-10-05', amountCents: 100 })).rejects.toBeInstanceOf(PaymentNotAllowedError);
    const quote = await draftWithLine(db, 'quote');
    await issue(db, quote, 'AN-{YYYY}-{NNNN}');
    await expect(addPayment(db, quote, { date: '2026-10-05', amountCents: 100 })).rejects.toBeInstanceOf(PaymentNotAllowedError);
    const receipt = await draftWithLine(db, 'receipt');
    await issue(db, receipt, 'QU-{YYYY}-{NNNN}');
    await expect(addPayment(db, receipt, { date: '2026-10-05', amountCents: 0 })).rejects.toThrow(RangeError);
    await addPayment(db, receipt, { date: '2026-10-05', amountCents: 100, method: 'cash' });
    await expect(addPayment(db, receipt, { date: '2026-10-05', amountCents: 100, method: 'crypto' as never })).rejects.toThrow(/CHECK/);
  });

  it('deleting a draft or an issued quote cascades to lines and payments; issued quotes free no number', async () => {
    const db = await freshDb();
    const draft = await draftWithLine(db);
    await deleteDocument(db, draft);
    expect(await getDocument(db, draft)).toBeNull();
    expect(await listLines(db, draft)).toEqual([]);

    const quote = await draftWithLine(db, 'quote');
    await issue(db, quote, 'AN-{YYYY}-{NNNN}');
    await deleteDocument(db, quote);
    expect(await listLines(db, quote)).toEqual([]);
    const next = await draftWithLine(db, 'quote');
    expect(await issue(db, next, 'AN-{YYYY}-{NNNN}')).toBe('AN-2026-0002');
  });

  it('lists documents newest first with filters', async () => {
    const db = await freshDb();
    const client = await createClient(db, { name: 'Beispiel GmbH' }, NOW);
    await createDraft(db, { type: 'invoice', issueDate: '2026-09-01', clientId: client }, NOW);
    await createDraft(db, { type: 'quote', issueDate: '2026-10-01' }, NOW);
    await createDraft(db, { type: 'invoice', issueDate: '2026-10-02' }, NOW);
    expect((await listDocuments(db)).map((d) => d.issueDate)).toEqual(['2026-10-02', '2026-10-01', '2026-09-01']);
    expect((await listDocuments(db, { type: 'invoice' })).length).toBe(2);
    expect((await listDocuments(db, { clientId: client })).length).toBe(1);
    expect((await listDocuments(db, { status: 'issued' })).length).toBe(0);
  });
});

describe('numbering (SPEC §5 numbering examples, D17)', () => {
  it('first invoice RE-2026-0001; a deleted draft leaves no gap; next RE-2026-0002', async () => {
    const db = await freshDb();
    const first = await draftWithLine(db);
    const deleted = await draftWithLine(db); // created before the first is issued
    expect(await issue(db, first)).toBe('RE-2026-0001');
    await deleteDocument(db, deleted);
    const second = await draftWithLine(db);
    expect(await issue(db, second)).toBe('RE-2026-0002');
  });

  it('a new year starts a new counter: first invoice of 2027-01-02 is RE-2027-0001', async () => {
    const db = await freshDb();
    await issue(db, await draftWithLine(db));
    await issue(db, await draftWithLine(db, 'invoice', '2027-01-02')).then((n) => expect(n).toBe('RE-2027-0001'));
    await issue(db, await draftWithLine(db, 'invoice', '2026-12-31')).then((n) => expect(n).toBe('RE-2026-0002'));
  });

  it('each type has its own series; cancellations share the invoice series', async () => {
    const db = await freshDb();
    expect(await issue(db, await draftWithLine(db))).toBe('RE-2026-0001');
    expect(await issue(db, await draftWithLine(db, 'quote'), 'AN-{YYYY}-{NNNN}')).toBe('AN-2026-0001');
    expect(await issue(db, await draftWithLine(db, 'receipt'), 'QU-{YYYY}-{NNNN}')).toBe('QU-2026-0001');
    const cancellation = await createDraft(db, { type: 'cancellation', issueDate: '2026-10-01', sourceId: 1 }, NOW);
    await addLine(db, cancellation, { name: 'Webdesign', qtyMilli: -1000, priceE4: 850_000, taxRateBp: 1900 });
    expect(await issue(db, cancellation)).toBe('RE-2026-0002');
    expect(await getDocument(db, cancellation)).toMatchObject({ series: 'invoice', sourceId: 1 });
  });

  it('next number raised to 43 gives RE-2026-0043; lowering to 40 after 42 was used is refused', async () => {
    const db = await freshDb();
    await issue(db, await draftWithLine(db));
    await setNextValue(db, 'invoice:2026', 43);
    expect(await issue(db, await draftWithLine(db))).toBe('RE-2026-0043');
    await expect(setNextValue(db, 'invoice:2026', 40)).rejects.toBeInstanceOf(NextNumberError);
    await expect(setNextValue(db, 'invoice:2026', 43)).rejects.toBeInstanceOf(NextNumberError);
    expect(await getCounter(db, 'invoice:2026')).toEqual({ seriesKey: 'invoice:2026', nextValue: 44, maxUsed: 43 });
  });

  it('a mistaken raise can be lowered again while the values are unused', async () => {
    const db = await freshDb();
    await issue(db, await draftWithLine(db));
    await setNextValue(db, 'invoice:2026', 500);
    await setNextValue(db, 'invoice:2026', 2);
    expect(await issue(db, await draftWithLine(db))).toBe('RE-2026-0002');
  });

  it('{NNNNN} without a year is one continuous counter across years', async () => {
    const db = await freshDb();
    expect(await issue(db, await draftWithLine(db), '{NNNNN}')).toBe('00001');
    expect(await issue(db, await draftWithLine(db, 'invoice', '2027-01-02'), '{NNNNN}')).toBe('00002');
  });

  it('the same number can never be stored twice in one series (UNIQUE); other series may repeat the text', async () => {
    const db = await freshDb();
    expect(await issue(db, await draftWithLine(db), '{NNNN}')).toBe('0001');
    const other = await draftWithLine(db);
    await expect(
      db.runAsync("UPDATE documents SET status = 'issued', series = 'invoice', number = '0001' WHERE id = ?", other)
    ).rejects.toThrow(/UNIQUE/);
    expect(await issue(db, await draftWithLine(db, 'quote'), '{NNNN}')).toBe('0001');
  });

  it('a failed Issue rolls back the counter (no number consumed)', async () => {
    const db = await freshDb();
    const id = await draftWithLine(db);
    await expect(
      withTransaction(db, async (db) => {
        await takeNumber(db, 'invoice', 'RE-{YYYY}-{NNNN}', '2026-10-01');
        throw new Error('render failed');
      })
    ).rejects.toThrow('render failed');
    expect(await getCounter(db, 'invoice:2026')).toEqual({ seriesKey: 'invoice:2026', nextValue: 1, maxUsed: 0 });
    expect(await issue(db, id)).toBe('RE-2026-0001');
  });

  it('number patterns: stored per series, validated, default by language', async () => {
    const db = await freshDb();
    expect(await getNumberPattern(db, 'invoice', 'de')).toBe('RE-{YYYY}-{NNNN}');
    expect(await getNumberPattern(db, 'invoice', 'en')).toBe('INV-{YYYY}-{NNNN}');
    await setNumberPattern(db, 'quote', 'A{YY}-{NNN}');
    expect(await getNumberPattern(db, 'quote', 'de')).toBe('A{YY}-{NNN}');
    await expect(setNumberPattern(db, 'quote', 'no counter')).rejects.toThrow(/invalid_pattern/);
  });
});

describe('theme preference', () => {
  it('defaults to system, persists changes, and ignores invalid stored values', async () => {
    const db = await freshDb();
    expect(await getThemePreference(db)).toBe('system');

    await setThemePreference(db, 'dark');
    expect(await getThemePreference(db)).toBe('dark');

    await db.runAsync("UPDATE settings SET value = 'purple' WHERE key = 'theme'");
    expect(await getThemePreference(db)).toBe('system');
  });
});

describe('input limits (P3.5 nice-to-haves, review #14 and #17)', () => {
  it('refreshDraftTotals returns null instead of throwing when amounts leave the engine range', async () => {
    const db = await freshDb();
    const id = await draftWithLine(db);
    const before = (await refreshDraftTotals(db, id, NOW))!.gross;
    await addLine(db, id, { name: 'huge', qtyMilli: 999_999_999_999, priceE4: 9_999_999_999_999, taxRateBp: 1900 });
    expect(await refreshDraftTotals(db, id, NOW)).toBeNull();
    expect((await getDocument(db, id))!.grossCents).toBe(before); // the cache stays as it was
  });

  it('a payment needs a real date', async () => {
    const db = await freshDb();
    const id = await draftWithLine(db);
    await issue(db, id);
    await expect(addPayment(db, id, { date: 'gestern', amountCents: 100 })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(addPayment(db, id, { date: '2026-02-30', amountCents: 100 })).rejects.toThrow(/YYYY-MM-DD/);
    expect(await addPayment(db, id, { date: '2026-10-05', amountCents: 100 })).toBeGreaterThan(0);
  });
});

describe('migration 5 (V1.5 P1): shipping address, photos, signatures, attachments', () => {
  it('upgrades a version-4 database with issued documents; old rows get empty defaults', async () => {
    const db = createTestDb();
    await db.execAsync('PRAGMA foreign_keys = ON;');
    await db.execAsync(`${MIGRATIONS.slice(0, 4).join('\n')} PRAGMA user_version = 4;`);
    const client = await db.runAsync("INSERT INTO clients (name, created_at, updated_at) VALUES ('Alt GmbH', 1, 1)");
    await db.runAsync("INSERT INTO catalog_items (name, created_at, updated_at) VALUES ('Alt', 1, 1)");
    const id = await createDraft(db, { type: 'invoice', issueDate: '2026-10-01' }, NOW);
    await db.runAsync('INSERT INTO document_lines (document_id, position, name, qty_milli, price_e4, tax_rate_bp) VALUES (?, 0, ?, 1000, 10000, 1900)', id, 'X');
    await issue(db, id);
    const before = await db.getFirstAsync('SELECT * FROM documents WHERE id = ?', id);
    await openDatabase(db);
    expect((await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version).toBe(LATEST_VERSION);
    expect(await db.getFirstAsync('SELECT * FROM documents WHERE id = ?', id)).toEqual(before);
    expect(await getClient(db, client.lastInsertRowId)).toEqual(expect.objectContaining({ shipName: '', shipStreet: '', shipPostalCode: '', shipCity: '', shipCountryCode: '' }));
    expect((await listCatalogItems(db))[0].imageFile).toBeNull();
    expect((await listLines(db, id))[0].imageFile).toBeNull();
    expect((await getBusiness(db)).signature).toBeNull();
    expect(await db.getAllAsync('SELECT * FROM attachments')).toEqual([]);
  });

  it('client shipping address and business signature are stored', async () => {
    const db = await freshDb();
    const c = await createClient(db, { name: 'Ship AG', shipName: 'Lager Nord', shipStreet: 'Hafen 1', shipPostalCode: '20457', shipCity: 'Hamburg', shipCountryCode: 'DE' }, NOW);
    expect(await getClient(db, c)).toEqual(expect.objectContaining({ shipName: 'Lager Nord', shipCity: 'Hamburg' }));
    await updateBusiness(db, { signature: '{"v":1,"w":10,"h":10,"d":"M1 1 L2 2"}' }, NOW);
    expect((await getBusiness(db)).signature).toContain('M1 1');
  });

  it('a catalog line copies the item photo; issued lines keep it locked', async () => {
    const db = await freshDb();
    const item = await createCatalogItem(db, { name: 'Stuhl', priceE4: 500_000, taxRateBp: 1900, imageFile: 'items/a.jpg' }, NOW);
    const id = await createDraft(db, { type: 'invoice', issueDate: '2026-10-01' }, NOW);
    const lineId = await addCatalogLine(db, id, item);
    expect((await listLines(db, id))[0]).toEqual(expect.objectContaining({ id: lineId, imageFile: 'items/a.jpg' }));
    await issue(db, id);
    await expect(db.runAsync('UPDATE document_lines SET image_file = NULL WHERE id = ?', lineId)).rejects.toThrow(/document_locked/);
  });

  it('attachments: limits, defaults, and printed pages of an issued document are locked (triggers)', async () => {
    const db = await freshDb();
    const id = await draftWithLine(db);
    const page = await addAttachment(db, id, { file: 'attachments/p.jpg', mime: 'image/jpeg', bytes: 1000, width: 800, height: 600 }, NOW);
    const pdf = await addAttachment(db, id, { file: 'attachments/x.pdf', mime: 'application/pdf', bytes: 2000, name: 'Lieferschein.pdf' }, NOW);
    expect((await listAttachments(db, id)).map((a) => [a.id, a.use, a.position])).toEqual([[page, 'page', 0], [pdf, 'mail', 1]]);
    await expect(setAttachmentUse(db, pdf, 'page')).rejects.toBeInstanceOf(AttachmentLimitError);
    await expect(db.runAsync("INSERT INTO attachments (document_id, file, mime, bytes, use, created_at) VALUES (?, 'a.pdf', 'application/pdf', 1, 'page', 1)", id)).rejects.toThrow(/CHECK/);
    await expect(addAttachment(db, id, { file: 'big.jpg', mime: 'image/jpeg', bytes: 16 * 1024 * 1024 })).rejects.toBeInstanceOf(AttachmentLimitError);
    for (let i = 1; i < MAX_PAGE_ATTACHMENTS; i++) await addAttachment(db, id, { file: `attachments/${i}.jpg`, mime: 'image/jpeg', bytes: 1 }, NOW);
    await expect(addAttachment(db, id, { file: 'attachments/13.jpg', mime: 'image/jpeg', bytes: 1, use: 'page' })).rejects.toThrow(/pages/);
    // Issue: the printed pages are now part of the PDF.
    await issue(db, id);
    await expect(deleteAttachment(db, page)).rejects.toThrow(/document_locked/);
    await expect(setAttachmentUse(db, page, 'keep')).rejects.toThrow(/document_locked/);
    await expect(db.runAsync("UPDATE attachments SET file = 'other.jpg' WHERE id = ?", page)).rejects.toThrow(/document_locked/);
    await expect(db.runAsync("INSERT INTO attachments (document_id, file, mime, bytes, use, created_at) VALUES (?, 'n.jpg', 'image/jpeg', 1, 'page', 1)", id)).rejects.toThrow(/document_locked/);
    await renameAttachment(db, page, 'Quittung'); // the label is not printed: allowed
    expect(await deleteAttachment(db, pdf)).toBe('attachments/x.pdf'); // not printed: allowed
    // A receipt photo can still be kept with the issued invoice, as an e-mail file or just kept.
    const later = await addAttachment(db, id, { file: 'attachments/later.jpg', mime: 'image/jpeg', bytes: 5 }, NOW);
    expect((await listAttachments(db, id)).find((a) => a.id === later)?.use).toBe('mail');
  });

  it('deleting a draft or an issued quote removes its attachments and signature (cascade passes the triggers)', async () => {
    const db = await freshDb();
    const quote = await draftWithLine(db, 'quote');
    await addAttachment(db, quote, { file: 'attachments/q.jpg', mime: 'image/jpeg', bytes: 1 }, NOW);
    await expect(setDocumentSignature(db, quote, 'Eva', '{}', NOW)).rejects.toThrow(/signature_not_allowed/);
    await issue(db, quote, 'AN-{YYYY}-{NNNN}');
    await setDocumentSignature(db, quote, 'Eva Klein', '{"v":1}', NOW);
    await setDocumentSignature(db, quote, 'Eva Klein', '{"v":1,"x":2}', NOW + 1);
    expect(await getDocumentSignature(db, quote)).toEqual({ documentId: quote, signer: 'Eva Klein', data: '{"v":1,"x":2}', signedAt: NOW + 1 });
    await deleteDocument(db, quote);
    expect(await db.getAllAsync('SELECT * FROM attachments')).toEqual([]);
    expect(await db.getAllAsync('SELECT * FROM signatures')).toEqual([]);
    const invoice = await draftWithLine(db);
    await expect(setDocumentSignature(db, invoice, 'X', '{}', NOW)).rejects.toThrow(/signature_not_allowed/);
  });
});

describe('accept with signature (V1.5 P1)', () => {
  it('accepts and stores the signature in one transaction; reopening or declining removes it', async () => {
    const { acceptQuoteSigned, reopenQuote, declineQuote } = jest.requireActual('./lifecycle') as typeof import('./lifecycle');
    const db = await freshDb();
    const quote = await draftWithLine(db, 'quote');
    await issue(db, quote, 'AN-{YYYY}-{NNNN}');
    await acceptQuoteSigned(db, quote, 'Eva Klein', '{"v":1,"w":9,"h":9,"d":"M1 1 L2 2"}', NOW);
    expect((await getDocument(db, quote))?.status).toBe('accepted');
    expect((await getDocumentSignature(db, quote))?.signer).toBe('Eva Klein');
    // A draft quote cannot be signed, and nothing is half-written.
    const draft = await draftWithLine(db, 'quote');
    await expect(acceptQuoteSigned(db, draft, 'X', '{}', NOW)).rejects.toThrow();
    expect(await getDocumentSignature(db, draft)).toBeNull();
    expect((await getDocument(db, draft))?.status).toBe('draft');
    const q2 = await draftWithLine(db, 'quote');
    await issue(db, q2, 'AN-{YYYY}-{NNNN}');
    await setDocumentSignature(db, q2, 'Y', '{}', NOW);
    await reopenQuote(db, q2, NOW);
    expect(await getDocumentSignature(db, q2)).toBeNull();
    const q3 = await draftWithLine(db, 'quote');
    await issue(db, q3, 'AN-{YYYY}-{NNNN}');
    await setDocumentSignature(db, q3, 'Z', '{}', NOW);
    await declineQuote(db, q3, NOW);
    expect(await getDocumentSignature(db, q3)).toBeNull();
  });
});
