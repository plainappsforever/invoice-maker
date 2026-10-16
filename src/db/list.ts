// Rows for the Documents list (SPEC §6): one query per tab with the client name the document carries (the snapshot's
// for issued ones, review #20), the paid sum and the derived display status (SPEC §5.9).
import type { DocumentType } from '@/engine/numbering';
import { deriveStatus, effectiveDueDate, type DerivedStatus, type ReceiptKind } from '@/engine/status';

import type { DocumentStatus } from './documents';
import { withRead } from './transaction';
import type { Db } from './types';

export type DocumentRow = {
  id: number;
  type: DocumentType;
  status: DocumentStatus;
  receiptKind: ReceiptKind | null;
  number: string | null;
  clientName: string;
  issueDate: string;
  currency: string;
  grossCents: number;
  derived: DerivedStatus;
};

type Raw = {
  id: number; type: DocumentType; status: DocumentStatus; receipt_kind: ReceiptKind | null; number: string | null;
  client_name: string; issue_date: string; due_date: string | null; valid_until: string | null; payment_days: number | null;
  currency: string; gross_cents: number; sent_at: number | null; paid: number;
};

/** The three tabs: Invoices (with their cancellations), Quotes, Receipts. */
export const TAB_TYPES: Record<'invoices' | 'quotes' | 'receipts', DocumentType[]> = {
  invoices: ['invoice', 'cancellation'],
  quotes: ['quote'],
  receipts: ['receipt'],
};

function dueOf(r: Raw): string | null {
  try {
    return effectiveDueDate({ issueDate: r.issue_date, dueDate: r.due_date, paymentDays: r.payment_days });
  } catch {
    return r.due_date; // payment days outside 0-365: the check reports it, the list just shows no due date
  }
}

export function listDocumentRows(db: Db, types: DocumentType[], today: string, search = '', clientId?: number): Promise<DocumentRow[]> {
  return withRead(db, async (db) => {
    const params: (string | number)[] = [...types];
    let where = `d.type IN (${types.map(() => '?').join(', ')})`;
    if (clientId !== undefined) {
      where += ' AND d.client_id = ?';
      params.push(clientId);
    }
    const q = search.trim();
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where += ` AND (d.number LIKE ? ESCAPE '\\' OR COALESCE(json_extract(d.snapshot, '$.client.name'), c.name, '') LIKE ? ESCAPE '\\'
                      OR d.reference LIKE ? ESCAPE '\\' OR d.intro LIKE ? ESCAPE '\\' OR d.notes LIKE ? ESCAPE '\\')`;
      params.push(like, like, like, like, like);
    }
    const rows = await db.getAllAsync<Raw>(
      `SELECT d.id, d.type, d.status, d.receipt_kind, d.number, d.issue_date, d.due_date, d.valid_until, d.payment_days,
              d.currency, d.gross_cents, d.sent_at,
              COALESCE(json_extract(d.snapshot, '$.client.name'), c.name, '') AS client_name,
              COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.document_id = d.id), 0) AS paid
         FROM documents d LEFT JOIN clients c ON c.id = d.client_id
        WHERE ${where}
        ORDER BY (d.status = 'draft') DESC, d.issue_date DESC, d.id DESC`,
      ...params
    );
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      receiptKind: r.receipt_kind,
      number: r.number,
      clientName: r.client_name,
      issueDate: r.issue_date,
      currency: r.currency,
      grossCents: r.gross_cents,
      derived: deriveStatus(
        {
          type: r.type,
          status: r.status,
          receiptKind: r.receipt_kind,
          sentAt: r.sent_at,
          dueDate: dueOf(r),
          validUntil: r.valid_until,
          grossCents: r.gross_cents,
          paidCents: r.paid,
        },
        today
      ),
    }));
  });
}

export type RelatedDocument = {
  id: number;
  type: DocumentType;
  status: DocumentStatus;
  number: string | null;
  /** 'source' = the document this one was made from; 'derived' = documents made from this one. */
  role: 'source' | 'derived';
};

/** The document a cancellation, payment receipt or invoice-from-quote refers to, and the documents made from this one. */
export function relatedDocuments(db: Db, id: number): Promise<RelatedDocument[]> {
  return withRead(db, async (db) => {
    const rows = await db.getAllAsync<{ id: number; type: DocumentType; status: DocumentStatus; number: string | null; role: 'source' | 'derived' }>(
      `SELECT s.id, s.type, s.status, s.number, 'source' AS role FROM documents d JOIN documents s ON s.id = d.source_id WHERE d.id = ?
       UNION ALL
       SELECT x.id, x.type, x.status, x.number, 'derived' AS role FROM documents x WHERE x.source_id = ?
       ORDER BY role DESC, id`,
      id,
      id
    );
    return rows;
  });
}
