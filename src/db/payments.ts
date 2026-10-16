// Payments: only on issued invoices and receipts (V1_PLAN "Lifecycle"); deposits are payments (D22).
import { isValidIsoDate } from '@/engine/dates';

import { fromRow, insertSql } from './rows';
import { queued, withRead } from './transaction';
import type { Db } from './types';

export type PaymentMethod = 'bank' | 'cash' | 'card' | 'paypal' | 'other';
export type Payment = {
  id: number;
  documentId: number;
  /** 'YYYY-MM-DD' */
  date: string;
  amountCents: number;
  method: PaymentMethod;
  note: string;
  createdAt: number;
};
export type PaymentInput = { date: string; amountCents: number; method?: PaymentMethod; note?: string };

const FIELDS = ['documentId', 'date', 'amountCents', 'method', 'note', 'createdAt'] as const;

export class PaymentNotAllowedError extends Error {
  constructor(readonly documentId: number) {
    super(`payment_not_allowed: document ${documentId} is not an issued invoice or receipt`);
    this.name = 'PaymentNotAllowedError';
  }
}

export const addPayment = queued(async (db: Db, documentId: number, input: PaymentInput, now: number = Date.now()): Promise<number> => {
  const doc = await db.getFirstAsync<{ type: string; status: string }>('SELECT type, status FROM documents WHERE id = ?', documentId);
  if (!doc || doc.status !== 'issued' || (doc.type !== 'invoice' && doc.type !== 'receipt')) {
    throw new PaymentNotAllowedError(documentId);
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents === 0) throw new RangeError('payment amount must be a non-zero number of cents');
  if (!isValidIsoDate(input.date)) throw new RangeError('payment date must be YYYY-MM-DD'); // review #17
  const { sql, values } = insertSql('payments', { ...input, documentId, createdAt: now }, FIELDS);
  return (await db.runAsync(sql, ...values)).lastInsertRowId;
});

export function listPayments(db: Db, documentId: number): Promise<Payment[]> {
  return withRead(db, async (db) => {
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM payments WHERE document_id = ? ORDER BY date, id',
      documentId
    );
    return rows.map((r) => fromRow<Payment>(r));
  });
}

export const deletePayment = queued(async (db: Db, id: number): Promise<void> => {
  await db.runAsync('DELETE FROM payments WHERE id = ?', id);
});
