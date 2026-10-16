// Wording rules (D21, STRATEGY.md): v1 never claims compliance or e-invoicing, and legal texts are
// information with their source, never advice or a legal conclusion. PURE. Used by the Jest tests of
// every user-facing text source (i18n dictionaries, legal notes, check items, reminder texts).

/** Compliance / e-invoice claims (V1_PLAN rule 11). */
export const BANNED_CLAIMS: readonly RegExp[] = [
  /compliant/i,
  /compliance/i,
  /konform/i,
  /rechtssicher/i,
  /\bGoBD\b/i,
  /E-?Rechnung/i,
  /XRechnung/i,
  /ZUGFeRD/i,
  /e-?invoic/i,
];

/** Advice and legal conclusions (D21, warranty-wallet D47 pattern), English and German. */
export const BANNED_ADVICE: readonly RegExp[] = [
  /\byou (must|have to|need to|are required to|are obliged)\b/i,
  /\bmust\b/i,
  /required by law/i,
  /legally (valid|binding|correct|required)/i,
  /\b(valid|correct|complete) invoice\b/i,
  /invoice is (valid|correct|complete)/i,
  /\bguarantee/i,
  /all (mandatory|required) (details|information)/i,
  /\b(Sie|du) (müssen|musst|sind verpflichtet|bist verpflichtet)\b/i,
  /\bmüssen\b/i,
  /gesetzlich vorgeschrieben/i,
  /rechtsgültig/i,
  /(gültige|korrekte|vollständige) Rechnung/i,
  /Rechnung ist (gültig|korrekt|vollständig)/i,
  /steuerlich (korrekt|richtig|einwandfrei)/i,
  /rechtlich (korrekt|einwandfrei)/i,
  /garantier/i,
  /alle Pflichtangaben/i,
];

export const BANNED_PHRASES: readonly RegExp[] = [...BANNED_CLAIMS, ...BANNED_ADVICE];

/**
 * Texts that may NAME e-invoice formats because they say this app does NOT create them (v1.1 D88, review #10): the
 * PDF footer line and the Help text with dates and sources. They still pass the advice rules and must contain a
 * negation; every other use of "E-Rechnung"/"e-invoice"/"XRechnung"/"ZUGFeRD" fails the test.
 */
export const EINVOICE_INFO_KEYS: readonly string[] = ['render.einvoiceNote', 'about.einvoice.title', 'about.einvoice.body', 'about.einvoice.source'];
export const NEGATION = /\b(not|no|kein|keine|keinen)\b/i;

/** The patterns a text matches (empty = allowed). */
export function bannedIn(text: string): string[] {
  return BANNED_PHRASES.filter((p) => p.test(text)).map(String);
}
