// The totals engine (SPEC §5 steps 1–8, D16, D19). PURE: no React/Expo imports.
// All inputs and outputs are integers: cents, qty ×1 000, price ×10 000, basis points.
// Products are formed in BigInt (qty × price can exceed 2^53) and every division is rounded half away
// from zero by roundHalfAway at exactly the steps the SPEC defines.

import { floorDivMod, MAX_ABS_CENTS, roundHalfAway, toSafeNumber } from './money';

/** EN 16931 VAT category codes (UNTDID 5305 subset, D18). Only S carries a rate; the others are 0 %. */
export type TaxCategory = 'S' | 'Z' | 'E' | 'AE' | 'K' | 'G' | 'O';
export const TAX_CATEGORIES: readonly TaxCategory[] = ['S', 'Z', 'E', 'AE', 'K', 'G', 'O'];

export type DiscountKind = 'none' | 'percent' | 'amount';
/** percent: value in basis points (10 % = 1000); amount: value in cents. */
export type Discount = { kind: DiscountKind; value: number };
export const NO_DISCOUNT: Discount = { kind: 'none', value: 0 };

export type TotalsLine = {
  qtyMilli: number;
  priceE4: number;
  category: TaxCategory;
  rateBp: number;
  discount: Discount;
};

export type TotalsInput = {
  lines: TotalsLine[];
  /** true: unit prices are gross (include VAT) — SPEC §5 step 6. */
  pricesIncludeVat: boolean;
  discount: Discount;
  /** Payment amounts in cents. */
  payments: number[];
};

export type LineTotals = { base: number; discount: number; net: number };

export type GroupTotals = {
  category: TaxCategory;
  rateBp: number;
  /** G_k: sum of line nets (gross amounts in gross mode). */
  amount: number;
  /** D_k: share of the document discount. */
  discount: number;
  /** T_k: taxable amount (net). */
  taxable: number;
  /** V_k */
  tax: number;
  /** T_k + V_k (= H_k in gross mode). */
  gross: number;
};

export type Totals = {
  lines: LineTotals[];
  groups: GroupTotals[];
  /** ΣG_k before the document discount. */
  lineTotal: number;
  /** D */
  discount: number;
  /** N */
  net: number;
  /** V */
  tax: number;
  /** Gr */
  gross: number;
  /** P */
  paid: number;
  /** Bd = Gr − P; negative = overpaid. */
  balance: number;
};

/** The rate the engine uses: categories other than S carry no VAT (SPEC §5 step 3). */
export function effectiveRateBp(category: TaxCategory, rateBp: number): number {
  return category === 'S' ? rateBp : 0;
}

const sign = (n: bigint): bigint => (n < 0n ? -1n : 1n);
const absBig = (n: bigint): bigint => (n < 0n ? -n : n);

/**
 * Discount on a base: percent → round(base × bp / 10 000); amount → min(amount, |base|) taken in the
 * direction of the base, so a cancellation (negated base) gets exactly the negated discount.
 */
function discountOn(base: bigint, discount: Discount): bigint {
  switch (discount.kind) {
    case 'none':
      return 0n;
    case 'percent':
      return roundHalfAway(base * BigInt(discount.value), 10_000n);
    case 'amount': {
      const amount = BigInt(Math.abs(discount.value));
      const capped = amount < absBig(base) ? amount : absBig(base);
      return sign(base) * capped;
    }
  }
}

/** Line base B = round(q × p / 100 000) in cents (SPEC §5 step 1). */
export function lineBase(qtyMilli: number, priceE4: number): number {
  return toSafeNumber(roundHalfAway(BigInt(qtyMilli) * BigInt(priceE4), 100_000n));
}

export function computeLine(line: TotalsLine): LineTotals {
  const base = roundHalfAway(BigInt(line.qtyMilli) * BigInt(line.priceE4), 100_000n);
  const discount = discountOn(base, line.discount);
  return { base: toSafeNumber(base), discount: toSafeNumber(discount), net: toSafeNumber(base - discount) };
}

function categoryOrder(category: TaxCategory): number {
  return TAX_CATEGORIES.indexOf(category);
}

/** Sort order of VAT groups: rate descending, then category order S, Z, E, AE, K, G, O. */
export function compareGroups(a: { category: TaxCategory; rateBp: number }, b: { category: TaxCategory; rateBp: number }) {
  return b.rateBp - a.rateBp || categoryOrder(a.category) - categoryOrder(b.category);
}

/**
 * Allocates the document discount D to groups proportionally by the largest-remainder method
 * (SPEC §5 step 4). `amounts` must already be in group order (rate desc, category). The result sums
 * to D exactly. Computed on magnitudes in the direction of ΣG, so negated input gives negated output.
 */
export function allocateDiscount(total: bigint, amounts: bigint[]): bigint[] {
  const sum = amounts.reduce((a, b) => a + b, 0n);
  if (total === 0n || sum === 0n) return amounts.map(() => 0n);
  const s = sign(sum);
  const d = absBig(total) * sign(total) * s; // D in the direction of ΣG (normally ≥ 0)
  const denom = absBig(sum);
  const parts = amounts.map((g, index) => {
    const [floor, rem] = floorDivMod(d * g * s, denom);
    return { index, floor, rem };
  });
  let remaining = d - parts.reduce((a, p) => a + p.floor, 0n);
  const step = remaining >= 0n ? 1n : -1n;
  // Largest fractional part first; ties keep group order (higher rate first, then category).
  const order = [...parts].sort((a, b) => (b.rem === a.rem ? a.index - b.index : b.rem > a.rem ? 1 : -1));
  const result = parts.map((p) => p.floor);
  for (let i = 0; remaining !== 0n; i = (i + 1) % order.length) {
    result[order[i].index] += step;
    remaining -= step;
  }
  return result.map((x) => x * s);
}

export function computeTotals(input: TotalsInput): Totals {
  const lines = input.lines.map(computeLine);

  // Step 3: groups per (category, effective rate).
  const map = new Map<string, { category: TaxCategory; rateBp: number; amount: bigint }>();
  input.lines.forEach((line, i) => {
    const rateBp = effectiveRateBp(line.category, line.rateBp);
    const key = `${line.category}|${rateBp}`;
    const group = map.get(key) ?? { category: line.category, rateBp, amount: 0n };
    group.amount += BigInt(lines[i].net);
    map.set(key, group);
  });
  const sorted = [...map.values()].sort(compareGroups);
  const lineTotal = sorted.reduce((a, g) => a + g.amount, 0n);

  // Step 4: document discount and its allocation.
  const discount = discountOn(lineTotal, input.discount);
  const shares = allocateDiscount(
    discount,
    sorted.map((g) => g.amount)
  );

  // Steps 5/6: tax per group.
  const groups: GroupTotals[] = sorted.map((g, k) => {
    const after = g.amount - shares[k];
    const rate = BigInt(g.rateBp);
    let taxable: bigint;
    let tax: bigint;
    if (input.pricesIncludeVat) {
      tax = roundHalfAway(after * rate, 10_000n + rate);
      taxable = after - tax;
    } else {
      taxable = after;
      tax = roundHalfAway(after * rate, 10_000n);
    }
    return {
      category: g.category,
      rateBp: g.rateBp,
      amount: toSafeNumber(g.amount),
      discount: toSafeNumber(shares[k]),
      taxable: toSafeNumber(taxable),
      tax: toSafeNumber(tax),
      gross: toSafeNumber(taxable + tax),
    };
  });

  const net = groups.reduce((a, g) => a + g.taxable, 0);
  const tax = groups.reduce((a, g) => a + g.tax, 0);
  const gross = net + tax;
  // Step 7.
  const paid = input.payments.reduce((a, p) => a + p, 0);
  return {
    lines,
    groups,
    lineTotal: toSafeNumber(lineTotal),
    discount: toSafeNumber(discount),
    net,
    tax,
    gross,
    paid,
    balance: gross - paid,
  };
}

/** Step 8: the cancellation of a document = every quantity negated, no payments. */
export function cancellationInput(input: TotalsInput): TotalsInput {
  return {
    ...input,
    lines: input.lines.map((l) => ({ ...l, qtyMilli: -l.qtyMilli })),
    payments: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Validation (SPEC §5 step 10)
// ---------------------------------------------------------------------------------------------

export const MAX_LINES = 500;

export type TotalsIssue =
  | { code: 'no_lines' }
  | { code: 'too_many_lines' }
  | { code: 'qty_zero'; line: number }
  | { code: 'negative_qty'; line: number }
  | { code: 'negative_price'; line: number }
  | { code: 'invalid_rate'; line: number }
  | { code: 'line_discount_too_large'; line: number }
  | { code: 'document_discount_too_large' }
  | { code: 'amount_too_large' };

function discountTooLarge(discount: Discount, base: number): boolean {
  if (discount.value < 0) return true;
  if (discount.kind === 'percent') return discount.value > 10_000;
  if (discount.kind === 'amount') return discount.value > Math.abs(base);
  return false;
}

/**
 * Checks a document before it is issued. `allowNegative` is only for cancellations (negated quantities).
 * Discounts larger than the base are capped by computeTotals; here they are reported so the editor
 * can show them.
 */
export function validateTotals(input: TotalsInput, options: { allowNegative?: boolean } = {}): TotalsIssue[] {
  const issues: TotalsIssue[] = [];
  if (input.lines.length === 0) issues.push({ code: 'no_lines' });
  if (input.lines.length > MAX_LINES) issues.push({ code: 'too_many_lines' });
  input.lines.forEach((l, line) => {
    if (l.qtyMilli === 0) issues.push({ code: 'qty_zero', line });
    if (l.qtyMilli < 0 && !options.allowNegative) issues.push({ code: 'negative_qty', line });
    if (l.priceE4 < 0) issues.push({ code: 'negative_price', line });
    if (!Number.isInteger(l.rateBp) || l.rateBp < 0 || l.rateBp > 10_000) issues.push({ code: 'invalid_rate', line });
  });
  let totals: Totals | null = null;
  try {
    totals = computeTotals(input);
  } catch {
    issues.push({ code: 'amount_too_large' });
  }
  if (totals) {
    totals.lines.forEach((t, line) => {
      if (discountTooLarge(input.lines[line].discount, t.base)) issues.push({ code: 'line_discount_too_large', line });
    });
    if (discountTooLarge(input.discount, totals.lineTotal)) issues.push({ code: 'document_discount_too_large' });
    const all = [
      ...totals.lines.flatMap((t) => [t.base, t.net]),
      totals.lineTotal,
      totals.net,
      totals.tax,
      totals.gross,
      totals.balance,
    ];
    if (all.some((v) => Math.abs(v) > MAX_ABS_CENTS)) issues.push({ code: 'amount_too_large' });
  }
  return issues;
}
