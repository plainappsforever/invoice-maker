// IBAN and BIC checks (ISO 13616 mod 97, ISO 9362). PURE: no React/Expo imports.

/** IBAN lengths of the SEPA countries (EPC409-09 register of IBAN countries). */
const SEPA_IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18,
  FR: 27, GB: 22, GI: 23, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20,
  LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27,
  VA: 22,
};

export type IbanError = 'empty' | 'invalid_format' | 'wrong_length' | 'checksum';

/** Removes spaces and dashes, upper-cases. */
export function normalizeIban(input: string): string {
  return input.replace(/[\s \-]/g, '').toUpperCase();
}

/** ISO 7064 mod 97-10 over the rearranged IBAN, computed digit by digit (no big numbers). */
export function ibanMod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const digits = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder;
}

export function validateIban(input: string): IbanError | null {
  const iban = normalizeIban(input);
  if (iban === '') return 'empty';
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return 'invalid_format';
  const expected = SEPA_IBAN_LENGTHS[iban.slice(0, 2)];
  if (expected !== undefined && iban.length !== expected) return 'wrong_length';
  if (ibanMod97(iban) !== 1) return 'checksum';
  return null;
}

export function isSepaCountry(iban: string): boolean {
  return normalizeIban(iban).slice(0, 2) in SEPA_IBAN_LENGTHS;
}

/** EEA = the EU states plus Iceland, Liechtenstein and Norway (IBAN country codes; Greece's IBANs start with GR). */
const EEA_IBAN_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU',
  'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'IS', 'LI', 'NO',
]);

/** True for SEPA IBANs of EEA countries. EPC069-12 version 002 makes the BIC optional only for these. */
export function isEeaIban(iban: string): boolean {
  return EEA_IBAN_COUNTRIES.has(normalizeIban(iban).slice(0, 2));
}

/** Groups of four for display and print: "DE89 3704 0044 0532 0130 00". */
export function formatIban(input: string): string {
  return normalizeIban(input).replace(/(.{4})(?=.)/g, '$1 ');
}

export function normalizeBic(input: string): string {
  return input.replace(/\s/g, '').toUpperCase();
}

/** 8 or 11 characters: bank (4 letters), country (2 letters), location (2), optional branch (3). */
export function isValidBic(input: string): boolean {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(normalizeBic(input));
}
