import type { DocumentType } from './numbering';
import {
  ACTIONS,
  allowedActions,
  assertCan,
  deriveStatus,
  dueDateError,
  dueDateFor,
  effectiveDueDate,
  InvalidTransitionError,
  isQuoteExpired,
  outcome,
  paymentDaysFor,
  statusChangeAllowed,
  type Action,
  type DocumentStatus,
  type LifecycleDoc,
  type Outcome,
  type StatusInput,
} from './status';

// The complete expected table. Every (document, action) pair not listed here must be forbidden.
type Row = [label: string, doc: LifecycleDoc, allowed: Partial<Record<Action, Outcome>>];
const TABLE: Row[] = [
  ['invoice draft', { type: 'invoice', status: 'draft' }, { edit: 'draft', issue: 'issued', delete: 'deleted', duplicate: 'draft' }],
  ['invoice issued', { type: 'invoice', status: 'issued' }, { markSent: 'issued', duplicate: 'issued', cancel: 'cancelled', recordPayment: 'issued', paymentReceipt: 'issued' }],
  ['invoice cancelled', { type: 'invoice', status: 'cancelled' }, { markSent: 'cancelled', duplicate: 'cancelled' }],
  ['quote draft', { type: 'quote', status: 'draft' }, { edit: 'draft', issue: 'issued', delete: 'deleted', duplicate: 'draft' }],
  ['quote issued', { type: 'quote', status: 'issued' }, { markSent: 'issued', duplicate: 'issued', delete: 'deleted', accept: 'accepted', decline: 'declined', reopen: 'draft' }],
  ['quote accepted', { type: 'quote', status: 'accepted' }, { markSent: 'accepted', duplicate: 'accepted', delete: 'deleted', convert: 'invoiced' }],
  ['quote declined', { type: 'quote', status: 'declined' }, { markSent: 'declined', duplicate: 'declined', delete: 'deleted' }],
  ['quote invoiced', { type: 'quote', status: 'invoiced' }, { markSent: 'invoiced', duplicate: 'invoiced' }],
  ['cash receipt draft', { type: 'receipt', status: 'draft', receiptKind: 'cash' }, { edit: 'draft', issue: 'issued', delete: 'deleted', duplicate: 'draft' }],
  ['cash receipt issued', { type: 'receipt', status: 'issued', receiptKind: 'cash' }, { markSent: 'issued', duplicate: 'issued', recordPayment: 'issued' }],
  ['payment receipt draft', { type: 'receipt', status: 'draft', receiptKind: 'payment' }, { edit: 'draft', issue: 'issued', delete: 'deleted' }],
  ['payment receipt issued', { type: 'receipt', status: 'issued', receiptKind: 'payment' }, { markSent: 'issued', recordPayment: 'issued' }],
  ['cancellation draft', { type: 'cancellation', status: 'draft' }, { edit: 'draft', issue: 'issued', delete: 'deleted' }],
  ['cancellation issued', { type: 'cancellation', status: 'issued' }, { markSent: 'issued' }],
];

describe('lifecycle transition table', () => {
  it.each(TABLE)('%s: exactly the listed actions are allowed, with the listed outcome', (_label, doc, allowed) => {
    for (const action of ACTIONS) {
      expect([action, outcome(doc, action)]).toEqual([action, allowed[action] ?? null]);
    }
    expect(allowedActions(doc)).toEqual(ACTIONS.filter((a) => a in allowed));
  });

  it('never allows editing anything but a draft (an issued invoice is never edited)', () => {
    for (const [, doc] of TABLE) expect(outcome(doc, 'edit') !== null).toBe(doc.status === 'draft');
  });

  it('statuses that cannot occur for a type allow nothing but sent/duplicate', () => {
    const impossible: [DocumentType, DocumentStatus][] = [
      ['invoice', 'accepted'], ['invoice', 'declined'], ['invoice', 'invoiced'], ['receipt', 'cancelled'], ['cancellation', 'cancelled'],
    ];
    for (const [type, status] of impossible) {
      const actions = allowedActions({ type, status }).filter((a) => a !== 'markSent' && a !== 'duplicate');
      expect([type, status, actions]).toEqual([type, status, []]);
    }
  });

  it('assertCan throws InvalidTransitionError for forbidden actions', () => {
    expect(assertCan({ type: 'invoice', status: 'issued' }, 'cancel')).toBe('cancelled');
    expect(() => assertCan({ type: 'invoice', status: 'issued' }, 'edit')).toThrow(InvalidTransitionError);
    expect(() => assertCan({ type: 'invoice', status: 'cancelled' }, 'cancel')).toThrow(/invalid_transition: cancel/);
    expect(() => assertCan({ type: 'cancellation', status: 'issued' }, 'cancel')).toThrow(InvalidTransitionError);
    expect(() => assertCan({ type: 'quote', status: 'declined' }, 'convert')).toThrow(InvalidTransitionError);
    expect(() => assertCan({ type: 'quote', status: 'issued' }, 'convert')).toThrow(InvalidTransitionError);
  });

  it('plain status updates allow only table transitions, never Issue (it needs a number)', () => {
    expect(statusChangeAllowed({ type: 'invoice', status: 'issued' }, 'cancelled')).toBe(true);
    expect(statusChangeAllowed({ type: 'invoice', status: 'draft' }, 'issued')).toBe(false);
    expect(statusChangeAllowed({ type: 'invoice', status: 'cancelled' }, 'issued')).toBe(false);
    expect(statusChangeAllowed({ type: 'invoice', status: 'issued' }, 'draft')).toBe(false);
    expect(statusChangeAllowed({ type: 'quote', status: 'issued' }, 'draft')).toBe(true);
    expect(statusChangeAllowed({ type: 'quote', status: 'accepted' }, 'declined')).toBe(false);
    expect(statusChangeAllowed({ type: 'quote', status: 'issued' }, 'issued')).toBe(true);
  });
});

const TODAY = '2026-10-20';
const invoice = (over: Partial<StatusInput> = {}): StatusInput => ({
  type: 'invoice', status: 'issued', sentAt: null, dueDate: '2026-10-15', validUntil: null, grossCents: 10_000, paidCents: 0, ...over,
});

describe('derived status (SPEC §5.9) — computed from dates and payments, never stored', () => {
  it('open invoices: issued, or sent once sent_at is set', () => {
    expect(deriveStatus(invoice({ dueDate: '2026-10-30' }), TODAY).status).toBe('issued');
    expect(deriveStatus(invoice({ dueDate: '2026-10-30', sentAt: 1 }), TODAY).status).toBe('sent');
    expect(deriveStatus(invoice({ dueDate: null }), TODAY).status).toBe('issued');
  });

  it('overdue only when the due date is before today and a balance is left', () => {
    expect(deriveStatus(invoice({ dueDate: TODAY }), TODAY)).toMatchObject({ status: 'issued', overdue: false });
    expect(deriveStatus(invoice({ dueDate: '2026-10-19' }), TODAY)).toMatchObject({ status: 'overdue', overdue: true, daysOverdue: 1 });
    expect(deriveStatus(invoice(), TODAY)).toMatchObject({ status: 'overdue', daysOverdue: 5, balance: 10_000 });
    // Same stored row, earlier day: not overdue — nothing stored changes.
    expect(deriveStatus(invoice(), '2026-10-15').status).toBe('issued');
    // Across a month end.
    expect(deriveStatus(invoice({ dueDate: '2026-10-31' }), '2026-11-01')).toMatchObject({ status: 'overdue', daysOverdue: 1 });
  });

  it('payments: partially paid, paid, overpaid', () => {
    expect(deriveStatus(invoice({ dueDate: '2026-10-30', paidCents: 3_000 }), TODAY)).toMatchObject({
      status: 'partially_paid', partiallyPaid: true, balance: 7_000,
    });
    expect(deriveStatus(invoice({ paidCents: 10_000 }), TODAY)).toMatchObject({ status: 'paid', balance: 0, overdue: false });
    expect(deriveStatus(invoice({ paidCents: 12_000 }), TODAY)).toMatchObject({ status: 'paid', overpaid: true, balance: -2_000 });
  });

  it('an overdue invoice with a part payment is overdue and flagged partially paid (D39)', () => {
    expect(deriveStatus(invoice({ paidCents: 3_000 }), TODAY)).toMatchObject({ status: 'overdue', partiallyPaid: true, balance: 7_000 });
  });

  it('cancelled invoices, drafts, receipts and cancellations', () => {
    expect(deriveStatus(invoice({ status: 'cancelled' }), TODAY).status).toBe('cancelled');
    expect(deriveStatus(invoice({ status: 'draft' }), TODAY).status).toBe('draft');
    expect(deriveStatus(invoice({ type: 'receipt' }), TODAY).status).toBe('issued');
    expect(deriveStatus(invoice({ type: 'cancellation', grossCents: -10_000, sentAt: 5 }), TODAY).status).toBe('sent');
  });

  it('quotes: expired after valid-until unless accepted/declined/invoiced', () => {
    const quote = (status: DocumentStatus, validUntil: string | null) => invoice({ type: 'quote', status, validUntil, dueDate: null });
    expect(deriveStatus(quote('issued', '2026-10-19'), TODAY).status).toBe('expired');
    expect(deriveStatus(quote('issued', TODAY), TODAY).status).toBe('issued');
    expect(deriveStatus(quote('issued', null), TODAY).status).toBe('issued');
    expect(deriveStatus(quote('accepted', '2026-10-01'), TODAY).status).toBe('accepted');
    expect(deriveStatus(quote('declined', '2026-10-01'), TODAY).status).toBe('declined');
    expect(deriveStatus(quote('invoiced', '2026-10-01'), TODAY).status).toBe('invoiced');
    expect(isQuoteExpired({ type: 'quote', status: 'issued', validUntil: '2026-10-19' }, TODAY)).toBe(true);
    expect(isQuoteExpired({ type: 'invoice', status: 'issued', validUntil: '2026-10-19' }, TODAY)).toBe(false);
  });
});

describe('payment terms', () => {
  it('due date = issue date + payment days (calendar days)', () => {
    expect(dueDateFor('2026-10-01', 14)).toBe('2026-10-15');
    expect(dueDateFor('2026-10-01', 0)).toBe('2026-10-01');
    expect(dueDateFor('2026-12-20', 30)).toBe('2027-01-19');
    expect(dueDateFor('2026-01-31', 30)).toBe('2026-03-02');
    expect(() => dueDateFor('2026-10-01', -1)).toThrow(RangeError);
    expect(() => dueDateFor('2026-10-01', 1.5)).toThrow(RangeError);
    expect(() => dueDateFor('2026-10-01', 366)).toThrow(RangeError);
  });

  it('explicit due date wins; else payment days; else none', () => {
    expect(effectiveDueDate({ issueDate: '2026-10-01', dueDate: '2026-11-30', paymentDays: 14 })).toBe('2026-11-30');
    expect(effectiveDueDate({ issueDate: '2026-10-01', dueDate: null, paymentDays: 7 })).toBe('2026-10-08');
    expect(effectiveDueDate({ issueDate: '2026-10-01', dueDate: null, paymentDays: null })).toBeNull();
  });

  it('client payment days override the business default', () => {
    expect(paymentDaysFor(30, 14)).toBe(30);
    expect(paymentDaysFor(0, 14)).toBe(0);
    expect(paymentDaysFor(null, 14)).toBe(14);
    expect(paymentDaysFor(undefined, 14)).toBe(14);
  });

  it('a due date before the issue date is refused (SPEC §10)', () => {
    expect(dueDateError('2026-10-10', '2026-10-09')).toBe('before_issue');
    expect(dueDateError('2026-10-10', '2026-10-10')).toBeNull();
    expect(dueDateError('2026-10-10', null)).toBeNull();
    expect(dueDateError('2026-10-10', '2026-02-30')).toBe('invalid');
  });
});
