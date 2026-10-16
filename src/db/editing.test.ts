/**
 * @jest-environment node
 */
// Draft editing rules of the UI (P4): client defaults, treatment/§19 conversion of drafts only, catalog lines,
// the Documents list query, the fixtures and the same probes the debug screen runs on the device.
import { createTestDb } from '../../test/node-sqlite-db';

import { getBusiness, updateBusiness } from './business';
import { createClient } from './clients';
import { FIXTURES, resetAll, runProbes, seedFixture } from './debug';
import { getDocument, listDocuments, totalsInputFor } from './documents';
import { addCatalogLine, moveDraftLine, patchDraft, saveDraftLine, setDraftClient, setDraftTreatment, setVatMode } from './editing';
import { createCatalogItem } from './items';
import { issueDocument, newDraft } from './lifecycle';
import { listDocumentRows, TAB_TYPES } from './list';
import { listLines } from './lines';
import { openDatabase } from './migrations';
import { setSetting } from './settings';
import { computeTotals } from '@/engine/totals';
import { defaultLegalNote } from '@/engine/notes';
import type { Db } from './types';

const TODAY = '2026-10-01';
const clock = { today: TODAY, now: 1_790_000_000_000 };

async function setup() {
  const db = createTestDb();
  await openDatabase(db);
  await updateBusiness(db, { name: 'Muster Design', street: 'Musterstr. 1', postalCode: '10115', city: 'Berlin', taxNumber: '12/345/67890' });
  return db;
}

const form = (name: string, rateBp = 1900) => ({
  name, description: '', qtyMilli: 1000, unitCode: 'C62', priceE4: 1_000_000, rateBp, discountKind: 'none' as const, discountValue: 0,
});

const total = async (db: Db, id: number) => computeTotals(await totalsInputFor(db, id));

describe('fixtures and probes', () => {
  it('Example A and B fixtures give 1.330,29 and 75,97 through the editing functions', async () => {
    const db = await setup();
    await seedFixture(db, 'examples');
    const drafts = await listDocuments(db, { status: 'draft' });
    expect(drafts.map((d) => d.grossCents).sort((a, b) => a - b)).toEqual([7_597, 133_029]);
    const a = drafts.find((d) => d.grossCents === 133_029)!;
    expect(await total(db, a.id)).toMatchObject({ net: 112_266, tax: 20_763, gross: 133_029 });
  });

  it('every fixture seeds on a clean database and reset empties it again', async () => {
    const db = await setup();
    for (const f of FIXTURES) {
      await resetAll(db);
      await seedFixture(db, f);
    }
    await resetAll(db);
    expect(await listDocuments(db)).toEqual([]);
    expect((await getBusiness(db)).name).toBe('');
    // triggers survived the reset: an issued document is still locked afterwards
    await seedFixture(db, 'issued');
    const [issued] = await listDocuments(db, { status: 'issued' });
    await expect(db.runAsync("UPDATE documents SET notes = 'x' WHERE id = ?", issued.id)).rejects.toThrow(/document_locked/);
  });

  it('all on-device probes pass on the Node fake too', async () => {
    const db = await setup();
    const results = await runProbes(db);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.length).toBe(11); // = "PROBES 11/11 ok" in the p35-probes flow
  });
});

describe('client and treatment', () => {
  it('choosing a client copies language, currency, payment days, treatment and note; lines follow the treatment', async () => {
    const db = await setup();
    const eu = await createClient(db, { name: 'Acme BV', countryCode: 'NL', vatId: 'NL123456789B01', language: 'en', currency: 'USD', paymentDays: 30, treatment: 'reverse_charge', buyerReference: 'PO-9' });
    const id = await newDraft(db, { type: 'invoice', today: TODAY });
    await saveDraftLine(db, id, null, form('Consulting'));
    await setDraftClient(db, id, eu);
    const doc = (await getDocument(db, id))!;
    expect(doc).toMatchObject({ clientId: eu, language: 'en', currency: 'USD', paymentDays: 30, treatment: 'reverse_charge', buyerReference: 'PO-9' });
    expect(doc.legalNote).toBe(defaultLegalNote('reverse_charge', 'standard', 'en'));
    const [line] = await listLines(db, id);
    expect(line).toMatchObject({ taxCategory: 'AE', taxRateBp: 0 });
    expect(doc.grossCents).toBe(doc.netCents);
    // back to standard: the line gets the default 19 % and the stock note is dropped
    await setDraftTreatment(db, id, 'standard');
    expect((await listLines(db, id))[0]).toMatchObject({ taxCategory: 'S', taxRateBp: 1900 });
    expect((await getDocument(db, id))!.legalNote).toBe('');
  });

  it('a legal note the user edited is never replaced', async () => {
    const db = await setup();
    const id = await newDraft(db, { type: 'invoice', today: TODAY });
    await setDraftTreatment(db, id, 'export');
    await patchDraft(db, id, { legalNote: 'Mein eigener Text' });
    await setDraftTreatment(db, id, 'exempt');
    expect((await getDocument(db, id))!.legalNote).toBe('Mein eigener Text');
  });

  it('clearing the client returns to the business defaults', async () => {
    const db = await setup();
    const c = await createClient(db, { name: 'X', language: 'en', currency: 'CHF' });
    const id = await newDraft(db, { type: 'invoice', clientId: c, today: TODAY });
    await setDraftClient(db, id, null);
    expect(await getDocument(db, id)).toMatchObject({ clientId: null, language: 'de', currency: 'EUR' });
  });
});

describe('§19 switch (SPEC §10)', () => {
  it('converts drafts only; issued documents keep their VAT; switching back restores normal lines', async () => {
    const db = await setup();
    const issuedId = await newDraft(db, { type: 'invoice', today: TODAY });
    await saveDraftLine(db, issuedId, null, form('Alt'));
    await issueDocument(db, issuedId, clock);
    const draftId = await newDraft(db, { type: 'invoice', today: TODAY });
    await saveDraftLine(db, draftId, null, form('Neu'));
    await setVatMode(db, 'small_business');
    expect((await listLines(db, draftId))[0]).toMatchObject({ taxCategory: 'E', taxRateBp: 0 });
    expect((await getDocument(db, draftId))!.legalNote).toBe(defaultLegalNote('standard', 'small_business', 'de'));
    expect((await getDocument(db, draftId))!.grossCents).toBe(10_000);
    expect((await listLines(db, issuedId))[0]).toMatchObject({ taxCategory: 'S', taxRateBp: 1900 });
    expect((await getDocument(db, issuedId))!.grossCents).toBe(11_900);
    // a line added in §19 mode carries no VAT whatever rate the form says
    await saveDraftLine(db, draftId, null, form('Mehr', 1900));
    expect((await listLines(db, draftId))[1]).toMatchObject({ taxCategory: 'E', taxRateBp: 0 });
    await setVatMode(db, 'standard');
    expect((await listLines(db, draftId)).map((l) => [l.taxCategory, l.taxRateBp])).toEqual([['S', 1900], ['S', 1900]]);
    expect((await getDocument(db, draftId))!.legalNote).toBe('');
  });
});

describe('lines', () => {
  it('catalog items are added at quantity 1; the price follows the document gross/net mode', async () => {
    const db = await setup();
    const item = await createCatalogItem(db, { name: 'Brutto-Ding', priceE4: 1_190_000, priceIncludesVat: true, taxRateBp: 1900 });
    const net = await newDraft(db, { type: 'invoice', today: TODAY });
    await addCatalogLine(db, net, item);
    expect((await listLines(db, net))[0]).toMatchObject({ name: 'Brutto-Ding', qtyMilli: 1000, priceE4: 1_000_000, catalogItemId: item });
    const gross = await newDraft(db, { type: 'invoice', today: TODAY });
    await patchDraft(db, gross, { pricesIncludeVat: true });
    await addCatalogLine(db, gross, item);
    expect((await listLines(db, gross))[0].priceE4).toBe(1_190_000);
    expect((await getDocument(db, gross))!.grossCents).toBe(11_900);
  });

  it('lines move up and down and totals stay right', async () => {
    const db = await setup();
    const id = await newDraft(db, { type: 'invoice', today: TODAY });
    const a = await saveDraftLine(db, id, null, form('A'));
    await saveDraftLine(db, id, null, form('B'));
    await moveDraftLine(db, id, a, 1);
    expect((await listLines(db, id)).map((l) => l.name)).toEqual(['B', 'A']);
    await moveDraftLine(db, id, a, 1); // already last: nothing happens
    expect((await listLines(db, id)).map((l) => l.name)).toEqual(['B', 'A']);
    expect((await getDocument(db, id))!.netCents).toBe(20_000);
  });

  it('a discount patch refreshes the cached totals', async () => {
    const db = await setup();
    const id = await newDraft(db, { type: 'invoice', today: TODAY });
    await saveDraftLine(db, id, null, form('A'));
    await patchDraft(db, id, { discountKind: 'percent', discountValue: 1000 });
    expect((await getDocument(db, id))!.grossCents).toBe(10_710);
  });
});

describe('Documents list rows', () => {
  it('lists by tab with the snapshot client name, derived status, drafts first, and searches', async () => {
    const db = await setup();
    const c = await createClient(db, { name: 'Müller GmbH' });
    const inv = await newDraft(db, { type: 'invoice', clientId: c, today: TODAY });
    await saveDraftLine(db, inv, null, form('Webdesign'));
    await issueDocument(db, inv, clock);
    await newDraft(db, { type: 'invoice', today: TODAY });
    await newDraft(db, { type: 'quote', clientId: c, today: TODAY });
    const rows = await listDocumentRows(db, TAB_TYPES.invoices, TODAY);
    expect(rows.map((r) => [r.status, r.number, r.clientName, r.derived.status])).toEqual([
      ['draft', null, '', 'draft'],
      ['issued', 'RE-2026-0001', 'Müller GmbH', 'issued'],
    ]);
    expect((await listDocumentRows(db, TAB_TYPES.quotes, TODAY)).length).toBe(1);
    expect((await listDocumentRows(db, TAB_TYPES.invoices, TODAY, 'müll')).length).toBe(1);
    expect((await listDocumentRows(db, TAB_TYPES.invoices, TODAY, '0001')).length).toBe(1);
    expect((await listDocumentRows(db, TAB_TYPES.invoices, TODAY, '100%_')).length).toBe(0); // LIKE wildcards are escaped
    await setSetting(db, 'x', 'y');
    // a 2026-09 invoice is overdue on 2026-10-01 (14 days default → due 2026-09-15)
    const old = await newDraft(db, { type: 'invoice', clientId: c, today: '2026-09-01' });
    await saveDraftLine(db, old, null, form('Alt'));
    await issueDocument(db, old, { today: '2026-09-01' });
    const overdue = (await listDocumentRows(db, TAB_TYPES.invoices, TODAY)).find((r) => r.id === old)!;
    expect(overdue.derived).toMatchObject({ status: 'overdue', overdue: true });
  });
});
