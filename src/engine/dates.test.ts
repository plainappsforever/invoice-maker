import { addDays, daysBetween, formatDate, isValidIsoDate, monthOf, parseIsoDate, todayLocal } from './dates';

describe('calendar dates', () => {
  it('adds days across month and year ends and leap days', () => {
    expect(addDays('2026-10-01', 14)).toBe('2026-10-15');
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-11-17', 30)).toBe('2026-12-17');
  });

  it('is unaffected by daylight-saving changes (calendar days, not 24 h steps)', () => {
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26');
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
    expect(daysBetween('2026-10-15', '2026-10-01')).toBe(-14);
  });

  it('validates and formats', () => {
    expect(parseIsoDate('2026-02-29')).toBeNull();
    expect(isValidIsoDate('2028-02-29')).toBe(true);
    expect(isValidIsoDate('2026-13-01')).toBe(false);
    expect(isValidIsoDate(null)).toBe(false);
    expect(() => addDays('1.10.2026', 1)).toThrow(RangeError);
    expect(formatDate('2026-10-01', 'de')).toBe('01.10.2026');
    expect(formatDate('2026-10-01', 'en')).toBe('1 Oct 2026');
    expect(monthOf('2026-10-31')).toBe('2026-10');
  });

  it('todayLocal uses the local calendar day (Berlin), not UTC', () => {
    // 1 Oct 2026 00:30 in Berlin = 30 Sep 22:30 UTC.
    expect(todayLocal(new Date(2026, 9, 1, 0, 30))).toBe('2026-10-01');
    expect(new Date(2026, 9, 1, 0, 30).toISOString().slice(0, 10)).toBe('2026-09-30');
  });
});
