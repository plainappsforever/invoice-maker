// Documents (invoice, quote, receipt, cancellation). Drafts are editable; everything else is locked
// (D20): only status, sent_at, cancelled_at, pdf_file and payments change after Issue. The JS guard here
// and the SQLite triggers of migration 2 enforce the same rule. Issue, cancellation, conversion and
// receipts live in lifecycle.ts (P2).
import type { Lang } from '@/engine/money';
import type { DocumentType } from '@/engine/numbering';
import { InvalidTransitionError, outcome, statusChangeAllowed, type DocumentStatus } from '@/engine/status';
import { computeTotals, type DiscountKind, type TaxCategory, type Totals, type TotalsInput } from '@/engine/totals';

import type { Treatment } from './clients';
import { fromRow, insertSql, updateSql } from './rows';
import { queued, withRead } from './transaction';
import { DocumentLockedError, type Db } from './types';

export type { DocumentStatus };
export type ServiceMode = 'same' | 'date' | 'period' | 'month' | 'none';
export type Paper = 'A4' | 'LETTER';
export type CustomField = { label: string; value: string };

export type Document = {
  id: number;
  type: DocumentType;
  receiptKind: 'payment' | 'cash' | null;
  status: DocumentStatus;
  /** Number space ('invoice' | 'quote' | 'receipt'); NULL while draft (D32). */
  series: string | null;
  number: string | null;
  clientId: number | null;
  /** 'YYYY-MM-DD' local calendar date. */
  issueDate: string;
  serviceMode: ServiceMode;
  serviceFrom: string | null;
  serviceTo: string | null;
  dueDate: string | null;
  validUntil: string | null;
  paymentDays: number | null;
  reference: string;
  buyerReference: string;
  currency: string;
  language: Lang;
  pricesIncludeVat: boolean;
  treatment: Treatment;
  discountKind: DiscountKind;
  /** Basis points (percent) or cents (amount). */
  discountValue: number;
  intro: string;
  notes: string;
  paymentText: string;
  footer: string;
  legalNote: string;
  /** JSON [{label, value}], at most 5. */
  customFields: string;
  template: string;
  accent: string;
  logoRight: boolean;
  paper: Paper;
  showGirocode: boolean;
  depositCents: number | null;
  sourceId: number | null;
  netCents: number;
  taxCents: number;
  grossCents: number;
  snapshot: string | null;
  pdfFile: string | null;
  sentAt: number | null;
  issuedAt: number | null;
  cancelledAt: number | null;
  createdAt: number;
  updatedAt: number;
};

/** Fields a draft may change. */
const DRAFT_FIELDS = [
  'receiptKind', 'clientId', 'issueDate', 'serviceMode', 'serviceFrom', 'serviceTo', 'dueDate', 'validUntil',
  'paymentDays', 'reference', 'buyerReference', 'currency', 'language', 'pricesIncludeVat', 'treatment',
  'discountKind', 'discountValue', 'intro', 'notes', 'paymentText', 'footer', 'legalNote', 'customFields',
  'template', 'accent', 'logoRight', 'paper', 'showGirocode', 'depositCents', 'sourceId', 'netCents', 'taxCents',
  'grossCents', 'updatedAt',
] as const;
/** Fields that may change after Issue (status transitions are validated in P2). */
const STATE_FIELDS = ['status', 'sentAt', 'cancelledAt', 'pdfFile', 'updatedAt'] as const;
const CREATE_FIELDS = ['type', ...DRAFT_FIELDS, 'createdAt'] as const;

export type DraftPatch = Partial<Pick<Document, Exclude<(typeof DRAFT_FIELDS)[number], 'updatedAt'>>>;
export type DraftInput = DraftPatch & { type: DocumentType; issueDate: string };
export type StatePatch = Partial<Pick<Document, 'status' | 'sentAt' | 'cancelledAt' | 'pdfFile'>>;

const BOOLEANS = ['pricesIncludeVat', 'logoRight', 'showGirocode'];
const map = (row: Record<string, unknown>) => fromRow<Document>(row, BOOLEANS);

export const createDraft = queued(async (db: Db, input: DraftInput, now: number = Date.now()): Promise<number> => {
  const { sql, values } = insertSql('documents', { ...input, createdAt: now, updatedAt: now }, CREATE_FIELDS);
  return (await db.runAsync(sql, ...values)).lastInsertRowId;
});

export function getDocument(db: Db, id: number): Promise<Document | null> {
  return withRead(db, async (db) => {
    const row = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM documents WHERE id = ?', id);
    return row ? map(row) : null;
  });
}

export function listDocuments(
  db: Db,
  filter: { type?: DocumentType; status?: DocumentStatus; clientId?: number } = {}
): Promise<Document[]> {
  return withRead(db, async (db) => {
    const conditions: [string, string | number | undefined][] = [
      ['type = ?', filter.type],
      ['status = ?', filter.status],
      ['client_id = ?', filter.clientId],
    ];
    const active = conditions.filter(([, value]) => value !== undefined);
    const where = active.map(([sql]) => sql);
    const params = active.map(([, value]) => value as string | number);
    const rows = await db.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM documents ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY issue_date DESC, id DESC`,
      ...params
    );
    return rows.map(map);
  });
}

/** Throws DocumentLockedError unless the document exists and is a draft. */
export async function assertDraft(db: Db, id: number): Promise<void> {
  const row = await db.getFirstAsync<{ status: string }>('SELECT status FROM documents WHERE id = ?', id);
  if (!row) throw new Error(`document ${id} not found`);
  if (row.status !== 'draft') throw new DocumentLockedError(id);
}

export const updateDraft = queued(async (db: Db, id: number, patch: DraftPatch, now: number = Date.now()): Promise<void> => {
  await assertDraft(db, id);
  const update = updateSql('documents', id, { ...patch, updatedAt: now }, DRAFT_FIELDS);
  if (update) await db.runAsync(update.sql, ...update.values);
});

/**
 * status / sent_at / cancelled_at / pdf_file. A status change must be a transition of the lifecycle table
 * (`src/engine/status.ts`); Issue (needs a number + snapshot) and cancellation (needs the cancellation
 * invoice) go through `src/db/lifecycle.ts`, which calls this inside its transactions.
 */
export const updateDocumentState = queued(async (db: Db, id: number, patch: StatePatch, now: number = Date.now()): Promise<void> => {
  if (patch.status !== undefined) {
    const doc = await getDocument(db, id);
    if (!doc) throw new Error(`document ${id} not found`);
    if (!statusChangeAllowed(doc, patch.status)) {
      throw new InvalidTransitionError(patch.status === 'issued' ? 'issue' : 'edit', doc);
    }
  }
  const update = updateSql('documents', id, { ...patch, updatedAt: now }, STATE_FIELDS);
  if (update) await db.runAsync(update.sql, ...update.values);
});

/**
 * Drafts can always be deleted (they have no number, so no gap). Issued invoices, receipts and
 * cancellations never (cancel instead, D17); issued/accepted/declined quotes can, their numbers are not
 * reused; an invoiced quote cannot (its invoice refers to it). Rules: `outcome(doc, 'delete')`.
 */
export const deleteDocument = queued(async (db: Db, id: number): Promise<void> => {
  const doc = await getDocument(db, id);
  if (!doc) return;
  if (outcome(doc, 'delete') === null) {
    throw doc.status !== 'draft' && doc.type !== 'quote' ? new DocumentLockedError(id) : new InvalidTransitionError('delete', doc);
  }
  await db.runAsync('DELETE FROM documents WHERE id = ?', id);
  // Deleting the invoice draft made from a quote gives the quote back its "accepted" state (convert undone).
  if (doc.status === 'draft' && doc.type === 'invoice' && doc.sourceId !== null) {
    await db.runAsync(
      `UPDATE documents SET status = 'accepted' WHERE id = ? AND type = 'quote' AND status = 'invoiced'
         AND NOT EXISTS (SELECT 1 FROM documents WHERE source_id = ?)`,
      doc.sourceId,
      doc.sourceId
    );
  }
});

/** Builds the engine input from stored rows; a read unit (joins a running unit when given its handle, review #20). */
export function totalsInputFor(db: Db, id: number): Promise<TotalsInput> {
  return withRead(db, (db) => readTotalsInput(db, id));
}

async function readTotalsInput(db: Db, id: number): Promise<TotalsInput> {
  const doc = await getDocument(db, id);
  if (!doc) throw new Error(`document ${id} not found`);
  const lines = await db.getAllAsync<{
    qty_milli: number; price_e4: number; tax_category: TaxCategory; tax_rate_bp: number;
    discount_kind: DiscountKind; discount_value: number;
  }>(
    'SELECT qty_milli, price_e4, tax_category, tax_rate_bp, discount_kind, discount_value FROM document_lines WHERE document_id = ? ORDER BY position, id',
    id
  );
  const payments = await db.getAllAsync<{ amount_cents: number }>('SELECT amount_cents FROM payments WHERE document_id = ?', id);
  return {
    pricesIncludeVat: doc.pricesIncludeVat,
    discount: { kind: doc.discountKind, value: doc.discountValue },
    payments: payments.map((p) => p.amount_cents),
    lines: lines.map((l) => ({
      qtyMilli: l.qty_milli,
      priceE4: l.price_e4,
      category: l.tax_category,
      rateBp: l.tax_rate_bp,
      discount: { kind: l.discount_kind, value: l.discount_value },
    })),
  };
}

/**
 * Recomputes a draft with the engine and caches line nets + document net/tax/gross. Amounts beyond the engine's
 * range (review #14) leave the cache as it was and return null; the check reports `amount_too_large`.
 */
export const refreshDraftTotals = queued(async (db: Db, id: number, now: number = Date.now()): Promise<Totals | null> => {
  await assertDraft(db, id);
  let totals: Totals;
  try {
    totals = computeTotals(await totalsInputFor(db, id));
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  const lineIds = await db.getAllAsync<{ id: number }>(
    'SELECT id FROM document_lines WHERE document_id = ? ORDER BY position, id',
    id
  );
  for (let i = 0; i < lineIds.length; i++) {
    await db.runAsync('UPDATE document_lines SET net_cents = ? WHERE id = ?', totals.lines[i].net, lineIds[i].id);
  }
  await updateDraft(db, id, { netCents: totals.net, taxCents: totals.tax, grossCents: totals.gross }, now);
  return totals;
});
