// Mandatory-details check before Issue (D21, D30, SPEC F6/§10). PURE.
// Lists what is missing as information ("usually required", with the source) and never blocks Issue,
// except hard errors: no line, invalid numbers (SPEC §5 step 10), a negative total, a missing currency, and a
// VAT line on a §19 small business's document (D51: the PDF would state VAT the business says it does not charge) or
// on a document whose treatment has no VAT (reverse charge, intra-EU, export, exempt; D83).
// Item texts: i18n keys `check.<id>`; the check screen also shows `check.notAdvice`.
import { isCurrencyCode } from './money';
import { hasPlaceholder, LEGAL_NOTES, noteIdFor, SOURCES, type LegalSource } from './notes';
import type { DocumentType } from './numbering';
import { MAX_PAYMENT_DAYS, type ReceiptKind } from './status';
import { computeTotals, validateTotals, type TotalsInput } from './totals';
import { lineConflicts, type Treatment, type VatMode } from './treatment';

export type Severity = 'error' | 'warn' | 'info';

export type CheckId =
  // hard errors (block Issue)
  | 'no_lines'
  | 'too_many_lines'
  | 'qty_zero'
  | 'negative_qty'
  | 'negative_price'
  | 'invalid_rate'
  | 'line_discount_too_large'
  | 'document_discount_too_large'
  | 'amount_too_large'
  | 'negative_total'
  | 'currency_missing'
  | 'small_business_vat'
  | 'line_too_tall'
  | 'payment_days_invalid'
  | 'text_too_tall'
  // usually required / worth a look
  | 'business_name'
  | 'business_address'
  | 'business_tax_id'
  | 'own_vat_id_missing'
  | 'client_missing'
  | 'client_name'
  | 'line_name_missing'
  | 'client_address'
  | 'client_vat_id_missing'
  | 'service_date_missing'
  | 'service_period_invalid'
  | 'due_before_issue'
  | 'legal_note_missing'
  | 'legal_note_placeholder'
  | 'vat_lines_conflict'
  | 'receipt_over_250'
  | 'issue_date_future'
  | 'issue_date_past'
  /** A past-dated draft whose date of supply is "same as issue date": the user picks the date (v1.1 D82). */
  | 'service_date_stale'
  | 'valid_until_missing';

/** Where "Fix" leads (P4 maps these to screens/fields). */
export type FixTarget =
  | 'business'
  | 'business.address'
  | 'business.taxId'
  | 'business.vatId'
  | 'client'
  | 'client.address'
  | 'client.vatId'
  | 'lines'
  /** One tap: every line with VAT gets the treatment's no-VAT category at 0 % (`removeLineVat`). */
  | 'lines.removeVat'
  | 'serviceDate'
  | 'issueDate'
  | 'dueDate'
  | 'validUntil'
  | 'legalNote'
  /** Intro, notes, payment text or closing text. */
  | 'texts'
  | 'currency'
  | 'discount';

export type CheckItem = {
  id: CheckId;
  severity: Severity;
  fix: FixTarget;
  sources: LegalSource[];
  /** Line index for line-specific errors. */
  line?: number;
  /** `service_date_stale`: the draft's own (old) date, offered as one of the two choices. */
  date?: string;
};

export type CheckDocument = {
  type: DocumentType;
  receiptKind: ReceiptKind | null;
  issueDate: string;
  serviceMode: 'same' | 'date' | 'period' | 'month' | 'none';
  serviceFrom: string | null;
  serviceTo: string | null;
  dueDate: string | null;
  validUntil: string | null;
  /** Payment term in days (invoices); the due date at Issue = issue date + this. */
  paymentDays: number | null;
  currency: string;
  treatment: Treatment;
  legalNote: string;
};

export type CheckBusiness = {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  taxNumber: string;
  vatId: string;
  vatMode: VatMode;
};

export type CheckClient = { name: string; street: string; postalCode: string; city: string; vatId: string } | null;

export type CheckInput = {
  doc: CheckDocument;
  business: CheckBusiness;
  client: CheckClient;
  totals: TotalsInput;
  /** Line names in line order (the kind of service, §14 Abs. 4 Nr. 5 UStG). */
  lineNames: string[];
  /** Local calendar day 'YYYY-MM-DD'. */
  today: string;
};

/** §33 UStDV small-amount limit: 250 € gross. */
export const SMALL_AMOUNT_CENTS = 25_000;

const blank = (s: string | null | undefined) => (s ?? '').trim() === '';
const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

export function hasBlockingErrors(items: CheckItem[]): boolean {
  return items.some((i) => i.severity === 'error');
}

export function checkDocument(input: CheckInput): CheckItem[] {
  const { doc, business, client, today } = input;
  const items: CheckItem[] = [];
  const add = (id: CheckId, severity: Severity, fix: FixTarget, sources: LegalSource[] = [], line?: number) =>
    items.push(line === undefined ? { id, severity, fix, sources } : { id, severity, fix, sources, line });

  // Hard errors -------------------------------------------------------------------------------
  const isCancellation = doc.type === 'cancellation';
  for (const issue of validateTotals(input.totals, { allowNegative: isCancellation })) {
    const fix: FixTarget = issue.code === 'document_discount_too_large' ? 'discount' : 'lines';
    add(issue.code, 'error', fix, [], 'line' in issue ? issue.line : undefined);
  }
  if (!isCurrencyCode(doc.currency)) add('currency_missing', 'error', 'currency');
  const days = doc.paymentDays;
  if (doc.type === 'invoice' && days !== null && (!Number.isInteger(days) || days < 0 || days > MAX_PAYMENT_DAYS)) {
    add('payment_days_invalid', 'error', 'dueDate'); // review #17: Issue would otherwise throw a bare RangeError
  }
  let gross = 0;
  try {
    gross = computeTotals(input.totals).gross;
  } catch {
    // reported as amount_too_large above
  }
  if (!isCancellation && gross < 0) add('negative_total', 'error', 'lines');
  if (isCancellation) return sortItems(items); // a copy of an issued invoice: nothing else to check

  // Who issues it (all types) -----------------------------------------------------------------
  const isPaymentReceipt = doc.type === 'receipt' && doc.receiptKind === 'payment';
  const isCashReceipt = doc.type === 'receipt' && !isPaymentReceipt;
  const isInvoice = doc.type === 'invoice';
  const smallAmount =
    doc.currency === 'EUR' && gross <= SMALL_AMOUNT_CENTS &&
    doc.treatment !== 'reverse_charge' && doc.treatment !== 'intra_eu_goods';
  const lawFor = isCashReceipt || (isInvoice && smallAmount) ? [SOURCES.ustdv33] : isInvoice ? [SOURCES.ustg14] : [];

  if (blank(business.name)) add('business_name', 'warn', 'business', lawFor);
  if (blank(business.street) || blank(business.postalCode) || blank(business.city)) {
    add('business_address', 'warn', 'business.address', lawFor);
  }
  // Recipient name (§14 Abs. 4 Nr. 1) and kind of service (Nr. 5; §33 UStDV for small amounts), review #7.
  if (client && blank(client.name)) add('client_name', 'warn', 'client', lawFor);
  const unnamed = input.lineNames.findIndex((name) => blank(name));
  if (unnamed >= 0) add('line_name_missing', 'warn', 'lines', lawFor, unnamed);
  if (doc.issueDate > today) add('issue_date_future', 'info', 'issueDate');
  else if (doc.issueDate < today && (isInvoice || isCashReceipt) && doc.serviceMode === 'same') {
    // Issue re-dates the draft to today (D54); "same as issue date" would then print a date of supply nobody
    // chose. Block until the user picks today or the draft's date (v1.1 D82, review #5).
    items.push({ id: 'service_date_stale', severity: 'error', fix: 'serviceDate', sources: [SOURCES.ustg14], date: doc.issueDate });
  } else if (doc.issueDate < today) add('issue_date_past', 'info', 'issueDate'); // Issue re-dates it (D54)

  if (doc.type === 'quote') {
    if (!client) add('client_missing', 'warn', 'client');
    if (blank(doc.validUntil)) add('valid_until_missing', 'info', 'validUntil');
  }

  if (isCashReceipt && (doc.currency !== 'EUR' || gross > SMALL_AMOUNT_CENTS)) {
    add('receipt_over_250', 'warn', 'client', [SOURCES.ustdv33]);
  }

  if (isInvoice) {
    if (!smallAmount && blank(business.taxNumber) && blank(business.vatId)) {
      add('business_tax_id', 'warn', 'business.taxId', [SOURCES.ustg14]);
    }
    if (!client) {
      if (!smallAmount) add('client_missing', 'warn', 'client', [SOURCES.ustg14]);
    } else if (!smallAmount && (blank(client.street) || blank(client.postalCode) || blank(client.city))) {
      add('client_address', 'warn', 'client.address', [SOURCES.ustg14]);
    }
    if (!smallAmount) checkServiceDate(doc, add);
    if (doc.dueDate !== null && doc.dueDate < doc.issueDate) add('due_before_issue', 'warn', 'dueDate');
  }

  // Treatment notes (invoices, receipts and quotes; a payment receipt copies its invoice's note) ----
  if (!isPaymentReceipt) {
    const noteId = noteIdFor(doc.treatment, business.vatMode);
    const noteSources = noteId ? LEGAL_NOTES[noteId].sources : [];
    if (noteId && blank(doc.legalNote)) add('legal_note_missing', doc.type === 'quote' ? 'info' : 'warn', 'legalNote', noteSources);
    if (hasPlaceholder(doc.legalNote)) add('legal_note_placeholder', 'warn', 'legalNote', noteSources);
    const conflict = input.totals.lines.findIndex((l) => lineConflicts(doc.treatment, business.vatMode, l));
    if (conflict >= 0 && business.vatMode === 'small_business') {
      add('small_business_vat', 'error', 'lines.removeVat', LEGAL_NOTES.small_business.sources, conflict);
    } else if (conflict >= 0) {
      // A document that calls the supply tax-free (or the client liable) and still shows VAT: tax shown on an invoice
      // is owed (§ 14c Abs. 1 UStG), so this blocks like the §19 case (v1.1 D83, review #6). One tap fixes it; a
      // user who really means VAT switches the treatment to Standard.
      add('vat_lines_conflict', 'error', 'lines.removeVat', [...noteSources, SOURCES.ustg14c], conflict);
    }
    if (doc.treatment === 'reverse_charge' || doc.treatment === 'intra_eu_goods') {
      if (doc.type !== 'quote' && client && blank(client.vatId)) add('client_vat_id_missing', 'warn', 'client.vatId', [SOURCES.ustg14a]);
      if (doc.type !== 'quote' && blank(business.vatId)) add('own_vat_id_missing', 'warn', 'business.vatId', [SOURCES.ustg14a]);
    }
  }
  return sortItems(items);
}

function checkServiceDate(doc: CheckDocument, add: (id: CheckId, s: Severity, f: FixTarget, src?: LegalSource[]) => void) {
  const sources = [SOURCES.ustg14, SOURCES.ustdv31];
  switch (doc.serviceMode) {
    case 'same':
      return; // "Leistungsdatum entspricht Rechnungsdatum" (RESEARCH §2.1)
    case 'none':
      return add('service_date_missing', 'warn', 'serviceDate', sources);
    case 'date':
    case 'month':
      if (blank(doc.serviceFrom)) add('service_date_missing', 'warn', 'serviceDate', sources);
      return;
    case 'period':
      if (blank(doc.serviceFrom) || blank(doc.serviceTo)) return add('service_date_missing', 'warn', 'serviceDate', sources);
      if ((doc.serviceTo as string) < (doc.serviceFrom as string)) add('service_period_invalid', 'warn', 'serviceDate', sources);
  }
}

function sortItems(items: CheckItem[]): CheckItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => SEVERITY_ORDER[a.item.severity] - SEVERITY_ORDER[b.item.severity] || a.index - b.index)
    .map((x) => x.item);
}
