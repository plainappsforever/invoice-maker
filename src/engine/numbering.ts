// Document numbers (D17, SPEC §5 "Numbering examples"). PURE: no React/Expo imports.
// Drafts have no number. "Issue" takes the next value of the series counter, so deleting a draft never
// leaves a gap and a number is never handed out twice. Patterns: {YYYY} {YY} {MM} and {N…} (zero
// padding = count of N). A pattern with a year token keeps one counter per year of the issue date.

import type { Lang } from './money';

export type DocumentType = 'invoice' | 'quote' | 'receipt' | 'cancellation';
/** Number spaces. Cancellations are numbered in the invoice series (D17). */
export type Series = 'invoice' | 'quote' | 'receipt';

export function seriesOf(type: DocumentType): Series {
  return type === 'cancellation' ? 'invoice' : type;
}

export const DEFAULT_PATTERNS: Record<Lang, Record<Series, string>> = {
  de: { invoice: 'RE-{YYYY}-{NNNN}', quote: 'AN-{YYYY}-{NNNN}', receipt: 'QU-{YYYY}-{NNNN}' },
  en: { invoice: 'INV-{YYYY}-{NNNN}', quote: 'QUO-{YYYY}-{NNNN}', receipt: 'REC-{YYYY}-{NNNN}' },
};

export const PATTERN_MAX_LENGTH = 30;

const TOKEN = /\{(YYYY|YY|MM|N+)\}/g;

export type PatternError = 'empty' | 'too_long' | 'no_counter' | 'two_counters' | 'invalid_character' | 'unknown_token';

/** Must contain exactly one {N…}, be ≤ 30 characters, and use only A–Z a–z 0–9 - / _ . besides tokens. */
export function validatePattern(pattern: string): PatternError | null {
  if (pattern.trim() === '') return 'empty';
  if (pattern.length > PATTERN_MAX_LENGTH) return 'too_long';
  const counters = pattern.match(/\{N+\}/g) ?? [];
  const rest = pattern.replace(TOKEN, '');
  if (/[{}]/.test(rest)) return 'unknown_token';
  if (!/^[A-Za-z0-9\-/_.]*$/.test(rest)) return 'invalid_character';
  if (counters.length === 0) return 'no_counter';
  if (counters.length > 1) return 'two_counters';
  return null;
}

export function hasYearToken(pattern: string): boolean {
  return /\{(YYYY|YY)\}/.test(pattern);
}

function parseIsoDate(date: string): { year: string; month: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`invalid date "${date}", expected YYYY-MM-DD`);
  return { year: m[1], month: m[2] };
}

/** formatNumber('RE-{YYYY}-{NNNN}', 1, '2026-10-01') → 'RE-2026-0001'. Larger values are never cut. */
export function formatNumber(pattern: string, value: number, issueDate: string): string {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`invalid counter value ${value}`);
  const { year, month } = parseIsoDate(issueDate);
  return pattern.replace(TOKEN, (_, token: string) => {
    if (token === 'YYYY') return year;
    if (token === 'YY') return year.slice(2);
    if (token === 'MM') return month;
    return String(value).padStart(token.length, '0');
  });
}

/** Counter key: 'invoice:2026' when the pattern has a year token, else 'invoice'. */
export function seriesKey(type: DocumentType, pattern: string, issueDate: string): string {
  const series = seriesOf(type);
  return hasYearToken(pattern) ? `${series}:${parseIsoDate(issueDate).year}` : series;
}

/**
 * "Next number" may be raised (to continue from another app) but never set to a value that was
 * already used: n ≥ maxUsed + 1.
 */
export function canSetNextValue(next: number, maxUsed: number): boolean {
  return Number.isInteger(next) && next >= 1 && next >= maxUsed + 1;
}
