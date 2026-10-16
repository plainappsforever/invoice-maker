// Tax treatments (D21): the VAT category of a document's lines and the client-form suggestion.
// PURE. A suggestion is always shown to the user in the client form, never applied silently.
import type { TaxCategory } from './totals';

export type Treatment = 'standard' | 'reverse_charge' | 'intra_eu_goods' | 'export' | 'exempt';
export const TREATMENTS: readonly Treatment[] = ['standard', 'reverse_charge', 'intra_eu_goods', 'export', 'exempt'];
export type VatMode = 'standard' | 'small_business';

/** EU member states, ISO 3166-1 alpha-2 (Greece is GR here; its VAT ids start with EL). */
export const EU_COUNTRIES: readonly string[] = [
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU',
  'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
];

export function isEuCountry(countryCode: string): boolean {
  return EU_COUNTRIES.includes(countryCode.trim().toUpperCase());
}

/**
 * VAT category of every line under a treatment; null = standard (S with the line's own rate).
 * §19 small business → E (D35); reverse charge → AE; intra-EU goods → K; export → G; other exemption → E.
 */
export function treatmentCategory(treatment: Treatment, vatMode: VatMode): TaxCategory | null {
  switch (treatment) {
    case 'reverse_charge':
      return 'AE';
    case 'intra_eu_goods':
      return 'K';
    case 'export':
      return 'G';
    case 'exempt':
      return 'E';
    default:
      return vatMode === 'small_business' ? 'E' : null;
  }
}

/**
 * Category + rate a new or converted line gets. Lines without VAT carry rate 0. A standard line at 0 % is
 * category Z (zero-rated), not S at 0 % (EN 16931 BR-S-05; review #15).
 */
export function lineTax(treatment: Treatment, vatMode: VatMode, rateBp: number): { category: TaxCategory; rateBp: number } {
  const category = treatmentCategory(treatment, vatMode);
  if (category) return { category, rateBp: 0 };
  return rateBp === 0 ? { category: 'Z', rateBp: 0 } : { category: 'S', rateBp };
}

/** True when a line shows VAT although the treatment/§19 mode says no VAT (check item). */
export function lineConflicts(treatment: Treatment, vatMode: VatMode, line: { category: TaxCategory; rateBp: number }): boolean {
  if (treatmentCategory(treatment, vatMode) === null) return false; // standard: mixed rates/categories are fine
  return line.category === 'S' && line.rateBp > 0;
}

export type TreatmentSuggestion = {
  /** null: no suggestion, the user chooses (e.g. clients outside the EU: goods vs. services differ). */
  treatment: Treatment | null;
  reason: 'domestic' | 'eu_business_with_vat_id' | 'eu_without_vat_id' | 'non_eu';
};

/**
 * Default treatment for a client (V1_PLAN P2.3): Germany → standard; another EU country with a VAT id
 * (business) → reverse charge (services, §13b/§14a UStG); EU without a VAT id → standard; outside the EU → no
 * suggestion. Shown in the client form as a suggestion, never applied silently.
 */
export function suggestTreatment(client: { countryCode: string; vatId: string; kind: 'business' | 'person' }): TreatmentSuggestion {
  const country = client.countryCode.trim().toUpperCase() || 'DE';
  if (country === 'DE') return { treatment: 'standard', reason: 'domestic' };
  if (!isEuCountry(country)) return { treatment: null, reason: 'non_eu' };
  if (client.kind === 'business' && client.vatId.trim() !== '') return { treatment: 'reverse_charge', reason: 'eu_business_with_vat_id' };
  return { treatment: 'standard', reason: 'eu_without_vat_id' };
}
