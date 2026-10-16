// CSV export (SPEC §9, D28). PURE: rows in, file text out. Five files: documents (one row per document), lines,
// payments, clients, items. UTF-8 with BOM, CRLF line ends. German: `;` separator and decimal comma; English: `,`
// and decimal point. Amounts are plain decimals without thousands separators (spreadsheets read them as numbers),
// dates are ISO `YYYY-MM-DD` in both languages. Text cells that a spreadsheet would run as a formula (`= + - @`,
// tab, CR) get a leading apostrophe; number cells never do (a cancellation's -12,34 stays a number).
import { daysInMonth, parseIsoDate, toIsoDate } from '@/engine/dates';
import type { Lang } from '@/engine/money';
import { deriveStatus } from '@/engine/status';
import { translate, type TranslationKey } from '@/i18n';
import type { CatalogItem } from '@/db/items';
import type { Client } from '@/db/clients';
import type { Document } from '@/db/documents';
import type { DocumentLine } from '@/db/lines';
import type { Payment } from '@/db/payments';

export type CsvKind = 'documents' | 'lines' | 'payments' | 'clients' | 'items';
export const CSV_KINDS: readonly CsvKind[] = ['documents', 'lines', 'payments', 'clients', 'items'];

export type CsvInput = {
  documents: Document[];
  lines: DocumentLine[];
  payments: Payment[];
  clients: Client[];
  items: CatalogItem[];
};

export type CsvPeriod = { from: string | null; to: string | null };

export type CsvOptions = {
  lang: Lang;
  /** Issue-date range (inclusive) for documents, their lines and payments. Clients and items are always complete. */
  period?: CsvPeriod;
  /** The local calendar day, for the derived status (overdue …). */
  today: string;
};

export type CsvFormat = { separator: ';' | ','; decimal: ',' | '.' };

export function formatFor(lang: Lang): CsvFormat {
  return lang === 'de' ? { separator: ';', decimal: ',' } : { separator: ',', decimal: '.' };
}

// ---------------------------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------------------------

const FORMULA_START = /^'*[=+\-@\t\r]/;

/**
 * Formula-injection guard for TEXT cells: text a spreadsheet would treat as a formula gets one leading
 * apostrophe. Text that already starts with apostrophes before such a character gets one more, so
 * `unguardFormula` can always undo it exactly.
 */
export function guardFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

export function unguardFormula(text: string): string {
  return text.startsWith("'") && FORMULA_START.test(text.slice(1)) ? text.slice(1) : text;
}

/** Integer with `scale` implied decimals as plain text: no grouping, at least `minDecimals` decimals. */
export function plainDecimal(value: number, scale: number, decimal: ',' | '.', minDecimals = scale): string {
  const negative = value < 0;
  const digits = String(Math.abs(value)).padStart(scale + 1, '0');
  const intPart = digits.slice(0, digits.length - scale);
  let frac = digits.slice(digits.length - scale);
  while (frac.length > minDecimals && frac.endsWith('0')) frac = frac.slice(0, -1);
  return `${negative && Number(digits) !== 0 ? '-' : ''}${intPart}${frac ? decimal + frac : ''}`;
}

type Column<R> = {
  key: string;
  de: string;
  en: string;
  /** Number cells are written as they are; text cells go through guardFormula. */
  numeric?: boolean;
  get: (row: R, ctx: Ctx) => string;
};

type Ctx = {
  lang: Lang;
  fmt: CsvFormat;
  today: string;
  clients: Map<number, Client>;
  documents: Map<number, Document>;
  paid: Map<number, number>;
  tr: (key: TranslationKey) => string;
};

const cents = (n: number, ctx: Ctx) => plainDecimal(n, 2, ctx.fmt.decimal);
const yesNo = (b: boolean, ctx: Ctx) => (b ? (ctx.lang === 'de' ? 'ja' : 'yes') : ctx.lang === 'de' ? 'nein' : 'no');

type Snapshot = { client?: { name?: string; vatId?: string; countryCode?: string } | null; business?: unknown } | null;

function snapshotOf(doc: Document): Snapshot {
  if (!doc.snapshot) return null;
  try {
    const parsed: unknown = JSON.parse(doc.snapshot);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Snapshot) : null;
  } catch {
    return null;
  }
}

/** The recipient as it was at Issue (snapshot), else the live client row. */
function recipient(doc: Document, ctx: Ctx): { name: string; vatId: string; country: string } {
  const snap = snapshotOf(doc)?.client;
  if (snap) return { name: snap.name ?? '', vatId: snap.vatId ?? '', country: snap.countryCode ?? '' };
  const live = doc.clientId ? ctx.clients.get(doc.clientId) : undefined;
  return { name: live?.name ?? '', vatId: live?.vatId ?? '', country: live?.countryCode ?? '' };
}

function serviceRange(doc: Document): [string, string] {
  switch (doc.serviceMode) {
    case 'same':
      return [doc.issueDate, doc.issueDate];
    case 'date':
      return [doc.serviceFrom ?? '', doc.serviceFrom ?? ''];
    case 'period':
      return [doc.serviceFrom ?? '', doc.serviceTo ?? ''];
    case 'month': {
      const p = doc.serviceFrom ? parseIsoDate(doc.serviceFrom) : null;
      return p ? [toIsoDate(p.y, p.m, 1), toIsoDate(p.y, p.m, daysInMonth(p.y, p.m))] : ['', ''];
    }
    default:
      return ['', ''];
  }
}

const DOCUMENT_COLUMNS: Column<Document>[] = [
  { key: 'number', de: 'Nummer', en: 'Number', get: (d) => d.number ?? '' },
  { key: 'type', de: 'Typ', en: 'Type', get: (d, c) => c.tr(`doc.type.${d.type}` as TranslationKey) },
  {
    key: 'status',
    de: 'Status',
    en: 'Status',
    get: (d, c) =>
      c.tr(
        `status.${
          deriveStatus({ type: d.type, status: d.status, receiptKind: d.receiptKind, sentAt: d.sentAt, dueDate: d.dueDate, validUntil: d.validUntil, grossCents: d.grossCents, paidCents: c.paid.get(d.id) ?? 0 }, c.today).status
        }` as TranslationKey
      ),
  },
  { key: 'issue_date', de: 'Datum', en: 'Date', get: (d) => d.issueDate },
  { key: 'due_date', de: 'Fällig am', en: 'Due date', get: (d) => d.dueDate ?? '' },
  { key: 'service_from', de: 'Leistung von', en: 'Service from', get: (d) => serviceRange(d)[0] },
  { key: 'service_to', de: 'Leistung bis', en: 'Service to', get: (d) => serviceRange(d)[1] },
  { key: 'client', de: 'Kunde', en: 'Client', get: (d, c) => recipient(d, c).name },
  { key: 'client_vat_id', de: 'USt-IdNr. Kunde', en: 'Client VAT ID', get: (d, c) => recipient(d, c).vatId },
  { key: 'client_country', de: 'Land Kunde', en: 'Client country', get: (d, c) => recipient(d, c).country },
  { key: 'currency', de: 'Währung', en: 'Currency', get: (d) => d.currency },
  { key: 'net', de: 'Netto', en: 'Net', numeric: true, get: (d, c) => cents(d.netCents, c) },
  { key: 'tax', de: 'USt.', en: 'VAT', numeric: true, get: (d, c) => cents(d.taxCents, c) },
  { key: 'gross', de: 'Brutto', en: 'Gross', numeric: true, get: (d, c) => cents(d.grossCents, c) },
  { key: 'paid', de: 'Bezahlt', en: 'Paid', numeric: true, get: (d, c) => (d.type === 'invoice' || d.type === 'receipt' ? cents(c.paid.get(d.id) ?? 0, c) : '') },
  { key: 'balance', de: 'Offen', en: 'Balance', numeric: true, get: (d, c) => (d.type === 'invoice' && d.status !== 'cancelled' ? cents(d.grossCents - (c.paid.get(d.id) ?? 0), c) : '') },
  { key: 'treatment', de: 'Steuerliche Behandlung', en: 'Tax treatment', get: (d, c) => c.tr(`treatment.${d.treatment}` as TranslationKey) },
  { key: 'prices_include_vat', de: 'Preise brutto', en: 'Prices include VAT', get: (d, c) => yesNo(d.pricesIncludeVat, c) },
  { key: 'language', de: 'Sprache', en: 'Language', get: (d) => d.language },
  { key: 'reference', de: 'Referenz', en: 'Reference', get: (d) => d.reference },
  { key: 'buyer_reference', de: 'Leitweg-ID', en: 'Buyer reference', get: (d) => d.buyerReference },
  { key: 'source', de: 'Bezug', en: 'Refers to', get: (d, c) => (d.sourceId ? (c.documents.get(d.sourceId)?.number ?? '') : '') },
];

const numberOf = (documentId: number, ctx: Ctx) => ctx.documents.get(documentId)?.number ?? '';
const typeOf = (documentId: number, ctx: Ctx) => {
  const doc = ctx.documents.get(documentId);
  return doc ? ctx.tr(`doc.type.${doc.type}` as TranslationKey) : '';
};

const LINE_COLUMNS: Column<DocumentLine>[] = [
  { key: 'document', de: 'Dokument', en: 'Document', get: (l, c) => numberOf(l.documentId, c) },
  { key: 'type', de: 'Typ', en: 'Type', get: (l, c) => typeOf(l.documentId, c) },
  { key: 'position', de: 'Position', en: 'Position', numeric: true, get: (l) => String(l.position) },
  { key: 'name', de: 'Bezeichnung', en: 'Name', get: (l) => l.name },
  { key: 'description', de: 'Beschreibung', en: 'Description', get: (l) => l.description },
  { key: 'quantity', de: 'Menge', en: 'Quantity', numeric: true, get: (l, c) => plainDecimal(l.qtyMilli, 3, c.fmt.decimal, 0) },
  { key: 'unit', de: 'Einheit', en: 'Unit', get: (l) => l.unitCode },
  { key: 'unit_price', de: 'Einzelpreis', en: 'Unit price', numeric: true, get: (l, c) => plainDecimal(l.priceE4, 4, c.fmt.decimal, 2) },
  { key: 'vat_category', de: 'USt.-Kategorie', en: 'VAT category', get: (l) => l.taxCategory },
  { key: 'vat_rate', de: 'USt.-Satz %', en: 'VAT rate %', numeric: true, get: (l, c) => plainDecimal(l.taxCategory === 'S' ? l.taxRateBp : 0, 2, c.fmt.decimal, 0) },
  {
    key: 'discount_percent',
    de: 'Rabatt %',
    en: 'Discount %',
    numeric: true,
    get: (l, c) => (l.discountKind === 'percent' ? plainDecimal(l.discountValue, 2, c.fmt.decimal, 0) : ''),
  },
  { key: 'discount_amount', de: 'Rabatt Betrag', en: 'Discount amount', numeric: true, get: (l, c) => (l.discountKind === 'amount' ? cents(l.discountValue, c) : '') },
  { key: 'line_net', de: 'Zeilenbetrag', en: 'Line amount', numeric: true, get: (l, c) => cents(l.netCents, c) },
];

const PAYMENT_COLUMNS: Column<Payment>[] = [
  { key: 'document', de: 'Dokument', en: 'Document', get: (p, c) => numberOf(p.documentId, c) },
  { key: 'date', de: 'Datum', en: 'Date', get: (p) => p.date },
  { key: 'amount', de: 'Betrag', en: 'Amount', numeric: true, get: (p, c) => cents(p.amountCents, c) },
  { key: 'currency', de: 'Währung', en: 'Currency', get: (p, c) => c.documents.get(p.documentId)?.currency ?? '' },
  { key: 'method', de: 'Zahlungsart', en: 'Method', get: (p, c) => c.tr(`payment.method.${p.method}` as TranslationKey) },
  { key: 'note', de: 'Notiz', en: 'Note', get: (p) => p.note },
];

const CLIENT_COLUMNS: Column<Client>[] = [
  { key: 'name', de: 'Name', en: 'Name', get: (r) => r.name },
  { key: 'kind', de: 'Art', en: 'Kind', get: (r) => r.kind },
  { key: 'contact', de: 'Ansprechpartner', en: 'Contact', get: (r) => r.contact },
  { key: 'street', de: 'Straße', en: 'Street', get: (r) => r.street },
  { key: 'postal_code', de: 'PLZ', en: 'Postal code', get: (r) => r.postalCode },
  { key: 'city', de: 'Ort', en: 'City', get: (r) => r.city },
  { key: 'country', de: 'Land', en: 'Country', get: (r) => r.countryCode },
  { key: 'email', de: 'E-Mail', en: 'Email', get: (r) => r.email },
  { key: 'phone', de: 'Telefon', en: 'Phone', get: (r) => r.phone },
  { key: 'vat_id', de: 'USt-IdNr.', en: 'VAT ID', get: (r) => r.vatId },
  { key: 'buyer_reference', de: 'Leitweg-ID', en: 'Buyer reference', get: (r) => r.buyerReference },
  { key: 'treatment', de: 'Steuerliche Behandlung', en: 'Tax treatment', get: (r, c) => c.tr(`treatment.${r.treatment}` as TranslationKey) },
  { key: 'language', de: 'Sprache', en: 'Language', get: (r) => r.language ?? '' },
  { key: 'currency', de: 'Währung', en: 'Currency', get: (r) => r.currency ?? '' },
  { key: 'payment_days', de: 'Zahlungsziel (Tage)', en: 'Payment terms (days)', numeric: true, get: (r) => (r.paymentDays === null ? '' : String(r.paymentDays)) },
  { key: 'notes', de: 'Notizen', en: 'Notes', get: (r) => r.notes },
  { key: 'ship_name', de: 'Lieferanschrift Name', en: 'Delivery name', get: (r) => r.shipName },
  { key: 'ship_street', de: 'Lieferanschrift Straße', en: 'Delivery street', get: (r) => r.shipStreet },
  { key: 'ship_postal_code', de: 'Lieferanschrift PLZ', en: 'Delivery postal code', get: (r) => r.shipPostalCode },
  { key: 'ship_city', de: 'Lieferanschrift Ort', en: 'Delivery city', get: (r) => r.shipCity },
  { key: 'ship_country', de: 'Lieferanschrift Land', en: 'Delivery country', get: (r) => r.shipCountryCode },
  { key: 'archived', de: 'Archiviert', en: 'Archived', get: (r, c) => yesNo(r.archived, c) },
];

const ITEM_COLUMNS: Column<CatalogItem>[] = [
  { key: 'name', de: 'Name', en: 'Name', get: (r) => r.name },
  { key: 'description', de: 'Beschreibung', en: 'Description', get: (r) => r.description },
  { key: 'unit', de: 'Einheit', en: 'Unit', get: (r) => r.unitCode },
  { key: 'sku', de: 'Artikelnr.', en: 'SKU', get: (r) => r.sku },
  { key: 'price', de: 'Preis', en: 'Price', numeric: true, get: (r, c) => plainDecimal(r.priceE4, 4, c.fmt.decimal, 2) },
  { key: 'price_includes_vat', de: 'Preis brutto', en: 'Price includes VAT', get: (r, c) => yesNo(r.priceIncludesVat, c) },
  { key: 'vat_category', de: 'USt.-Kategorie', en: 'VAT category', get: (r) => r.taxCategory },
  { key: 'vat_rate', de: 'USt.-Satz %', en: 'VAT rate %', numeric: true, get: (r, c) => plainDecimal(r.taxCategory === 'S' ? r.taxRateBp : 0, 2, c.fmt.decimal, 0) },
  { key: 'archived', de: 'Archiviert', en: 'Archived', get: (r, c) => yesNo(r.archived, c) },
];

// ---------------------------------------------------------------------------------------------
// Selection and tables
// ---------------------------------------------------------------------------------------------

function inPeriod(date: string, period: CsvPeriod | undefined): boolean {
  if (!period) return true;
  return (period.from === null || date >= period.from) && (period.to === null || date <= period.to);
}

function context(input: CsvInput, options: CsvOptions): { ctx: Ctx; documents: Document[] } {
  // Drafts have no number and no final amounts: never exported.
  const documents = input.documents.filter((d) => d.status !== 'draft' && inPeriod(d.issueDate, options.period));
  const paid = new Map<number, number>();
  for (const p of input.payments) paid.set(p.documentId, (paid.get(p.documentId) ?? 0) + p.amountCents);
  const ctx: Ctx = {
    lang: options.lang,
    fmt: formatFor(options.lang),
    today: options.today,
    clients: new Map(input.clients.map((c) => [c.id, c])),
    // every document, so "Refers to" can name a source outside the period
    documents: new Map(input.documents.map((d) => [d.id, d])),
    paid,
    tr: (key) => translate(options.lang, key),
  };
  return { ctx, documents };
}

export type CsvTable = { header: string[]; rows: string[][] };

function table<R>(columns: Column<R>[], rows: R[], ctx: Ctx): CsvTable {
  return {
    header: columns.map((c) => c[ctx.lang]),
    rows: rows.map((row) => columns.map((c) => (c.numeric ? c.get(row, ctx) : guardFormula(c.get(row, ctx))))),
  };
}

/** The table behind a CSV file (guarded cells, before quoting). */
export function csvTable(kind: CsvKind, input: CsvInput, options: CsvOptions): CsvTable {
  const { ctx, documents } = context(input, options);
  const ids = new Set(documents.map((d) => d.id));
  switch (kind) {
    case 'documents':
      return table(DOCUMENT_COLUMNS, documents, ctx);
    case 'lines':
      return table(LINE_COLUMNS, input.lines.filter((l) => ids.has(l.documentId)), ctx);
    case 'payments':
      return table(PAYMENT_COLUMNS, input.payments.filter((p) => ids.has(p.documentId)), ctx);
    case 'clients':
      return table(CLIENT_COLUMNS, input.clients, ctx);
    case 'items':
      return table(ITEM_COLUMNS, input.items, ctx);
  }
}

/** Which columns of a kind hold numbers (round-trip tests and a future import). */
export function numericColumns(kind: CsvKind): string[] {
  const all = { documents: DOCUMENT_COLUMNS, lines: LINE_COLUMNS, payments: PAYMENT_COLUMNS, clients: CLIENT_COLUMNS, items: ITEM_COLUMNS }[kind] as Column<never>[];
  return all.filter((c) => c.numeric).map((c) => c.key);
}

export function columnKeys(kind: CsvKind): string[] {
  const all = { documents: DOCUMENT_COLUMNS, lines: LINE_COLUMNS, payments: PAYMENT_COLUMNS, clients: CLIENT_COLUMNS, items: ITEM_COLUMNS }[kind] as Column<never>[];
  return all.map((c) => c.key);
}

// ---------------------------------------------------------------------------------------------
// Serialising and parsing (RFC 4180)
// ---------------------------------------------------------------------------------------------

/** Quote a field holding the separator, a quote, CR or LF; double inner quotes. */
export function csvField(value: string, separator: string): string {
  return value.includes(separator) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function serialize(tableData: CsvTable, separator: string): string {
  const lines = [tableData.header, ...tableData.rows].map((row) => row.map((v) => csvField(v, separator)).join(separator));
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function buildCsv(kind: CsvKind, input: CsvInput, options: CsvOptions): string {
  return serialize(csvTable(kind, input, options), formatFor(options.lang).separator);
}

export function csvFileName(kind: CsvKind, date: string): string {
  return `invoice-maker-${kind}-${date}.csv`;
}

export type CsvFile = { kind: CsvKind; fileName: string; text: string };

/** All five files for a period (the export screen shares them together). */
export function buildAllCsv(input: CsvInput, options: CsvOptions): CsvFile[] {
  return CSV_KINDS.map((kind) => ({ kind, fileName: csvFileName(kind, options.today), text: buildCsv(kind, input, options) }));
}

/** Parses CSV text (BOM, quoted fields with separators/quotes/line breaks, CRLF or LF) into rows of cells. */
export function parseCsv(text: string, separator: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false; // anything read for the current row
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      started = true;
    } else if (ch === separator) {
      row.push(field);
      field = '';
      started = true;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      started = false;
    } else {
      field += ch;
      started = true;
    }
  }
  if (started || field !== '') {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export type CsvPeriodChoice = 'thisYear' | 'lastYear' | 'all';

/** The period chooser of Settings → Backup & data → Export CSV (SPEC §7 flow 8), by issue date. */
export function csvPeriod(choice: CsvPeriodChoice, today: string): CsvPeriod {
  if (choice === 'all') return { from: null, to: null };
  const year = Number(today.slice(0, 4)) - (choice === 'lastYear' ? 1 : 0);
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}
