/**
 * @jest-environment node
 */
// P6 (payments UI rules, client detail, related documents, "Delete all data", backup → delete all → restore round trip,
// the data-change hook, reminders from the overdue fixture). Pure db level on the Node SQLite fake.
import { createTestDb } from '../../test/node-sqlite-db';

import { buildBackup, hashData, serializeBackup } from '@/data/backup';
import { csvPeriod } from '@/data/csv';
import { addDays, todayLocal } from '@/engine/dates';
import { plan } from '@/lib/reminder-plan';
import { readPlanInputs } from '@/lib/reminder-inputs';

import { updateBusiness } from './business';
import { onDataChange } from './changes';
import { createClient } from './clients';
import { resetAll, seedFixture } from './debug';
import { eraseAllData, resetNumbering } from './erase';
import { getDocument, listDocuments } from './documents';
import { cancelInvoice, createPaymentReceipt, documentStatus, duplicateDocument, issueDocument, newDraft } from './lifecycle';
import { listDocumentRows, relatedDocuments } from './list';
import { LATEST_VERSION, openDatabase } from './migrations';
import { addPayment, deletePayment, listPayments } from './payments';
import { dataCounts, dataFingerprint, readAllData, restoreFromText } from './restore';
import { getReminderSettings, getSetting, setSetting } from './settings';
import { clientOverview, homeSummary, openInvoices } from './summary';
import { saveDraftLine } from './editing';
import { queued, withRead } from './transaction';

const TODAY = '2026-10-01';
const clock = { today: TODAY, now: 1_790_000_000_000 };

async function setup() {
  const db = createTestDb();
  await openDatabase(db);
  await updateBusiness(db, { name: 'Muster Design', street: 'Musterstr. 1', postalCode: '10115', city: 'Berlin', taxNumber: '12/345/67890' });
  return db;
}

const line = (name: string, priceE4: number, rateBp = 1900) => ({
  name, description: '', qtyMilli: 1000, unitCode: 'C62', priceE4, rateBp, discountKind: 'none' as const, discountValue: 0,
});

async function invoice(db: Awaited<ReturnType<typeof setup>>, clientId: number | null, priceE4: number, currency = 'EUR') {
  const id = await newDraft(db, { type: 'invoice', clientId: clientId ?? undefined, today: TODAY });
  await saveDraftLine(db, id, null, line('Work', priceE4 * 10)); // priceE4 argument = net euros × 1 000 for brevity
  if (currency !== 'EUR') await db.runAsync('UPDATE documents SET currency = ? WHERE id = ?', currency, id);
  await issueDocument(db, id, clock);
  return id;
}

describe('payments: partial, overpayment, exact cents', () => {
  it('a part payment, then the exact rest, then an overpayment: statuses and balances to the cent', async () => {
    const db = await setup();
    const id = await invoice(db, null, 1_000_000); // 1.000,00 net → 1.190,00 gross
    expect(await documentStatus(db, id, TODAY)).toMatchObject({ status: 'issued', balance: 119_000 });
    await addPayment(db, id, { date: TODAY, amountCents: 50_001, method: 'bank' });
    expect(await documentStatus(db, id, TODAY)).toMatchObject({ status: 'partially_paid', balance: 68_999, partiallyPaid: true });
    const rest = await addPayment(db, id, { date: TODAY, amountCents: 68_999, method: 'cash' });
    expect(await documentStatus(db, id, TODAY)).toMatchObject({ status: 'paid', balance: 0, overpaid: false });
    await deletePayment(db, rest);
    await addPayment(db, id, { date: TODAY, amountCents: 70_000, method: 'card', note: 'too much' });
    expect(await documentStatus(db, id, TODAY)).toMatchObject({ status: 'paid', balance: -1_001, overpaid: true });
    expect((await listPayments(db, id)).map((p) => p.amountCents)).toEqual([50_001, 70_000]);
    expect(await openInvoices(db)).toEqual([]); // paid (overpaid) = not outstanding
  });

  it('a payment can be deleted again and the balance returns', async () => {
    const db = await setup();
    const id = await invoice(db, null, 1_000_000);
    const p = await addPayment(db, id, { date: TODAY, amountCents: 119_000 });
    expect((await homeSummary(db, TODAY)).outstanding).toEqual([]);
    await deletePayment(db, p);
    expect((await homeSummary(db, TODAY)).outstanding).toEqual([{ currency: 'EUR', cents: 119_000, count: 1 }]);
  });
});

describe('client detail: outstanding per client and currency', () => {
  it('sums open balances per client, never across currencies, and lists only that client\'s documents', async () => {
    const db = await setup();
    const a = await createClient(db, { name: 'Alpha GmbH' });
    const b = await createClient(db, { name: 'Beta AG' });
    const i1 = await invoice(db, a, 1_000_000);
    await invoice(db, a, 2_000_000);
    await invoice(db, a, 500_000, 'USD');
    await invoice(db, b, 3_000_000);
    await addPayment(db, i1, { date: TODAY, amountCents: 19_000 });
    const overview = await clientOverview(db, a, '2026-10-20');
    expect(overview.outstanding).toEqual([
      { currency: 'EUR', cents: 119_000 - 19_000 + 238_000, count: 2 },
      { currency: 'USD', cents: 59_500, count: 1 },
    ]);
    expect(overview.overdue).toEqual(overview.outstanding); // 14-day terms, 2026-10-20 is past due
    expect((await clientOverview(db, a, TODAY)).overdue).toEqual([]);
    const rows = await listDocumentRows(db, ['invoice', 'cancellation', 'quote', 'receipt'], TODAY, '', a);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.clientName === 'Alpha GmbH')).toBe(true);
    expect((await clientOverview(db, b, TODAY)).outstanding).toEqual([{ currency: 'EUR', cents: 357_000, count: 1 }]);
  });
});

describe('cancellation (Storno), corrected copy and related documents', () => {
  it('cancel → cancellation numbered next, original cancelled, copy is a draft; related links both ways', async () => {
    const db = await setup();
    const id = await invoice(db, null, 1_000_000);
    const payment = await addPayment(db, id, { date: TODAY, amountCents: 10_000 });
    const { cancellationId, number } = await cancelInvoice(db, id, clock);
    expect(number).toMatch(/0002$/);
    expect(await getDocument(db, id)).toMatchObject({ status: 'cancelled' });
    expect(await getDocument(db, cancellationId)).toMatchObject({ type: 'cancellation', status: 'issued', grossCents: -119_000, sourceId: id });
    const copy = await duplicateDocument(db, id, clock);
    expect(await getDocument(db, copy)).toMatchObject({ type: 'invoice', status: 'draft', number: null, grossCents: 119_000 });
    expect((await relatedDocuments(db, id)).map((r) => [r.type, r.role])).toEqual([['cancellation', 'derived']]);
    expect(await relatedDocuments(db, cancellationId)).toEqual([expect.objectContaining({ id, type: 'invoice', role: 'source' })]);
    expect((await listPayments(db, id)).map((p) => p.id)).toEqual([payment]); // payments stay recorded
    expect(await openInvoices(db)).toEqual([]); // a cancelled invoice is not outstanding
  });

  it('a payment receipt is related to its invoice', async () => {
    const db = await setup();
    const id = await invoice(db, null, 1_000_000);
    await addPayment(db, id, { date: TODAY, amountCents: 40_000 });
    const receipt = await createPaymentReceipt(db, id, clock);
    expect((await relatedDocuments(db, id)).map((r) => [r.id, r.type])).toEqual([[receipt, 'receipt']]);
  });
});

describe('Delete all data', () => {
  it('empties every table, keeps this phone\'s preferences, keeps numbering (D81) and keeps the lock triggers', async () => {
    const db = await setup();
    await seedFixture(db, 'issued');
    await setSetting(db, 'theme', 'dark');
    await setSetting(db, 'ui_language', 'en');
    await setSetting(db, 'notif_asked', '1');
    await setSetting(db, 'reminder_time', '07:30');
    expect(await dataCounts(db)).toEqual({ documents: 1, clients: 1 });
    await eraseAllData(db);
    expect(await dataCounts(db)).toEqual({ documents: 0, clients: 0 });
    expect(await listDocuments(db)).toEqual([]);
    expect(await getSetting(db, 'theme')).toBe('dark');
    expect(await getSetting(db, 'ui_language')).toBe('en');
    expect(await getSetting(db, 'notif_asked')).toBe('1');
    expect(await getSetting(db, 'reminder_time')).toBeNull();
    const rates = await db.getAllAsync('SELECT * FROM tax_rates');
    expect(rates).toHaveLength(3);
    // Review #4 probe: RE-…-0001 was issued before Delete all; the next Issue must not hand it out again (D81).
    await updateBusiness(db, { name: 'Neu' });
    const id = await invoice(db, null, 100_000);
    expect((await getDocument(db, id))?.number).toMatch(/0002$/);
    // issued documents are locked again (triggers recreated)
    await expect(db.runAsync("UPDATE documents SET notes = 'x' WHERE id = ?", id)).rejects.toThrow();
  });

  it('"Reset numbering" is the separate, explicit way back to 1; existing numbers are still skipped (D53)', async () => {
    const db = await setup();
    await seedFixture(db, 'issued');
    await eraseAllData(db);
    await resetNumbering(db);
    await updateBusiness(db, { name: 'Neu' });
    const first = await invoice(db, null, 100_000);
    expect((await getDocument(db, first))?.number).toMatch(/0001$/);
    await resetNumbering(db);
    const second = await invoice(db, null, 100_000);
    expect((await getDocument(db, second))?.number).toMatch(/0002$/); // 0001 exists on this phone
  });
});

describe('A11: backup → delete all → restore gives the same rows (count + hash)', () => {
  it('payments, cancellation, receipt, quote and settings survive the round trip', async () => {
    const db = await setup();
    await seedFixture(db, 'issued');
    const [inv] = await listDocuments(db, { status: 'issued' });
    await addPayment(db, inv.id, { date: TODAY, amountCents: 50_000, method: 'cash' });
    await createPaymentReceipt(db, inv.id, clock);
    await setSetting(db, 'reminder_time', '08:15');
    const before = await dataFingerprint(db);
    const text = serializeBackup(buildBackup(await withRead(db, readAllData), { schemaVersion: LATEST_VERSION, exportedAt: '2026-10-01T10:00:00.000Z', app: 'invoice-maker' }));
    await eraseAllData(db);
    expect(await dataFingerprint(db)).not.toBe(before);
    const result = await restoreFromText(db, text);
    expect(result.ok).toBe(true);
    expect(await dataFingerprint(db)).toBe(before);
    expect(hashData(await withRead(db, readAllData))).toBe(before);
    expect((await getReminderSettings(db)).reminderTime).toBe('08:15');
  });

  it('restoring an older backup keeps the counters at max(phone, file) (D52): no number is handed out twice', async () => {
    const db = await setup();
    await seedFixture(db, 'issued');
    const old = serializeBackup(buildBackup(await withRead(db, readAllData), { schemaVersion: LATEST_VERSION, exportedAt: '2026-10-01T10:00:00.000Z', app: 'invoice-maker' }));
    const [inv] = await listDocuments(db, { status: 'issued' });
    await cancelInvoice(db, inv.id, clock); // RE-…-0002 exists on the phone only
    const result = await restoreFromText(db, old);
    expect(result.ok && result.plan.phone?.phoneOnlyNumbers).toHaveLength(1);
    const next = await invoice(db, null, 100_000);
    expect((await getDocument(db, next))?.number).toMatch(/0003$/);
  });
});

describe('data-change hook', () => {
  it('fires once per finished outermost write unit, not for reads and not for nested units', async () => {
    const db = await setup();
    let n = 0;
    const off = onDataChange(() => n++);
    await setSetting(db, 'x', '1'); // queued write
    await withRead(db, (db) => db.getAllAsync('SELECT 1'));
    expect(n).toBe(1);
    const nested = queued(async (db) => {
      await setSetting(db, 'y', '1');
      await setSetting(db, 'z', '1');
    });
    await nested(db);
    expect(n).toBe(2);
    await expect(db.runAsync('SELECT bogus').catch(() => undefined)).resolves.toBeUndefined();
    off();
    await setSetting(db, 'x', '2');
    expect(n).toBe(2);
  });
});

describe('reminders from the data', () => {
  it('the overdue fixture (due yesterday) plans exactly one notification for today when the time is still ahead', async () => {
    const db = await setup();
    await resetAll(db);
    await seedFixture(db, 'overdue');
    const { invoices, settings } = await readPlanInputs(db);
    expect(invoices).toHaveLength(1);
    expect(invoices[0].dueDate).toBe(addDays(todayLocal(), -1));
    const morning = new Date(`${todayLocal()}T00:05:00`);
    const planned = plan(invoices, { ...settings, reminderTime: '23:50', language: 'en' }, morning);
    expect(planned).toHaveLength(1);
    expect(planned[0].day).toBe(todayLocal());
    expect(planned[0].title).toContain(invoices[0].number);
    // paying the invoice removes the reminder
    const [row] = await listDocuments(db, { status: 'issued' });
    await addPayment(db, row.id, { date: todayLocal(), amountCents: row.grossCents });
    expect(plan((await readPlanInputs(db)).invoices, { ...settings, reminderTime: '23:50', language: 'en' }, morning)).toEqual([]);
  });

  it('reminder settings default to overdue on, day-before off, 09:00; bad times fall back', async () => {
    const db = await setup();
    expect(await getReminderSettings(db)).toEqual({ reminderTime: '09:00', remindOverdue: true, remindDueTomorrow: false });
    await setSetting(db, 'reminder_time', '25:99');
    await setSetting(db, 'remind_overdue', '0');
    await setSetting(db, 'remind_due_tomorrow', '1');
    expect(await getReminderSettings(db)).toEqual({ reminderTime: '09:00', remindOverdue: false, remindDueTomorrow: true });
  });
});

describe('CSV period chooser', () => {
  it('this year, last year and all', () => {
    expect(csvPeriod('thisYear', '2026-10-01')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(csvPeriod('lastYear', '2026-10-01')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(csvPeriod('all', '2026-10-01')).toEqual({ from: null, to: null });
  });
});
