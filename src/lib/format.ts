// UI formatting in the UI language (documents use their own language through the renderer, D15).
import { formatDate, isValidIsoDate, parseIsoDate, toIsoDate } from '@/engine/dates';
import { formatAmount, formatMoney, type Lang } from '@/engine/money';
import { UNIT_CODES } from '@/db/items';
import { getUiLanguage, t } from '@/i18n';

export const money = (cents: number, currency: string) => formatMoney(cents, currency, getUiLanguage());
export const amount = (cents: number) => formatAmount(cents, getUiLanguage());
export const dateLabel = (iso: string | null | undefined) => (isValidIsoDate(iso) ? formatDate(iso, getUiLanguage()) : '');

/** Date as typed in a field: '01.10.2026' (German UI) or '2026-10-01' (English UI, unambiguous). */
export function dateInputText(iso: string | null | undefined, lang: Lang = getUiLanguage()): string {
  const p = iso ? parseIsoDate(iso) : null;
  if (!p) return '';
  return lang === 'de' ? `${String(p.d).padStart(2, '0')}.${String(p.m).padStart(2, '0')}.${p.y}` : iso!;
}

/** Reads 'D.M.YYYY' (also 'D.M.YY' → 20YY), 'YYYY-MM-DD' or 'YYYY/MM/DD'; null when it is not a real date. */
export function parseDateInput(text: string): string | null {
  const t = text.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  let y: number, mo: number, d: number;
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else {
    m = /^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})$/.exec(t);
    if (!m) return null;
    [d, mo, y] = [Number(m[1]), Number(m[2]), m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])];
  }
  const iso = toIsoDate(y, mo, d);
  return isValidIsoDate(iso) ? iso : null;
}

/** 'h', 'pcs' … in the UI language; unknown codes are shown as they are. */
export function unitLabel(code: string): string {
  return (UNIT_CODES as readonly string[]).includes(code) ? t(`render.unit.${code as (typeof UNIT_CODES)[number]}`) : code;
}
