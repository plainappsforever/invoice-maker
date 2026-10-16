// CSV import of clients and catalog items (V1.5 P1, Idea-b). PURE: file text in, a preview plan out; the database
// side (one transaction) is src/db/import.ts. Reads our own CSV export back exactly (headers in both languages, the
// formula guard undone) and the usual exports of other tools: Google Contacts, Outlook, German invoicing apps.
// - Separator detected from the header line (`;`, `,`, tab, outside quotes); UTF-8 BOM stripped; CRLF, LF, CR.
// - RFC 4180 quoting: quoted separators, quoted newlines, `""` for a quote.
// - Numbers: German files (`;`) read `1.234,56`, English files (`,`) `1,234.56` (engine parseDecimal).
// - A cell that starts with `=` stays TEXT: nothing in the app evaluates it, and our CSV export guards it again.
// - Duplicates (against the phone's data and inside the file) are shown and skipped unless the user includes them.
import { isEuCountry, TREATMENTS, type Treatment } from '@/engine/treatment';
import { parseDecimal, type Lang } from '@/engine/money';
import type { TaxCategory } from '@/engine/totals';
import { translate, type TranslationKey } from '@/i18n';

import { unguardFormula } from './csv';

export type ImportKind = 'clients' | 'items';
export const MAX_IMPORT_CHARS = 5_000_000;
export const MAX_IMPORT_ROWS = 5_000;
const MAX_TEXT = 500;
const MAX_NOTES = 5_000;

// ---------------------------------------------------------------------------------------------
// CSV reader

export type CsvRead = { ok: true; rows: string[][]; separator: ';' | ',' | '\t' } | { ok: false; error: 'empty' | 'tooLarge' | 'tooManyRows' | 'unclosedQuote' };

function detectSeparator(text: string): ';' | ',' | '\t' {
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch as keyof typeof counts]++;
  }
  if (counts['\t'] > counts[';'] && counts['\t'] > counts[',']) return '\t';
  return counts[';'] >= counts[','] && counts[';'] > 0 ? ';' : ',';
}

export function readCsv(source: string): CsvRead {
  if (source.length > MAX_IMPORT_CHARS) return { ok: false, error: 'tooLarge' };
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  if (text.trim() === '') return { ok: false, error: 'empty' };
  const separator = detectSeparator(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(cell);
    cell = '';
    if (!(row.length === 1 && row[0].trim() === '')) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (ch === separator) {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      endRow();
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (rows.length > MAX_IMPORT_ROWS + 1) return { ok: false, error: 'tooManyRows' };
    } else cell += ch;
    i++;
  }
  if (quoted) return { ok: false, error: 'unclosedQuote' };
  if (cell !== '' || row.length > 0) endRow();
  if (rows.length === 0) return { ok: false, error: 'empty' };
  if (rows.length > MAX_IMPORT_ROWS + 1) return { ok: false, error: 'tooManyRows' };
  return { ok: true, rows, separator };
}

// ---------------------------------------------------------------------------------------------
// Column mapping

export type ClientField =
  | 'name' | 'company' | 'firstName' | 'lastName' | 'kind' | 'contact' | 'street' | 'street2' | 'postalCode' | 'city'
  | 'countryCode' | 'email' | 'phone' | 'vatId' | 'buyerReference' | 'treatment' | 'language' | 'currency'
  | 'paymentDays' | 'notes' | 'archived' | 'shipName' | 'shipStreet' | 'shipPostalCode' | 'shipCity' | 'shipCountryCode';
export type ItemField =
  | 'name' | 'description' | 'unit' | 'sku' | 'price' | 'priceIncludesVat' | 'vatCategory' | 'vatRate' | 'archived';
export type ImportField = ClientField | ItemField;

export const CLIENT_FIELDS: readonly ClientField[] = [
  'name', 'company', 'firstName', 'lastName', 'kind', 'contact', 'street', 'street2', 'postalCode', 'city', 'countryCode',
  'email', 'phone', 'vatId', 'buyerReference', 'treatment', 'language', 'currency', 'paymentDays', 'notes', 'archived',
  'shipName', 'shipStreet', 'shipPostalCode', 'shipCity', 'shipCountryCode',
];
export const ITEM_FIELDS: readonly ItemField[] = ['name', 'description', 'unit', 'sku', 'price', 'priceIncludesVat', 'vatCategory', 'vatRate', 'archived'];

/** Header names (folded: lower case, no accents, only letters and digits) per field. Our own export first. */
const CLIENT_HEADERS: Record<ClientField, string[]> = {
  name: ['name', 'kundenname', 'kunde', 'displayname', 'anzeigename', 'fullname', 'vollstandigername', 'kontaktname'],
  company: ['firma', 'company', 'firmenname', 'unternehmen', 'organization', 'organisation', 'organization1name', 'companyname', 'business'],
  firstName: ['vorname', 'firstname', 'givenname', 'first'],
  lastName: ['nachname', 'lastname', 'familyname', 'surname', 'last', 'name2'],
  kind: ['art', 'kind', 'typ', 'type', 'kundentyp'],
  contact: ['ansprechpartner', 'contact', 'contactperson', 'kontaktperson', 'ansprechperson'],
  street: ['strasse', 'street', 'address', 'adresse', 'anschrift', 'strasseundhausnummer', 'strassehausnummer', 'address1street', 'businessstreet', 'homestreet', 'addressline1', 'rechnungsadresse'],
  street2: ['adresszusatz', 'address2', 'addressline2', 'zusatz', 'businessstreet2'],
  postalCode: ['plz', 'postalcode', 'postleitzahl', 'zip', 'zipcode', 'postcode', 'address1postalcode', 'businesspostalcode', 'homepostalcode'],
  city: ['ort', 'city', 'stadt', 'town', 'wohnort', 'address1city', 'businesscity', 'homecity'],
  countryCode: ['land', 'country', 'countrycode', 'landercode', 'address1country', 'businesscountryregion', 'businesscountry', 'homecountryregion'],
  email: ['email', 'emailadresse', 'mail', 'emailaddress', 'email1value', 'e1value'],
  phone: ['telefon', 'phone', 'tel', 'telefonnummer', 'phonenumber', 'phone1value', 'businessphone', 'mobile', 'mobil', 'handy', 'mobilephone', 'primaryphone'],
  vatId: ['ustidnr', 'vatid', 'ustid', 'umsatzsteueridentifikationsnummer', 'vatnumber', 'vat', 'uid', 'ustidnummer', 'vatregistrationnumber'],
  buyerReference: ['leitwegid', 'buyerreference', 'leitweg'],
  treatment: ['steuerlichebehandlung', 'taxtreatment'],
  language: ['sprache', 'language'],
  currency: ['wahrung', 'currency'],
  paymentDays: ['zahlungszieltage', 'paymenttermsdays', 'zahlungsziel', 'paymentterms', 'zahlungsfrist'],
  notes: ['notizen', 'notes', 'notiz', 'bemerkung', 'bemerkungen', 'kommentar', 'comment', 'note'],
  archived: ['archiviert', 'archived'],
  shipName: ['lieferanschriftname', 'deliveryname', 'shippingname', 'lieferadressename'],
  shipStreet: ['lieferanschriftstrasse', 'deliverystreet', 'shippingstreet', 'lieferadressestrasse', 'shippingaddress'],
  shipPostalCode: ['lieferanschriftplz', 'deliverypostalcode', 'shippingpostalcode', 'shippingzip', 'lieferadresseplz'],
  shipCity: ['lieferanschriftort', 'deliverycity', 'shippingcity', 'lieferadresseort'],
  shipCountryCode: ['lieferanschriftland', 'deliverycountry', 'shippingcountry', 'lieferadresseland'],
};
const ITEM_HEADERS: Record<ItemField, string[]> = {
  name: ['name', 'bezeichnung', 'artikel', 'artikelname', 'produkt', 'product', 'leistung', 'item', 'title', 'titel', 'produktname'],
  description: ['beschreibung', 'description', 'details', 'langtext'],
  unit: ['einheit', 'unit', 'mengeneinheit', 'uom'],
  sku: ['artikelnr', 'sku', 'artikelnummer', 'itemnumber', 'productnumber', 'produktnummer', 'nummer', 'number', 'code'],
  price: ['preis', 'price', 'einzelpreis', 'unitprice', 'nettopreis', 'netprice', 'vkpreis', 'verkaufspreis', 'rate', 'preisnetto'],
  priceIncludesVat: ['preisbrutto', 'priceincludesvat', 'brutto', 'inklmwst', 'inclvat', 'bruttopreis'],
  vatCategory: ['ustkategorie', 'vatcategory', 'steuerkategorie'],
  vatRate: ['ustsatz', 'vatrate', 'mwst', 'mwstsatz', 'steuersatz', 'taxrate', 'ust', 'vat', 'tax'],
  archived: ['archiviert', 'archived'],
};

export const foldHeader = (h: string) =>
  h.toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

export type Mapping = (ImportField | null)[];

/** One field per column, guessed from the header; a field is used by the first column that names it. */
export function guessMapping(header: readonly string[], kind: ImportKind): Mapping {
  const table = (kind === 'clients' ? CLIENT_HEADERS : ITEM_HEADERS) as Record<string, string[]>;
  const taken = new Set<string>();
  return header.map((h) => {
    const f = foldHeader(h);
    const field = Object.keys(table).find((k) => !taken.has(k) && table[k].includes(f)) ?? null;
    if (field) taken.add(field);
    return field as ImportField | null;
  });
}

// ---------------------------------------------------------------------------------------------
// Values

const YES = new Set(['ja', 'yes', 'true', 'wahr', '1', 'x', 'y', 'j', 'brutto', 'gross', 'inkl', 'incl']);
const COUNTRY_NAMES: Record<string, string> = {
  deutschland: 'DE', germany: 'DE', osterreich: 'AT', austria: 'AT', schweiz: 'CH', switzerland: 'CH', frankreich: 'FR',
  france: 'FR', niederlande: 'NL', netherlands: 'NL', nederland: 'NL', belgien: 'BE', belgium: 'BE', italien: 'IT',
  italy: 'IT', spanien: 'ES', spain: 'ES', polen: 'PL', poland: 'PL', danemark: 'DK', denmark: 'DK', luxemburg: 'LU',
  luxembourg: 'LU', grossbritannien: 'GB', vereinigteskonigreich: 'GB', unitedkingdom: 'GB', uk: 'GB', england: 'GB',
  usa: 'US', vereinigtestaaten: 'US', unitedstates: 'US', tschechien: 'CZ', czechia: 'CZ', schweden: 'SE', sweden: 'SE',
  irland: 'IE', ireland: 'IE', portugal: 'PT', liechtenstein: 'LI', norwegen: 'NO', norway: 'NO', finnland: 'FI', finland: 'FI',
};
const UNIT_WORDS: Record<string, string> = {
  c62: 'C62', stk: 'C62', stuck: 'C62', st: 'C62', pcs: 'C62', pc: 'C62', piece: 'C62', pieces: 'C62', ea: 'C62', each: 'C62',
  hur: 'HUR', h: 'HUR', std: 'HUR', stunde: 'HUR', stunden: 'HUR', hour: 'HUR', hours: 'HUR', hr: 'HUR', hrs: 'HUR',
  day: 'DAY', tag: 'DAY', tage: 'DAY', days: 'DAY', d: 'DAY', mon: 'MON', monat: 'MON', monate: 'MON', month: 'MON', months: 'MON',
  kmt: 'KMT', km: 'KMT', kgm: 'KGM', kg: 'KGM', mtr: 'MTR', m: 'MTR', meter: 'MTR', mtk: 'MTK', m2: 'MTK', qm: 'MTK',
  ltr: 'LTR', l: 'LTR', liter: 'LTR', litre: 'LTR', ls: 'LS', pauschal: 'LS', pausch: 'LS', lumpsum: 'LS', flat: 'LS', psch: 'LS',
};
const CATEGORIES: readonly TaxCategory[] = ['S', 'Z', 'E', 'AE', 'K', 'G', 'O'];

const cap = (s: string, n = MAX_TEXT) => (s.length > n ? s.slice(0, n) : s);
const clean = (s: string | undefined) => unguardFormula((s ?? '').trim());

function countryCode(value: string): string | null {
  const v = value.trim();
  if (v === '') return null;
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  return COUNTRY_NAMES[foldHeader(v)] ?? null;
}

function treatmentOf(value: string): Treatment | null {
  const v = foldHeader(value);
  if (!v) return null;
  for (const t of TREATMENTS) {
    if (foldHeader(t) === v) return t;
    for (const lang of ['de', 'en'] as const) if (foldHeader(translate(lang, `treatment.${t}` as TranslationKey)) === v) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Plan

export type ClientImport = {
  kind: 'business' | 'person';
  name: string;
  contact: string;
  street: string;
  postalCode: string;
  city: string;
  countryCode: string;
  email: string;
  phone: string;
  vatId: string;
  buyerReference: string;
  treatment: Treatment;
  language: Lang | null;
  currency: string | null;
  paymentDays: number | null;
  notes: string;
  shipName: string;
  shipStreet: string;
  shipPostalCode: string;
  shipCity: string;
  shipCountryCode: string;
  archived: boolean;
};
export type ItemImport = {
  name: string;
  description: string;
  unitCode: string;
  sku: string;
  priceE4: number;
  priceIncludesVat: boolean;
  taxCategory: TaxCategory;
  taxRateBp: number;
  archived: boolean;
};

export type ImportProblem =
  | 'noName' | 'badPrice' | 'badVatRate' | 'badCountry' | 'badPaymentDays' | 'unknownUnit' | 'unknownTreatment' | 'badCurrency';
/** `skip` problems keep the row out; the others are fixed with a default and reported. */
const SKIP: ReadonlySet<ImportProblem> = new Set(['noName', 'badPrice', 'badVatRate']);

export type ImportRow<T> = {
  /** 1-based line number of the data row in the file (the header is line 1). */
  line: number;
  record: T | null;
  problems: ImportProblem[];
  /** Same as a client/item on this phone (its id) or an earlier row of the file (`file`). */
  duplicateOf: number | 'file' | null;
};

export type ImportPlan<T> = {
  kind: ImportKind;
  separator: ';' | ',' | '\t';
  header: string[];
  mapping: Mapping;
  rows: ImportRow<T>[];
  counts: { total: number; ready: number; duplicates: number; skipped: number };
};

export type Existing = {
  clients: { id: number; name: string; email: string; postalCode: string }[];
  items: { id: number; name: string; sku: string }[];
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function clientKey(c: { name: string; email: string; postalCode: string }): string[] {
  const keys = [`n:${norm(c.name)}|${norm(c.postalCode)}`];
  if (c.email.trim()) keys.push(`e:${norm(c.email)}`);
  return keys;
}
export const itemKey = (i: { name: string; sku: string }): string => (i.sku.trim() ? `s:${norm(i.sku)}` : `n:${norm(i.name)}`);

function readClient(cells: string[], mapping: Mapping): { record: ClientImport | null; problems: ImportProblem[] } {
  const get = (f: ClientField) => {
    const i = mapping.indexOf(f);
    return i < 0 ? '' : clean(cells[i]);
  };
  const problems: ImportProblem[] = [];
  const company = get('company');
  const person = [get('firstName'), get('lastName')].filter(Boolean).join(' ');
  const explicitName = get('name');
  const name = cap(explicitName || company || person);
  if (!name) return { record: null, problems: ['noName'] };
  const kindText = foldHeader(get('kind'));
  const kind: 'business' | 'person' =
    ['person', 'privat', 'privatperson', 'private', 'individual', 'privatkunde'].includes(kindText) ? 'person'
      : ['business', 'firma', 'company', 'unternehmen', 'geschaftskunde', 'gewerblich'].includes(kindText) ? 'business'
        : !explicitName && !company && person ? 'person' : 'business';
  let contact = get('contact');
  if (!contact && person && person !== name) contact = person;
  let country = countryCode(get('countryCode'));
  if (get('countryCode') && !country) problems.push('badCountry');
  country = country ?? 'DE';
  const daysText = get('paymentDays');
  let paymentDays: number | null = null;
  if (daysText) {
    const n = Number(daysText);
    if (Number.isInteger(n) && n >= 0 && n <= 365) paymentDays = n;
    else problems.push('badPaymentDays');
  }
  const treatmentText = get('treatment');
  const treatment = treatmentText ? treatmentOf(treatmentText) : null;
  if (treatmentText && !treatment) problems.push('unknownTreatment');
  const language = get('language').toLowerCase();
  const currency = get('currency').toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) problems.push('badCurrency');
  const street = [get('street'), get('street2')].filter(Boolean).join(', ');
  return {
    problems,
    record: {
      kind,
      name,
      contact: cap(contact),
      street: cap(street),
      postalCode: cap(get('postalCode'), 20),
      city: cap(get('city')),
      countryCode: country,
      email: cap(get('email')),
      phone: cap(get('phone'), 60),
      vatId: cap(get('vatId').replace(/\s+/g, '').toUpperCase(), 30),
      buyerReference: cap(get('buyerReference'), 100),
      // Our treatment column, or the standard one; a suggestion for EU/non-EU clients is the form's job (D21).
      treatment: treatment ?? 'standard',
      language: language === 'de' || language === 'en' ? language : null,
      currency: /^[A-Z]{3}$/.test(currency) ? currency : null,
      paymentDays,
      notes: cap(get('notes'), MAX_NOTES),
      shipName: cap(get('shipName')),
      shipStreet: cap(get('shipStreet')),
      shipPostalCode: cap(get('shipPostalCode'), 20),
      shipCity: cap(get('shipCity')),
      shipCountryCode: get('shipCountryCode') ? countryCode(get('shipCountryCode')) ?? '' : '',
      archived: YES.has(foldHeader(get('archived'))),
    },
  };
}

function readItem(cells: string[], mapping: Mapping, lang: Lang): { record: ItemImport | null; problems: ImportProblem[] } {
  const get = (f: ItemField) => {
    const i = mapping.indexOf(f);
    return i < 0 ? '' : clean(cells[i]);
  };
  const problems: ImportProblem[] = [];
  const name = cap(get('name'));
  if (!name) return { record: null, problems: ['noName'] };
  const priceText = get('price').replace(/\s*(€|eur|euro)\s*$/i, '');
  let priceE4 = 0;
  if (priceText) {
    const parsed = parseDecimal(priceText, lang, 4);
    if (!parsed.ok || Math.abs(parsed.value) > 9_999_999_999_999) return { record: null, problems: ['badPrice'] };
    priceE4 = parsed.value;
  }
  let taxCategory: TaxCategory = 'S';
  const catText = get('vatCategory').toUpperCase();
  if (CATEGORIES.includes(catText as TaxCategory)) taxCategory = catText as TaxCategory;
  let taxRateBp = 1900;
  const rateText = get('vatRate').replace(/\s*%$/, '');
  if (rateText) {
    const parsed = parseDecimal(rateText, lang, 2);
    if (!parsed.ok || parsed.value < 0 || parsed.value > 10_000) return { record: null, problems: ['badVatRate'] };
    taxRateBp = parsed.value;
    if (!catText) taxCategory = taxRateBp === 0 ? 'Z' : 'S';
  }
  if (taxCategory !== 'S') taxRateBp = 0;
  const unitText = get('unit');
  let unitCode = 'C62';
  if (unitText) {
    const u = UNIT_WORDS[foldHeader(unitText)] ?? (UNIT_WORDS[unitText.toLowerCase()] ? UNIT_WORDS[unitText.toLowerCase()] : undefined);
    if (u) unitCode = u;
    else problems.push('unknownUnit');
  }
  return {
    problems,
    record: {
      name,
      description: cap(get('description'), MAX_NOTES),
      unitCode,
      sku: cap(get('sku'), 100),
      priceE4,
      priceIncludesVat: YES.has(foldHeader(get('priceIncludesVat'))),
      taxCategory,
      taxRateBp,
      archived: YES.has(foldHeader(get('archived'))),
    },
  };
}

export function planImport(read: Extract<CsvRead, { ok: true }>, kind: 'clients', existing: Existing, mapping?: Mapping): ImportPlan<ClientImport>;
export function planImport(read: Extract<CsvRead, { ok: true }>, kind: 'items', existing: Existing, mapping?: Mapping): ImportPlan<ItemImport>;
export function planImport(
  read: Extract<CsvRead, { ok: true }>,
  kind: ImportKind,
  existing: Existing,
  mapping?: Mapping
): ImportPlan<ClientImport> | ImportPlan<ItemImport> {
  const [header, ...data] = read.rows;
  const map = mapping ?? guessMapping(header, kind);
  // `;` files come from German spreadsheets (decimal comma); `,` files from English ones. Tab: look at the numbers.
  const lang: Lang = read.separator === ';' ? 'de' : read.separator === ',' ? 'en' : /\d,\d{1,2}(\D|$)/.test(data.map((r) => r.join(' ')).join(' ')) ? 'de' : 'en';
  const seen = new Map<string, number | 'file'>();
  if (kind === 'clients') for (const c of existing.clients) for (const k of clientKey(c)) seen.set(k, c.id);
  else for (const i of existing.items) seen.set(itemKey(i), i.id);
  const rows: ImportRow<ClientImport | ItemImport>[] = data.map((cells, index) => {
    const { record, problems } = kind === 'clients' ? readClient(cells, map) : readItem(cells, map, lang);
    let duplicateOf: number | 'file' | null = null;
    if (record) {
      const keys = kind === 'clients' ? clientKey(record as ClientImport) : [itemKey(record as ItemImport)];
      for (const k of keys) if (duplicateOf === null && seen.has(k)) duplicateOf = seen.get(k) as number | 'file';
      for (const k of keys) if (!seen.has(k)) seen.set(k, 'file');
    }
    return { line: index + 2, record, problems, duplicateOf };
  });
  const skipped = rows.filter((r) => !r.record || r.problems.some((p) => SKIP.has(p))).length;
  const duplicates = rows.filter((r) => r.record && r.duplicateOf !== null).length;
  return {
    kind,
    separator: read.separator,
    header,
    mapping: map,
    rows: rows as ImportRow<never>[],
    counts: { total: rows.length, ready: rows.length - skipped - duplicates, duplicates, skipped },
  };
}

/** The records an import writes: rows without a skipping problem; duplicates only when the user asked for them. */
export function recordsToImport<T>(plan: ImportPlan<T>, includeDuplicates: boolean): T[] {
  return plan.rows.filter((r) => r.record && !r.problems.some((p) => SKIP.has(p)) && (includeDuplicates || r.duplicateOf === null)).map((r) => r.record as T);
}

/** EU client with a VAT id → the form would suggest reverse charge; the import keeps 'standard' and says so. */
export function needsTreatmentReview(c: ClientImport): boolean {
  return c.treatment === 'standard' && c.countryCode !== 'DE' && (isEuCountry(c.countryCode) ? c.vatId !== '' : c.kind === 'business');
}
