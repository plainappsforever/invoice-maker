// Calendar dates as 'YYYY-MM-DD' strings (local calendar days). PURE: no React/Expo imports.
// No Date/time-zone arithmetic on calendar days: an invoice dated 2026-03-29 stays 2026-03-29 in every
// zone and across daylight-saving changes (pattern from warranty-wallet's dates.ts).
import type { Lang } from './money';

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export type YMD = { y: number; m: number; d: number };

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function parseIsoDate(s: string): YMD | null {
  const match = ISO.exec(s);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

export function isValidIsoDate(s: string | null | undefined): s is string {
  return typeof s === 'string' && parseIsoDate(s) !== null;
}

export function toIsoDate(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function mustParse(s: string): YMD {
  const parsed = parseIsoDate(s);
  if (!parsed) throw new RangeError(`invalid calendar date "${s}", expected YYYY-MM-DD`);
  return parsed;
}

/** Calendar arithmetic: 2026-01-31 + 1 = 2026-02-01; 2026-10-01 + 14 = 2026-10-15. */
export function addDays(iso: string, n: number): string {
  const { y, m, d } = mustParse(iso);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return toIsoDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Whole calendar days from a to b (negative when b is before a). */
export function daysBetween(a: string, b: string): number {
  const pa = mustParse(a);
  const pb = mustParse(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}

/** The device's LOCAL calendar day (never UTC). */
export function todayLocal(now: Date = new Date()): string {
  return toIsoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** 'YYYY-MM' of a date. */
export function monthOf(iso: string): string {
  mustParse(iso);
  return iso.slice(0, 7);
}

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Document/notification date format, deterministic (no Intl): '01.10.2026' (de), '1 Oct 2026' (en). */
export function formatDate(iso: string, lang: Lang): string {
  const { y, m, d } = mustParse(iso);
  if (lang === 'de') return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
  return `${d} ${MONTHS_EN[m - 1]} ${y}`;
}
