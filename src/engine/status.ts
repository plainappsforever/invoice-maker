// Document lifecycle (V1_PLAN "Lifecycle", SPEC §5.9, D17, D20, D30). PURE: no React/Expo imports.
// Stored statuses: draft → issued (all types); quote issued → accepted | declined, accepted → invoiced
// (by convert); invoice issued → cancelled (with a cancellation invoice). "Sent", "paid", "partially paid",
// "overdue" and "expired" are DERIVED from sent_at, payments and dates — never stored.
import { addDays, daysBetween, isValidIsoDate } from './dates';
import type { DocumentType } from './numbering';

export type DocumentStatus = 'draft' | 'issued' | 'cancelled' | 'accepted' | 'declined' | 'invoiced';
export const DOCUMENT_STATUSES: readonly DocumentStatus[] = ['draft', 'issued', 'cancelled', 'accepted', 'declined', 'invoiced'];
export type ReceiptKind = 'payment' | 'cash';

export type Action =
  | 'edit' // change content (fields, lines)
  | 'issue' // assign the number, freeze (snapshot)
  | 'reopen' // issued quote back to draft, keeping its number (D38)
  | 'accept'
  | 'decline'
  | 'convert' // accepted quote → new invoice draft
  | 'cancel' // issued invoice → cancellation invoice (Storno)
  | 'delete'
  | 'markSent'
  | 'recordPayment'
  | 'paymentReceipt' // payment receipt for a (partly) paid invoice
  | 'duplicate';
export const ACTIONS: readonly Action[] = [
  'edit', 'issue', 'reopen', 'accept', 'decline', 'convert', 'cancel', 'delete', 'markSent', 'recordPayment',
  'paymentReceipt', 'duplicate',
];

export type LifecycleDoc = { type: DocumentType; status: DocumentStatus; receiptKind?: ReceiptKind | null };

/** Result of an action: the new stored status, 'deleted', or the same status for side actions. */
export type Outcome = DocumentStatus | 'deleted';

/**
 * The complete transition table. Returns null for every forbidden action — the data layer refuses those
 * with InvalidTransitionError (and the SQLite triggers refuse content changes of non-drafts, D34).
 */
export function outcome(doc: LifecycleDoc, action: Action): Outcome | null {
  const { type, status } = doc;
  if (status === 'draft') {
    switch (action) {
      case 'edit':
        return 'draft';
      case 'issue':
        return 'issued';
      case 'delete':
        return 'deleted'; // drafts have no number: no gap (D17)
      case 'duplicate':
        return type === 'cancellation' || (type === 'receipt' && doc.receiptKind === 'payment') ? null : 'draft';
      default:
        return null;
    }
  }
  // Every issued document: sent date and duplicate (except cancellations and payment receipts).
  if (action === 'markSent') return status;
  if (action === 'duplicate') {
    return type === 'cancellation' || (type === 'receipt' && doc.receiptKind === 'payment') ? null : status;
  }
  switch (type) {
    case 'invoice':
      if (status !== 'issued') return null; // cancelled: final
      if (action === 'cancel') return 'cancelled';
      if (action === 'recordPayment' || action === 'paymentReceipt') return 'issued';
      return null;
    case 'quote':
      if (action === 'delete') return status === 'invoiced' ? null : 'deleted'; // number never reused (D17)
      if (status === 'issued') {
        if (action === 'accept') return 'accepted';
        if (action === 'decline') return 'declined';
        if (action === 'reopen') return 'draft';
      }
      if (status === 'accepted' && action === 'convert') return 'invoiced';
      return null;
    case 'receipt':
      return status === 'issued' && action === 'recordPayment' ? 'issued' : null;
    case 'cancellation':
      return null;
  }
}

export function can(doc: LifecycleDoc, action: Action): boolean {
  return outcome(doc, action) !== null;
}

export function allowedActions(doc: LifecycleDoc): Action[] {
  return ACTIONS.filter((a) => can(doc, a));
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly action: Action,
    readonly from: LifecycleDoc
  ) {
    super(`invalid_transition: ${action} is not allowed for a ${from.status} ${from.type}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertCan(doc: LifecycleDoc, action: Action): Outcome {
  const result = outcome(doc, action);
  if (result === null) throw new InvalidTransitionError(action, doc);
  return result;
}

/** Status changes a plain state update may make (Issue needs a number, so it goes through issueDocument). */
const STATUS_ACTIONS: readonly Action[] = ['reopen', 'accept', 'decline', 'convert', 'cancel'];

export function statusChangeAllowed(doc: LifecycleDoc, to: DocumentStatus): boolean {
  if (to === doc.status) return true;
  return STATUS_ACTIONS.some((a) => outcome(doc, a) === to);
}

// ---------------------------------------------------------------------------------------------
// Derived display status (SPEC §5.9, F8)
// ---------------------------------------------------------------------------------------------

export type DisplayStatus =
  | 'draft'
  | 'issued'
  | 'sent'
  | 'partially_paid'
  | 'paid'
  | 'overdue'
  | 'cancelled'
  | 'accepted'
  | 'declined'
  | 'invoiced'
  | 'expired';

export type StatusInput = LifecycleDoc & {
  sentAt: number | null;
  dueDate: string | null;
  validUntil: string | null;
  grossCents: number;
  /** Sum of payments (cents). */
  paidCents: number;
};

export type DerivedStatus = {
  status: DisplayStatus;
  /** Balance due = gross − paid (negative = overpaid), SPEC §5 step 7. */
  balance: number;
  overdue: boolean;
  partiallyPaid: boolean;
  overpaid: boolean;
  /** Whole days past the due date (0 when not overdue). */
  daysOverdue: number;
};

/** due date < today (local calendar day). ISO strings compare correctly as text. */
export function isPastDue(dueDate: string | null, today: string): boolean {
  return isValidIsoDate(dueDate) && dueDate < today;
}

/**
 * SPEC §5.9 for issued invoices: paid if Bd ≤ 0; overdue if due date < today and Bd > 0; partially paid if
 * P > 0; else open (shown as "sent" when sent_at is set, else "issued"). An overdue invoice with a part
 * payment is "overdue" with `partiallyPaid` true (D39: the action the user needs wins).
 * Quotes: expired if valid-until < today while still only issued. Computed, never stored.
 */
export function deriveStatus(doc: StatusInput, today: string): DerivedStatus {
  const balance = doc.grossCents - doc.paidCents;
  const base = { balance, overdue: false, partiallyPaid: false, overpaid: false, daysOverdue: 0 };
  const open: DisplayStatus = doc.sentAt !== null ? 'sent' : 'issued';
  if (doc.status === 'draft') return { ...base, status: 'draft' };
  if (doc.type === 'quote') {
    if (doc.status === 'issued' && isPastDue(doc.validUntil, today)) return { ...base, status: 'expired' };
    return { ...base, status: doc.status === 'issued' ? open : doc.status };
  }
  if (doc.type !== 'invoice') return { ...base, status: doc.status === 'issued' ? open : doc.status };
  if (doc.status === 'cancelled') return { ...base, status: 'cancelled' };
  const partiallyPaid = doc.paidCents > 0 && balance > 0;
  const overpaid = balance < 0;
  if (balance <= 0) return { ...base, status: 'paid', overpaid };
  if (isPastDue(doc.dueDate, today)) {
    const daysOverdue = daysBetween(doc.dueDate as string, today);
    return { ...base, status: 'overdue', overdue: true, partiallyPaid, daysOverdue };
  }
  return { ...base, status: partiallyPaid ? 'partially_paid' : open, partiallyPaid };
}

// ---------------------------------------------------------------------------------------------
// Payment terms and quote validity
// ---------------------------------------------------------------------------------------------

export const MAX_PAYMENT_DAYS = 365;
export const DEFAULT_QUOTE_VALID_DAYS = 30;

/** Payment days of a new document: the client's, else the business default (SPEC §4). */
export function paymentDaysFor(clientDays: number | null | undefined, businessDays: number): number {
  return clientDays ?? businessDays;
}

/** Due date = issue date + payment days (calendar days; 0 = due on the issue date). */
export function dueDateFor(issueDate: string, paymentDays: number): string {
  if (!Number.isInteger(paymentDays) || paymentDays < 0 || paymentDays > MAX_PAYMENT_DAYS) {
    throw new RangeError(`payment days must be 0–${MAX_PAYMENT_DAYS}`);
  }
  return addDays(issueDate, paymentDays);
}

/** The due date an invoice gets at Issue: the explicit one, else issue date + payment days, else none. */
export function effectiveDueDate(doc: { issueDate: string; dueDate: string | null; paymentDays: number | null }): string | null {
  if (doc.dueDate) return doc.dueDate;
  return doc.paymentDays === null ? null : dueDateFor(doc.issueDate, doc.paymentDays);
}

/** SPEC §10: a due date before the issue date is refused. */
export function dueDateError(issueDate: string, dueDate: string | null): 'before_issue' | 'invalid' | null {
  if (dueDate === null) return null;
  if (!isValidIsoDate(dueDate)) return 'invalid';
  return dueDate < issueDate ? 'before_issue' : null;
}

export function isQuoteExpired(doc: { type: DocumentType; status: DocumentStatus; validUntil: string | null }, today: string): boolean {
  return doc.type === 'quote' && doc.status === 'issued' && isPastDue(doc.validUntil, today);
}
