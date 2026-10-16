// Document lifecycle on the database (V1_PLAN P2.1, D17, D20, D30, D34). Every operation that changes more
// than one row runs in ONE transaction. Transition rules come from the pure table in `src/engine/status.ts`;
// the JS guard in documents.ts and the SQLite triggers (D34) keep issued documents frozen.
import { hasBlockingErrors, checkDocument, type CheckItem } from '@/engine/check';
import { addDays, daysBetween, formatDate } from '@/engine/dates';
import { formatMoney, type Lang } from '@/engine/money';
import { defaultLegalNote, withRetentionNote } from '@/engine/notes';
import { seriesOf, type DocumentType } from '@/engine/numbering';
import {
  assertCan,
  DEFAULT_QUOTE_VALID_DAYS,
  deriveStatus,
  effectiveDueDate,
  paymentDaysFor,
  type DerivedStatus,
  type ReceiptKind,
} from '@/engine/status';
import { computeTotals } from '@/engine/totals';
import { lineConflicts, lineTax, type Treatment } from '@/engine/treatment';
import { translate } from '@/i18n';
import { buildCtx, tooTall } from '@/render/html';
import { buildRenderModel, type RenderModel } from '@/render/model';

import { deleteDocumentSignature, listAttachments, setDocumentSignature } from './attachments';
import { getBusiness, type Business } from './business';
import { getClient, type Client } from './clients';
import { takeNumber } from './counters';
import {
  createDraft,
  getDocument,
  refreshDraftTotals,
  totalsInputFor,
  updateDocumentState,
  updateDraft,
  type Document,
  type DraftInput,
} from './documents';
import { addLine, listLines, updateLine, type DocumentLine } from './lines';
import { listPayments, type PaymentMethod } from './payments';
import { getNumberPattern, getSetting } from './settings';
import { queued, withRead, withTransaction } from './transaction';
import type { Db } from './types';

export class IssueBlockedError extends Error {
  constructor(readonly items: CheckItem[]) {
    super(`issue_blocked: ${items.map((i) => i.id).join(', ')}`);
    this.name = 'IssueBlockedError';
  }
}

export type Clock = { today: string; now?: number };

const isUniqueError = (e: unknown) => /UNIQUE constraint failed/i.test(String((e as { message?: unknown })?.message ?? e));

async function mustGet(db: Db, id: number): Promise<Document> {
  const doc = await getDocument(db, id);
  if (!doc) throw new Error(`document ${id} not found`);
  return doc;
}

// ---------------------------------------------------------------------------------------------
// New drafts with defaults from the business and the client
// ---------------------------------------------------------------------------------------------

/** Language, currency, treatment, payment days and legal note a document takes from its client (SPEC flow 2). */
export function clientDefaults(business: Business, client: Client | null) {
  const language: Lang = client?.language ?? business.language;
  const treatment: Treatment = client?.treatment ?? 'standard';
  return {
    language,
    currency: client?.currency ?? business.currency,
    treatment,
    paymentDays: paymentDaysFor(client?.paymentDays, business.paymentDays),
    legalNote: defaultLegalNote(treatment, business.vatMode, language),
  };
}

/** Default texts per language and type (settings `text.<lang>.<intro|notes|payment|footer>.<type>`). */
export async function defaultTexts(db: Db, lang: Lang, type: DocumentType) {
  const get = async (kind: string) => (await getSetting(db, `text.${lang}.${kind}.${type}`)) ?? '';
  return { intro: await get('intro'), notes: await get('notes'), paymentText: await get('payment'), footer: await get('footer') };
}

/** Setting `retention_note` = '1': invoices for private clients carry the §14b retention note (D55). */
export async function invoiceNote(db: Db, client: Client | null, note: string, lang: Lang): Promise<string> {
  if (client?.kind !== 'person' || (await getSetting(db, RETENTION_NOTE_SETTING)) !== '1') return note;
  return withRetentionNote(note, lang);
}

export const RETENTION_NOTE_SETTING = 'retention_note';

async function layoutDefaults(db: Db) {
  const template = await getSetting(db, 'default_template');
  const accent = await getSetting(db, 'default_accent');
  const paper = await getSetting(db, 'default_paper');
  const logoRight = await getSetting(db, 'default_logo_right');
  const girocode = await getSetting(db, 'default_girocode');
  return {
    ...(logoRight !== null ? { logoRight: logoRight === '1' } : {}),
    ...(girocode !== null ? { showGirocode: girocode === '1' } : {}),
    ...(template ? { template } : {}),
    ...(accent ? { accent } : {}),
    ...(paper === 'A4' || paper === 'LETTER' ? { paper } : {}),
  } as Partial<DraftInput>;
}

export const newDraft = queued(async (
  db: Db,
  input: { type: Exclude<DocumentType, 'cancellation'>; receiptKind?: ReceiptKind; clientId?: number | null } & Clock
): Promise<number> => {
  const business = await getBusiness(db);
  const client = input.clientId ? await getClient(db, input.clientId) : null;
  const d = clientDefaults(business, client);
  return createDraft(
    db,
    {
      type: input.type,
      receiptKind: input.type === 'receipt' ? (input.receiptKind ?? 'cash') : null,
      clientId: client?.id ?? null,
      issueDate: input.today,
      language: d.language,
      currency: d.currency,
      treatment: d.treatment,
      legalNote: input.type === 'invoice' ? await invoiceNote(db, client, d.legalNote, d.language) : d.legalNote,
      buyerReference: client?.buyerReference ?? '',
      paymentDays: input.type === 'invoice' ? d.paymentDays : null,
      validUntil: input.type === 'quote' ? addDays(input.today, DEFAULT_QUOTE_VALID_DAYS) : null,
      ...(await defaultTexts(db, d.language, input.type)),
      ...(await layoutDefaults(db)),
    },
    input.now
  );
});

// ---------------------------------------------------------------------------------------------
// Check + Issue
// ---------------------------------------------------------------------------------------------

/** The mandatory-details check for a stored document (preview panel, Issue); a read unit (review #20). */
export function checkStoredDocument(db: Db, id: number, today: string): Promise<CheckItem[]> {
  return withRead(db, (db) => readCheck(db, id, today));
}

async function readCheck(db: Db, id: number, today: string): Promise<CheckItem[]> {
  const doc = await mustGet(db, id);
  const business = await getBusiness(db);
  const client = doc.clientId ? await getClient(db, doc.clientId) : null;
  const lineNames = (await listLines(db, id)).map((l) => l.name);
  const items = checkDocument({ doc, business, client, totals: await totalsInputFor(db, id), lineNames, today });
  if (hasBlockingErrors(items)) return items;
  // Anything taller than an empty page would be cut off in the PDF: refuse to issue it (D56, review #9).
  const tall = tooTall(buildCtx(await liveModel(db, doc, doc.number, doc.series as RenderModel['series'], doc.dueDate)));
  const errors: CheckItem[] = tall.rows.map((line) => ({ id: 'line_too_tall', severity: 'error', fix: 'lines', sources: [], line }));
  if (tall.intro || tall.blocks.length) {
    errors.push({ id: 'text_too_tall', severity: 'error', fix: tall.blocks.includes('legal') && !tall.intro && tall.blocks.length === 1 ? 'legalNote' : 'texts', sources: [] });
  }
  return [...errors, ...items];
}

/** Render model of a document: the frozen snapshot when issued, else built from live rows (drafts). */
export async function renderModelFor(db: Db, id: number): Promise<RenderModel> {
  const doc = await mustGet(db, id);
  if (doc.status !== 'draft' && doc.snapshot) return JSON.parse(doc.snapshot) as RenderModel;
  return liveModel(db, doc, doc.number, doc.series as RenderModel['series'], doc.type === 'invoice' ? effectiveDueDate(doc) : doc.dueDate);
}

async function liveModel(db: Db, doc: Document, number: string | null, series: RenderModel['series'], dueDate: string | null) {
  let business: RenderModel['business'] = await getBusiness(db);
  let client: RenderModel['client'] = doc.clientId ? await getClient(db, doc.clientId) : null;
  const source = doc.sourceId ? await getDocument(db, doc.sourceId) : null;
  const sourceModel = source?.snapshot && source.type === 'invoice' ? (JSON.parse(source.snapshot) as RenderModel) : null;
  if (sourceModel && doc.type === 'cancellation') {
    // A Storno cancels exactly the invoice that was sent: same recipient, same issuer data, same VAT mode, even
    // if the client or the business was edited since (v1.1 D80, review #3; D51 for the VAT mode).
    business = sourceModel.business;
    client = sourceModel.client;
  } else if (sourceModel && doc.type === 'receipt' && doc.receiptKind === 'payment') {
    // A payment receipt confirms a payment for that invoice: the payer is the invoice's recipient (D80); the
    // business is today's, with the VAT mode the invoice was issued under (D51).
    business = { ...business, vatMode: sourceModel.business.vatMode };
    client = sourceModel.client;
  }
  return buildRenderModel({
    doc,
    number,
    series,
    dueDate,
    business,
    client,
    lines: await listLines(db, doc.id),
    source: source ? { type: source.type, number: source.number, issueDate: source.issueDate } : null,
    // Photos the user marked "print as a page" (V1.5 P1); a Storno never repeats them.
    attachments: doc.type === 'cancellation'
      ? []
      : (await listAttachments(db, doc.id))
        .filter((a) => a.use === 'page' && a.mime !== 'application/pdf')
        .map((a) => ({ file: a.file, name: a.name, width: a.width, height: a.height })),
  });
}

const MAX_NUMBER_SKIPS = 10_000;

async function numberExists(db: Db, series: string, number: string): Promise<boolean> {
  return (await db.getFirstAsync('SELECT 1 FROM documents WHERE series = ? AND number = ?', series, number)) !== null;
}

/**
 * Issue inside an open transaction (D17, D20, D34): a past date becomes today (D54) → check → line nets → number (a reopened quote keeps its
 * own) → ONE UPDATE that moves the status from draft and writes number, series, due date, totals and the
 * snapshot. Numbers that already exist are skipped (D53); a UNIQUE(series, number) clash at the UPDATE takes
 * the next value once more, then fails (V1_PLAN "Numbering").
 */
async function issueInTransaction(db: Db, id: number, clock: Clock): Promise<{ number: string; series: string }> {
  const now = clock.now ?? Date.now();
  let doc = await mustGet(db, id);
  assertCan(doc, 'issue');
  // A draft dated in the past is issued with today's date, so numbers never run backwards in time (D54).
  // "Date of supply = issue date" on such a draft blocks Issue until the user chooses the date (D82, review #5):
  // check before re-dating, or the check would no longer see the old date.
  if (doc.issueDate < clock.today) {
    const before = await checkStoredDocument(db, id, clock.today);
    if (hasBlockingErrors(before)) throw new IssueBlockedError(before.filter((i) => i.severity === 'error'));
    await updateDraft(db, id, { issueDate: clock.today }, now);
    doc = await mustGet(db, id);
  }
  const items = await checkStoredDocument(db, id, clock.today);
  if (hasBlockingErrors(items)) throw new IssueBlockedError(items.filter((i) => i.severity === 'error'));

  const totals = computeTotals(await totalsInputFor(db, id));
  const lineIds = await db.getAllAsync<{ id: number }>('SELECT id FROM document_lines WHERE document_id = ? ORDER BY position, id', id);
  for (let i = 0; i < lineIds.length; i++) {
    await db.runAsync('UPDATE document_lines SET net_cents = ? WHERE id = ?', totals.lines[i].net, lineIds[i].id);
  }
  const dueDate = doc.type === 'invoice' ? effectiveDueDate(doc) : doc.dueDate;
  const series = seriesOf(doc.type);
  const keep = doc.number !== null && doc.series !== null; // reopened quote (D38)
  const business = await getBusiness(db);
  const pattern = await getNumberPattern(db, series, business.language);
  let number = keep ? (doc.number as string) : (await takeNumber(db, doc.type, pattern, doc.issueDate)).number;
  // After a pattern change the counter may format numbers that already exist (e.g. {YYYY} → a literal year,
  // review #4). Skip them: each skipped value belongs to an existing document, so no gap appears (D53).
  for (let skipped = 0; !keep && (await numberExists(db, series, number)); skipped++) {
    if (skipped >= MAX_NUMBER_SKIPS) throw new Error(`issue: ${MAX_NUMBER_SKIPS} numbers in a row already exist; raise "next number"`);
    number = (await takeNumber(db, doc.type, pattern, doc.issueDate)).number;
  }

  for (let attempt = 0; ; attempt++) {
    const snapshot = JSON.stringify(await liveModel(db, doc, number, series, dueDate));
    try {
      const result = await db.runAsync(
        `UPDATE documents SET status = 'issued', series = ?, number = ?, due_date = ?, net_cents = ?, tax_cents = ?,
           gross_cents = ?, snapshot = ?, issued_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'`,
        series, number, dueDate, totals.net, totals.tax, totals.gross, snapshot, now, now, id
      );
      if (result.changes !== 1) throw new Error(`issue: document ${id} changed during Issue`);
      return { number, series };
    } catch (error) {
      if (!isUniqueError(error) || keep || attempt >= 1) throw error;
      number = (await takeNumber(db, doc.type, pattern, doc.issueDate)).number;
    }
  }
}

/** "Issue": assigns the next number in one transaction; a failure rolls the counter back (D17). */
export function issueDocument(db: Db, id: number, clock: Clock) {
  return withTransaction(db, (db) => issueInTransaction(db, id, clock));
}

/**
 * The check's one-tap fix `lines.removeVat` (D51): every line of a draft that shows VAT under a no-VAT
 * treatment or §19 mode gets that treatment's category at 0 %. Returns how many lines changed.
 */
export const removeLineVat = queued(async (db: Db, id: number, now: number = Date.now()): Promise<number> => {
  const doc = await mustGet(db, id);
  assertCan(doc, 'edit');
  const business = await getBusiness(db);
  const target = lineTax(doc.treatment, business.vatMode, 0);
  let changed = 0;
  for (const l of await listLines(db, id)) {
    if (!lineConflicts(doc.treatment, business.vatMode, { category: l.taxCategory, rateBp: l.taxRateBp })) continue;
    await updateLine(db, l.id, { taxCategory: target.category, taxRateBp: target.rateBp });
    changed++;
  }
  if (changed) await refreshDraftTotals(db, id, now);
  return changed;
});

// ---------------------------------------------------------------------------------------------
// Copies: cancellation, conversion, duplicate, payment receipt
// ---------------------------------------------------------------------------------------------

/** Content fields a copy takes over from its source document. */
function contentOf(doc: Document): Omit<DraftInput, 'type' | 'issueDate'> {
  return {
    receiptKind: doc.receiptKind,
    clientId: doc.clientId,
    serviceMode: doc.serviceMode,
    serviceFrom: doc.serviceFrom,
    serviceTo: doc.serviceTo,
    paymentDays: doc.paymentDays,
    reference: doc.reference,
    buyerReference: doc.buyerReference,
    currency: doc.currency,
    language: doc.language,
    pricesIncludeVat: doc.pricesIncludeVat,
    treatment: doc.treatment,
    discountKind: doc.discountKind,
    discountValue: doc.discountValue,
    intro: doc.intro,
    notes: doc.notes,
    paymentText: doc.paymentText,
    footer: doc.footer,
    legalNote: doc.legalNote,
    customFields: doc.customFields,
    template: doc.template,
    accent: doc.accent,
    logoRight: doc.logoRight,
    paper: doc.paper,
    showGirocode: doc.showGirocode,
    depositCents: doc.depositCents,
  };
}

async function copyLines(db: Db, from: DocumentLine[], to: number, qtySign: 1 | -1 = 1) {
  for (const l of from) {
    await addLine(db, to, {
      catalogItemId: l.catalogItemId,
      name: l.name,
      description: l.description,
      qtyMilli: l.qtyMilli * qtySign,
      unitCode: l.unitCode,
      priceE4: l.priceE4,
      taxCategory: l.taxCategory,
      taxRateBp: l.taxRateBp,
      discountKind: l.discountKind,
      discountValue: l.discountValue,
    });
  }
}

/**
 * Storno (D20, SPEC flow 5): a cancellation invoice with every quantity negated (exact negative totals, D35),
 * linked by source_id, numbered in the invoice series and issued in the same transaction; the invoice
 * becomes 'cancelled'. Its lines are inserted while it is still a draft (D34). Payments stay recorded.
 * Offer `duplicateDocument(invoiceId)` afterwards for the corrected copy.
 */
export function cancelInvoice(db: Db, invoiceId: number, clock: Clock): Promise<{ cancellationId: number; number: string }> {
  const now = clock.now ?? Date.now();
  return withTransaction(db, async (db) => {
    const invoice = await mustGet(db, invoiceId);
    assertCan(invoice, 'cancel');
    const content = contentOf(invoice);
    const cancellationId = await createDraft(
      db,
      {
        ...content,
        type: 'cancellation',
        receiptKind: null,
        issueDate: clock.today,
        // The cancellation refers to the original supply: 'same' meant the invoice's own date.
        ...(invoice.serviceMode === 'same' ? { serviceMode: 'date' as const, serviceFrom: invoice.issueDate, serviceTo: null } : {}),
        dueDate: null,
        paymentDays: null,
        depositCents: null,
        sourceId: invoiceId,
        intro: translate(invoice.language, 'doc.cancellation.intro', {
          number: invoice.number ?? '',
          date: formatDate(invoice.issueDate, invoice.language),
        }),
        notes: '',
        paymentText: '',
        showGirocode: false,
      },
      now
    );
    await copyLines(db, await listLines(db, invoiceId), cancellationId, -1);
    const { number } = await issueInTransaction(db, cancellationId, { ...clock, now });
    await updateDocumentState(db, invoiceId, { status: 'cancelled', cancelledAt: now }, now);
    return { cancellationId, number };
  });
}

/** Quote accepted → new invoice draft with all lines; the quote becomes 'invoiced' (SPEC flow 3). */
export function convertQuote(db: Db, quoteId: number, clock: Clock): Promise<number> {
  const now = clock.now ?? Date.now();
  return withTransaction(db, async (db) => {
    const quote = await mustGet(db, quoteId);
    assertCan(quote, 'convert');
    const business = await getBusiness(db);
    const client = quote.clientId ? await getClient(db, quote.clientId) : null;
    const texts = await defaultTexts(db, quote.language, 'invoice');
    const invoiceId = await createDraft(
      db,
      {
        ...contentOf(quote),
        type: 'invoice',
        receiptKind: null,
        issueDate: clock.today,
        validUntil: null,
        dueDate: null,
        paymentDays: paymentDaysFor(client?.paymentDays, business.paymentDays),
        legalNote: await invoiceNote(db, client, quote.legalNote, quote.language),
        sourceId: quoteId,
        intro: texts.intro,
        paymentText: texts.paymentText,
        footer: texts.footer,
      },
      now
    );
    await copyLines(db, await listLines(db, quoteId), invoiceId);
    await refreshDraftTotals(db, invoiceId, now);
    await updateDocumentState(db, quoteId, { status: 'invoiced' }, now);
    return invoiceId;
  });
}

/**
 * Duplicate (also the "corrected copy" after a cancellation): a new draft of the same type with the same
 * client, lines and texts, dated today, no number. Payment terms keep their length.
 */
export function duplicateDocument(db: Db, id: number, clock: Clock): Promise<number> {
  const now = clock.now ?? Date.now();
  return withTransaction(db, async (db) => {
    const doc = await mustGet(db, id);
    assertCan(doc, 'duplicate');
    const paymentDays =
      doc.paymentDays ?? (doc.dueDate && doc.dueDate >= doc.issueDate ? daysBetween(doc.issueDate, doc.dueDate) : null);
    const validDays = doc.validUntil && doc.validUntil >= doc.issueDate ? daysBetween(doc.issueDate, doc.validUntil) : null;
    const copyId = await createDraft(
      db,
      {
        ...contentOf(doc),
        type: doc.type,
        issueDate: clock.today,
        dueDate: null,
        paymentDays: doc.type === 'invoice' ? paymentDays : null,
        validUntil: doc.type === 'quote' ? addDays(clock.today, validDays ?? DEFAULT_QUOTE_VALID_DAYS) : null,
        sourceId: null,
      },
      now
    );
    await copyLines(db, await listLines(db, id), copyId);
    await refreshDraftTotals(db, copyId, now);
    return copyId;
  });
}

/**
 * Payment receipt (D30, amended v1.1 D79) for a (partly) paid invoice: a receipt draft referencing the invoice,
 * for one payment or (without `paymentId`) all payments. It confirms the money received and carries NO VAT
 * breakdown: one line outside the VAT groups (category O, 0 %) and a note that the VAT is shown on the invoice,
 * because the invoice already states the tax for that supply (§ 14c UStG risk, review #1). The amount is capped
 * at the invoice gross minus what earlier payment receipts of this invoice already confirm; a surplus is named
 * as "overpaid by" in the notes, never spread over VAT groups.
 */
export function createPaymentReceipt(db: Db, invoiceId: number, options: Clock & { paymentId?: number }): Promise<number> {
  const now = options.now ?? Date.now();
  return withTransaction(db, async (db) => {
    const invoice = await mustGet(db, invoiceId);
    assertCan(invoice, 'paymentReceipt');
    const payments = await listPayments(db, invoiceId);
    const chosen = options.paymentId === undefined ? payments : payments.filter((p) => p.id === options.paymentId);
    if (chosen.length === 0) throw new Error(`payment receipt: no payment ${options.paymentId ?? ''} on document ${invoiceId}`);
    const amount = chosen.reduce((sum, p) => sum + p.amountCents, 0);
    if (amount <= 0) throw new RangeError('payment receipt: the amount received must be positive');
    const earlier = await db.getFirstAsync<{ sum: number }>(
      "SELECT COALESCE(SUM(gross_cents), 0) AS sum FROM documents WHERE source_id = ? AND type = 'receipt' AND receipt_kind = 'payment'",
      invoiceId
    );
    const room = invoice.grossCents - (earlier?.sum ?? 0);
    if (room <= 0) throw new PaymentReceiptFullError();
    const confirmed = Math.min(amount, room);
    const overpaid = amount - confirmed;
    const date = chosen.map((p) => p.date).sort().at(-1) as string;
    const methods = [...new Set(chosen.map((p) => p.method))];
    const lang = invoice.language;
    const intro =
      methods.length === 1
        ? translate(lang, 'doc.receipt.payment.intro', { date: formatDate(date, lang), method: translate(lang, `payment.method.${methods[0] as PaymentMethod}`) })
        : translate(lang, 'doc.receipt.payment.introNoMethod', { date: formatDate(date, lang) });
    const ref = { number: invoice.number ?? '', date: formatDate(invoice.issueDate, lang) };
    const receiptId = await createDraft(
      db,
      {
        ...contentOf(invoice),
        type: 'receipt',
        receiptKind: 'payment',
        issueDate: options.today,
        serviceMode: 'same',
        serviceFrom: null,
        serviceTo: null,
        dueDate: null,
        paymentDays: null,
        pricesIncludeVat: true,
        discountKind: 'none',
        discountValue: 0,
        depositCents: null,
        sourceId: invoiceId,
        intro,
        notes: overpaid > 0 ? translate(lang, 'doc.receipt.payment.overpaid', { amount: formatMoney(overpaid, invoice.currency, lang) }) : '',
        paymentText: '',
        legalNote: translate(lang, 'doc.receipt.payment.vatNote', ref),
        showGirocode: false,
      },
      now
    );
    await addLine(db, receiptId, {
      name: translate(lang, 'doc.receipt.payment.line', ref),
      qtyMilli: 1000,
      priceE4: confirmed * 100,
      unitCode: 'LS',
      taxCategory: 'O',
      taxRateBp: 0,
    });
    await refreshDraftTotals(db, receiptId, now);
    return receiptId;
  });
}

/** Earlier payment receipts of this invoice already confirm its whole amount (D79). */
export class PaymentReceiptFullError extends Error {
  constructor() {
    super('payment receipt: earlier receipts already cover the invoice amount');
    this.name = 'PaymentReceiptFullError';
  }
}

// ---------------------------------------------------------------------------------------------
// Simple state transitions
// ---------------------------------------------------------------------------------------------

const transition = queued(async (db: Db, id: number, action: 'accept' | 'decline' | 'reopen', now: number = Date.now()) => {
  const doc = await mustGet(db, id);
  const to = assertCan(doc, action);
  await updateDocumentState(db, id, { status: to as Document['status'] }, now);
  // A client signature belongs to the quote as it was accepted: declining or reopening it for edits removes it (V1.5 P1).
  if (action !== 'accept') await deleteDocumentSignature(db, id);
});

/** "Accept with signature" (V1.5 P1, L140-a): the status move and the client's signature in one transaction. */
export function acceptQuoteSigned(db: Db, id: number, signer: string, signature: string, now: number = Date.now()): Promise<void> {
  return withTransaction(db, async (db) => {
    const doc = await mustGet(db, id);
    if (doc.status === 'issued') await transition(db, id, 'accept', now);
    else if (doc.status !== 'accepted') assertCan(doc, 'accept');
    await setDocumentSignature(db, id, signer, signature, now);
  });
}

export const acceptQuote = (db: Db, id: number, now?: number) => transition(db, id, 'accept', now);
export const declineQuote = (db: Db, id: number, now?: number) => transition(db, id, 'decline', now);
/**
 * An issued quote back to draft for editing (D20 "quotes stay editable until accepted", D38). It keeps its
 * number, so issuing it again does not consume a new one.
 */
export const reopenQuote = (db: Db, id: number, now?: number) => transition(db, id, 'reopen', now);

/** "Mark as sent" (share sheet completed or the user says so). */
export const markSent = queued(async (db: Db, id: number, now: number = Date.now()): Promise<void> => {
  assertCan(await mustGet(db, id), 'markSent');
  await updateDocumentState(db, id, { sentAt: now }, now);
});

/** Derived display status from stored status, sent date, payments and dates (SPEC §5.9) — never stored. A read unit. */
export function documentStatus(db: Db, id: number, today: string): Promise<DerivedStatus> {
  return withRead(db, async (db) => {
    const doc = await mustGet(db, id);
    const row = await db.getFirstAsync<{ paid: number }>('SELECT COALESCE(SUM(amount_cents), 0) AS paid FROM payments WHERE document_id = ?', id);
    return deriveStatus({ ...doc, paidCents: row?.paid ?? 0 }, today);
  });
}
