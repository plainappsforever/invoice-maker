// Backup (SPEC §9, D28; V1.5 P1 format 2). PURE: build, strict validation and a restore plan; the database side
// (read everything, replace everything in one transaction) is src/db/restore.ts. Validation never throws: a
// wrong, corrupt or newer file comes back as { ok: false, error } and nothing is touched.
//
// Format 1 (v1.x, still restored): one JSON file { format: 'invoice-maker-backup', version: 1, schemaVersion, app,
// exportedAt, data: { tables … }, files: { 'logo/<name>.png': base64 } }.
// Format 2 (V1.5): a ZIP with `backup.json` (the same JSON, version 2, `files` empty) and every file the data refers
// to as `files/<relative path>` (logos, attachment photos and PDFs, item photos), stored byte for byte. JSON cannot
// carry photos sensibly, and a restore that silently dropped them would weaken the backup (WORKFLOW L11).
// Rows use exactly the SQLite column names. Issued documents are restored from their snapshots (their PDFs are
// rendered again on demand: `pdf_file` is not part of the file). Columns and tables added by a later schema are
// filled with their defaults when an older file is restored (`since`).
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';

import { isValidIsoDate } from '@/engine/dates';
import { MAX_ABS_CENTS } from '@/engine/money';
import { seriesOf, type DocumentType } from '@/engine/numbering';
import { parseSignature } from '@/engine/signature';
import { RENDER_MODEL_VERSION } from '@/render/model';

export const BACKUP_FORMAT = 'invoice-maker-backup';
/** Version of this file format. A file with a higher number was made by a newer app. */
export const BACKUP_VERSION = 2;
/**
 * Oldest database schema whose backups can be restored. Migration 2 created the Invoice Maker tables. A later
 * migration that changes columns adds an upgrader for the older schemas here (none needed yet: 2 is the latest).
 */
export const MIN_BACKUP_SCHEMA = 2;
/** Refuse anything larger before parsing it (logos are ≤ 600 px PNGs; real backups are far smaller). */
export const MAX_BACKUP_CHARS = 60_000_000;
const MAX_LOGO_CHARS = 4_000_000;
/** ZIP limits, checked from the directory before anything is inflated (zip bombs). */
export const MAX_ZIP_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 600 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 5_000;
/** Settings that belong to this phone, not to the data: never written to a backup, never overwritten by a restore. */
export const DEVICE_SETTINGS: readonly string[] = ['theme', 'ui_language', 'notif_asked', 'last_backup_at'];

export type Row = Record<string, string | number | null>;

export type BackupData = {
  settings: Record<string, string>;
  business: Row[];
  tax_rates: Row[];
  clients: Row[];
  catalog_items: Row[];
  documents: Row[];
  document_lines: Row[];
  payments: Row[];
  number_counters: Row[];
  attachments: Row[];
  signatures: Row[];
};

export type BackupFile = {
  format: typeof BACKUP_FORMAT;
  version: number;
  schemaVersion: number;
  app: string;
  exportedAt: string;
  data: BackupData;
  files: Record<string, string>;
};

// ---------------------------------------------------------------------------------------------
// Table definitions (the columns of migration 2, without documents.pdf_file)
// ---------------------------------------------------------------------------------------------

type Col = {
  name: string;
  type: 'int' | 'text';
  nullable?: boolean;
  enum?: readonly string[];
  min?: number;
  max?: number;
  bool?: boolean;
  date?: boolean;
  nonEmpty?: boolean;
  pattern?: RegExp;
  json?: 'array' | 'object';
  /** Schema version that added the column; an older file gets `fallback`. */
  since?: number;
  fallback?: string | number | null;
  file?: boolean;
  signature?: boolean;
};

const SAFE = Number.MAX_SAFE_INTEGER;
const int = (name: string, o: Partial<Col> = {}): Col => ({ name, type: 'int', ...o });
const text = (name: string, o: Partial<Col> = {}): Col => ({ name, type: 'text', ...o });
const bool = (name: string): Col => int(name, { bool: true, min: 0, max: 1 });
const money = (name: string, o: Partial<Col> = {}): Col => int(name, { min: -MAX_ABS_CENTS, max: MAX_ABS_CENTS, ...o });
const date = (name: string, o: Partial<Col> = {}): Col => text(name, { date: true, ...o });
const stamp = (name: string, nullable = false): Col => int(name, { min: 0, max: SAFE, nullable });

const LANG = ['de', 'en'] as const;
const TREATMENTS = ['standard', 'reverse_charge', 'intra_eu_goods', 'export', 'exempt'] as const;
const CATEGORIES = ['S', 'Z', 'E', 'AE', 'K', 'G', 'O'] as const;
const DISCOUNT_KINDS = ['none', 'percent', 'amount'] as const;
const CURRENCY = /^[A-Z]{3}$/;
/** Relative names of stored files (uuid names written by src/lib/files.ts). Never '..', never absolute. */
export const FILE_PATH = /^(logo|attachments|items)\/[A-Za-z0-9._-]{1,100}\.(png|jpe?g|pdf)$/;
const v5 = <T extends Col>(c: T, fallback: string | number | null): T => ({ ...c, since: 5, fallback });

export const TABLES = {
  business: [
    int('id', { min: 1, max: 1 }), text('name'), text('street'), text('postal_code'), text('city'), text('country_code'),
    text('email'), text('phone'), text('website'), text('tax_number'), text('vat_id'), text('iban'), text('bic'),
    text('bank_name'), text('account_holder'), text('logo_file', { nullable: true }),
    text('vat_mode', { enum: ['standard', 'small_business'] }), text('currency', { pattern: CURRENCY }),
    text('language', { enum: LANG }), int('payment_days', { min: 0, max: 365 }), text('footer'), stamp('updated_at'),
    v5(text('signature', { nullable: true, signature: true }), null),
  ],
  tax_rates: [
    int('id', { min: 1, max: SAFE }), text('label', { nonEmpty: true }), int('rate_bp', { min: 0, max: 10_000 }),
    bool('is_default'), bool('archived'), int('sort', { min: -SAFE, max: SAFE }),
  ],
  clients: [
    int('id', { min: 1, max: SAFE }), text('kind', { enum: ['business', 'person'] }), text('name', { nonEmpty: true }),
    text('contact'), text('street'), text('postal_code'), text('city'), text('country_code'), text('email'), text('phone'),
    text('vat_id'), text('buyer_reference'), text('treatment', { enum: TREATMENTS }),
    text('language', { nullable: true, enum: LANG }), text('currency', { nullable: true, pattern: CURRENCY }),
    int('payment_days', { nullable: true, min: 0, max: 365 }), text('notes'), bool('archived'), stamp('created_at'), stamp('updated_at'),
    v5(text('ship_name'), ''), v5(text('ship_street'), ''), v5(text('ship_postal_code'), ''), v5(text('ship_city'), ''),
    v5(text('ship_country_code'), ''),
  ],
  catalog_items: [
    int('id', { min: 1, max: SAFE }), text('name', { nonEmpty: true }), text('description'), text('unit_code'), text('sku'),
    int('price_e4', { min: -SAFE, max: SAFE }), bool('price_includes_vat'), text('tax_category', { enum: CATEGORIES }),
    int('tax_rate_bp', { min: 0, max: 10_000 }), bool('archived'), stamp('created_at'), stamp('updated_at'),
    v5(text('image_file', { nullable: true, file: true }), null),
  ],
  documents: [
    int('id', { min: 1, max: SAFE }), text('type', { enum: ['invoice', 'quote', 'receipt', 'cancellation'] }),
    text('receipt_kind', { nullable: true, enum: ['payment', 'cash'] }),
    text('status', { enum: ['draft', 'issued', 'cancelled', 'accepted', 'declined', 'invoiced'] }),
    text('series', { nullable: true, enum: ['invoice', 'quote', 'receipt'] }), text('number', { nullable: true, nonEmpty: true }),
    int('client_id', { nullable: true, min: 1, max: SAFE }), date('issue_date'),
    text('service_mode', { enum: ['same', 'date', 'period', 'month', 'none'] }), date('service_from', { nullable: true }),
    date('service_to', { nullable: true }), date('due_date', { nullable: true }), date('valid_until', { nullable: true }),
    int('payment_days', { nullable: true, min: 0, max: 365 }), text('reference'), text('buyer_reference'),
    text('currency', { pattern: CURRENCY }), text('language', { enum: LANG }), bool('prices_include_vat'),
    text('treatment', { enum: TREATMENTS }), text('discount_kind', { enum: DISCOUNT_KINDS }),
    int('discount_value', { min: -SAFE, max: SAFE }), text('intro'), text('notes'), text('payment_text'), text('footer'),
    text('legal_note'), text('custom_fields', { json: 'array' }), text('template', { nonEmpty: true }),
    text('accent', { pattern: /^#[0-9a-fA-F]{6}$/ }), bool('logo_right'), text('paper', { enum: ['A4', 'LETTER'] }),
    bool('show_girocode'), money('deposit_cents', { nullable: true }), int('source_id', { nullable: true, min: 1, max: SAFE }),
    money('net_cents'), money('tax_cents'), money('gross_cents'), text('snapshot', { nullable: true, json: 'object' }),
    stamp('sent_at', true), stamp('issued_at', true), stamp('cancelled_at', true), stamp('created_at'), stamp('updated_at'),
  ],
  document_lines: [
    int('id', { min: 1, max: SAFE }), int('document_id', { min: 1, max: SAFE }), int('position', { min: 0, max: 100_000 }),
    int('catalog_item_id', { nullable: true, min: 1, max: SAFE }), text('name'), text('description'),
    int('qty_milli', { min: -SAFE, max: SAFE }), text('unit_code'), int('price_e4', { min: -SAFE, max: SAFE }),
    text('tax_category', { enum: CATEGORIES }), int('tax_rate_bp', { min: 0, max: 10_000 }),
    text('discount_kind', { enum: DISCOUNT_KINDS }), int('discount_value', { min: -SAFE, max: SAFE }), money('net_cents'),
    v5(text('image_file', { nullable: true, file: true }), null),
  ],
  payments: [
    int('id', { min: 1, max: SAFE }), int('document_id', { min: 1, max: SAFE }), date('date'), money('amount_cents'),
    text('method', { enum: ['bank', 'cash', 'card', 'paypal', 'other'] }), text('note'), stamp('created_at'),
  ],
  number_counters: [text('series_key', { nonEmpty: true }), int('next_value', { min: 1, max: SAFE }), int('max_used', { min: 0, max: SAFE })],
  attachments: [
    int('id', { min: 1, max: SAFE }), int('document_id', { min: 1, max: SAFE }), text('file', { file: true }), text('name'),
    text('mime', { enum: ['image/jpeg', 'image/png', 'application/pdf'] }), int('width', { nullable: true, min: 1, max: 100_000 }),
    int('height', { nullable: true, min: 1, max: 100_000 }), int('bytes', { min: 0, max: MAX_ZIP_FILE_BYTES }),
    text('use', { enum: ['page', 'mail', 'keep'] }), int('position', { min: 0, max: 100_000 }), stamp('created_at'),
  ],
  signatures: [int('document_id', { min: 1, max: SAFE }), text('signer'), text('data', { signature: true }), stamp('signed_at')],
} as const satisfies Record<string, readonly Col[]>;
/** Tables added by a later schema: an older file has none of their rows. */
const TABLE_SINCE: Partial<Record<keyof typeof TABLES, number>> = { attachments: 5, signatures: 5 };

export type TableName = keyof typeof TABLES;
/** Order that satisfies foreign keys when inserting (restore deletes in the reverse order). */
export const TABLE_ORDER: readonly TableName[] = [
  'business', 'tax_rates', 'clients', 'catalog_items', 'documents', 'document_lines', 'payments', 'number_counters',
  'attachments', 'signatures',
];
export const columnNames = (table: TableName): string[] => TABLES[table].map((c) => c.name);

// ---------------------------------------------------------------------------------------------
// Errors and results
// ---------------------------------------------------------------------------------------------

export type BackupErrorCode =
  | 'tooLarge' // over MAX_BACKUP_CHARS
  | 'notJson' // not parseable (truncated, corrupt, not text)
  | 'notInvoiceMaker' // valid JSON, but not our file → "This is not an Invoice Maker backup"
  | 'newerVersion' // made by a newer app → "Update the app first"
  | 'unsupported' // made before the Invoice Maker tables existed
  | 'shape' // a field is missing, unknown, has the wrong type, range or format
  | 'duplicate' // two rows with the same id, or the same (series, number)
  | 'reference' // a row points at a row that is not in the file
  | 'inconsistent'; // rows contradict each other (totals, snapshot, status)

export type BackupError = { code: BackupErrorCode; detail: string };

export type BackupCounts = {
  invoices: number;
  cancellations: number;
  quotes: number;
  receipts: number;
  drafts: number;
  clients: number;
  items: number;
  payments: number;
  lines: number;
};

export type RestorePlan = {
  counts: BackupCounts;
  schemaVersion: number;
  exportedAt: string;
  /** Hash over all rows: the same data gives the same hash (A11 "count + hash"). */
  hash: string;
  /** Files the restore writes back (relative to the document directory): logos, attachments, item photos. */
  logoFiles: string[];
  /** Files the data refers to that the backup does not contain (their documents keep their rows; the photo is gone). */
  missingFiles: string[];
  /** 1 = JSON file of v1.x, 2 = ZIP. */
  formatVersion: number;
  /** Filled by the database side (`previewRestore`, restore results): what this phone has that the file lacks. */
  phone?: PhoneComparison;
};

/** A number counter this phone is further along than the backup: the restore keeps the phone's value (D52). */
export type CounterKept = { seriesKey: string; fileNext: number; phoneNext: number };
export type PhoneComparison = {
  countersKept: CounterKept[];
  /** Numbers issued on this phone that the backup does not contain (they are replaced, never handed out again). */
  phoneOnlyNumbers: string[];
};

export type BackupParse = { ok: true; file: BackupFile; plan: RestorePlan } | { ok: false; error: BackupError };

class Invalid extends Error {
  constructor(readonly code: BackupErrorCode, detail: string) {
    super(detail);
  }
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

export function backupFileName(date: string): string {
  return `invoice-maker-backup-${date}.zip`;
}

export function buildBackup(
  data: BackupData,
  options: { schemaVersion: number; exportedAt: string; app: string; files?: Record<string, string> }
): BackupFile {
  const settings: Record<string, string> = {};
  for (const key of Object.keys(data.settings).sort()) if (!DEVICE_SETTINGS.includes(key)) settings[key] = data.settings[key];
  const files: Record<string, string> = {};
  for (const key of Object.keys(options.files ?? {}).sort()) files[key] = (options.files as Record<string, string>)[key];
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schemaVersion: options.schemaVersion,
    app: options.app,
    exportedAt: options.exportedAt,
    data: { ...data, settings },
    files,
  };
}

export function serializeBackup(file: BackupFile): string {
  return `${JSON.stringify(file, null, 1)}\n`;
}

export function countsOf(data: BackupData): BackupCounts {
  const docs = data.documents;
  const ofType = (t: string) => docs.filter((d) => d.type === t && d.status !== 'draft').length;
  return {
    invoices: ofType('invoice'),
    cancellations: ofType('cancellation'),
    quotes: ofType('quote'),
    receipts: ofType('receipt'),
    drafts: docs.filter((d) => d.status === 'draft').length,
    clients: data.clients.length,
    items: data.catalog_items.length,
    payments: data.payments.length,
    lines: data.document_lines.length,
  };
}

/** cyrb53 over the canonical JSON of the rows: 53-bit, deterministic, as hex (not a security feature). */
export function hashData(data: BackupData): string {
  const canonical = JSON.stringify([data.settings, ...TABLE_ORDER.map((t) => data[t])]);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < canonical.length; i++) {
    const ch = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** Logo files a backup must carry: the business logo and every logo an issued snapshot refers to (D41). */
export function referencedLogoFiles(data: Pick<BackupData, 'business' | 'documents'>): string[] {
  return referencedFiles({ ...data, catalog_items: [], document_lines: [], attachments: [] }).filter((f) => f.startsWith('logo/'));
}

/**
 * Every file a backup must carry (V1.5 P1): logos (business and snapshots, D41), attachments, item photos of catalog
 * items and lines, and the photos an issued snapshot printed. Only names in the safe FILE_PATH form are returned.
 */
export function referencedFiles(data: Pick<BackupData, 'business' | 'documents' | 'catalog_items' | 'document_lines' | 'attachments'>): string[] {
  const names = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && FILE_PATH.test(v)) names.add(v);
  };
  for (const b of data.business) add(b.logo_file);
  for (const i of data.catalog_items) add(i.image_file);
  for (const l of data.document_lines) add(l.image_file);
  for (const a of data.attachments) add(a.file);
  for (const d of data.documents) {
    if (typeof d.snapshot !== 'string') continue;
    try {
      const snap = JSON.parse(d.snapshot) as { business?: { logoFile?: unknown }; lines?: { imageFile?: unknown }[]; attachments?: { file?: unknown }[] };
      add(snap.business?.logoFile);
      for (const l of Array.isArray(snap.lines) ? snap.lines : []) add(l?.imageFile);
      for (const a of Array.isArray(snap.attachments) ? snap.attachments : []) add(a?.file);
    } catch {
      /* validated elsewhere */
    }
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkValue(where: string, col: Col, value: unknown): string | number | null {
  const at = `${where} ${col.name}`;
  if (value === null) {
    if (col.nullable) return null;
    throw new Invalid('shape', `${at} must not be empty`);
  }
  if (col.type === 'int') {
    const min = col.min ?? -SAFE;
    const max = col.max ?? SAFE;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Invalid('shape', `${at} must be a whole number from ${min} to ${max}`);
    }
    return value;
  }
  if (typeof value !== 'string') throw new Invalid('shape', `${at} must be text`);
  if (col.nonEmpty && value.trim() === '') throw new Invalid('shape', `${at} must not be empty`);
  if (col.enum && !col.enum.includes(value)) throw new Invalid('shape', `${at} "${value}" is not one of ${col.enum.join(', ')}`);
  if (col.date && !isValidIsoDate(value)) throw new Invalid('shape', `${at} "${value}" is not a YYYY-MM-DD date`);
  if (col.pattern && !col.pattern.test(value)) throw new Invalid('shape', `${at} "${value.slice(0, 40)}" has the wrong format`);
  if (col.json) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Invalid('shape', `${at} is not valid JSON`);
    }
    if (col.json === 'array' ? !Array.isArray(parsed) : !isObj(parsed)) throw new Invalid('shape', `${at} has the wrong JSON type`);
  }
  if (col.file && !FILE_PATH.test(value)) throw new Invalid('shape', `${at} "${value.slice(0, 60)}" is not a file name of this app`);
  if (col.signature && !parseSignature(value)) throw new Invalid('shape', `${at} is not a readable signature`);
  return value;
}

function validateRows(table: TableName, rows: unknown, schemaVersion: number): Row[] {
  if (rows === undefined && (TABLE_SINCE[table] ?? 0) > schemaVersion) return [];
  if (!Array.isArray(rows)) throw new Invalid('shape', `${table} must be a list`);
  const cols = TABLES[table] as readonly Col[];
  const names = cols.map((c) => c.name);
  return rows.map((raw, i) => {
    const where = `${table} row ${i + 1}`;
    if (!isObj(raw)) throw new Invalid('shape', `${where} is not an object`);
    for (const key of Object.keys(raw)) if (!names.includes(key)) throw new Invalid('shape', `${where} has an unknown field "${key}"`);
    const row: Row = {};
    for (const col of cols) {
      if (!(col.name in raw)) {
        if ((col.since ?? 0) > schemaVersion) {
          row[col.name] = col.fallback ?? null;
          continue;
        }
        throw new Invalid('shape', `${where} is missing "${col.name}"`);
      }
      row[col.name] = checkValue(where, col, raw[col.name]);
    }
    return row;
  });
}

function uniqueIds(table: string, rows: Row[], key = 'id'): Set<number> {
  const ids = new Set<number>();
  for (const r of rows) {
    const id = r[key] as number;
    if (ids.has(id)) throw new Invalid('duplicate', `${table} ${key} ${id} appears twice`);
    ids.add(id);
  }
  return ids;
}

function checkSnapshot(doc: Row, lineCount: number): void {
  const label = `Document ${doc.id}`;
  const issuedLike = doc.status !== 'draft';
  if (doc.snapshot === null) {
    if (issuedLike) throw new Invalid('inconsistent', `${label} is issued but has no snapshot`);
    return;
  }
  const snap = JSON.parse(doc.snapshot as string) as Record<string, unknown>;
  const version = snap.modelVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new Invalid('shape', `${label} snapshot has no modelVersion`);
  if (version > RENDER_MODEL_VERSION) throw new Invalid('newerVersion', `${label} was saved by a newer app (snapshot version ${version}); update the app first`);
  if (!issuedLike) return;
  if (snap.type !== doc.type) throw new Invalid('inconsistent', `${label} snapshot is a ${String(snap.type)}, the row is a ${String(doc.type)}`);
  if (snap.number !== doc.number) throw new Invalid('inconsistent', `${label} snapshot number differs from the row`);
  const totals = snap.totals as { gross?: unknown } | undefined;
  if (!isObj(totals) || totals.gross !== doc.gross_cents) throw new Invalid('inconsistent', `${label} total differs from its snapshot`);
  if (!Array.isArray(snap.lines) || snap.lines.length !== lineCount) throw new Invalid('inconsistent', `${label} has ${lineCount} lines, its snapshot ${Array.isArray(snap.lines) ? snap.lines.length : 'none'}`);
}

function checkSemantics(data: BackupData): void {
  if (data.business.length !== 1) throw new Invalid('shape', `business must have exactly one row, not ${data.business.length}`);
  const tableIds = {} as Record<string, Set<number>>;
  for (const t of ['tax_rates', 'clients', 'catalog_items', 'documents', 'document_lines', 'payments'] as const) tableIds[t] = uniqueIds(t, data[t]);
  const counters = new Set<string>();
  for (const c of data.number_counters) {
    if (counters.has(c.series_key as string)) throw new Invalid('duplicate', `number counter "${c.series_key}" appears twice`);
    counters.add(c.series_key as string);
    if ((c.next_value as number) <= (c.max_used as number)) throw new Invalid('inconsistent', `number counter "${c.series_key}": next value ${c.next_value} is not above the highest used ${c.max_used}`);
  }

  const lineCounts = new Map<number, number>();
  for (const l of data.document_lines) {
    if (!tableIds.documents.has(l.document_id as number)) throw new Invalid('reference', `Line ${l.id} belongs to document ${l.document_id}, which is not in the file`);
    if (l.catalog_item_id !== null && !tableIds.catalog_items.has(l.catalog_item_id as number)) throw new Invalid('reference', `Line ${l.id} names item ${l.catalog_item_id}, which is not in the file`);
    lineCounts.set(l.document_id as number, (lineCounts.get(l.document_id as number) ?? 0) + 1);
  }
  const numbers = new Set<string>();
  for (const d of data.documents) {
    const label = `Document ${d.id}`;
    if (d.client_id !== null && !tableIds.clients.has(d.client_id as number)) throw new Invalid('reference', `${label} names client ${d.client_id}, which is not in the file`);
    if (d.source_id !== null && (d.source_id === d.id || !tableIds.documents.has(d.source_id as number))) throw new Invalid('reference', `${label} refers to document ${d.source_id}, which is not in the file`);
    if ((d.receipt_kind !== null) !== (d.type === 'receipt')) throw new Invalid('inconsistent', `${label}: a receipt kind belongs to receipts only`);
    if ((d.series === null) !== (d.number === null)) throw new Invalid('inconsistent', `${label}: series and number belong together`);
    if (d.series !== null && d.series !== seriesOf(d.type as DocumentType)) throw new Invalid('inconsistent', `${label}: series "${d.series}" does not fit a ${d.type}`);
    if (d.status !== 'draft' && d.number === null) throw new Invalid('inconsistent', `${label} is issued but has no number`);
    if (d.status === 'cancelled' && d.type !== 'invoice') throw new Invalid('inconsistent', `${label}: only invoices are cancelled`);
    if (['accepted', 'declined', 'invoiced'].includes(d.status as string) && d.type !== 'quote') throw new Invalid('inconsistent', `${label}: ${d.status} applies to quotes only`);
    if (d.type === 'cancellation' && d.status !== 'draft' && d.status !== 'issued') throw new Invalid('inconsistent', `${label}: a cancellation is draft or issued`);
    if ((d.net_cents as number) + (d.tax_cents as number) !== d.gross_cents) throw new Invalid('inconsistent', `${label}: net + VAT is not the total`);
    if (d.number !== null) {
      const key = `${d.series}\u0000${d.number}`;
      if (numbers.has(key)) throw new Invalid('duplicate', `The number ${d.number} appears twice`);
      numbers.add(key);
    }
    checkSnapshot(d, lineCounts.get(d.id as number) ?? 0);
  }
  for (const p of data.payments) {
    if (!tableIds.documents.has(p.document_id as number)) throw new Invalid('reference', `Payment ${p.id} belongs to document ${p.document_id}, which is not in the file`);
  }
  uniqueIds('attachments', data.attachments);
  for (const a of data.attachments) {
    if (!tableIds.documents.has(a.document_id as number)) throw new Invalid('reference', `Attachment ${a.id} belongs to document ${a.document_id}, which is not in the file`);
    if (a.use === 'page' && a.mime === 'application/pdf') throw new Invalid('inconsistent', `Attachment ${a.id}: a PDF cannot be printed as a page`);
  }
  const docsById = new Map(data.documents.map((d) => [d.id as number, d]));
  uniqueIds('signatures', data.signatures, 'document_id');
  for (const g of data.signatures) {
    const doc = docsById.get(g.document_id as number);
    if (!doc) throw new Invalid('reference', `A signature belongs to document ${g.document_id}, which is not in the file`);
    if (doc.type !== 'quote' || doc.status === 'draft') throw new Invalid('inconsistent', `Document ${doc.id}: only issued quotes carry a client signature`);
  }
}

const LOGO_PATH = /^logo\/[A-Za-z0-9._-]{1,100}\.(png|jpe?g)$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function validateFiles(files: unknown, version: number): Record<string, string> {
  if (!isObj(files)) throw new Invalid('shape', 'files must be an object');
  const out: Record<string, string> = {};
  for (const [path, value] of Object.entries(files)) {
    if (!LOGO_PATH.test(path)) throw new Invalid('shape', `File "${path.slice(0, 60)}" is not a logo path`);
    if (typeof value !== 'string' || value.length > MAX_LOGO_CHARS || value.length % 4 !== 0 || !BASE64.test(value)) {
      throw new Invalid('shape', `File "${path}" is not valid base64 or is too large`);
    }
    out[path] = value;
  }
  return out;
}

function validate(source: string, ourSchemaVersion: number): BackupFile {
  if (source.length > MAX_BACKUP_CHARS) throw new Invalid('tooLarge', `The file has ${source.length} characters; the limit is ${MAX_BACKUP_CHARS}`);
  let raw: unknown;
  try {
    raw = JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source);
  } catch {
    throw new Invalid('notJson', 'The file is not readable JSON (damaged or cut off)');
  }
  if (!isObj(raw) || raw.format !== BACKUP_FORMAT) throw new Invalid('notInvoiceMaker', 'This is not an Invoice Maker backup');
  const { version, schemaVersion } = raw;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw new Invalid('shape', 'version is missing');
  if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new Invalid('shape', 'schemaVersion is missing');
  if (version > BACKUP_VERSION || schemaVersion > ourSchemaVersion) {
    throw new Invalid('newerVersion', `Made by a newer Invoice Maker (backup ${version}, schema ${schemaVersion}); update the app first`);
  }
  if (schemaVersion < MIN_BACKUP_SCHEMA) throw new Invalid('unsupported', `Schema ${schemaVersion} has no Invoice Maker data`);
  for (const key of Object.keys(raw)) {
    if (!['format', 'version', 'schemaVersion', 'app', 'exportedAt', 'data', 'files'].includes(key)) throw new Invalid('shape', `The file has an unknown field "${key}"`);
  }
  if (typeof raw.app !== 'string') throw new Invalid('shape', 'app must be text');
  if (typeof raw.exportedAt !== 'string' || Number.isNaN(Date.parse(raw.exportedAt))) throw new Invalid('shape', 'exportedAt must be a date');
  if (!isObj(raw.data)) throw new Invalid('shape', 'data must be an object');
  const tableNames = ['settings', ...TABLE_ORDER];
  for (const key of Object.keys(raw.data)) if (!tableNames.includes(key)) throw new Invalid('shape', `data has an unknown table "${key}"`);
  for (const key of tableNames) {
    if (!(key in raw.data) && (TABLE_SINCE[key as TableName] ?? 0) <= schemaVersion) throw new Invalid('shape', `data is missing "${key}"`);
  }

  const rawSettings = raw.data.settings;
  if (!isObj(rawSettings)) throw new Invalid('shape', 'settings must be an object');
  const settings: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawSettings)) {
    if (DEVICE_SETTINGS.includes(key)) continue;
    if (key.length === 0 || key.length > 120 || typeof value !== 'string') throw new Invalid('shape', `Setting "${key.slice(0, 40)}" must be text`);
    settings[key] = value;
  }
  const data: BackupData = {
    settings,
    business: validateRows('business', raw.data.business, schemaVersion),
    tax_rates: validateRows('tax_rates', raw.data.tax_rates, schemaVersion),
    clients: validateRows('clients', raw.data.clients, schemaVersion),
    catalog_items: validateRows('catalog_items', raw.data.catalog_items, schemaVersion),
    documents: validateRows('documents', raw.data.documents, schemaVersion),
    document_lines: validateRows('document_lines', raw.data.document_lines, schemaVersion),
    payments: validateRows('payments', raw.data.payments, schemaVersion),
    number_counters: validateRows('number_counters', raw.data.number_counters, schemaVersion),
    attachments: validateRows('attachments', raw.data.attachments, schemaVersion),
    signatures: validateRows('signatures', raw.data.signatures, schemaVersion),
  };
  checkSemantics(data);
  return { format: BACKUP_FORMAT, version, schemaVersion, app: raw.app, exportedAt: raw.exportedAt, data, files: validateFiles(raw.files, version) };
}

/**
 * Restore never hands out a number twice (D52, review #3): per series key the restored counter is the
 * maximum of this phone's and the file's (next value and highest used). Keys only on the phone are kept too.
 */
export function mergeCounters(fileRows: readonly Row[], phoneRows: readonly Row[]): Row[] {
  const merged = new Map<string, Row>();
  for (const r of fileRows) merged.set(r.series_key as string, { ...r });
  for (const p of phoneRows) {
    const key = p.series_key as string;
    const f = merged.get(key);
    merged.set(key, f
      ? { series_key: key, next_value: Math.max(f.next_value as number, p.next_value as number), max_used: Math.max(f.max_used as number, p.max_used as number) }
      : { series_key: key, next_value: p.next_value, max_used: p.max_used });
  }
  return [...merged.values()].sort((a, b) => String(a.series_key).localeCompare(String(b.series_key)));
}

/** What the restore summary tells the user before replacing this phone's data (D52). */
export function compareWithPhone(file: Pick<BackupData, 'number_counters' | 'documents'>, phone: Pick<BackupData, 'number_counters' | 'documents'>): PhoneComparison {
  const fileNext = new Map(file.number_counters.map((c) => [c.series_key as string, c.next_value as number]));
  const countersKept = phone.number_counters
    .filter((p) => (p.next_value as number) > (fileNext.get(p.series_key as string) ?? 1))
    .map((p) => ({ seriesKey: p.series_key as string, fileNext: fileNext.get(p.series_key as string) ?? 1, phoneNext: p.next_value as number }))
    .sort((a, b) => a.seriesKey.localeCompare(b.seriesKey));
  const inFile = new Set(file.documents.filter((d) => d.number !== null).map((d) => `${d.series}\u0000${d.number}`));
  const phoneOnlyNumbers = phone.documents
    .filter((d) => d.number !== null && !inFile.has(`${d.series}\u0000${d.number}`))
    .map((d) => d.number as string)
    .sort();
  return { countersKept, phoneOnlyNumbers };
}

export function planFor(file: BackupFile, zipFiles?: readonly string[]): RestorePlan {
  const carried = [...new Set([...Object.keys(file.files), ...(zipFiles ?? [])])].sort();
  const wanted = referencedFiles(file.data);
  const have = new Set(carried);
  return {
    counts: countsOf(file.data),
    schemaVersion: file.schemaVersion,
    exportedAt: file.exportedAt,
    hash: hashData(file.data),
    logoFiles: carried.filter((f) => wanted.includes(f)),
    missingFiles: wanted.filter((f) => !have.has(f)),
    formatVersion: file.version,
  };
}

// ---------------------------------------------------------------------------------------------
// ZIP container (format 2)
// ---------------------------------------------------------------------------------------------

const ZIP_JSON = 'backup.json';
const ZIP_FILE = /^files\/(.+)$/;

/** True when the bytes start like a ZIP ("PK\x03\x04"). */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** The ZIP: backup.json (deflated) + files/<path> (stored; photos and PDFs are compressed already). */
export function buildBackupZip(file: BackupFile, binaries: Record<string, Uint8Array>): Uint8Array {
  const entries: Zippable = { [ZIP_JSON]: [strToU8(serializeBackup({ ...file, files: {} })), { level: 6 }] };
  for (const path of Object.keys(binaries).sort()) {
    if (!FILE_PATH.test(path)) throw new Error(`not a file of this app: ${path}`);
    entries[`files/${path}`] = [binaries[path], { level: 0 }];
  }
  // Fixed time stamps: the same data gives the same bytes.
  return zipSync(entries, { mtime: new Date('2026-01-01T00:00:00Z') });
}

export type BackupZipParse = (Extract<BackupParse, { ok: true }> & { binaries: Record<string, Uint8Array> }) | Extract<BackupParse, { ok: false }>;

/** Reads and validates a format-2 ZIP (or a format-1 JSON given as bytes). Limits are checked before inflating. */
export function parseBackupBytes(bytes: Uint8Array, ourSchemaVersion: number): BackupZipParse {
  if (!isZip(bytes)) {
    if (bytes.length > MAX_BACKUP_CHARS * 4) return { ok: false, error: { code: 'tooLarge', detail: `The file has ${bytes.length} bytes` } };
    let text: string;
    try {
      text = strFromU8(bytes);
    } catch {
      return { ok: false, error: { code: 'notJson', detail: 'The file is not text' } };
    }
    const parsed = parseBackup(text, ourSchemaVersion);
    if (!parsed.ok) return parsed;
    const binaries: Record<string, Uint8Array> = {};
    return { ...parsed, binaries };
  }
  let total = 0;
  let count = 0;
  let refused = '';
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes, {
      filter: (f) => {
        count++;
        total += f.originalSize;
        if (count > MAX_ZIP_ENTRIES || total > MAX_ZIP_TOTAL_BYTES) refused ||= 'The backup is larger than this app restores';
        else if (f.name === ZIP_JSON) {
          if (f.originalSize > MAX_BACKUP_CHARS * 4) refused ||= 'backup.json is too large';
        } else if (f.name.endsWith('/')) return false;
        else {
          const m = ZIP_FILE.exec(f.name);
          if (!m || !FILE_PATH.test(m[1])) refused ||= `Unexpected entry "${f.name.slice(0, 60)}" in the backup`;
          else if (f.originalSize > MAX_ZIP_FILE_BYTES) refused ||= `File "${m[1]}" is too large`;
        }
        return refused === '';
      },
    });
  } catch (e) {
    return { ok: false, error: { code: 'notJson', detail: `The ZIP is damaged (${e instanceof Error ? e.message : String(e)})` } };
  }
  if (refused) return { ok: false, error: { code: 'tooLarge', detail: refused } };
  const json = unzipped[ZIP_JSON];
  if (!json) return { ok: false, error: { code: 'notInvoiceMaker', detail: 'This ZIP is not an Invoice Maker backup (no backup.json)' } };
  const parsed = parseBackup(strFromU8(json), ourSchemaVersion);
  if (!parsed.ok) return parsed;
  if (parsed.file.version < 2) return { ok: false, error: { code: 'shape', detail: 'A ZIP backup must be format 2' } };
  const binaries: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(unzipped)) {
    const m = ZIP_FILE.exec(name);
    if (m) binaries[m[1]] = data;
  }
  return { ok: true, file: parsed.file, plan: planFor(parsed.file, Object.keys(binaries)), binaries };
}

/** Parses and strictly validates a backup file's text. Never throws; the plan says what a restore would do. */
export function parseBackup(source: unknown, ourSchemaVersion: number): BackupParse {
  if (typeof source !== 'string') return { ok: false, error: { code: 'notJson', detail: 'The file is not text' } };
  try {
    const file = validate(source, ourSchemaVersion);
    return { ok: true, file, plan: planFor(file) };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: { code: e.code, detail: e.message } };
    return { ok: false, error: { code: 'shape', detail: e instanceof Error ? e.message : 'Unreadable file' } };
  }
}
