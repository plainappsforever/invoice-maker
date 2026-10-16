// Integer money helpers (D16). PURE: no React/Expo imports.
// Amounts are cents, unit prices ×10 000, quantities ×1 000, rates and percentages in basis points.
// No floating point is ever used for a stored value: every division goes through roundHalfAway.

export type Lang = 'de' | 'en';

export const SCALE = { cents: 2, priceE4: 4, qtyMilli: 3, bp: 2 } as const;

/** Largest amount the app accepts: 999 999 999.99 (SPEC §5 step 10). */
export const MAX_ABS_CENTS = 99_999_999_999;

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

/**
 * numerator / denominator rounded half away from zero, exactly (BigInt), e.g. 2.5 → 3, −2.5 → −3.
 * This is the only rounding function of the engine (SPEC §5 notation).
 */
export function roundHalfAway(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const n = abs(numerator);
  const d = abs(denominator);
  const q = (2n * n + d) / (2n * d);
  return negative ? -q : q;
}

/** Same as roundHalfAway for safe integers, returning a Number. Products are formed in BigInt. */
export function roundDiv(numerator: number | bigint, denominator: number | bigint): number {
  return toSafeNumber(roundHalfAway(BigInt(numerator), BigInt(denominator)));
}

/** Floor division and remainder with a positive denominator (remainder always in [0, d)). */
export function floorDivMod(n: bigint, d: bigint): [bigint, bigint] {
  if (d <= 0n) throw new RangeError('denominator must be positive');
  let q = n / d;
  let r = n % d;
  if (r < 0n) {
    q -= 1n;
    r += d;
  }
  return [q, r];
}

export function toSafeNumber(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`value out of safe integer range: ${n}`);
  }
  return Number(n);
}

// ---------------------------------------------------------------------------------------------
// Parsing user input
// ---------------------------------------------------------------------------------------------

export type ParseError = 'empty' | 'invalid' | 'too_many_decimals' | 'too_large';
export type ParseResult = { ok: true; value: number } | { ok: false; error: ParseError };

const SEPARATORS: Record<Lang, { decimal: string; group: string }> = {
  de: { decimal: ',', group: '.' },
  en: { decimal: '.', group: ',' },
};

/** True when "1.234.567" style grouping is valid: first group 1–3 digits without a leading zero, others exactly 3. */
function isValidGrouping(text: string, group: string): boolean {
  const parts = text.split(group);
  if (parts.length < 2) return false;
  if (!/^[1-9]\d{0,2}$/.test(parts[0])) return false;
  return parts.slice(1).every((p) => /^\d{3}$/.test(p));
}

/**
 * Parses a decimal number typed by the user into an integer with `scale` decimals.
 * German "1.234,56", English "1,234.56", and the short forms "12,5" / "12.5" are accepted. When only
 * one kind of separator appears it is read as the decimal separator unless it forms valid thousands
 * grouping in the language ("1.234" in German = 1234, "12.5" in German = 12,5). When both appear, the
 * last one is the decimal separator. Spaces and a leading € are ignored. Never rounds: too many
 * decimals is an error.
 */
export function parseDecimal(input: string, lang: Lang, scale: number): ParseResult {
  let text = input.replace(/[\s  €]/g, '');
  if (text === '') return { ok: false, error: 'empty' };
  let negative = false;
  if (text.startsWith('-') || text.startsWith('−')) {
    negative = true;
    text = text.slice(1);
  }
  if (!/^[\d.,]+$/.test(text) || !/\d/.test(text)) return { ok: false, error: 'invalid' };

  const { group } = SEPARATORS[lang];
  let intPart: string;
  let fracPart = '';
  const hasComma = text.includes(',');
  const hasDot = text.includes('.');
  if (hasComma && hasDot) {
    const lastSep = text.lastIndexOf(',') > text.lastIndexOf('.') ? ',' : '.';
    const otherSep = lastSep === ',' ? '.' : ',';
    const idx = text.lastIndexOf(lastSep);
    const head = text.slice(0, idx);
    if (head.includes(lastSep) || !isValidGrouping(head, otherSep)) return { ok: false, error: 'invalid' };
    intPart = head.split(otherSep).join('');
    fracPart = text.slice(idx + 1);
  } else if (hasComma || hasDot) {
    const sep = hasComma ? ',' : '.';
    if (sep === group && isValidGrouping(text, group)) {
      intPart = text.split(group).join('');
    } else {
      const parts = text.split(sep);
      if (parts.length !== 2) return { ok: false, error: 'invalid' };
      [intPart, fracPart] = parts;
    }
  } else {
    intPart = text;
  }
  if (intPart === '') intPart = '0';
  if (!/^\d+$/.test(intPart) || !/^\d*$/.test(fracPart)) return { ok: false, error: 'invalid' };
  if (fracPart.length > scale) {
    if (/^0*$/.test(fracPart.slice(scale))) fracPart = fracPart.slice(0, scale);
    else return { ok: false, error: 'too_many_decimals' };
  }
  const digits = intPart + fracPart.padEnd(scale, '0');
  const value = BigInt(digits);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: 'too_large' };
  const n = Number(value);
  return { ok: true, value: negative && n !== 0 ? -n : n };
}

export const parseCents = (text: string, lang: Lang) => parseDecimal(text, lang, SCALE.cents);
/** Domain limits of the input fields (review #14): quantity ≤ 999 999 999,999; unit price ≤ 999 999 999,9999. */
export const MAX_QTY_MILLI = 999_999_999_999;
export const MAX_PRICE_E4 = 9_999_999_999_999;
const capped = (r: ParseResult, max: number): ParseResult => (r.ok && Math.abs(r.value) > max ? { ok: false, error: 'too_large' } : r);
export const parsePriceE4 = (text: string, lang: Lang) => capped(parseDecimal(text, lang, SCALE.priceE4), MAX_PRICE_E4);
export const parseQtyMilli = (text: string, lang: Lang) => capped(parseDecimal(text, lang, SCALE.qtyMilli), MAX_QTY_MILLI);
export const parseBp = (text: string, lang: Lang) => parseDecimal(text, lang, SCALE.bp);

// ---------------------------------------------------------------------------------------------
// Formatting (no Intl: Hermes/JSC differ; our output must be identical on both platforms)
// ---------------------------------------------------------------------------------------------

/**
 * Formats an integer with `scale` implied decimals. Shows at least `minDecimals` decimals and drops
 * further trailing zeros (12 500 at scale 3, min 0 → "12,5").
 */
export function formatDecimal(value: number, scale: number, lang: Lang, minDecimals = scale): string {
  const { decimal, group } = SEPARATORS[lang];
  const negative = value < 0;
  const digits = String(Math.abs(value)).padStart(scale + 1, '0');
  const intDigits = digits.slice(0, digits.length - scale);
  let frac = digits.slice(digits.length - scale);
  while (frac.length > minDecimals && frac.endsWith('0')) frac = frac.slice(0, -1);
  const grouped = intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return `${negative ? '-' : ''}${grouped}${frac ? decimal + frac : ''}`;
}

/** "1.234,56" / "1,234.56" */
export const formatAmount = (cents: number, lang: Lang) => formatDecimal(cents, SCALE.cents, lang, 2);
/** Unit price: 2 to 4 decimals ("85,00", "0,1234"). */
export const formatPrice = (priceE4: number, lang: Lang) => formatDecimal(priceE4, SCALE.priceE4, lang, 2);
/** Quantity: 0 to 3 decimals ("12,5", "500"). */
export const formatQty = (qtyMilli: number, lang: Lang) => formatDecimal(qtyMilli, SCALE.qtyMilli, lang, 0);
/** Percentage from basis points: "19", "7,5". */
export const formatPercent = (bp: number, lang: Lang) => formatDecimal(bp, SCALE.bp, lang, 0);

/** Currencies offered in v1. All have two minor units (ISO 4217), so "cents" holds for every one. */
export const CURRENCIES = [
  { code: 'EUR', symbol: '€' },
  { code: 'USD', symbol: '$' },
  { code: 'GBP', symbol: '£' },
  { code: 'CHF', symbol: null },
  { code: 'PLN', symbol: null },
  { code: 'CZK', symbol: null },
  { code: 'DKK', symbol: null },
  { code: 'SEK', symbol: null },
  { code: 'NOK', symbol: null },
  { code: 'HUF', symbol: null },
  { code: 'RON', symbol: null },
  { code: 'CAD', symbol: null },
  { code: 'AUD', symbol: null },
] as const;

export type CurrencyCode = (typeof CURRENCIES)[number]['code'];

export function isCurrencyCode(code: string): code is CurrencyCode {
  return CURRENCIES.some((c) => c.code === code);
}

/**
 * German: "1.234,56 €", "1.234,56 CHF". English: "€1,234.56", "-€5.00", "CHF 1,234.56".
 * Uses a non-breaking space between number and code/symbol.
 */
export function formatMoney(cents: number, currency: string, lang: Lang): string {
  const symbol = CURRENCIES.find((c) => c.code === currency)?.symbol ?? null;
  const number = formatAmount(Math.abs(cents), lang);
  const sign = cents < 0 ? '-' : '';
  if (lang === 'de') return `${sign}${number} ${symbol ?? currency}`;
  return symbol ? `${sign}${symbol}${number}` : `${sign}${currency} ${number}`;
}
