// GiroCode / EPC QR payload (EPC069-12 v2.1, version 002, RESEARCH §2.5, D26). PURE.
// Lines: BCD / 002 / 1 (UTF-8) / SCT / BIC (optional) / name ≤ 70 / IBAN / EUR amount / purpose ≤ 4 /
// structured reference ≤ 35 OR unstructured text ≤ 140 / info ≤ 70. LF separators, nothing after the
// last populated element, payload ≤ 331 bytes. The QR itself (level M) is drawn by the renderer (P3).

import { isEeaIban, isSepaCountry, isValidBic, normalizeBic, normalizeIban, validateIban } from './iban';

export const EPC_MAX_BYTES = 331;
export const EPC_LIMITS = { name: 70, remittance: 140, info: 70, purpose: 4 } as const;
export const EPC_MIN_CENTS = 1;
export const EPC_MAX_CENTS = 99_999_999_999;

export type EpcInput = {
  name: string;
  iban: string;
  bic?: string;
  /** Amount in cents (the balance due). */
  amountCents: number;
  currency: string;
  /** Unstructured remittance text (the document number, + client name if space). */
  remittance: string;
  info?: string;
};

/** 'not_sepa': a SEPA transfer cannot reach the account; 'bic_required': outside the EEA version 002 needs the BIC. */
export type EpcError = 'currency' | 'amount' | 'iban' | 'not_sepa' | 'bic' | 'bic_required' | 'name';
export type EpcResult = { ok: true; payload: string } | { ok: false; error: EpcError };

/** UTF-8 byte length, computed from code points (no TextEncoder dependency on the JS engine). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Line breaks would break the line format; control characters are dropped. */
function clean(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Truncates to at most `maxChars` characters (code points, never splitting a surrogate pair). */
export function truncateChars(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('').trimEnd();
}

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    const n = utf8Length(ch);
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out.trimEnd();
}

/** "EUR1030.29" */
export function formatEpcAmount(cents: number): string {
  return `EUR${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** Document number, then the client name when it still fits in 140 characters. */
export function remittanceText(documentNumber: string, clientName = ''): string {
  const number = clean(documentNumber);
  const name = clean(clientName);
  if (!name) return truncateChars(number, EPC_LIMITS.remittance);
  const both = `${number} ${name}`;
  return Array.from(both).length <= EPC_LIMITS.remittance ? both : truncateChars(number, EPC_LIMITS.remittance);
}

export function buildEpcPayload(input: EpcInput): EpcResult {
  if (input.currency !== 'EUR') return { ok: false, error: 'currency' };
  if (!Number.isInteger(input.amountCents) || input.amountCents < EPC_MIN_CENTS || input.amountCents > EPC_MAX_CENTS) {
    return { ok: false, error: 'amount' };
  }
  const iban = normalizeIban(input.iban);
  if (validateIban(iban) !== null) return { ok: false, error: 'iban' };
  if (!isSepaCountry(iban)) return { ok: false, error: 'not_sepa' }; // review #11
  const bic = input.bic ? normalizeBic(input.bic) : '';
  if (bic && !isValidBic(bic)) return { ok: false, error: 'bic' };
  if (!bic && !isEeaIban(iban)) return { ok: false, error: 'bic_required' };
  let name = truncateChars(clean(input.name), EPC_LIMITS.name);
  if (!name) return { ok: false, error: 'name' };
  let remittance = truncateChars(clean(input.remittance), EPC_LIMITS.remittance);
  let info = truncateChars(clean(input.info ?? ''), EPC_LIMITS.info);

  const assemble = () => {
    const lines = ['BCD', '002', '1', 'SCT', bic, name, iban, formatEpcAmount(input.amountCents), '', '', remittance, info];
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  };
  // Over 331 bytes (only possible with many multi-byte characters): shorten info, then the remittance
  // text, then the name.
  let payload = assemble();
  let excess = utf8Length(payload) - EPC_MAX_BYTES;
  if (excess > 0 && info) {
    info = truncateUtf8(info, Math.max(0, utf8Length(info) - excess));
    payload = assemble();
    excess = utf8Length(payload) - EPC_MAX_BYTES;
  }
  if (excess > 0) {
    remittance = truncateUtf8(remittance, Math.max(0, utf8Length(remittance) - excess));
    payload = assemble();
    excess = utf8Length(payload) - EPC_MAX_BYTES;
  }
  if (excess > 0) {
    name = truncateUtf8(name, utf8Length(name) - excess);
    payload = assemble();
  }
  return { ok: true, payload };
}
