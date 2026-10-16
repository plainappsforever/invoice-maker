import {
  canSetNextValue,
  DEFAULT_PATTERNS,
  formatNumber,
  hasYearToken,
  seriesKey,
  seriesOf,
  validatePattern,
} from './numbering';

describe('formatNumber (SPEC §5 numbering examples)', () => {
  it('RE-{YYYY}-{NNNN}', () => {
    expect(formatNumber('RE-{YYYY}-{NNNN}', 1, '2026-10-01')).toBe('RE-2026-0001');
    expect(formatNumber('RE-{YYYY}-{NNNN}', 43, '2026-10-01')).toBe('RE-2026-0043');
    expect(formatNumber('RE-{YYYY}-{NNNN}', 1, '2027-01-02')).toBe('RE-2027-0001');
  });
  it('never cuts a number that outgrows its padding', () => {
    expect(formatNumber('{NNN}', 12345, '2026-10-01')).toBe('12345');
  });
  it('{YY} and {MM}', () => {
    expect(formatNumber('R{YY}{MM}-{NN}', 7, '2026-03-15')).toBe('R2603-07');
  });
  it('{NNNNN} without a year is one continuous number', () => {
    expect(formatNumber('{NNNNN}', 42, '2027-06-01')).toBe('00042');
  });
  it('rejects counter values below 1 and malformed dates', () => {
    expect(() => formatNumber('{N}', 0, '2026-10-01')).toThrow(RangeError);
    expect(() => formatNumber('{N}', 1, '01.10.2026')).toThrow(RangeError);
  });
});

describe('series', () => {
  it('one counter per type and year when the pattern has a year', () => {
    expect(seriesKey('invoice', 'RE-{YYYY}-{NNNN}', '2026-10-01')).toBe('invoice:2026');
    expect(seriesKey('invoice', 'RE-{YYYY}-{NNNN}', '2027-01-02')).toBe('invoice:2027');
    expect(seriesKey('invoice', 'RE{YY}-{NNN}', '2027-01-02')).toBe('invoice:2027');
    expect(seriesKey('quote', 'AN-{YYYY}-{NNNN}', '2026-10-01')).toBe('quote:2026');
    expect(seriesKey('receipt', 'QU-{YYYY}-{NNNN}', '2026-10-01')).toBe('receipt:2026');
  });
  it('one continuous counter without a year token, even with {MM}', () => {
    expect(seriesKey('invoice', '{NNNNN}', '2026-10-01')).toBe('invoice');
    expect(seriesKey('invoice', '{MM}-{NNNNN}', '2027-10-01')).toBe('invoice');
    expect(hasYearToken('{MM}-{NNNNN}')).toBe(false);
  });
  it('cancellations are numbered in the invoice series', () => {
    expect(seriesOf('cancellation')).toBe('invoice');
    expect(seriesKey('cancellation', 'RE-{YYYY}-{NNNN}', '2026-10-01')).toBe('invoice:2026');
  });
});

describe('validatePattern', () => {
  it('accepts the defaults', () => {
    for (const lang of ['de', 'en'] as const) {
      for (const pattern of Object.values(DEFAULT_PATTERNS[lang])) expect(validatePattern(pattern)).toBeNull();
    }
  });
  it.each([
    ['', 'empty'],
    ['RE-2026', 'no_counter'],
    ['{NNN}-{NN}', 'two_counters'],
    ['RE {NNNN}', 'invalid_character'],
    ['RE#{NNNN}', 'invalid_character'],
    ['RÉ-{NNNN}', 'invalid_character'],
    ['RE-{DD}-{NNNN}', 'unknown_token'],
    ['RE-{YYYY-{NNNN}', 'unknown_token'],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZ{NNNN}', 'too_long'],
  ])('%s → %s', (pattern, error) => expect(validatePattern(pattern)).toBe(error));
  it('allows A–Z a–z 0–9 - / _ .', () => expect(validatePattern('Re_2026/a.b-{N}')).toBeNull());
});

describe('next number', () => {
  it('may be raised, never lowered to a used value (raised to 43; 40 refused after 42 was used)', () => {
    expect(canSetNextValue(43, 1)).toBe(true);
    expect(canSetNextValue(40, 42)).toBe(false);
    expect(canSetNextValue(43, 42)).toBe(true);
    expect(canSetNextValue(1, 0)).toBe(true);
    expect(canSetNextValue(0, 0)).toBe(false);
    expect(canSetNextValue(2.5, 0)).toBe(false);
  });
});
