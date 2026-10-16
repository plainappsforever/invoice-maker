/**
 * @jest-environment node
 */
import examples from '@/engine/__fixtures__/worked-examples.json';
import { LEGAL_NOTES, RETENTION_NOTE } from '@/engine/notes';
import { InvalidTransitionError } from '@/engine/status';
import type { TaxCategory } from '@/engine/totals';
import { plan } from '@/lib/reminder-plan';
import type { RenderModel } from '@/render/model';

import { createTestDb } from '../../test/node-sqlite-db';

import { updateBusiness } from './business';
import { createClient, updateClient } from './clients';
import { getCounter, setNextValue } from './counters';
import { createDraft, deleteDocument, getDocument, listDocuments, updateDocumentState, updateDraft } from './documents';
import {
  acceptQuote,
  cancelInvoice,
  checkStoredDocument,
  convertQuote,
  createPaymentReceipt,
  declineQuote,
  documentStatus,
  duplicateDocument,
  issueDocument,
  IssueBlockedError,
  markSent,
  newDraft,
  PaymentReceiptFullError,
  renderModelFor,
  reopenQuote,
  RETENTION_NOTE_SETTING,
} from './lifecycle';
import { addLine, listLines, updateLine } from './lines';
import { openDatabase } from './migrations';
import { addPayment, PaymentNotAllowedError } from './payments';
import { setNumberPattern, setSetting } from './settings';
import { homeSummary, openInvoices } from './summary';
import { DocumentLockedError, isLockedError, type Db } from './types';

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

/** 3 × 85,00 € at 19 % = 255,00 net, 48,45 VAT, 303,45 gross. */
async function invoiceDraft(db: Db, clientId: number | null, over: { today?: string } = {}) {
  const id = await newDraft(db, { type: 'invoice', clientId, today: over.today ?? TODAY, now: NOW });
  await addLine(db, id, { name: 'Webdesign', qtyMilli: 3000, priceE4: 850_000, taxRateBp: 1900, unitCode: 'HUR' });
  return id;
}

async function issuedInvoice(db: Db, clientId: number | null) {
  const id = await invoiceDraft(db, clientId);
  await issueDocument(db, id, clock);
  return id;
}

describe('Issue (D17, D20, D34)', () => {
  it('assigns the next number, due date, totals and a snapshot in one step', async () => {
    const { db, clientId } = await setup();
    const id = await invoiceDraft(db, clientId);
    expect(await getDocument(db, id)).toMatchObject({ status: 'draft', number: null, paymentDays: 14, dueDate: null });
    const result = await issueDocument(db, id, clock);
    expect(result).toEqual({ number: 'RE-2026-0001', series: 'invoice' });
    const doc = (await getDocument(db, id))!;
    expect(doc).toMatchObject({
      status: 'issued', series: 'invoice', number: 'RE-2026-0001', dueDate: '2026-10-15', issuedAt: NOW,
      netCents: 25_500, taxCents: 4_845, grossCents: 30_345,
    });
    expect((await listLines(db, id))[0].netCents).toBe(25_500);
    const model = JSON.parse(doc.snapshot!) as RenderModel;
    expect(model).toMatchObject({
      modelVersion: 2, type: 'invoice', number: 'RE-2026-0001', issueDate: TODAY, dueDate: '2026-10-15', language: 'de',
      business: { name: 'Muster Design', city: 'Berlin', vatMode: 'standard' },
      client: { name: 'Kunde GmbH', city: 'Hamburg' },
      totals: { net: 25_500, tax: 4_845, gross: 30_345 },
      legalSources: [],
    });
    expect(model.lines).toEqual([expect.objectContaining({ position: 1, name: 'Webdesign', unitCode: 'HUR', base: 25_500, net: 25_500 })]);
    expect(await getCounter(db, 'invoice:2026')).toMatchObject({ nextValue: 2, maxUsed: 1 });
  });

  it('the snapshot never changes: later business/client edits do not reach an issued invoice', async () => {
    const { db, clientId } = await setup();
    const id = await issuedInvoice(db, clientId);
    await updateBusiness(db, { name: 'Neuer Name', city: 'München' }, NOW + 1);
    await updateClient(db, clientId, { name: 'Umbenannt AG' }, NOW + 1);
    const model = await renderModelFor(db, id);
    expect(model.business.name).toBe('Muster Design');
    expect(model.client?.name).toBe('Kunde GmbH');
    const error = await db.runAsync(`UPDATE documents SET snapshot = '{}' WHERE id = ${id}`).then(() => null, (e: unknown) => e);
    expect(isLockedError(error)).toBe(true);
    // A draft is rendered from live rows.
    const draft = await invoiceDraft(db, clientId);
    expect((await renderModelFor(db, draft)).business.name).toBe('Neuer Name');
    expect((await renderModelFor(db, draft)).number).toBeNull();
  });

  it('an issued invoice is never edited: fields, lines, re-issue and status jumps are refused', async () => {
    const { db, clientId } = await setup();
    const id = await issuedInvoice(db, clientId);
    const [line] = await listLines(db, id);
    await expect(updateDraft(db, id, { notes: 'x' })).rejects.toBeInstanceOf(DocumentLockedError);
    await expect(updateLine(db, line.id, { qtyMilli: 1 })).rejects.toBeInstanceOf(DocumentLockedError);
    await expect(issueDocument(db, id, clock)).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(updateDocumentState(db, id, { status: 'draft' })).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(updateDocumentState(db, id, { status: 'accepted' })).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(deleteDocument(db, id)).rejects.toBeInstanceOf(DocumentLockedError);
    expect(await getCounter(db, 'invoice:2026')).toMatchObject({ nextValue: 2 });
  });

  it('a draft cannot become issued by a plain status update (it needs a number)', async () => {
    const { db, clientId } = await setup();
    const id = await invoiceDraft(db, clientId);
    await expect(updateDocumentState(db, id, { status: 'issued' })).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('hard errors block Issue and roll the counter back; warnings never block', async () => {
    const { db } = await setup();
    const empty = await newDraft(db, { type: 'invoice', today: TODAY, now: NOW });
    const blocked = await issueDocument(db, empty, clock).then(() => null, (e: unknown) => e);
    expect(blocked).toBeInstanceOf(IssueBlockedError);
    expect((blocked as IssueBlockedError).items.map((i) => i.id)).toEqual(['no_lines']);
    expect((await getDocument(db, empty))?.status).toBe('draft');
    expect(await getCounter(db, 'invoice:2026')).toMatchObject({ nextValue: 1, maxUsed: 0 });

    // No client, no business details: the check lists them, Issue still works (D21, SPEC §10).
    await updateBusiness(db, { name: '', street: '', taxNumber: '' }, NOW);
    const id = await invoiceDraft(db, null);
    expect((await checkStoredDocument(db, id, TODAY)).map((i) => i.id)).toEqual(['business_name', 'business_address', 'business_tax_id', 'client_missing']);
    expect((await issueDocument(db, id, clock)).number).toBe('RE-2026-0001');
  });

  it('uses the issue date year, the business language pattern and a custom pattern', async () => {
    const { db, clientId } = await setup();
    const next = await invoiceDraft(db, clientId, { today: '2027-01-02' });
    expect((await issueDocument(db, next, { today: '2027-01-02', now: NOW })).number).toBe('RE-2027-0001');
    await updateBusiness(db, { language: 'en' }, NOW);
    expect((await issueDocument(db, await invoiceDraft(db, clientId), clock)).number).toBe('INV-2026-0001');
    await setNumberPattern(db, 'invoice', '{YY}{MM}-{NNN}');
    expect((await issueDocument(db, await invoiceDraft(db, clientId), clock)).number).toBe('2610-002');
  });

  it('a pattern change that formats existing numbers again skips them: Issue never blocks (D53, review #4)', async () => {
    const { db, clientId } = await setup();
    await issuedInvoice(db, clientId); // RE-2026-0001 via counter invoice:2026
    // A pattern without a year token has its own counter ('invoice') and formats the same text again.
    await setNumberPattern(db, 'invoice', 'RE-2026-{NNNN}');
    expect((await issueDocument(db, await invoiceDraft(db, clientId), clock)).number).toBe('RE-2026-0002');
    expect(await getCounter(db, 'invoice')).toMatchObject({ nextValue: 3, maxUsed: 2 });

    const db2 = (await setup()).db; // the review probe: three invoices, then the literal-year pattern
    for (let i = 0; i < 3; i++) await issuedInvoice(db2, clientId); // 0001–0003
    await setNumberPattern(db2, 'invoice', 'RE-2026-{NNNN}');
    const id = await invoiceDraft(db2, clientId);
    expect(await issueDocument(db2, id, clock)).toEqual({ number: 'RE-2026-0004', series: 'invoice' });
    expect(await getCounter(db2, 'invoice')).toMatchObject({ nextValue: 5, maxUsed: 4 });
    const numbers = (await listDocuments(db2, { type: 'invoice' })).map((d) => d.number).sort();
    expect(numbers).toEqual(['RE-2026-0001', 'RE-2026-0002', 'RE-2026-0003', 'RE-2026-0004']); // no gap, no duplicate
    // a blocked Issue takes no number on either counter
    const empty = await newDraft(db2, { type: 'invoice', clientId, ...clock });
    await setNumberPattern(db2, 'invoice', 'RE-{YYYY}-{NNNN}');
    await expect(issueDocument(db2, empty, clock)).rejects.toBeInstanceOf(IssueBlockedError);
    expect(await getCounter(db2, 'invoice:2026')).toMatchObject({ nextValue: 4, maxUsed: 3 });
  });
});

describe('a stale draft is issued with today\'s date (P3.5 F5, D54, review #5; v1.1 D82)', () => {
  it('review probe: draft of 30.12.2026, RE-2027-0001 on 02.01., old draft issued 05.01. → RE-2027-0002 dated 05.01.2027', async () => {
    const { db, clientId } = await setup();
    const stale = await invoiceDraft(db, clientId, { today: '2026-12-30' });
    const fresh = await invoiceDraft(db, clientId, { today: '2027-01-02' });
    expect((await issueDocument(db, fresh, { today: '2027-01-02', now: NOW })).number).toBe('RE-2027-0001');

    // "same as issue date" on a stale draft: no silent date of supply — Issue is blocked and takes no number (D82)
    expect((await checkStoredDocument(db, stale, '2027-01-05')).map((i) => [i.id, i.severity, i.date])).toEqual([['service_date_stale', 'error', '2026-12-30']]);
    await expect(issueDocument(db, stale, { today: '2027-01-05', now: NOW })).rejects.toBeInstanceOf(IssueBlockedError);
    expect(await getDocument(db, stale)).toMatchObject({ issueDate: '2026-12-30', serviceMode: 'same', number: null });
    expect(await getCounter(db, 'invoice:2027')).toMatchObject({ nextValue: 2 });
    // the user chooses "keep 30.12.2026" (the check's second button): it becomes the typed date of supply
    await updateDraft(db, stale, { serviceMode: 'date', serviceFrom: '2026-12-30', serviceTo: null }, NOW);
    expect((await checkStoredDocument(db, stale, '2027-01-05')).map((i) => [i.id, i.severity])).toEqual([['issue_date_past', 'info']]);
    expect((await issueDocument(db, stale, { today: '2027-01-05', now: NOW })).number).toBe('RE-2027-0002');
    const doc = (await getDocument(db, stale))!;
    expect(doc).toMatchObject({ issueDate: '2027-01-05', serviceMode: 'date', serviceFrom: '2026-12-30', dueDate: '2027-01-19' });
    const model = JSON.parse(doc.snapshot!) as RenderModel;
    expect(model).toMatchObject({ issueDate: '2027-01-05', number: 'RE-2027-0002' });
    expect(await getCounter(db, 'invoice:2026')).toMatchObject({ nextValue: 1, maxUsed: 0 }); // 2026 counter untouched
  });

  it('an explicit service date or period is kept as it is; a blocked Issue leaves the draft date unchanged', async () => {
    const { db, clientId } = await setup();
    const id = await invoiceDraft(db, clientId, { today: '2026-06-01' });
    await updateDraft(db, id, { serviceMode: 'period', serviceFrom: '2026-05-01', serviceTo: '2026-05-31' }, NOW);
    await issueDocument(db, id, clock);
    expect(await getDocument(db, id)).toMatchObject({ issueDate: TODAY, serviceMode: 'period', serviceFrom: '2026-05-01', serviceTo: '2026-05-31' });

    const empty = await newDraft(db, { type: 'invoice', clientId, today: '2026-06-01', now: NOW });
    await expect(issueDocument(db, empty, clock)).rejects.toBeInstanceOf(IssueBlockedError);
    expect(await getDocument(db, empty)).toMatchObject({ issueDate: '2026-06-01', serviceMode: 'same' });
  });

  it('choice "today": the draft takes today\'s date, so the date of supply = issue date = today (D82)', async () => {
    const { db, clientId } = await setup();
    const id = await invoiceDraft(db, clientId, { today: '2026-09-01' });
    await updateDraft(db, id, { issueDate: TODAY }, NOW); // what the check's first button does (patchDraft)
    expect(await checkStoredDocument(db, id, TODAY)).toEqual([]);
    await issueDocument(db, id, clock);
    const model = JSON.parse((await getDocument(db, id))!.snapshot!) as RenderModel;
    expect(model).toMatchObject({ issueDate: TODAY, serviceMode: 'same' });
  });

  it('a future issue date stays (SPEC §10: allowed with a check item)', async () => {
    const { db, clientId } = await setup();
    const id = await invoiceDraft(db, clientId, { today: '2026-10-20' });
    expect((await checkStoredDocument(db, id, TODAY)).map((i) => i.id)).toEqual(['issue_date_future']);
    await issueDocument(db, id, clock);
    expect(await getDocument(db, id)).toMatchObject({ issueDate: '2026-10-20', serviceMode: 'same' });
  });
});

describe('cancellation invoice (Storno, D20, SPEC flow 5, A3)', () => {
  it('creates a negated copy numbered in the invoice series, linked to the invoice, and cancels the invoice', async () => {
    const { db, clientId } = await setup();
    const id = await issuedInvoice(db, clientId);
    const { cancellationId, number } = await cancelInvoice(db, id, { today: '2026-10-05', now: NOW + 10 });
    expect(number).toBe('RE-2026-0002');
    const storno = (await getDocument(db, cancellationId))!;
    expect(storno).toMatchObject({
      type: 'cancellation', status: 'issued', series: 'invoice', number: 'RE-2026-0002', sourceId: id, issueDate: '2026-10-05',
      netCents: -25_500, taxCents: -4_845, grossCents: -30_345, serviceMode: 'date', serviceFrom: TODAY, dueDate: null,
      intro: 'Stornorechnung zu Rechnung RE-2026-0001 vom 01.10.2026.',
    });
    expect((await listLines(db, cancellationId)).map((l) => l.qtyMilli)).toEqual([-3000]);
    const model = JSON.parse(storno.snapshot!) as RenderModel;
    expect(model.source).toEqual({ type: 'invoice', number: 'RE-2026-0001', issueDate: TODAY });
    expect(await getDocument(db, id)).toMatchObject({ status: 'cancelled', cancelledAt: NOW + 10, number: 'RE-2026-0001' });
    // Final: no second cancellation, no cancelling the cancellation, no payments, no edits.
    await expect(cancelInvoice(db, id, clock)).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(cancelInvoice(db, cancellationId, clock)).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(addPayment(db, id, { date: TODAY, amountCents: 100 })).rejects.toBeInstanceOf(PaymentNotAllowedError);
    await expect(updateDraft(db, cancellationId, { notes: 'x' })).rejects.toBeInstanceOf(DocumentLockedError);
    await expect(deleteDocument(db, cancellationId)).rejects.toBeInstanceOf(DocumentLockedError);
    expect((await documentStatus(db, id, '2026-12-01')).status).toBe('cancelled');
  });

  it('is the exact negation of worked examples A and B (discounts, gross mode)', async () => {
    for (const example of examples.examples.filter((e) => e.id === 'A' || e.id === 'B')) {
      const { db } = await setup();
      const input = example.input!;
      const id = await createDraft(db, {
        type: 'invoice', issueDate: TODAY, pricesIncludeVat: input.pricesIncludeVat,
        discountKind: input.discount.kind as 'percent', discountValue: input.discount.value,
      }, NOW);
      for (const l of input.lines) {
        await addLine(db, id, {
          name: l.name, qtyMilli: l.qtyMilli, priceE4: l.priceE4, taxCategory: l.category as TaxCategory, taxRateBp: l.rateBp,
          discountKind: l.discount.kind as 'none', discountValue: l.discount.value,
        });
      }
      await issueDocument(db, id, clock);
      const { cancellationId } = await cancelInvoice(db, id, clock);
      const original = JSON.parse((await getDocument(db, id))!.snapshot!) as RenderModel;
      const storno = JSON.parse((await getDocument(db, cancellationId))!.snapshot!) as RenderModel;
      expect([example.id, storno.totals.gross]).toEqual([example.id, -original.totals.gross]);
      expect(storno.totals.groups.map((g) => [g.rateBp, g.taxable, g.tax])).toEqual(original.totals.groups.map((g) => [g.rateBp, -g.taxable, -g.tax]));
      expect(storno.lines.map((l) => l.net)).toEqual(original.lines.map((l) => -l.net));
    }
  });

  it('offers a corrected copy: a new draft with the same content and no number', async () => {
    const { db, clientId } = await setup();
    const id = await issuedInvoice(db, clientId);
    await cancelInvoice(db, id, clock);
    const copy = await duplicateDocument(db, id, { today: '2026-10-06', now: NOW });
    expect(await getDocument(db, copy)).toMatchObject({
      type: 'invoice', status: 'draft', number: null, series: null, clientId, issueDate: '2026-10-06', paymentDays: 14,
      sourceId: null, grossCents: 30_345,
    });
    expect((await listLines(db, copy)).map((l) => [l.name, l.qtyMilli])).toEqual([['Webdesign', 3000]]);
    expect((await issueDocument(db, copy, clock)).number).toBe('RE-2026-0003');
  });
});

describe('payments and derived status (SPEC §5.9, A8)', () => {
  it('partial → partially paid; full → paid; overdue is computed from the date, never stored', async () => {
    const { db, clientId } = await setup();
    const id = await issuedInvoice(db, clientId); // due 2026-10-15, 303,45 €
    expect((await documentStatus(db, id, TODAY)).status).toBe('issued');
    await markSent(db, id, NOW + 1);
    expect((await documentStatus(db, id, TODAY)).status).toBe('sent');
    expect(await documentStatus(db, id, '2026-10-16')).toMatchObject({ status: 'overdue', daysOverdue: 1, balance: 30_345 });
    await addPayment(db, id, { date: '2026-10-10', amountCents: 10_000 });
    expect(await documentStatus(db, id, TODAY)).toMatchObject({ status: 'partially_paid', balance: 20_345 });
    expect(await documentStatus(db, id, '2026-10-20')).toMatchObject({ status: 'overdue', partiallyPaid: true });
    await addPayment(db, id, { date: '2026-10-12', amountCents: 20_345 });
    expect(await documentStatus(db, id, '2026-10-20')).toMatchObject({ status: 'paid', balance: 0, overdue: false });
    await addPayment(db, id, { date: '2026-10-12', amountCents: 2_000 });
    expect(await documentStatus(db, id, '2026-10-20')).toMatchObject({ status: 'paid', overpaid: true, balance: -2_000 });
    expect((await getDocument(db, id))?.status).toBe('issued'); // stored status untouched
    expect((await getDocument(db, id))?.sentAt).toBe(NOW + 1);
  });

  it('mark as sent is refused for drafts', async () => {
    const { db, clientId } = await setup();
    await expect(markSent(db, await invoiceDraft(db, clientId))).rejects.toBeInstanceOf(InvalidTransitionError);
  });
});

describe('receipts (D30)', () => {
  it('payment receipt: one line without VAT, linked to the invoice, VAT referred to the invoice (v1.1 D79)', async () => {
    const { db, clientId } = await setup();
    const id = await invoiceDraft(db, clientId);
    await addLine(db, id, { name: 'Buch', qtyMilli: 1000, priceE4: 200_000, taxRateBp: 700 }); // 20,00 + 1,40
    await issueDocument(db, id, clock); // 324,85 gross
    await expect(createPaymentReceipt(db, id, clock)).rejects.toThrow(/no payment/);
    const paymentId = await addPayment(db, id, { date: '2026-10-03', amountCents: 10_000, method: 'cash' });
    const receipt = await createPaymentReceipt(db, id, { ...clock, paymentId });
    const doc = (await getDocument(db, receipt))!;
    expect(doc).toMatchObject({
      type: 'receipt', receiptKind: 'payment', status: 'draft', sourceId: id, clientId, pricesIncludeVat: true,
      grossCents: 10_000, taxCents: 0, notes: '',
      intro: 'Betrag erhalten am 03.10.2026 (Bar).',
      legalNote: 'Bestätigung einer Zahlung. Angaben zur Umsatzsteuer: siehe Rechnung RE-2026-0001 vom 01.10.2026.',
    });
    const lines = await listLines(db, receipt);
    expect(lines.map((l) => [l.name, l.taxCategory, l.taxRateBp, l.priceE4 / 100])).toEqual([
      ['Zahlung zu Rechnung RE-2026-0001 vom 01.10.2026', 'O', 0, 10_000],
    ]);
    expect((await issueDocument(db, receipt, clock)).number).toBe('QU-2026-0001');
    expect((await checkStoredDocument(db, receipt, TODAY))).toEqual([]);
    // Not for cancelled invoices; payment receipts are not duplicated.
    await cancelInvoice(db, id, clock);
    await expect(createPaymentReceipt(db, id, clock)).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(duplicateDocument(db, receipt, clock)).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('review #1 probe: 500,00 € paid on a 140,40 € invoice → receipt capped at 140,40, no VAT, "overpaid by 359,60"', async () => {
    const { db, clientId } = await setup();
    const id = await newDraft(db, { type: 'invoice', clientId, today: TODAY, now: NOW });
    await addLine(db, id, { name: 'Leistung', qtyMilli: 1000, priceE4: 1_000_000, taxRateBp: 1900 }); // 100 + 19
    await addLine(db, id, { name: 'Buch', qtyMilli: 1000, priceE4: 200_000, taxRateBp: 700 }); // 20 + 1,40
    await issueDocument(db, id, clock);
    expect(await getDocument(db, id)).toMatchObject({ netCents: 12_000, taxCents: 2_040, grossCents: 14_040 });
    await addPayment(db, id, { date: TODAY, amountCents: 50_000, method: 'bank' });
    const receipt = await createPaymentReceipt(db, id, clock);
    expect(await getDocument(db, receipt)).toMatchObject({ grossCents: 14_040, taxCents: 0, notes: expect.stringMatching(/^Überzahlt um 359,60\s€ \(über dem Rechnungsbetrag, nicht Teil dieser Quittung\)\.$/) });
    await issueDocument(db, receipt, clock);
    const model = await renderModelFor(db, receipt);
    expect(model.totals.tax).toBe(0); // was 72,65 € before v1.1 (more than the invoice's 20,40 €)
    expect(model.totals.groups.every((g) => g.tax === 0)).toBe(true);
    // The invoice amount is now fully confirmed: a second receipt is refused.
    await expect(createPaymentReceipt(db, id, clock)).rejects.toBeInstanceOf(PaymentReceiptFullError);
  });

  it('receipts per payment are capped by what earlier receipts already confirm', async () => {
    const { db, clientId } = await setup();
    const id = await issuedInvoice(db, clientId); // 303,45
    const p1 = await addPayment(db, id, { date: TODAY, amountCents: 20_000 });
    const p2 = await addPayment(db, id, { date: TODAY, amountCents: 20_000 });
    const r1 = await createPaymentReceipt(db, id, { ...clock, paymentId: p1 });
    const r2 = await createPaymentReceipt(db, id, { ...clock, paymentId: p2 });
    expect((await getDocument(db, r1))?.grossCents).toBe(20_000);
    expect(await getDocument(db, r2)).toMatchObject({ grossCents: 10_345, notes: expect.stringMatching(/^Überzahlt um 96,55\s€/) });
    await expect(createPaymentReceipt(db, id, clock)).rejects.toBeInstanceOf(PaymentReceiptFullError);
    // Deleting a receipt draft frees its amount again.
    await deleteDocument(db, r2);
    expect((await getDocument(db, await createPaymentReceipt(db, id, { ...clock, paymentId: p2 })))?.grossCents).toBe(10_345);
  });

  it('cash receipt: own series, no client needed up to 250 €', async () => {
    const { db } = await setup();
    const id = await newDraft(db, { type: 'receipt', today: TODAY, now: NOW });
    await addLine(db, id, { name: 'Beratung', qtyMilli: 1000, priceE4: 500_000, taxRateBp: 1900 });
    expect(await getDocument(db, id)).toMatchObject({ receiptKind: 'cash', paymentDays: null });
    expect(await checkStoredDocument(db, id, TODAY)).toEqual([]);
    expect((await issueDocument(db, id, clock)).number).toBe('QU-2026-0001');
    expect(await getDocument(db, id)).toMatchObject({ dueDate: null, grossCents: 5_950 });
  });
});

describe('quotes (SPEC flow 3, D20)', () => {
  async function issuedQuote(db: Db, clientId: number) {
    const id = await newDraft(db, { type: 'quote', clientId, today: TODAY, now: NOW });
    await addLine(db, id, { name: 'Konzept', qtyMilli: 2000, priceE4: 1_000_000, taxRateBp: 1900 });
    await issueDocument(db, id, clock);
    return id;
  }

  it('issue → accept → convert: an invoice draft with all lines; the quote is invoiced', async () => {
    const { db, clientId } = await setup();
    const quote = await issuedQuote(db, clientId);
    expect(await getDocument(db, quote)).toMatchObject({ number: 'AN-2026-0001', validUntil: '2026-10-31' });
    await expect(convertQuote(db, quote, clock)).rejects.toBeInstanceOf(InvalidTransitionError);
    await acceptQuote(db, quote);
    await setSetting(db, 'text.de.intro.invoice', 'Vielen Dank für Ihren Auftrag.');
    const invoice = await convertQuote(db, quote, { today: '2026-10-08', now: NOW });
    expect(await getDocument(db, invoice)).toMatchObject({
      type: 'invoice', status: 'draft', number: null, sourceId: quote, clientId, issueDate: '2026-10-08', paymentDays: 14,
      validUntil: null, intro: 'Vielen Dank für Ihren Auftrag.', grossCents: 23_800,
    });
    expect((await listLines(db, invoice)).map((l) => l.name)).toEqual(['Konzept']);
    expect((await getDocument(db, quote))?.status).toBe('invoiced');
    expect((await documentStatus(db, quote, '2027-01-01')).status).toBe('invoiced');
    await expect(convertQuote(db, quote, clock)).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(deleteDocument(db, quote)).rejects.toBeInstanceOf(InvalidTransitionError);
    // Deleting the invoice draft undoes the conversion.
    await deleteDocument(db, invoice);
    expect((await getDocument(db, quote))?.status).toBe('accepted');
  });

  it('decline; expiry is derived; issued quotes can be deleted, their number is not reused', async () => {
    const { db, clientId } = await setup();
    const a = await issuedQuote(db, clientId);
    expect((await documentStatus(db, a, '2026-11-01')).status).toBe('expired');
    await declineQuote(db, a);
    expect((await documentStatus(db, a, '2026-11-01')).status).toBe('declined');
    await expect(acceptQuote(db, a)).rejects.toBeInstanceOf(InvalidTransitionError);
    await deleteDocument(db, a);
    expect(await getDocument(db, a)).toBeNull();
    expect((await getDocument(db, await issuedQuote(db, clientId)))?.number).toBe('AN-2026-0002');
  });

  it('reopen an issued quote for editing (D38): keeps its number, no new number on re-issue', async () => {
    const { db, clientId } = await setup();
    const quote = await issuedQuote(db, clientId);
    await reopenQuote(db, quote);
    expect(await getDocument(db, quote)).toMatchObject({ status: 'draft', number: 'AN-2026-0001' });
    const [line] = await listLines(db, quote);
    await updateLine(db, line.id, { qtyMilli: 3000 });
    await expect(acceptQuote(db, quote)).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(await issueDocument(db, quote, clock)).toEqual({ number: 'AN-2026-0001', series: 'quote' });
    expect(await getDocument(db, quote)).toMatchObject({ status: 'issued', grossCents: 35_700 });
    expect(await getCounter(db, 'quote:2026')).toMatchObject({ nextValue: 2, maxUsed: 1 });
    await acceptQuote(db, quote);
    await expect(reopenQuote(db, quote)).rejects.toBeInstanceOf(InvalidTransitionError);
  });
});

describe('open invoices use the name on the invoice (review #20)', () => {
  it('renaming the client afterwards does not change the reminder/Home name', async () => {
    const { db, clientId } = await setup();
    await issuedInvoice(db, clientId);
    await updateClient(db, clientId, { name: 'Neuer Name AG' }, NOW);
    expect((await openInvoices(db)).map((i) => i.clientName)).toEqual(['Kunde GmbH']);
  });
});

describe('content taller than a page is refused, never clipped (D56, review #9)', () => {
  it('review probe: a 14,250-character description blocks Issue with line_too_tall on that line', async () => {
    const { db, clientId } = await setup();
    const id = await invoiceDraft(db, clientId);
    await addLine(db, id, { name: 'Bericht', description: 'Lorem ipsum dolor sit amet. '.repeat(509), qtyMilli: 1000, priceE4: 10_000, taxRateBp: 1900 });
    const error = await issueDocument(db, id, clock).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IssueBlockedError);
    expect((error as IssueBlockedError).items).toEqual([{ id: 'line_too_tall', severity: 'error', fix: 'lines', sources: [], line: 1 }]);
    expect(await getCounter(db, 'invoice:2026')).toMatchObject({ nextValue: 1 });
    // shortened to what fits on a page (about 2,000 characters here): Issue goes through, on more pages
    const line = (await listLines(db, id))[1];
    await updateLine(db, line.id, { description: 'Lorem ipsum dolor sit amet. '.repeat(70) });
    expect((await issueDocument(db, id, clock)).number).toBe('RE-2026-0001');
  });

  it('notes or a legal note longer than a page → text_too_tall', async () => {
    const { db, clientId } = await setup();
    const id = await invoiceDraft(db, clientId);
    await updateDraft(db, id, { notes: 'Bitte beachten Sie die folgenden Hinweise. '.repeat(400) }, NOW);
    expect((await checkStoredDocument(db, id, TODAY)).filter((i) => i.severity === 'error')).toEqual([{ id: 'text_too_tall', severity: 'error', fix: 'texts', sources: [] }]);
    await updateDraft(db, id, { notes: '', legalNote: 'Hinweis. '.repeat(2000) }, NOW);
    expect((await checkStoredDocument(db, id, TODAY)).filter((i) => i.severity === 'error')).toEqual([{ id: 'text_too_tall', severity: 'error', fix: 'legalNote', sources: [] }]);
  });
});

describe('§14b retention note for private clients (D55, review #8)', () => {
  it('with the setting on, invoices for private clients carry it (new and from a quote); others do not', async () => {
    const { db, clientId } = await setup();
    const person = await createClient(db, { kind: 'person', name: 'Erika Muster', street: 'Weg 3', postalCode: '20095', city: 'Hamburg' }, NOW);
    const noteOf = async (id: number) => (await getDocument(db, id))!.legalNote;
    expect(await noteOf(await newDraft(db, { type: 'invoice', clientId: person, ...clock }))).toBe(''); // off by default

    await setSetting(db, RETENTION_NOTE_SETTING, '1');
    expect(await noteOf(await newDraft(db, { type: 'invoice', clientId: person, ...clock }))).toBe(RETENTION_NOTE.text.de);
    expect(await noteOf(await newDraft(db, { type: 'invoice', clientId, ...clock }))).toBe(''); // a business client
    const quote = await newDraft(db, { type: 'quote', clientId: person, ...clock });
    expect(await noteOf(quote)).toBe('');
    await addLine(db, quote, { name: 'Bad sanieren', qtyMilli: 1000, priceE4: 50_000_000, taxRateBp: 1900 });
    await issueDocument(db, quote, clock);
    await acceptQuote(db, quote, NOW);
    const invoice = await convertQuote(db, quote, clock);
    expect(await noteOf(invoice)).toBe(RETENTION_NOTE.text.de);
    await issueDocument(db, invoice, clock);
    expect((JSON.parse((await getDocument(db, invoice))!.snapshot!) as RenderModel).texts.legalNote).toBe(RETENTION_NOTE.text.de);
  });
});

describe('new drafts take defaults from client and business', () => {
  it('language, currency, treatment, payment days and the legal note', async () => {
    const { db } = await setup();
    const at = await createClient(db, {
      name: 'Wien GmbH', countryCode: 'AT', vatId: 'ATU12345678', treatment: 'reverse_charge', language: 'en', currency: 'EUR', paymentDays: 30,
    }, NOW);
    const id = await newDraft(db, { type: 'invoice', clientId: at, today: TODAY, now: NOW });
    expect(await getDocument(db, id)).toMatchObject({
      language: 'en', treatment: 'reverse_charge', paymentDays: 30, legalNote: LEGAL_NOTES.reverse_charge.text.en, validUntil: null,
    });
    await updateBusiness(db, { vatMode: 'small_business' }, NOW);
    const q = await newDraft(db, { type: 'quote', today: TODAY, now: NOW });
    expect(await getDocument(db, q)).toMatchObject({ language: 'de', legalNote: LEGAL_NOTES.small_business.text.de, validUntil: '2026-10-31', paymentDays: null });
    await setSetting(db, 'default_paper', 'LETTER');
    expect((await getDocument(db, await newDraft(db, { type: 'invoice', today: TODAY, now: NOW })))?.paper).toBe('LETTER');
  });
});

describe('home summary and reminder candidates (SPEC §6, A8, D27)', () => {
  it('outstanding, overdue and paid this month — per currency', async () => {
    const { db, clientId } = await setup();
    const a = await issuedInvoice(db, clientId); // 303,45 due 15 Oct
    const b = await issuedInvoice(db, clientId);
    await addPayment(db, b, { date: '2026-10-02', amountCents: 30_345 }); // paid
    const c = await issuedInvoice(db, clientId);
    await addPayment(db, c, { date: '2026-09-30', amountCents: 345 }); // last month
    const usd = await newDraft(db, { type: 'invoice', clientId, today: TODAY, now: NOW });
    await updateDraft(db, usd, { currency: 'USD', paymentDays: 0 });
    await addLine(db, usd, { name: 'x', qtyMilli: 1000, priceE4: 1_000_000, taxRateBp: 0, taxCategory: 'S' });
    await issueDocument(db, usd, clock); // 100,00 USD due today
    const cancelled = await issuedInvoice(db, clientId);
    await addPayment(db, cancelled, { date: '2026-10-03', amountCents: 5_000 });
    await cancelInvoice(db, cancelled, clock);
    await invoiceDraft(db, clientId); // drafts never count

    expect(await homeSummary(db, TODAY)).toEqual({
      outstanding: [{ currency: 'EUR', cents: 30_345 + 30_000, count: 2 }, { currency: 'USD', cents: 10_000, count: 1 }],
      overdue: [],
      paidThisMonth: [{ currency: 'EUR', cents: 30_345 + 5_000, count: 2 }],
    });
    const later = await homeSummary(db, '2026-10-16');
    expect(later.overdue).toEqual([{ currency: 'EUR', cents: 60_345, count: 2 }, { currency: 'USD', cents: 10_000, count: 1 }]);
    expect(later.paidThisMonth).toEqual([{ currency: 'EUR', cents: 35_345, count: 2 }]);
    expect((await homeSummary(db, '2026-11-01')).paidThisMonth).toEqual([]);

    const open = await openInvoices(db);
    expect(open.map((o) => [o.id, o.balanceCents])).toEqual([[usd, 10_000], [a, 30_345], [c, 30_000]]);
    const planned = plan(open.map((o) => ({ ...o, status: 'issued' })), {
      reminderTime: '09:00', remindOverdue: true, remindDueTomorrow: false, language: 'de',
    }, new Date(2026, 9, 1, 8, 0));
    expect(planned.map((p) => [p.day, p.data.documentIds])).toEqual([['2026-10-02', [usd]], ['2026-10-16', [a, c]]]);
  });
});

// A2: 1 000 randomised create/issue/delete/cancel operations → no duplicate numbers, counters monotonic.
describe('property A2: randomised lifecycle operations', () => {
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
      return s / 2 ** 32;
    };
  }

  it.each([1, 2])('seed %i: numbers unique, drafts unnumbered, counters never decrease', async (seed) => {
    const random = rng(seed);
    const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
    const { db, clientId } = await setup();
    const counters = new Map<string, number>();
    const stats = { issued: 0, cancelled: 0, deleted: 0, blocked: 0 };

    for (let op = 0; op < 1000; op++) {
      const docs = await listDocuments(db);
      const drafts = docs.filter((d) => d.status === 'draft');
      const r = random();
      const day = pick(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
      if (r < 0.3 || drafts.length === 0) {
        const type = pick(['invoice', 'invoice', 'quote', 'receipt'] as const);
        const id = await newDraft(db, { type, clientId, today: day, now: NOW });
        if (random() < 0.9) await addLine(db, id, { name: 'x', qtyMilli: 1000, priceE4: 100_000, taxRateBp: 1900 });
      } else if (r < 0.65) {
        const draft = pick(drafts);
        try {
          await issueDocument(db, draft.id, { today: day, now: NOW });
          stats.issued++;
        } catch (e) {
          expect(e).toBeInstanceOf(IssueBlockedError); // only the 10 % without lines
          stats.blocked++;
        }
      } else if (r < 0.8) {
        const target = pick(docs.filter((d) => d.status === 'draft' || (d.type === 'quote' && d.status === 'issued')));
        if (target) {
          await deleteDocument(db, target.id);
          stats.deleted++;
        }
      } else if (r < 0.92) {
        const target = pick(docs.filter((d) => d.type === 'invoice' && d.status === 'issued'));
        if (target) {
          await cancelInvoice(db, target.id, { today: day, now: NOW });
          stats.cancelled++;
        }
      } else if (r < 0.96) {
        const target = pick(docs.filter((d) => d.type === 'quote' && d.status === 'issued'));
        if (target) await acceptQuote(db, target.id);
      } else {
        // The user raises "next number" (continuing from another app) — never below max used + 1.
        const key = pick(['invoice:2026', 'invoice:2027', 'quote:2027', 'receipt:2026']);
        const c = await getCounter(db, key);
        await setNextValue(db, key, c.nextValue + Math.floor(random() * 3));
      }

      const rows = await db.getAllAsync<{ series_key: string; next_value: number; max_used: number }>('SELECT * FROM number_counters');
      for (const row of rows) {
        expect(row.next_value).toBeGreaterThan(row.max_used);
        expect(row.max_used).toBeGreaterThanOrEqual(counters.get(row.series_key) ?? 0);
        counters.set(row.series_key, row.max_used);
      }
    }

    const all = await listDocuments(db);
    const numbered = all.filter((d) => d.number !== null);
    expect(new Set(numbered.map((d) => `${d.series}|${d.number}`)).size).toBe(numbered.length);
    for (const d of all) {
      expect([d.id, d.status === 'draft', d.number === null]).toEqual([d.id, d.status === 'draft', d.status === 'draft']);
      if (d.number) expect(d.number.slice(3, 7)).toBe(d.issueDate.slice(0, 4)); // RE-/AN-/QU-{YYYY}
      if (d.type === 'cancellation') {
        expect(d.series).toBe('invoice');
        expect((await getDocument(db, d.sourceId!))?.status).toBe('cancelled');
      }
    }
    const cancelledInvoices = all.filter((d) => d.type === 'invoice' && d.status === 'cancelled');
    expect(all.filter((d) => d.type === 'cancellation')).toHaveLength(cancelledInvoices.length);
    expect(stats.issued).toBeGreaterThan(150);
    expect(stats.cancelled).toBeGreaterThan(30);
    expect(stats.deleted).toBeGreaterThan(50);
  });
});
