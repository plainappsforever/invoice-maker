// Home summary (SPEC §6, A8) and reminder candidates (D27). Amounts are per currency and never summed
// across currencies (SPEC §10). Statuses are derived from payments and dates, never stored (SPEC §5.9).
import { isPastDue } from '@/engine/status';

import { withRead } from './transaction';
import type { Db } from './types';

export type CurrencyAmount = { currency: string; cents: number; count: number };
export type HomeSummary = { outstanding: CurrencyAmount[]; overdue: CurrencyAmount[]; paidThisMonth: CurrencyAmount[] };

export type OpenInvoice = {
  id: number;
  clientId: number | null;
  number: string;
  clientName: string;
  currency: string;
  grossCents: number;
  paidCents: number;
  balanceCents: number;
  dueDate: string | null;
};

/** Issued (not cancelled) invoices with a balance due > 0. */
export function openInvoices(db: Db): Promise<OpenInvoice[]> {
  return withRead(db, async (db) => {
    const rows = await db.getAllAsync<{
      id: number; client_id: number | null; number: string; client_name: string | null; currency: string; gross_cents: number; paid: number; due_date: string | null;
    }>(
      // The name the invoice carries (snapshot), not the client's current one (review #20).
      `SELECT d.id, d.client_id, d.number, COALESCE(json_extract(d.snapshot, '$.client.name'), c.name) AS client_name, d.currency, d.gross_cents, d.due_date,
              COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.document_id = d.id), 0) AS paid
         FROM documents d LEFT JOIN clients c ON c.id = d.client_id
        WHERE d.type = 'invoice' AND d.status = 'issued'
        ORDER BY d.due_date IS NULL, d.due_date, d.id`
    );
    return rows
      .map((r) => ({
        id: r.id,
        clientId: r.client_id,
        number: r.number,
        clientName: r.client_name ?? '',
        currency: r.currency,
        grossCents: r.gross_cents,
        paidCents: r.paid,
        balanceCents: r.gross_cents - r.paid,
        dueDate: r.due_date,
      }))
      .filter((r) => r.balanceCents > 0);
  });
}

function addTo(list: CurrencyAmount[], currency: string, cents: number, count = 1) {
  const entry = list.find((e) => e.currency === currency);
  if (entry) {
    entry.cents += cents;
    entry.count += count;
  } else {
    list.push({ currency, cents, count });
  }
}

const byCurrency = (a: CurrencyAmount, b: CurrencyAmount) => a.currency.localeCompare(b.currency);

/**
 * Outstanding = Σ balance of open invoices; Overdue = the part with due date < today; Paid this month =
 * Σ payments dated in today's calendar month on invoices (also cancelled ones: the money was received).
 */
export function homeSummary(db: Db, today: string): Promise<HomeSummary> {
  return withRead(db, async (db) => {
    const outstanding: CurrencyAmount[] = [];
    const overdue: CurrencyAmount[] = [];
    for (const inv of await openInvoices(db)) {
      addTo(outstanding, inv.currency, inv.balanceCents);
      if (isPastDue(inv.dueDate, today)) addTo(overdue, inv.currency, inv.balanceCents);
    }
    const paid = await db.getAllAsync<{ currency: string; cents: number; count: number }>(
      `SELECT d.currency, SUM(p.amount_cents) AS cents, COUNT(DISTINCT d.id) AS count
         FROM payments p JOIN documents d ON d.id = p.document_id
        WHERE d.type = 'invoice' AND d.status IN ('issued', 'cancelled') AND substr(p.date, 1, 7) = ?
        GROUP BY d.currency`,
      today.slice(0, 7)
    );
    return {
      outstanding: outstanding.sort(byCurrency),
      overdue: overdue.sort(byCurrency),
      paidThisMonth: paid.map((p) => ({ currency: p.currency, cents: p.cents, count: p.count })).sort(byCurrency),
    };
  });
}

/** One client's open money (client detail, SPEC §6): outstanding and overdue per currency, never summed across currencies. */
export function clientOverview(db: Db, clientId: number, today: string): Promise<{ outstanding: CurrencyAmount[]; overdue: CurrencyAmount[] }> {
  return withRead(db, async (db) => {
    const outstanding: CurrencyAmount[] = [];
    const overdue: CurrencyAmount[] = [];
    for (const inv of await openInvoices(db)) {
      if (inv.clientId !== clientId) continue;
      addTo(outstanding, inv.currency, inv.balanceCents);
      if (isPastDue(inv.dueDate, today)) addTo(overdue, inv.currency, inv.balanceCents);
    }
    return { outstanding: outstanding.sort(byCurrency), overdue: overdue.sort(byCurrency) };
  });
}
