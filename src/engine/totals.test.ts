import examples from './__fixtures__/worked-examples.json';
import { generateCases } from './__fixtures__/generated';
import oracle from './__fixtures__/oracle-cases.json';
import {
  allocateDiscount,
  cancellationInput,
  computeTotals,
  validateTotals,
  type TaxCategory,
  type Totals,
  type TotalsInput,
} from './totals';

type Example = (typeof examples.examples)[number];

function inputOf(example: Example): TotalsInput {
  const source = 'input' in example ? example : examples.examples.find((e) => e.id === example.cancellationOf)!;
  const input = (source as { input: TotalsInput }).input;
  const plain: TotalsInput = {
    pricesIncludeVat: input.pricesIncludeVat,
    discount: input.discount,
    payments: input.payments,
    lines: input.lines.map((l) => ({
      qtyMilli: l.qtyMilli,
      priceE4: l.priceE4,
      category: l.category as TaxCategory,
      rateBp: l.rateBp,
      discount: l.discount,
    })),
  };
  return 'cancellationOf' in example ? cancellationInput(plain) : plain;
}

describe('SPEC §5 worked examples (to the cent, every intermediate number)', () => {
  it.each(examples.examples.map((e) => [e.id, e] as const))('example %s', (_id, example) => {
    expect(computeTotals(inputOf(example))).toEqual(example.expected);
  });

  it('A: 5 % document discount 59,09 is split 56,60 / 2,49 and the balance after the 300,00 deposit is 1.030,29', () => {
    const t = computeTotals(inputOf(examples.examples[0]));
    expect(t.groups.map((g) => g.discount)).toEqual([5660, 249]);
    expect(t.balance).toBe(103029);
  });

  it('B: the remaining cent of the fixed discount goes to the 19 % group; total = entered gross − discount', () => {
    const t = computeTotals(inputOf(examples.examples[1]));
    expect(t.groups.map((g) => g.discount)).toEqual([377, 123]);
    expect(t.gross).toBe(8097 - 500);
  });

  it('E2: tax is rounded per rate group (0,19), not per line (would be 0,20)', () => {
    const example = examples.examples.find((e) => e.id === 'E2')!;
    const input = inputOf(example);
    const perLine = input.lines.reduce((a, l) => a + computeTotals({ ...input, lines: [l] }).tax, 0);
    expect(perLine).toBe(example.document.perLineTaxWouldBe);
    expect(computeTotals(input).tax).toBe(19);
  });

  it('F: the cancellation of A is the exact negation of A (except payments)', () => {
    const a = computeTotals(inputOf(examples.examples[0]));
    const f = computeTotals(inputOf(examples.examples.find((e) => e.id === 'F')!));
    expect(f.net).toBe(-a.net);
    expect(f.tax).toBe(-a.tax);
    expect(f.gross).toBe(-a.gross);
    expect(f.groups.map((g) => g.tax)).toEqual([-20432, -331]);
  });
});

// ---------------------------------------------------------------------------------------------
// Independent reference: decimal strings and BigInt digit strings, written separately from the
// engine. It follows SPEC §5 literally in euro units ("12.500" × "85.0000"), rounds by looking at
// decimal digits, and divides by long division to 40 decimal places.
// ---------------------------------------------------------------------------------------------

type Dec = { digits: bigint; scale: number }; // value = digits / 10^scale

const dec = (s: string): Dec => {
  const neg = s.startsWith('-');
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.');
  const digits = BigInt(i + f);
  return { digits: neg ? -digits : digits, scale: f.length };
};
const fromInt = (n: number, scale: number): Dec => ({ digits: BigInt(n), scale });
const align = (a: Dec, b: Dec): [bigint, bigint, number] => {
  const scale = Math.max(a.scale, b.scale);
  return [a.digits * 10n ** BigInt(scale - a.scale), b.digits * 10n ** BigInt(scale - b.scale), scale];
};
const add = (a: Dec, b: Dec): Dec => {
  const [x, y, scale] = align(a, b);
  return { digits: x + y, scale };
};
const sub = (a: Dec, b: Dec): Dec => add(a, { digits: -b.digits, scale: b.scale });
const mul = (a: Dec, b: Dec): Dec => ({ digits: a.digits * b.digits, scale: a.scale + b.scale });
const cmp = (a: Dec, b: Dec): number => {
  const [x, y] = align(a, b);
  return x === y ? 0 : x < y ? -1 : 1;
};
const isZero = (a: Dec) => a.digits === 0n;
const neg = (a: Dec): Dec => ({ digits: -a.digits, scale: a.scale });
const absDec = (a: Dec): Dec => (a.digits < 0n ? neg(a) : a);

/** Long division to 40 decimals, truncated (exact enough to decide rounding and remainders here). */
function div(a: Dec, b: Dec): Dec {
  const negative = a.digits < 0n !== b.digits < 0n;
  const [x, y] = align(absDec(a), absDec(b));
  let q = x / y;
  let r = x % y;
  let s = q.toString() + '.';
  for (let i = 0; i < 40; i++) {
    r *= 10n;
    q = r / y;
    r %= y;
    s += q.toString();
  }
  const result = dec(s);
  return negative ? neg(result) : result;
}

/** Round half away from zero to `places` decimals by inspecting the digit string. */
function roundTo(a: Dec, places: number): Dec {
  if (a.scale <= places) return { digits: a.digits * 10n ** BigInt(places - a.scale), scale: places };
  const negative = a.digits < 0n;
  const s = (negative ? -a.digits : a.digits).toString().padStart(a.scale + 1, '0');
  const cut = s.length - (a.scale - places);
  let kept = BigInt(s.slice(0, cut));
  if (Number(s[cut]) >= 5) kept += 1n;
  return { digits: negative ? -kept : kept, scale: places };
}
/** Floor (toward −∞) to `places` decimals by cutting the digit string. */
function floorTo(a: Dec, places: number): Dec {
  if (a.scale <= places) return { digits: a.digits * 10n ** BigInt(places - a.scale), scale: places };
  const negative = a.digits < 0n;
  const s = (negative ? -a.digits : a.digits).toString().padStart(a.scale + 1, '0');
  const cut = s.length - (a.scale - places);
  let kept = BigInt(s.slice(0, cut));
  if (negative && /[1-9]/.test(s.slice(cut))) kept += 1n;
  return { digits: negative ? -kept : kept, scale: places };
}
const toCents = (a: Dec): number => Number(roundTo(a, 2).digits);

function referenceTotals(input: TotalsInput): Totals {
  const hundred = dec('100');
  const lines = input.lines.map((l) => {
    const base = roundTo(mul(fromInt(l.qtyMilli, 3), fromInt(l.priceE4, 4)), 2);
    let disc = dec('0');
    if (l.discount.kind === 'percent') disc = roundTo(div(mul(base, fromInt(l.discount.value, 2)), hundred), 2);
    if (l.discount.kind === 'amount') {
      const amount = fromInt(l.discount.value, 2);
      const capped = cmp(amount, absDec(base)) < 0 ? amount : absDec(base);
      disc = base.digits < 0n ? neg(capped) : capped;
    }
    return { base, disc, net: sub(base, disc) };
  });

  const order: TaxCategory[] = ['S', 'Z', 'E', 'AE', 'K', 'G', 'O'];
  const groups: { category: TaxCategory; rate: number; amount: Dec }[] = [];
  input.lines.forEach((l, i) => {
    const rate = l.category === 'S' ? l.rateBp : 0;
    let g = groups.find((x) => x.category === l.category && x.rate === rate);
    if (!g) groups.push((g = { category: l.category, rate, amount: dec('0') }));
    g.amount = add(g.amount, lines[i].net);
  });
  groups.sort((a, b) => b.rate - a.rate || order.indexOf(a.category) - order.indexOf(b.category));
  const sum = groups.reduce((a, g) => add(a, g.amount), dec('0'));

  let total = dec('0');
  if (input.discount.kind === 'percent') total = roundTo(div(mul(sum, fromInt(input.discount.value, 2)), hundred), 2);
  if (input.discount.kind === 'amount') {
    const amount = fromInt(input.discount.value, 2);
    const capped = cmp(amount, absDec(sum)) < 0 ? amount : absDec(sum);
    total = sum.digits < 0n ? neg(capped) : capped;
  }

  // Largest remainder on magnitudes in the direction of ΣG.
  const flip = sum.digits < 0n;
  const shares = groups.map(() => dec('0'));
  if (!isZero(total) && !isZero(sum)) {
    const d = flip ? neg(total) : total;
    const raws = groups.map((g) => div(mul(d, flip ? neg(g.amount) : g.amount), absDec(sum)));
    const floors = raws.map((raw) => floorTo(raw, 2));
    let left = sub(d, floors.reduce((a, f) => add(a, f), dec('0')));
    const fractions = raws.map((raw, i) => ({ i, frac: sub(raw, floors[i]) }));
    fractions.sort((a, b) => cmp(b.frac, a.frac) || a.i - b.i);
    for (let k = 0; cmp(left, dec('0')) > 0; k = (k + 1) % fractions.length) {
      floors[fractions[k].i] = add(floors[fractions[k].i], dec('0.01'));
      left = sub(left, dec('0.01'));
    }
    floors.forEach((f, i) => (shares[i] = flip ? neg(f) : f));
  }

  const outGroups = groups.map((g, k) => {
    const after = sub(g.amount, shares[k]);
    const rate = fromInt(g.rate, 2); // percent
    let taxable: Dec;
    let tax: Dec;
    if (input.pricesIncludeVat) {
      tax = roundTo(div(mul(after, rate), add(hundred, rate)), 2);
      taxable = sub(after, tax);
    } else {
      taxable = after;
      tax = roundTo(div(mul(after, rate), hundred), 2);
    }
    return {
      category: g.category,
      rateBp: g.rate,
      amount: toCents(g.amount),
      discount: toCents(shares[k]),
      taxable: toCents(taxable),
      tax: toCents(tax),
      gross: toCents(add(taxable, tax)),
    };
  });
  const net = outGroups.reduce((a, g) => a + g.taxable, 0);
  const tax = outGroups.reduce((a, g) => a + g.tax, 0);
  const paid = input.payments.reduce((a, p) => a + p, 0);
  return {
    lines: lines.map((l) => ({ base: toCents(l.base), discount: toCents(l.disc), net: toCents(l.net) })),
    groups: outGroups,
    lineTotal: toCents(sum),
    discount: toCents(total),
    net,
    tax,
    gross: net + tax,
    paid,
    balance: net + tax - paid,
  };
}

describe('reference implementation sanity', () => {
  it('reproduces every worked example itself', () => {
    for (const e of examples.examples) expect(referenceTotals(inputOf(e))).toEqual(e.expected);
  });
  it('rounds half away from zero', () => {
    expect(roundTo(dec('0.125'), 2)).toEqual(dec('0.13'));
    expect(roundTo(dec('-0.125'), 2)).toEqual(dec('-0.13'));
    expect(roundTo(dec('0.1249'), 2)).toEqual(dec('0.12'));
  });
});

const CASES = generateCases(400);

describe('400 generated cases against the reference', () => {
  it('match to the cent', () => {
    let checked = 0;
    for (const input of CASES) {
      expect(computeTotals(input)).toEqual(referenceTotals(input));
      checked++;
    }
    expect(checked).toBe(400);
  });

  it('cover products above 2^53, gross mode, every discount kind and 0 % categories', () => {
    const lines = CASES.flatMap((c) => c.lines);
    expect(lines.some((l) => l.qtyMilli * l.priceE4 > Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(CASES.some((c) => c.pricesIncludeVat)).toBe(true);
    expect(CASES.some((c) => !c.pricesIncludeVat)).toBe(true);
    for (const kind of ['none', 'percent', 'amount']) expect(lines.some((l) => l.discount.kind === kind)).toBe(true);
    for (const kind of ['none', 'percent', 'amount']) expect(CASES.some((c) => c.discount.kind === kind)).toBe(true);
    expect(lines.some((l) => l.category === 'AE')).toBe(true);
    expect(CASES.some((c) => new Set(c.lines.map((l) => l.rateBp)).size >= 3)).toBe(true);
  });
});

describe('properties (all generated cases)', () => {
  const totals = CASES.map(computeTotals);

  it('the discount shares add up to the document discount exactly', () => {
    totals.forEach((t) => expect(t.groups.reduce((a, g) => a + g.discount, 0)).toBe(t.discount));
  });

  it('total = line total − document discount (+ VAT in net mode)', () => {
    CASES.forEach((input, i) => {
      const t = totals[i];
      if (input.pricesIncludeVat) expect(t.gross).toBe(t.lineTotal - t.discount);
      else expect(t.net).toBe(t.lineTotal - t.discount);
      expect(t.gross).toBe(t.net + t.tax);
      t.groups.forEach((g) => expect(g.gross).toBe(g.taxable + g.tax));
    });
  });

  it('a cancellation is the exact negation, number by number', () => {
    CASES.forEach((input, i) => {
      const t = totals[i];
      const c = computeTotals(cancellationInput(input));
      const negate = (n: number) => (n === 0 ? 0 : -n);
      expect(c.lines).toEqual(t.lines.map((l) => ({ base: negate(l.base), discount: negate(l.discount), net: negate(l.net) })));
      expect(c.groups).toEqual(
        t.groups.map((g) => ({
          ...g,
          amount: negate(g.amount),
          discount: negate(g.discount),
          taxable: negate(g.taxable),
          tax: negate(g.tax),
          gross: negate(g.gross),
        }))
      );
      expect([c.lineTotal, c.discount, c.net, c.tax, c.gross]).toEqual(
        [t.lineTotal, t.discount, t.net, t.tax, t.gross].map(negate)
      );
    });
  });

  it('groups are sorted by rate descending, then category order', () => {
    const order = ['S', 'Z', 'E', 'AE', 'K', 'G', 'O'];
    totals.forEach((t) => {
      for (let k = 1; k < t.groups.length; k++) {
        const a = t.groups[k - 1];
        const b = t.groups[k];
        expect(a.rateBp > b.rateBp || (a.rateBp === b.rateBp && order.indexOf(a.category) < order.indexOf(b.category))).toBe(true);
      }
    });
  });

  it('a share never moves away from its exact proportional value by a cent or more', () => {
    totals.forEach((t) => {
      if (t.lineTotal === 0) return;
      t.groups.forEach((g) => {
        const exact = (BigInt(t.discount) * BigInt(g.amount) * 100n) / BigInt(t.lineTotal); // ×100
        const diff = BigInt(g.discount) * 100n - exact;
        expect(diff > -100n && diff < 200n).toBe(true);
      });
    });
  });
});

describe('edge cases', () => {
  const line = (over: Partial<TotalsInput['lines'][number]> = {}) => ({
    qtyMilli: 1000,
    priceE4: 100_000,
    category: 'S' as TaxCategory,
    rateBp: 1900,
    discount: { kind: 'none' as const, value: 0 },
    ...over,
  });
  const doc = (over: Partial<TotalsInput> = {}): TotalsInput => ({
    lines: [line()],
    pricesIncludeVat: false,
    discount: { kind: 'none', value: 0 },
    payments: [],
    ...over,
  });

  it('empty document is all zeros', () => {
    expect(computeTotals(doc({ lines: [] }))).toMatchObject({ groups: [], net: 0, tax: 0, gross: 0, balance: 0 });
  });

  it('half cents round away from zero at the line base (0,005 → 0,01)', () => {
    expect(computeTotals(doc({ lines: [line({ priceE4: 50 })] })).lines[0].base).toBe(1);
    expect(computeTotals(doc({ lines: [line({ priceE4: 49 })] })).lines[0].base).toBe(0);
    expect(computeTotals(doc({ lines: [line({ qtyMilli: -1000, priceE4: 50 })] })).lines[0].base).toBe(-1);
  });

  it('a fixed discount larger than the base is capped at the base', () => {
    const t = computeTotals(doc({ lines: [line({ discount: { kind: 'amount', value: 99_999 } })] }));
    expect(t.lines[0]).toEqual({ base: 1000, discount: 1000, net: 0 });
    const d = computeTotals(doc({ discount: { kind: 'amount', value: 5000 } }));
    expect(d.discount).toBe(1000);
    expect(d.gross).toBe(0);
  });

  it('100 % document discount leaves nothing to tax', () => {
    const t = computeTotals(doc({ discount: { kind: 'percent', value: 10_000 } }));
    expect([t.net, t.tax, t.gross]).toEqual([0, 0, 0]);
  });

  it('non-S categories never carry VAT even if a rate is passed', () => {
    const t = computeTotals(doc({ lines: [line({ category: 'AE', rateBp: 1900 }), line({ category: 'E', rateBp: 700 })] }));
    expect(t.tax).toBe(0);
    expect(t.groups.map((g) => [g.category, g.rateBp])).toEqual([
      ['E', 0],
      ['AE', 0],
    ]);
  });

  it('Z 0 % and S 0 % stay separate groups (different categories)', () => {
    const t = computeTotals(doc({ lines: [line({ category: 'S', rateBp: 0 }), line({ category: 'Z', rateBp: 0 })] }));
    expect(t.groups.map((g) => g.category)).toEqual(['S', 'Z']);
  });

  it('allocation ties go to the higher rate first', () => {
    // 0,01 € discount across two equal groups: 19 % gets it.
    const t = computeTotals(
      doc({ lines: [line({ rateBp: 700 }), line({ rateBp: 1900 })], discount: { kind: 'amount', value: 1 } })
    );
    expect(t.groups.map((g) => [g.rateBp, g.discount])).toEqual([
      [1900, 1],
      [700, 0],
    ]);
    expect(allocateDiscount(3n, [10n, 10n, 10n, 10n])).toEqual([1n, 1n, 1n, 0n]);
  });

  it('overpayment gives a negative balance', () => {
    expect(computeTotals(doc({ payments: [500, 1000] })).balance).toBe(1190 - 1500);
  });

  it('handles the largest products exactly (999 999,999 × 1 000,0000)', () => {
    const t = computeTotals(doc({ lines: [line({ qtyMilli: 999_999_999, priceE4: 10_000_000, rateBp: 0 })] }));
    expect(t.lines[0].base).toBe(99_999_999_900);
  });
});

describe('validateTotals (SPEC §5 step 10)', () => {
  const ok: TotalsInput = {
    lines: [{ qtyMilli: 1000, priceE4: 10_000, category: 'S', rateBp: 1900, discount: { kind: 'none', value: 0 } }],
    pricesIncludeVat: false,
    discount: { kind: 'none', value: 0 },
    payments: [],
  };
  const codes = (input: TotalsInput, allowNegative = false) => validateTotals(input, { allowNegative }).map((i) => i.code);

  it('accepts a normal document', () => expect(codes(ok)).toEqual([]));
  it('requires lines, at most 500', () => {
    expect(codes({ ...ok, lines: [] })).toEqual(['no_lines']);
    expect(codes({ ...ok, lines: Array(501).fill(ok.lines[0]) })).toContain('too_many_lines');
  });
  it('rejects zero quantity, negative quantity (unless a cancellation) and negative prices', () => {
    expect(codes({ ...ok, lines: [{ ...ok.lines[0], qtyMilli: 0 }] })).toEqual(['qty_zero']);
    expect(codes({ ...ok, lines: [{ ...ok.lines[0], qtyMilli: -1000 }] })).toEqual(['negative_qty']);
    expect(codes({ ...ok, lines: [{ ...ok.lines[0], qtyMilli: -1000 }] }, true)).toEqual([]);
    expect(codes({ ...ok, lines: [{ ...ok.lines[0], priceE4: -1 }] })).toEqual(['negative_price']);
  });
  it('reports discounts over 100 % or over the base', () => {
    expect(codes({ ...ok, discount: { kind: 'percent', value: 10_001 } })).toEqual(['document_discount_too_large']);
    expect(codes({ ...ok, discount: { kind: 'amount', value: 101 } })).toEqual(['document_discount_too_large']);
    expect(codes({ ...ok, lines: [{ ...ok.lines[0], discount: { kind: 'amount', value: 101 } }] })).toEqual([
      'line_discount_too_large',
    ]);
  });
  it('rejects amounts above 999 999 999,99', () => {
    const big = { ...ok.lines[0], qtyMilli: 999_999_999, priceE4: 10_000_000 };
    expect(codes({ ...ok, lines: [big, big] })).toContain('amount_too_large');
  });
});

describe('independent Python oracle (scripts/totals-oracle.py, review "tests to add" #11)', () => {
  type OracleCase = { input: TotalsInput; expected: Omit<Totals, 'paid' | 'balance'>; negated?: boolean };
  const ORDER = ['S', 'Z', 'E', 'AE', 'K', 'G', 'O'];
  const cases = (oracle as { cases: OracleCase[] }).cases;

  it('computeTotals agrees with the oracle on every case, to the cent', () => {
    const mismatches: number[] = [];
    cases.forEach((c, i) => {
      const t = computeTotals(c.input);
      const groups = [...t.groups].sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || b.rateBp - a.rateBp);
      const actual = { lines: t.lines, groups, lineTotal: t.lineTotal, discount: t.discount, net: t.net, tax: t.tax, gross: t.gross };
      if (JSON.stringify(actual) !== JSON.stringify(c.expected)) mismatches.push(i);
    });
    expect(mismatches).toEqual([]);
    expect(cases.length).toBe(500);
  });

  it('covers gross and net mode, all discount kinds, cancellations and products above 2^53', () => {
    const lines = cases.flatMap((c) => c.input.lines);
    expect(cases.filter((c) => c.negated).length).toBe(50);
    expect(cases.some((c) => c.input.pricesIncludeVat) && cases.some((c) => !c.input.pricesIncludeVat)).toBe(true);
    for (const kind of ['percent', 'amount'] as const) {
      expect(lines.some((l) => l.discount.kind === kind)).toBe(true);
      expect(cases.some((c) => c.input.discount.kind === kind)).toBe(true);
    }
    expect(lines.some((l) => Math.abs(l.qtyMilli * l.priceE4) > Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});
