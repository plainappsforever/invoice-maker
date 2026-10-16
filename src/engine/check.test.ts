import { checkDocument, hasBlockingErrors, type CheckBusiness, type CheckClient, type CheckDocument, type CheckId, type CheckInput } from './check';
import { SOURCES } from './notes';
import type { TotalsInput, TotalsLine } from './totals';

const TODAY = '2026-10-01';
const line = (over: Partial<TotalsLine> = {}): TotalsLine => ({
  qtyMilli: 1000, priceE4: 850_000, category: 'S', rateBp: 1900, discount: { kind: 'none', value: 0 }, ...over,
}); // 85,00 € net → 101,15 € gross (> 250 € needs qty 3)

const business: CheckBusiness = {
  name: 'Muster Design', street: 'Hauptstr. 1', postalCode: '10115', city: 'Berlin', taxNumber: '12/345/67890', vatId: 'DE123456789',
  vatMode: 'standard',
};
const client: NonNullable<CheckClient> = { name: 'Kunde GmbH', street: 'Weg 2', postalCode: '20095', city: 'Hamburg', vatId: '' };
const doc: CheckDocument = {
  type: 'invoice', receiptKind: null, issueDate: TODAY, serviceMode: 'same', serviceFrom: null, serviceTo: null,
  dueDate: '2026-10-15', validUntil: null, paymentDays: null, currency: 'EUR', treatment: 'standard', legalNote: '',
};
const totals = (lines: TotalsLine[] = [line({ qtyMilli: 3000 })]): TotalsInput => ({
  lines, pricesIncludeVat: false, discount: { kind: 'none', value: 0 }, payments: [],
});

function run(over: { doc?: Partial<CheckDocument>; business?: Partial<CheckBusiness>; client?: CheckClient | Partial<NonNullable<CheckClient>>; totals?: TotalsInput; lineNames?: string[] } = {}) {
  const input: CheckInput = {
    doc: { ...doc, ...over.doc },
    business: { ...business, ...over.business },
    client: over.client === null ? null : { ...client, ...(over.client ?? {}) },
    totals: over.totals ?? totals(),
    lineNames: over.lineNames ?? (over.totals ?? totals()).lines.map((_, i) => `Leistung ${i + 1}`),
    today: TODAY,
  };
  return checkDocument(input);
}
const ids = (items: ReturnType<typeof run>) => items.map((i) => i.id);
const find = (items: ReturnType<typeof run>, id: CheckId) => items.find((i) => i.id === id);

describe('mandatory-details check: invoice above 250 € (§ 14 Abs. 4 UStG)', () => {
  it('a complete invoice has no items', () => {
    expect(run()).toEqual([]);
  });

  it.each<[string, Parameters<typeof run>[0], CheckId, string]>([
    ['business name', { business: { name: ' ' } }, 'business_name', 'business'],
    ['business street', { business: { street: '' } }, 'business_address', 'business.address'],
    ['business postal code', { business: { postalCode: '' } }, 'business_address', 'business.address'],
    ['business city', { business: { city: '' } }, 'business_address', 'business.address'],
    ['tax number and VAT id', { business: { taxNumber: '', vatId: '' } }, 'business_tax_id', 'business.taxId'],
    ['client', { client: null }, 'client_missing', 'client'],
    ['client street', { client: { street: '' } }, 'client_address', 'client.address'],
    ['client postal code', { client: { postalCode: '' } }, 'client_address', 'client.address'],
    ['client city', { client: { city: '' } }, 'client_address', 'client.address'],
    ['service date (none)', { doc: { serviceMode: 'none' } }, 'service_date_missing', 'serviceDate'],
    ['service date (date, empty)', { doc: { serviceMode: 'date' } }, 'service_date_missing', 'serviceDate'],
    ['service month (empty)', { doc: { serviceMode: 'month' } }, 'service_date_missing', 'serviceDate'],
    ['service period end', { doc: { serviceMode: 'period', serviceFrom: '2026-09-01' } }, 'service_date_missing', 'serviceDate'],
  ])('missing %s → warn item with the § 14 source and a Fix target', (_label, over, id, fix) => {
    const items = run(over);
    expect(ids(items)).toEqual([id]);
    expect(items[0]).toMatchObject({ severity: 'warn', fix });
    expect(items[0].sources).toContainEqual(SOURCES.ustg14);
    expect(hasBlockingErrors(items)).toBe(false); // information, never blocks Issue (D21)
  });

  it('either the tax number or the VAT id is enough', () => {
    expect(run({ business: { taxNumber: '' } })).toEqual([]);
    expect(run({ business: { vatId: '' } })).toEqual([]);
  });

  it('service period ending before it starts; given dates are fine', () => {
    expect(ids(run({ doc: { serviceMode: 'period', serviceFrom: '2026-09-30', serviceTo: '2026-09-01' } }))).toEqual(['service_period_invalid']);
    expect(run({ doc: { serviceMode: 'period', serviceFrom: '2026-09-01', serviceTo: '2026-09-30' } })).toEqual([]);
    expect(run({ doc: { serviceMode: 'month', serviceFrom: '2026-09-01' } })).toEqual([]);
    expect(run({ doc: { serviceMode: 'date', serviceFrom: '2026-09-28' } })).toEqual([]);
  });

  it('blank client name and blank line name are caught (§ 14 Abs. 4 Nr. 1 and 5, review #7)', () => {
    const items = run({ client: { name: '   ' }, totals: totals([line({ qtyMilli: 3000 }), line()]), lineNames: ['Webdesign', ''] });
    expect(items).toEqual([
      { id: 'client_name', severity: 'warn', fix: 'client', sources: [SOURCES.ustg14] },
      { id: 'line_name_missing', severity: 'warn', fix: 'lines', sources: [SOURCES.ustg14], line: 1 },
    ]);
    expect(hasBlockingErrors(items)).toBe(false);
    // small amounts: the § 33 UStDV source (kind of service is still needed there)
    const small = run({ totals: totals([line()]), lineNames: [' '] });
    expect(small).toEqual([{ id: 'line_name_missing', severity: 'warn', fix: 'lines', sources: [SOURCES.ustdv33], line: 0 }]);
  });

  it('dates: future issue date is info; due date before issue date is a warning', () => {
    const future = run({ doc: { issueDate: '2026-10-05', dueDate: null } });
    expect(future).toEqual([{ id: 'issue_date_future', severity: 'info', fix: 'issueDate', sources: [] }]);
    expect(ids(run({ doc: { dueDate: '2026-09-30' } }))).toEqual(['due_before_issue']);
    expect(run({ doc: { paymentDays: 400 } })).toEqual([{ id: 'payment_days_invalid', severity: 'error', fix: 'dueDate', sources: [] }]);
    expect(ids(run({ doc: { paymentDays: -1 } }))).toEqual(['payment_days_invalid']);
    expect(run({ doc: { paymentDays: 365 } })).toEqual([]);
    // a past issue date with a typed date of supply is information: Issue dates the document today (D54)
    expect(run({ doc: { issueDate: '2026-06-01', dueDate: null, serviceMode: 'date', serviceFrom: '2026-05-30' } })).toEqual([{ id: 'issue_date_past', severity: 'info', fix: 'issueDate', sources: [] }]);
    // …with "same as issue date" it blocks until the user chooses the date of supply (D82, review #5)
    expect(run({ doc: { issueDate: '2026-06-01', dueDate: null } })).toEqual([
      { id: 'service_date_stale', severity: 'error', fix: 'serviceDate', sources: [SOURCES.ustg14], date: '2026-06-01' },
    ]);
    expect(ids(run({ doc: { issueDate: '2026-06-01', dueDate: null, type: 'receipt', receiptKind: 'cash' } }))).toContain('service_date_stale');
    expect(ids(run({ doc: { issueDate: '2026-06-01', dueDate: null, type: 'quote', validUntil: '2026-07-01' } }))).not.toContain('service_date_stale');
  });
});

describe('small-amount invoices ≤ 250 € (§ 33 UStDV)', () => {
  const small = totals([line({ qtyMilli: 2000 })]); // 202,30 € gross
  it('need no client, client address, tax number or service date', () => {
    expect(run({ totals: small, client: null, business: { taxNumber: '', vatId: '' }, doc: { serviceMode: 'none' } })).toEqual([]);
  });
  it('still need the business name and address, with the § 33 UStDV source', () => {
    const items = run({ totals: small, business: { name: '', city: '' } });
    expect(ids(items)).toEqual(['business_name', 'business_address']);
    expect(items[0].sources).toEqual([SOURCES.ustdv33]);
  });
  it('the limit is gross 250,00 €; in another currency the full checks apply', () => {
    const exactly250 = totals([line({ qtyMilli: 1000, priceE4: 2_100_840 })]); // 210,084 → 210,08 net + 39,92 = 250,00
    expect(run({ totals: exactly250, client: null })).toEqual([]);
    const above = totals([line({ qtyMilli: 1000, priceE4: 2_100_920 })]); // 210,09 + 39,92 = 250,01
    expect(ids(run({ totals: above, client: null }))).toEqual(['client_missing']);
    expect(ids(run({ totals: small, client: null, doc: { currency: 'USD' } }))).toEqual(['client_missing']);
  });
});

describe('hard errors block Issue', () => {
  it.each<[string, TotalsInput, CheckId]>([
    ['no line', totals([]), 'no_lines'],
    ['quantity 0', totals([line({ qtyMilli: 0 })]), 'qty_zero'],
    ['negative quantity', totals([line({ qtyMilli: -1000 })]), 'negative_qty'],
    ['invalid rate', totals([line({ rateBp: 12_000 })]), 'invalid_rate'],
    ['line discount', totals([line({ discount: { kind: 'percent', value: 10_001 } })]), 'line_discount_too_large'],
    ['amount too large', totals([line({ qtyMilli: 999_999_000, priceE4: 99_999_990_000 })]), 'amount_too_large'],
  ])('%s', (_label, t, id) => {
    const items = run({ totals: t });
    expect(find(items, id)).toMatchObject({ severity: 'error', fix: 'lines' });
    expect(hasBlockingErrors(items)).toBe(true);
  });

  it('negative price → negative price and negative total', () => {
    const items = run({ totals: totals([line({ priceE4: -850_000, qtyMilli: 3000 })]) });
    expect(ids(items).slice(0, 2)).toEqual(['negative_price', 'negative_total']);
  });

  it('document discount too large and missing currency', () => {
    const t = { ...totals(), discount: { kind: 'amount' as const, value: 999_999 } };
    expect(find(run({ totals: t }), 'document_discount_too_large')).toMatchObject({ severity: 'error', fix: 'discount' });
    expect(find(run({ doc: { currency: '' } }), 'currency_missing')).toMatchObject({ severity: 'error', fix: 'currency' });
    expect(find(run({ doc: { currency: 'XYZ' } }), 'currency_missing')).toBeDefined();
  });

  it('errors come first, then warnings, then info', () => {
    const items = run({ totals: totals([]), business: { name: '' }, doc: { issueDate: '2026-10-09', dueDate: null } });
    expect(items.map((i) => i.severity)).toEqual(['error', 'warn', 'info']);
  });

  it('a cancellation (negated quantities) is not an error and is not re-checked', () => {
    const negated = totals([line({ qtyMilli: -3000 })]);
    expect(run({ totals: negated, doc: { type: 'cancellation' }, client: null, business: { name: '' } })).toEqual([]);
    expect(ids(run({ totals: totals([]), doc: { type: 'cancellation' } }))).toEqual(['no_lines']);
  });
});

describe('tax treatments and their notes', () => {
  const RC = 'Steuerschuldnerschaft des Leistungsempfängers.';
  const noVat = (category: TotalsLine['category']) => totals([line({ qtyMilli: 3000, category, rateBp: 0 })]);

  it('reverse charge: client VAT id, own VAT id and the note (§ 14a UStG)', () => {
    const items = run({ doc: { treatment: 'reverse_charge' }, business: { vatId: '' }, totals: noVat('AE') });
    expect(ids(items)).toEqual(['legal_note_missing', 'client_vat_id_missing', 'own_vat_id_missing']);
    expect(find(items, 'client_vat_id_missing')?.sources).toEqual([SOURCES.ustg14a]);
    expect(find(items, 'legal_note_missing')?.sources.map((s) => s.law)).toEqual(['§ 14a UStG', '§ 13b UStG']);
    expect(run({ doc: { treatment: 'reverse_charge', legalNote: RC }, client: { vatId: 'ATU12345678' }, totals: noVat('AE') })).toEqual([]);
  });

  it('reverse charge with VAT lines → blocking conflict pointing at the line, with the one-tap fix (D83, review #6)', () => {
    const items = run({ doc: { treatment: 'reverse_charge', legalNote: RC }, client: { vatId: 'ATU12345678' } });
    expect(items).toEqual([expect.objectContaining({ id: 'vat_lines_conflict', severity: 'error', fix: 'lines.removeVat', line: 0 })]);
    expect(find(items, 'vat_lines_conflict')?.sources.map((s) => s.law)).toContain('§ 14c UStG');
    expect(hasBlockingErrors(items)).toBe(true);
  });

  it('reverse charge is never a small-amount invoice', () => {
    const small = totals([line({ category: 'AE', rateBp: 0 })]);
    expect(ids(run({ doc: { treatment: 'reverse_charge', legalNote: RC }, client: null, totals: small }))).toEqual(['client_missing']);
  });

  it('intra-EU supply of goods: both VAT ids and the note', () => {
    expect(ids(run({ doc: { treatment: 'intra_eu_goods' }, totals: noVat('K') }))).toEqual(['legal_note_missing', 'client_vat_id_missing']);
  });

  it('export and exemption: the note; an exemption note with its [placeholder] still unfilled', () => {
    expect(ids(run({ doc: { treatment: 'export' }, totals: noVat('G') }))).toEqual(['legal_note_missing']);
    expect(ids(run({ doc: { treatment: 'exempt' }, totals: noVat('E') }))).toEqual(['legal_note_missing']);
    const placeholder = run({ doc: { treatment: 'exempt', legalNote: 'Umsatzsteuerfrei: [Befreiungsgrund ergänzen, z. B. § 4 Nr. … UStG]' }, totals: noVat('E') });
    expect(ids(placeholder)).toEqual(['legal_note_placeholder']);
    expect(run({ doc: { treatment: 'exempt', legalNote: 'Umsatzsteuerfrei nach § 4 Nr. 14 UStG.' }, totals: noVat('E') })).toEqual([]);
  });

  it('§ 19 small business: the note (§ 19 UStG, § 34a UStDV) and no VAT lines', () => {
    const sb = { vatMode: 'small_business' as const };
    const items = run({ business: sb, totals: noVat('E') });
    expect(ids(items)).toEqual(['legal_note_missing']);
    expect(items[0].sources).toEqual([SOURCES.ustg19, SOURCES.ustdv34a]);
  });

  it('§ 19 small business with a VAT line blocks Issue, with the one-tap fix (D51, review #2)', () => {
    const sb = { vatMode: 'small_business' as const };
    const note = 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.';
    const mixed = totals([line({ category: 'E', rateBp: 0 }), line({ qtyMilli: 2000 })]);
    const items = run({ business: sb, doc: { legalNote: note }, totals: mixed });
    expect(items).toEqual([expect.objectContaining({ id: 'small_business_vat', severity: 'error', fix: 'lines.removeVat', line: 1 })]);
    expect(items[0].sources).toEqual([SOURCES.ustg19, SOURCES.ustdv34a]);
    expect(hasBlockingErrors(items)).toBe(true);
    // under any treatment: a §19 business never issues a document with VAT
    expect(ids(run({ business: sb, doc: { treatment: 'reverse_charge', legalNote: 'x' }, client: { vatId: 'ATU12345678' } }))).toContain('small_business_vat');
    // a VAT line at 0 % and no-VAT categories are fine
    expect(run({ business: sb, doc: { legalNote: note }, totals: totals([line({ rateBp: 0 }), line({ category: 'E', rateBp: 0 })]) })).toEqual([]);
  });
});

describe('receipts (D30) and quotes', () => {
  const receipt = { type: 'receipt' as const, receiptKind: 'cash' as const, dueDate: null };
  it('cash receipt ≤ 250 €: no client needed; business name/address with § 33 UStDV', () => {
    const t = totals([line({ qtyMilli: 2000 })]);
    expect(run({ doc: receipt, client: null, totals: t, business: { taxNumber: '', vatId: '' } })).toEqual([]);
    expect(find(run({ doc: receipt, totals: t, business: { name: '' } }), 'business_name')?.sources).toEqual([SOURCES.ustdv33]);
  });
  it('cash receipt over 250 €: "a full invoice is usually required"', () => {
    const items = run({ doc: receipt, client: null });
    expect(items).toEqual([{ id: 'receipt_over_250', severity: 'warn', fix: 'client', sources: [SOURCES.ustdv33] }]);
  });
  it('payment receipt: only who issued it (the invoice carries the rest)', () => {
    const doc2 = { type: 'receipt' as const, receiptKind: 'payment' as const, dueDate: null, treatment: 'reverse_charge' as const };
    expect(run({ doc: doc2, client: null })).toEqual([]);
    expect(ids(run({ doc: doc2, business: { street: '' } }))).toEqual(['business_address']);
  });
  it('quote: client is a warning, valid-until and the note are info, no § 14 items', () => {
    const quote = { type: 'quote' as const, dueDate: null, validUntil: null, serviceMode: 'none' as const };
    const items = run({ doc: { ...quote, treatment: 'export' }, client: null, business: { taxNumber: '', vatId: '' }, totals: totals([line({ qtyMilli: 3000, category: 'G', rateBp: 0 })]) });
    expect(items.map((i) => [i.id, i.severity])).toEqual([
      ['client_missing', 'warn'],
      ['valid_until_missing', 'info'],
      ['legal_note_missing', 'info'],
    ]);
  });
});
