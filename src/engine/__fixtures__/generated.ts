// Deterministic generated totals cases (V1_PLAN "Totals engine": ≥ 200 cases checked against an
// independent reference). Same seed → same cases on every machine, so a failure is reproducible.

import type { Discount, TaxCategory, TotalsInput, TotalsLine } from '../totals';

/** mulberry32: small seeded PRNG. */
export function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)];
  return { next, int, pick };
}

const RATES: readonly [TaxCategory, number][] = [
  ['S', 1900], ['S', 1900], ['S', 1900], ['S', 700], ['S', 700], ['S', 2000], ['S', 2100], ['S', 550],
  ['S', 1000], ['Z', 0], ['E', 0], ['AE', 0], ['K', 0], ['G', 0], ['O', 0],
];

type Rng = ReturnType<typeof prng>;

function quantity(r: Rng): number {
  switch (r.int(0, 5)) {
    case 0: return 1000;
    case 1: return r.int(1, 20) * 1000;
    case 2: return r.int(1, 99) * 125; // 0.125 steps
    case 3: return r.int(1, 999_999); // three decimals
    case 4: return r.int(1, 500) * 500; // half units (hours)
    default: return r.int(1, 999_999_999); // huge
  }
}

function price(r: Rng, hugeQty: boolean): number {
  if (hugeQty) return r.int(0, 10_000_000); // product up to ~10^16 > 2^53
  switch (r.int(0, 4)) {
    case 0: return r.int(0, 100) * 10_000 + r.int(0, 99) * 100; // whole cents
    case 1: return r.int(0, 9_999); // sub-cent unit prices
    case 2: return r.int(0, 50_000_000); // up to 5 000 € with 4 decimals
    case 3: return 3333;
    default: return r.int(1, 99) * 50; // half cents → exercises .5 rounding
  }
}

function discount(r: Rng, maxAmount: number): Discount {
  switch (r.int(0, 5)) {
    case 0: return { kind: 'percent', value: r.int(1, 10_000) };
    case 1: return { kind: 'percent', value: r.pick([250, 500, 1000, 333, 1250, 5000, 10_000]) };
    case 2: return { kind: 'amount', value: r.int(0, Math.max(1, maxAmount)) };
    case 3: return { kind: 'amount', value: r.int(0, Math.max(1, maxAmount * 2)) }; // above base → capped
    default: return { kind: 'none', value: 0 };
  }
}

export function generateCases(count: number, seed = 20261001): TotalsInput[] {
  const r = prng(seed);
  const cases: TotalsInput[] = [];
  for (let c = 0; c < count; c++) {
    const lineCount = c % 25 === 0 ? r.int(30, 60) : r.int(1, 12);
    const lines: TotalsLine[] = [];
    for (let i = 0; i < lineCount; i++) {
      const [category, rateBp] = r.pick(RATES);
      const qtyMilli = quantity(r);
      const priceE4 = price(r, qtyMilli > 999_999);
      const approxBase = Math.round((qtyMilli * priceE4) / 100_000);
      lines.push({ qtyMilli, priceE4, category, rateBp, discount: discount(r, approxBase) });
    }
    const payments = Array.from({ length: r.int(0, 2) }, () => r.int(1, 500_000));
    cases.push({
      lines,
      pricesIncludeVat: r.next() < 0.4,
      discount: discount(r, 200_000),
      payments,
    });
  }
  return cases;
}
