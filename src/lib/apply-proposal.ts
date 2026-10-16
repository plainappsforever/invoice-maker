// A scan or picked-contact proposal → the client form (V1.5 P1). PURE. Only EMPTY fields are filled (a typed value is
// never overwritten); the default country "DE" of a new client counts as empty; the kind is set only for a client
// without a name yet. Returns what was filled and what was kept, for the message under the buttons.
import type { ContactFields } from '@/engine/contact-parse';

export const FILLABLE = ['name', 'contact', 'street', 'postalCode', 'city', 'countryCode', 'email', 'phone', 'vatId'] as const;
type Fillable = (typeof FILLABLE)[number];

export function applyProposal<F extends Record<Fillable, string> & { kind: 'business' | 'person' }>(form: F, p: ContactFields): { form: F; filled: number; kept: number } {
  const next = { ...form };
  let filled = 0;
  let kept = 0;
  const fresh = form.name.trim() === '';
  for (const key of FILLABLE) {
    const value = p[key].trim();
    if (!value) continue;
    const current = String(form[key] ?? '').trim();
    const defaultCountry = key === 'countryCode' && fresh && current === 'DE';
    if (current === '' || defaultCountry) {
      if (current !== value) filled++;
      next[key] = value as F[Fillable];
    } else if (current !== value) kept++;
  }
  if (fresh && p.kind) next.kind = p.kind;
  return { form: next, filled, kept };
}
