import {
  CURRENCIES,
  floorDivMod,
  formatAmount,
  formatMoney,
  formatPercent,
  formatPrice,
  formatQty,
  parseBp,
  parseCents,
  parsePriceE4,
  parseQtyMilli,
  roundDiv,
  roundHalfAway,
} from './money';

describe('roundHalfAway', () => {
  it.each([
    [5n, 10n, 1n],
    [4n, 10n, 0n],
    [15n, 10n, 2n],
    [25n, 10n, 3n],
    [-5n, 10n, -1n],
    [-25n, 10n, -3n],
    [-4n, 10n, 0n],
    [5n, -10n, -1n],
    [0n, 7n, 0n],
  ])('%s / %s = %s', (n, d, expected) => expect(roundHalfAway(n, d)).toBe(expected));

  it('is exact beyond 2^53', () => {
    expect(roundHalfAway(999_999_999n * 10_000_000n, 100_000n)).toBe(99_999_999_900n);
    expect(roundHalfAway(2n ** 80n + 1n, 2n)).toBe(2n ** 79n + 1n);
  });

  it('refuses division by zero', () => expect(() => roundHalfAway(1n, 0n)).toThrow(RangeError));
  it('roundDiv returns numbers', () => expect(roundDiv(2043165, 10_000)).toBe(204));
  it('floorDivMod floors toward −∞', () => {
    expect(floorDivMod(-7n, 2n)).toEqual([-4n, 1n]);
    expect(floorDivMod(7n, 2n)).toEqual([3n, 1n]);
  });
});

describe('parsing by language', () => {
  it.each([
    ['1.234,56', 'de', 123456],
    ['1,234.56', 'en', 123456],
    ['1,234.56', 'de', 123456], // both separators: the last one is the decimal separator
    ['1.234,56', 'en', 123456],
    ['12,5', 'de', 1250],
    ['12.5', 'de', 1250], // English keyboard in German
    ['12.5', 'en', 1250],
    ['12,5', 'en', 1250],
    ['1.234', 'de', 123400], // valid grouping → thousands
    ['1,234', 'en', 123400],
    ['1.23', 'en', 123],
    ['0,5', 'de', 50],
    [',5', 'de', 50],
    ['85', 'de', 8500],
    ['1.234.567,89', 'de', 123456789],
    [' 1 234,56 € ', 'de', 123456],
    ['-5,00', 'de', -500],
    ['12,500', 'de', 1250], // trailing zeros beyond 2 decimals are harmless
  ] as const)('cents %s (%s) → %s', (text, lang, value) => {
    expect(parseCents(text, lang)).toEqual({ ok: true, value });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['abc', 'invalid'],
    ['1,2,3', 'invalid'],
    ['1.2.3', 'invalid'],
    ['12,345', 'too_many_decimals'],
    ['1.23.456,7', 'invalid'],
    ['99999999999999999999', 'too_large'],
  ] as const)('cents %s → %s', (text, error) => {
    expect(parseCents(text, 'de')).toEqual({ ok: false, error });
  });

  it('unit prices take 4 decimals, quantities 3, percentages 2', () => {
    expect(parsePriceE4('0,1234', 'de')).toEqual({ ok: true, value: 1234 });
    expect(parsePriceE4('85', 'de')).toEqual({ ok: true, value: 850_000 });
    expect(parsePriceE4('0,12345', 'de')).toEqual({ ok: false, error: 'too_many_decimals' });
    expect(parseQtyMilli('12,5', 'de')).toEqual({ ok: true, value: 12_500 });
    // domain limits (review #14): quantity ≤ 999 999 999,999, price ≤ 999 999 999,9999
    expect(parseQtyMilli('999.999.999,999', 'de')).toEqual({ ok: true, value: 999_999_999_999 });
    expect(parseQtyMilli('1.000.000.000', 'de')).toEqual({ ok: false, error: 'too_large' });
    expect(parsePriceE4('999999999.9999', 'en')).toEqual({ ok: true, value: 9_999_999_999_999 });
    expect(parsePriceE4('1000000000', 'en')).toEqual({ ok: false, error: 'too_large' });
    expect(parseQtyMilli('0,125', 'de')).toEqual({ ok: true, value: 125 }); // leading 0 → not grouping
    expect(parseQtyMilli('0.125', 'de')).toEqual({ ok: true, value: 125 });
    expect(parseBp('19', 'de')).toEqual({ ok: true, value: 1900 });
    expect(parseBp('7,5', 'de')).toEqual({ ok: true, value: 750 });
  });
});

describe('formatting', () => {
  it('amounts', () => {
    expect(formatAmount(133029, 'de')).toBe('1.330,29');
    expect(formatAmount(133029, 'en')).toBe('1,330.29');
    expect(formatAmount(5, 'de')).toBe('0,05');
    expect(formatAmount(-133029, 'de')).toBe('-1.330,29');
    expect(formatAmount(99_999_999_999, 'en')).toBe('999,999,999.99');
  });
  it('prices, quantities and percentages', () => {
    expect(formatPrice(850_000, 'de')).toBe('85,00');
    expect(formatPrice(1234, 'de')).toBe('0,1234');
    expect(formatPrice(1_234_500, 'en')).toBe('123.45');
    expect(formatQty(12_500, 'de')).toBe('12,5');
    expect(formatQty(500_000, 'de')).toBe('500');
    expect(formatQty(1_000_000, 'en')).toBe('1,000');
    expect(formatQty(125, 'en')).toBe('0.125');
    expect(formatPercent(1900, 'de')).toBe('19');
    expect(formatPercent(750, 'de')).toBe('7,5');
  });
  it('money with currency', () => {
    expect(formatMoney(103029, 'EUR', 'de')).toBe('1.030,29 €');
    expect(formatMoney(103029, 'EUR', 'en')).toBe('€1,030.29');
    expect(formatMoney(-500, 'EUR', 'en')).toBe('-€5.00');
    expect(formatMoney(-500, 'EUR', 'de')).toBe('-5,00 €');
    expect(formatMoney(100, 'CHF', 'en')).toBe('CHF 1.00');
    expect(formatMoney(100, 'CHF', 'de')).toBe('1,00 CHF');
  });
  it('parse(format(x)) round-trips', () => {
    for (const lang of ['de', 'en'] as const) {
      for (const cents of [0, 1, 99, 100, 123456, 99_999_999_999, -2500]) {
        expect(parseCents(formatAmount(cents, lang), lang)).toEqual({ ok: true, value: cents });
      }
    }
  });
  it('currency list has unique codes and starts with EUR', () => {
    expect(CURRENCIES[0].code).toBe('EUR');
    expect(new Set(CURRENCIES.map((c) => c.code)).size).toBe(CURRENCIES.length);
  });
});
