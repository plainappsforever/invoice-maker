// A contact picked in the system contacts picker → client fields (V1.5 P1, Idea-c). PURE (no Expo imports; the shape
// is expo-contacts' legacy Contact). The result fills the client form like a scan does; nothing is saved by itself.
import { EMPTY_CONTACT, type ContactFields } from '@/engine/contact-parse';

export type PickedContact = {
  name?: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  namePrefix?: string;
  company?: string;
  contactType?: string;
  emails?: { email?: string; isPrimary?: boolean; label?: string }[];
  phoneNumbers?: { number?: string; isPrimary?: boolean; label?: string }[];
  addresses?: { street?: string; city?: string; postalCode?: string; country?: string; isoCountryCode?: string; label?: string }[];
};

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const first = <T extends { isPrimary?: boolean; label?: string }>(list: T[] | undefined, prefer: RegExp): T | undefined =>
  list?.find((x) => x.isPrimary) ?? list?.find((x) => prefer.test(x.label ?? '')) ?? list?.[0];

export function fieldsFromContact(c: PickedContact): ContactFields {
  const person = clean([c.namePrefix, c.firstName, c.middleName, c.lastName].filter(Boolean).join(' ')) || (c.company ? '' : clean(c.name));
  const company = clean(c.company);
  const address = first(c.addresses, /work|business|arbeit|gesch/i);
  const email = clean(first(c.emails, /work|arbeit/i)?.email).toLowerCase();
  const phone = clean(first(c.phoneNumbers, /work|main|arbeit|gesch/i)?.number);
  const iso = clean(address?.isoCountryCode).toUpperCase();
  const fields: ContactFields = {
    ...EMPTY_CONTACT,
    kind: company ? 'business' : person ? 'person' : '',
    name: company || person,
    contact: company ? person : '',
    street: (address?.street ?? '').split(/\r?\n/).map(clean).filter(Boolean).join(', '),
    postalCode: clean(address?.postalCode),
    city: clean(address?.city),
    countryCode: /^[A-Z]{2}$/.test(iso) ? iso : '',
    email,
    phone,
  };
  return fields;
}
