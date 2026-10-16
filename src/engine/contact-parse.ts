// Contact-text parser (V1.5 P1, N1): the lines an on-device text recogniser read from a business card, a letterhead
// or an e-mail signature → client fields. PURE (no React/Expo). The result is only ever a PROPOSAL shown in the
// editable client form; nothing is saved without the user. A field the parser is not sure about stays empty.
//
// How it reads: lines are cut at the separators cards and letterheads use (" · ", " | ", " • ", " – "), labels
// ("Tel.:", "E-Mail:") are recognised, and each piece is classified: e-mail, web address, VAT id, phone, fax,
// postcode + town, street, legal/register text, greeting, company, person. The user's own business (the recipient
// block of a letter) is skipped. Country comes from the postcode format first, then a country line, the VAT id,
// the phone prefix and the e-mail domain. Measured against src/engine/__fixtures__/contact-texts.json.
import { FIRST_NAMES, fold } from './first-names';

export type ContactFields = {
  kind: 'business' | 'person' | '';
  /** Company name for a business, the person's name otherwise (= the client's `name`). */
  name: string;
  /** The person at a company (= the client's `contact`). */
  contact: string;
  street: string;
  postalCode: string;
  city: string;
  countryCode: string;
  email: string;
  phone: string;
  vatId: string;
};
export type ContactField = keyof ContactFields;
export const CONTACT_FIELDS: readonly ContactField[] = [
  'kind', 'name', 'contact', 'street', 'postalCode', 'city', 'countryCode', 'email', 'phone', 'vatId',
];

/** The user's own business: its block in a letter (the recipient address) is ignored. */
export type OwnBusiness = { name?: string; street?: string; city?: string; email?: string };

export const EMPTY_CONTACT: Readonly<ContactFields> = Object.freeze({
  kind: '', name: '', contact: '', street: '', postalCode: '', city: '', countryCode: '', email: '', phone: '', vatId: '',
});

type Seg = { text: string; line: number; used: boolean };

// ---------------------------------------------------------------------------------------------------------
// Vocabulary

const LEGAL_FORM =
  /(?:^|[\s,(])(GmbH|gGmbH|mbH|GesmbH|UG|AG|KG|OHG|OG|GbR|e\.\s?U\.|e\.\s?K\.|e\.\s?Kfm\.|e\.\s?V\.|mbB|PartG|PartGmbB|Ltd\.?|Limited|LLC|L\.L\.C\.|Inc\.?|Corp\.?|PLC|SARL|SAS|S\.A\.S?\.?|S\.à\s?r\.l\.|S\.r\.l\.|Srl|S\.p\.A\.|SpA|S\.L\.U?\.?|B\.V\.|BV|N\.V\.|NV|SE|eG|KGaA|Sp\.\s?z\s?o\.\s?o\.|s\.r\.o\.|Kft\.|ApS|A\/S|AB|Oy|Stiftung|& Co\.?)(?=$|[\s,)])/;
const FAMILY_FIRM = /\s&\s*(Söhne|Sohn|Sons|Son|Fils|Partner|Partners|Co\.?)\b/i;
/** Word parts that make a two-or-more-word line a business name (folded, matched inside words). */
const BUSINESS_WORDS = [
  'praxis', 'kanzlei', 'studio', 'atelier', 'hotel', 'cafe', 'baeckerei', 'backerei', 'tischlerei', 'schreinerei',
  'werkstatt', 'service', 'consulting', 'beratung', 'agentur', 'agency', 'media', 'immobilien', 'verwaltung',
  'stadtwerke', 'schule', 'pflege', 'weingut', 'hof', 'buro', 'laden', 'shop', 'events', 'gartenbau', 'technik',
  'druck', 'reinigung', 'logisti', 'messebau', 'accountants', 'apotheke', 'salon', 'kosmetik', 'friseur', 'restaurant',
  'gasthaus', 'gasthof', 'bau', 'handel', 'vertrieb', 'versicherung', 'autohaus', 'kfz', 'schreibwaren', 'blumen',
  'raum', 'gruppe', 'group', 'solutions', 'systems', 'software', 'design', 'fenster', 'elektro', 'sanitar', 'metall',
  'zentrum', 'center', 'centre', 'institut', 'verlag', 'galerie', 'fotostudio', 'dienst', 'markt', 'werk', 'haus',
  'manufaktur', 'erei', 'gemeinde', 'kirche', 'fondation', 'foundation', 'stiftung', 'verein', 'feinkost',
  'getranke', 'arzt', 'physio', 'therapie', 'construcciones', 'brouwerij', 'transport', 'joinery', 'plumbing',
  'moebel', 'mobel', 'mobelhaus', 'brauerei', 'metzgerei', 'fleischerei', 'konditorei', 'optik', 'akustik', 'labor', 'klinik',
  'hausverwaltung', 'trading', 'freight', 'partners', 'associates', 'industries', 'holding', 'ventures', 'labs',
];
const COUNTRY_WORDS: Record<string, string> = {
  deutschland: 'DE', germany: 'DE', allemagne: 'DE', osterreich: 'AT', austria: 'AT', schweiz: 'CH', switzerland: 'CH',
  suisse: 'CH', svizzera: 'CH', 'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB',
  wales: 'GB', france: 'FR', frankreich: 'FR', nederland: 'NL', netherlands: 'NL', niederlande: 'NL', italia: 'IT',
  italy: 'IT', italien: 'IT', luxembourg: 'LU', luxemburg: 'LU', belgien: 'BE', belgium: 'BE', belgique: 'BE',
  belgie: 'BE', usa: 'US', 'united states': 'US', 'united states of america': 'US', spain: 'ES', espana: 'ES',
  spanien: 'ES', polska: 'PL', poland: 'PL', polen: 'PL', danmark: 'DK', denmark: 'DK', danemark: 'DK',
  liechtenstein: 'LI', ireland: 'IE', irland: 'IE', portugal: 'PT', sverige: 'SE', sweden: 'SE', schweden: 'SE',
};
const PHONE_PREFIX: [string, string][] = [
  ['352', 'LU'], ['423', 'LI'], ['353', 'IE'], ['351', 'PT'], ['49', 'DE'], ['43', 'AT'], ['41', 'CH'], ['44', 'GB'],
  ['33', 'FR'], ['31', 'NL'], ['39', 'IT'], ['32', 'BE'], ['34', 'ES'], ['48', 'PL'], ['45', 'DK'], ['46', 'SE'], ['1', 'US'],
];
const TLD: Record<string, string> = {
  de: 'DE', at: 'AT', ch: 'CH', fr: 'FR', nl: 'NL', it: 'IT', lu: 'LU', be: 'BE', uk: 'GB', es: 'ES', pl: 'PL',
  dk: 'DK', li: 'LI', ie: 'IE', pt: 'PT', se: 'SE',
};
const POSTCODE_PREFIX: Record<string, string> = { D: 'DE', A: 'AT', CH: 'CH', L: 'LU', B: 'BE', NL: 'NL', DK: 'DK', F: 'FR', I: 'IT', FL: 'LI' };

/** VAT id formats (EU VIES formats + GB, CH); format only, no check digit (a check is P3's VAT-id line). */
const VAT_FORMATS: Record<string, RegExp> = {
  DE: /^DE\d{9}$/, AT: /^ATU\d{8}$/, GB: /^GB(\d{9}|\d{12})$/, FR: /^FR[0-9A-Z]{2}\d{9}$/, NL: /^NL\d{9}B\d{2}$/,
  IT: /^IT\d{11}$/, LU: /^LU\d{8}$/, BE: /^BE[01]\d{9}$/, ES: /^ES[0-9A-Z]\d{7}[0-9A-Z]$/, PL: /^PL\d{10}$/,
  DK: /^DK\d{8}$/, IE: /^IE(\d{7}[A-Z]{1,2}|\d[A-Z]\d{5}[A-Z])$/, PT: /^PT\d{9}$/, SE: /^SE\d{12}$/, FI: /^FI\d{8}$/,
  CZ: /^CZ\d{8,10}$/, SK: /^SK\d{10}$/, SI: /^SI\d{8}$/, HU: /^HU\d{8}$/, RO: /^RO\d{2,10}$/, BG: /^BG\d{9,10}$/,
  HR: /^HR\d{11}$/, EE: /^EE\d{9}$/, LV: /^LV\d{11}$/, LT: /^LT(\d{9}|\d{12})$/, MT: /^MT\d{8}$/, CY: /^CY\d{8}[A-Z]$/,
  EL: /^EL\d{9}$/, CHE: /^CHE\d{9}(MWST|TVA|IVA)?$/,
};
const VAT_KEYWORD = /(ust[\s.-]*id|ust\.?-?nr|umsatzsteuer|\buid\b|\bvat\b|\btva\b|\bbtw\b|p\.?\s?iva|\bmwst\b|\bnif\b|\bnip\b|\bmoms\b|vat reg)/i;

const PHONE_LABEL =
  /^(?:tel(?:efon|ephone)?|fon|phone|ph|t|m|mob|mobil|mobile|handy|cell|tél|tel\.?\s?mobil|zentrale|hotline|büro|office|direkt|durchwahl|termine|ruf\w*(?:\s+24\s*h)?|☎|📞|✆)\.?\s*:?\s*(?=[+(\d]|[Ool][\dOol])/i;
const FAX_LABEL = /^(?:fax|telefax|f)\.?\s*:?\s*(?=[+(\d])/i;
const FAX_ANYWHERE = /\b(?:tele)?fax\b/i;
const GREETING =
  /(gr(ü|u)(ß|ss)e|\bgru(ß|ss)\b|regards|cordialement|sincerely|cheers|thanks|danke|^best,?$|^--+$|^sehr geehrte|^dear\b|^hallo\b|^hi\b|^liebe[rs]?\b|^mfg\b|^lg\b|^vg\b)/i;
const LEGAL_TEXT =
  /(amtsgericht|registergericht|handelsgericht|\bhr[ab]\b|\bvr\s?\d|^sitz\b|\bsitz:|steuer[\s.-]*(nr|nummer|id)|steuernr|st\.?-?nr|\biban\b|\bbic\b|\bbank|sparkasse|volksbank|raiffeisen|aufsichtsrat|gesellschafter|vorsitzende|gesch(ä|a)ftsf(ü|u)hr|vorstand:|company no|registered in|reg\.? no|\bfn\s?\d|\bik\s?\d|vertraulich|confidential|disclaimer|datenschutz|privacy|öffnungszeiten|opening hours|\buhr\b|^mo[\s.-]|^sa\s\d)/i;
const CONTACT_LABEL = /^(inh\.|inhaber(in)?|ihre?\s+ansprechpartner(in)?|ihre?\s+kontakt|ansprechpartner(in)?|kontakt(person)?|contact|pflegedienstleitung|leitung|z\.\s?hd\.?|attn\.?)\s*:?\s*/i;
const TITLE_KEEP = /^(Prof\.\s?Dr\.(\s?med\.)?|Dr\.\s?(med\.|rer\.\s?nat\.|jur\.|phil\.|-Ing\.)?|Prof\.|Mag\.|Mag\.a)\s*/;
const TITLE_DROP = /^(i\.\s?A\.|i\.\s?V\.|ppa\.|Herrn?|Frau|Mr\.?|Mrs\.?|Ms\.?|Dipl\.-\w+\.?|Dipl\.\s?\w+\.?|Ing\.|RA(in)?|StB|WP|B\.\s?Sc\.|M\.\s?Sc\.|Inh\.)\s+/;
/** Job titles: a line made of them describes a person's role, never the company (folded, word end). */
const ROLES = [
  'sachverstandiger', 'sachverstandige', 'berater', 'beraterin', 'hebamme', 'meister', 'meisterin', 'manager', 'managerin',
  'director', 'direktor', 'direktorin', 'leiter', 'leiterin', 'referent', 'referentin', 'assistent', 'assistentin',
  'consultant', 'developer', 'designer', 'designerin', 'architekt', 'architektin', 'ingenieur', 'ingenieurin', 'anwalt',
  'anwaltin', 'therapeut', 'therapeutin', 'lehrer', 'lehrerin', 'pastor', 'pastorin', 'pfarrer', 'pfarrerin', 'ceo',
  'cto', 'cfo', 'owner', 'founder', 'grunder', 'grunderin', 'ubersetzer', 'ubersetzerin', 'fotograf', 'fotografin',
  'makler', 'maklerin', 'sales', 'vertriebsleiter',
];
const FREEMAIL = /^(gmx|web|gmail|googlemail|t-online|posteo|outlook|hotmail|live|yahoo|icloud|me|mac|aol|mail|freenet|protonmail|proton|arcor|online|email|kabelmail|vodafone|mailbox)$/;
const PARTICLES = new Set(['von', 'van', 'de', 'der', 'den', 'di', 'da', 'zu', 'del', 'della', 'le', 'la', 'du', 'ten', 'ter', 'vom', 'zum', 'und']);
const DATE = /\b\d{1,2}\.\s?\d{1,2}\.\s?\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\.\s+(januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember)\b/i;
const REGISTER_TOKEN = /\b(HRB|HRA|VR|FN|IK|Nr|No|PLZ|Seite|Page|Rechnung|Invoice|Angebot|Kunde|Konto)\b/i;

const SEPARATORS = /\s+[·•–—]\s+|\s*[|]\s*|\s+[·•]\s*|\s*[·•]\s+/;
const UK_POSTCODE = '[A-Z]{1,2}\\d[A-Z\\d]?\\s?\\d[A-Z]{2}';
const CITY = "\\p{Lu}[\\p{L}.'()/ -]*?[\\p{L}.)]";

const RE_DE5 = new RegExp(`^(?:(D|F|I)[-\\s])?(\\d{5})\\s*(${CITY})$`, 'u');
const RE_4 = new RegExp(`^(?:(A|CH|L|B|DK|FL)[-\\s])?(\\d{4})\\s+(${CITY})$`, 'u');
const RE_NL = new RegExp(`^(?:NL[-\\s])?(\\d{4}\\s?[A-Z]{2})\\s+(${CITY})$`, 'u');
const RE_UK = new RegExp(`^(${CITY})\\s+(${UK_POSTCODE})$`, 'u');
const RE_PL = new RegExp(`^(?:PL[-\\s])?(\\d{2}-\\d{3})\\s+(${CITY})$`, 'u');
const RE_IE = new RegExp(`^(${CITY})\\s+((?:[AC-FHKNPRTV-Y]\\d{2}|D6W)\\s?[0-9AC-FHKNPRTV-Y]{4})$`, 'u');
const RE_US = new RegExp(`^(\\p{Lu}[\\p{L}.' -]*,\\s*[A-Z]{2})\\s+(\\d{5}(?:-\\d{4})?)$`, 'u');

// ---------------------------------------------------------------------------------------------------------
// Small helpers

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const digits = (s: string) => s.replace(/\D/g, '');
const words = (s: string) => s.split(/\s+/).filter(Boolean);

/** OCR fixes that are safe everywhere: "Bahnhofstr.3" → "Bahnhofstr. 3", "35390Gießen" → "35390 Gießen". */
function tidy(line: string): string {
  return collapse(
    line
      .replace(/^[^\p{L}\p{N}+(]+/u, '') // leading icons, bullets and "@ "
      .replace(/([a-zäöüß]\.)(\d)/g, '$1 $2')
      .replace(/^((?:[A-Z]{1,2}-)?\d{5})(\p{Lu})/u, '$1 $2')
      .replace(/^((?:[A-Z]{1,2}-)?)([\dOo]{5})(?=\s)/, (_m, p: string, code: string) =>
        (code.match(/\d/g)?.length ?? 0) >= 3 ? p + code.replace(/[Oo]/g, '0') : p + code)
  );
}

/** Phone digits that OCR read as letters: l/I/| → 1, O/o → 0, only between digit-like characters. */
function fixPhoneOcr(s: string): string {
  return s
    .replace(/(?<=[\d\s/()+-])[lI|](?=[\d\s/()-])|(?<=[\d\s/()+-])[lI|]$|^[lI|](?=[\dOo])/g, '1')
    .replace(/(?<=[\d\s/()+-])[Oo](?=[\d\s/()-])|^[Oo](?=[\dlI])/g, '0');
}

/** The phone number at the start of `s`, or '' (6-16 digits, not a date). */
function phoneAt(s: string): string {
  const fixed = fixPhoneOcr(s);
  const m = /^\+?\s?(?:\(\s?\+?\d[\d\s]*\)\s?)?[\d(][\d\s()/.\-–]*\d/.exec(fixed);
  if (!m) return '';
  const value = m[0].trim();
  const rest = fixed.slice(m[0].length).trim();
  if (rest && /^[\p{L}]/u.test(rest) && !/^(ext|durchwahl|dw)\b/i.test(rest)) return '';
  const n = digits(value).length;
  if (n < 6 || n > 16 || DATE.test(value)) return '';
  if (/^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(value)) return '';
  return value;
}

function titleCase(s: string): string {
  return s.replace(/\p{L}[\p{L}'-]*/gu, (w) => (PARTICLES.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0) + w.slice(1).toLowerCase()));
}

const isAllCaps = (s: string) => /\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s);

function isBusinessName(text: string): boolean {
  if (LEGAL_FORM.test(text) || FAMILY_FIRM.test(text)) return true;
  const tokens = words(text);
  if (tokens.length < 2 || /\d/.test(text) || text.length > 60) return false;
  // "Thomas Neuhaus" is a person even though "haus" is a business word.
  if (tokens.length <= 3 && FIRST_NAMES.has(fold(tokens[0]).replace(/-.*/, ''))) return false;
  // A business word ends a word ("Kfz-Meisterwerkstatt", "Gartenbau"); long ones may also start it
  // ("Immobilienmakler"). Never inside a surname ("Baumann", "Hofmann").
  return fold(text)
    .split(/[\s-]+/)
    .some((word) => BUSINESS_WORDS.some((w) => word.endsWith(w) || (w.length >= 6 && word.startsWith(w))));
}

/** The person's name in `text` (titles Dr./Prof./Mag. kept, others dropped), or ''. */
function personName(text0: string, emailLocal: string): string {
  // "Robert Chen, VP Sales", "Wolfgang Pichler, BSc": the name is before the comma.
  const text = text0.includes(',') ? text0.split(',')[0].trim() : text0;
  if (/[\d@]/.test(text) || text.length > 48 || isBusinessName(text) || isRole(text)) return '';
  if (text.includes('&')) {
    const parts = text.split(/\s*&\s*/);
    const people = parts.map((p) => personName(p, emailLocal));
    return people.every(Boolean) ? people.join(' & ') : '';
  }
  let rest = text.trim();
  let titled = false;
  let keep = '';
  for (let i = 0; i < 3; i++) {
    const drop = TITLE_DROP.exec(rest);
    if (drop) {
      rest = rest.slice(drop[0].length);
      titled = true;
      continue;
    }
    const k = TITLE_KEEP.exec(rest);
    if (k && k[0].trim()) {
      keep += `${k[0].trim()} `;
      rest = rest.slice(k[0].length);
      titled = true;
      continue;
    }
    break;
  }
  const tokens = words(rest);
  if (tokens.length < 2 || tokens.length > 4) return '';
  if (!tokens.every((t) => /^\p{Lu}[\p{L}'.-]*$/u.test(t) || PARTICLES.has(t))) return '';
  if (/\.$/.test(tokens[tokens.length - 1]) || /^(familie|family|team)$/i.test(tokens[0])) return '';
  const first = fold(tokens[0]).replace(/-.*/, '');
  const last = tokens[tokens.length - 1];
  const local = fold(emailLocal).replace(/[^a-z]/g, ' ');
  const inLocal = (w: string) => w.length >= 3 && (local.includes(fold(w)) || local.includes(germanTranslit(w)));
  // The e-mail's local part names the person ("t.mueller@", "menno@"): a strong hint without the name list.
  const emailHit = inLocal(last) || (first.length >= 3 && local.split(' ').includes(first));
  if (!(FIRST_NAMES.has(first) || titled || emailHit)) return '';
  const name = isAllCaps(rest) ? titleCase(rest) : rest;
  return collapse(keep + name);
}

function isRole(text: string): boolean {
  return fold(text)
    .split(/[\s,/|-]+/)
    .some((w) => ROLES.some((r) => w === r || (r.length >= 6 && w.endsWith(r))));
}

/** The e-mail domain without its top level ("weber-metallbau"), or '' for free-mail providers. */
function companyDomain(email: string): string {
  const host = email.split('@')[1] ?? '';
  const labels = host.split('.');
  const main = labels.length >= 3 && /^(co|com|org|ac)$/.test(labels[labels.length - 2]) ? labels[labels.length - 3] : labels[labels.length - 2] ?? '';
  return FREEMAIL.test(main) ? '' : main;
}

/** Company score: legal form 100; the e-mail domain spells the line 50; a business word 10; a job title rules it out. */
function companyScore(text: string, domain: string): number {
  if (LEGAL_FORM.test(text)) return 100;
  if (!isBusinessName(text) && !(domain && words(text).length >= 2)) return 0;
  if (isRole(text) && !LEGAL_FORM.test(text)) return 0;
  let score = isBusinessName(text) ? 10 : 0;
  if (domain) {
    const compact = (w: string) => fold(w).replace(/[^a-z0-9]/g, '');
    const line = compact(text);
    const lineDe = germanTranslit(text).replace(/[^a-z0-9]/g, '');
    const dom = compact(domain);
    if (line.length >= 5 && (dom.includes(line) || dom.includes(lineDe) || line.includes(dom))) score += 50;
  }
  return score;
}

function germanTranslit(word: string): string {
  return word.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
}

function isStreet(text: string): boolean {
  if (REGISTER_TOKEN.test(text) || DATE.test(text) || text.length > 60) return false;
  if (/^(Postfach|PO Box|P\.O\. Box|Case postale|BP)\s+\d[\d\s]*$/i.test(text)) return true;
  // Name + house number ("Lindenstraße 12", "An der Kirche 2", "Industriestr. 22-24", "Rosenthaler Str. 40/41").
  if (/^\p{Lu}[\p{L}.'-]*(?:\s+[\p{L}.'-]+)*\s+\d{1,4}\s?[a-zA-Z]?(?:\s?[-/]\s?\d{1,4}[a-zA-Z]?)?$/u.test(text)) return true;
  // House number first ("14 Camden High Street", "15, avenue de la Liberté", "1200 Market Street, Suite 400").
  if (/^\d{1,5}[a-zA-Z]?,?\s+\p{L}[\p{L}.' -]*(?:,\s*[\p{L}\d .'-]+)?$/u.test(text)) return true;
  // Polish "ul. Długa 15"; "Unit 3 Riverside Business Park"
  if (/^(ul\.|al\.|pl\.|os\.)\s+\p{Lu}[\p{L} .'-]*\s+\d{1,4}[a-zA-Z]?(?:\/\d{1,4})?$/u.test(text)) return true;
  if (/^(Unit|Flat|Suite|Apt\.?|Building|Block)\s+\d{1,4}[a-zA-Z]?,?\s+\p{Lu}[\p{L} .'-]*$/u.test(text)) return true;
  // "Unit 7, Dockside Park"
  return /^\p{Lu}\p{L}*\s+\d{1,4}[a-zA-Z]?,\s+\p{Lu}[\p{L} .'-]*$/u.test(text);
}

type Address = { postalCode: string; city: string; country: string };

function postcodeCity(text: string): Address | null {
  let m = RE_US.exec(text);
  if (m) return { city: m[1], postalCode: m[2], country: 'US' };
  m = RE_UK.exec(text);
  if (m && !/\d/.test(m[1])) return { city: m[1], postalCode: m[2].replace(/^(\S+?)(\d[A-Z]{2})$/, '$1 $2'), country: 'GB' };
  m = RE_IE.exec(text);
  if (m && !/\d/.test(m[1])) return { city: m[1], postalCode: m[2].replace(/^(\S{3})(\S{4})$/, '$1 $2'), country: 'IE' };
  m = RE_PL.exec(text);
  if (m && !/\d/.test(m[2])) return { postalCode: m[1], city: cleanCity(m[2]), country: 'PL' };
  m = RE_NL.exec(text);
  if (m) return { postalCode: m[1].replace(/^(\d{4})([A-Z]{2})$/, '$1 $2'), city: m[2], country: 'NL' };
  m = RE_DE5.exec(text);
  if (m && !/\d/.test(m[3])) return { postalCode: m[2], city: cleanCity(m[3]), country: m[1] ? POSTCODE_PREFIX[m[1]] : '' };
  m = RE_4.exec(text);
  if (m && !/\d/.test(m[3])) return { postalCode: m[2], city: cleanCity(m[3]), country: m[1] ? POSTCODE_PREFIX[m[1]] : '' };
  return null;
}

const cleanCity = (c: string) => collapse(c.replace(/[,;:]+$/, ''));

/** VAT id in a segment: keyword lines may space the digits ("DE 812 345 678"); other lines only compact ids. */
function vatIn(text: string): string {
  if (/\biban\b/i.test(text)) return '';
  const keyword = VAT_KEYWORD.test(text);
  const re = /\b(ATU|CHE|DE|GB|FR|NL|IT|LU|BE|ES|PL|DK|IE|PT|SE|FI|CZ|SK|SI|HU|RO|BG|HR|EE|LV|LT|MT|CY|EL)(?=[\s.:-]?[0-9A-Z])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const prefix = m[1];
    const tail = text.slice(m.index + prefix.length);
    const tokens = tail.match(/^[\s.:-]*([0-9A-Z]+(?:[\s.-][0-9A-Z]+)*)/);
    if (!tokens) continue;
    const parts = tokens[1].split(/[\s.-]/);
    if (!keyword && parts.length > 1 && !/^\d+$/.test(parts[0])) continue;
    for (let n = parts.length; n >= 1; n--) {
      if (!keyword && n > 1) continue;
      const candidate = prefix + parts.slice(0, n).join('');
      const country = prefix === 'ATU' ? 'AT' : prefix === 'CHE' ? 'CHE' : prefix;
      if (VAT_FORMATS[country]?.test(candidate)) return candidate;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------------------------------------
// Segmenting

function segmentLine(raw: string): string[] {
  const line = tidy(raw);
  if (!line) return [];
  const out: string[] = [];
  for (const part0 of line.split(SEPARATORS)) {
    const part = collapse(part0.replace(/^(registered office|postanschrift|anschrift|adresse|address|sitz der gesellschaft)\s*:\s*/i, ''));
    if (!part) continue;
    if (postcodeCity(part) || DATE.test(part) || /^\S.*,\s+(den|am)\s/.test(part)) {
      out.push(part); // "San Francisco, CA 94102" and "Erfurt, 12.10.2026" stay whole
      continue;
    }
    // "Company GmbH, Street 1, 12345 Town, Amtsgericht …": the comma piece with the postcode is its own segment,
    // a leading company piece too; the pieces before the postcode stay together as the street ("Unit 7, Dockside Park").
    const pieces = part.split(/,\s+/);
    const k = pieces.findIndex((p, i) => i > 0 && postcodeCity(p));
    if (k < 0) {
      out.push(part);
      continue;
    }
    let head = pieces.slice(0, k);
    if (head.length > 1 && isBusinessName(head[0])) {
      out.push(head[0]);
      head = head.slice(1);
    }
    out.push(head.join(', '), pieces[k], ...pieces.slice(k + 1));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Parse

export type ParseContactOptions = { own?: OwnBusiness };
export type ContactParse = { fields: ContactFields; /** the cleaned lines, for "recognised text" */ lines: string[] };

export function parseContactText(input: readonly string[] | string, options: ParseContactOptions = {}): ContactParse {
  const rawLines = (typeof input === 'string' ? input.split(/\r?\n/) : input).map(collapse);
  const lines = rawLines.filter((l) => l.length > 0);
  const segs: Seg[] = [];
  lines.forEach((l, i) => segmentLine(l).forEach((text) => segs.push({ text, line: i, used: false })));
  const fields: ContactFields = { ...EMPTY_CONTACT };

  markOwnBlock(segs, lines, options.own);

  // E-mail (first one), web addresses.
  for (const s of segs) {
    if (s.used) continue;
    const m = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:[.,][A-Za-z0-9-]+)*[.,][A-Za-z]{2,}/.exec(s.text);
    if (m) {
      const email = m[0].replace(/,(?=[A-Za-z]{2,}$)/, '.').replace(/,/g, '.').toLowerCase();
      if (!fields.email) fields.email = email;
      s.used = true;
      continue;
    }
    if (/^(web:?\s*|internet:?\s*)?(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(s.text) && !/\s/.test(s.text.replace(/^(web|internet):?\s*/i, ''))) {
      s.used = true;
    }
  }
  const emailLocal = fields.email.split('@')[0] ?? '';

  // VAT id. A keyword line with digits but no country prefix ("VAT No. 345 6789 01") gets the address's country later.
  let bareVat = '';
  for (const s of segs) {
    if (s.used) continue;
    const vat = vatIn(s.text);
    if (vat) {
      if (!fields.vatId) fields.vatId = vat;
      s.used = true;
    } else if (VAT_KEYWORD.test(s.text) && /\d/.test(s.text)) {
      const bare = /(?:^|[\s:.])(\d[\d .]{6,16}\d)\s*$/.exec(s.text);
      if (bare && !bareVat) bareVat = bare[1].replace(/[\s.]/g, '');
      s.used = true; // a VAT line: never a phone
    }
  }

  // Phone (first one that is not a fax), fax lines consumed.
  for (const s of segs) {
    if (s.used) continue;
    const fax = FAX_LABEL.exec(s.text);
    if (fax || (FAX_ANYWHERE.test(s.text) && /\d{3}/.test(s.text))) {
      s.used = true;
      continue;
    }
    if (LEGAL_TEXT.test(s.text) && !/^ruf/i.test(s.text)) continue;
    let value = '';
    const label = PHONE_LABEL.exec(s.text);
    if (label) value = phoneAt(s.text.slice(label[0].length));
    else {
      const colon = /^([\p{L} .\d-]{1,30}?)\s*:\s*(.+)$/u.exec(s.text);
      if (
        colon &&
        /(tel|fon|phone|ruf|mobil|handy|termin|hotline|zentrale|büro|office|enquir|anfrage|bestell|service|support|kontakt|contact|notdienst|reservier|auftr)/i.test(colon[1]) &&
        !/(nr\b|nummer|number|\bno\b|datum|date|konto|kunden|iban)/i.test(colon[1])
      )
        value = phoneAt(colon[2]);
      else if (/^[+(\d][\d\s()/.\-–]+$/.test(fixPhoneOcr(s.text))) value = phoneAt(s.text);
    }
    if (value) {
      if (!fields.phone) fields.phone = value;
      s.used = true;
    }
  }

  // Postcode + town (first one), street next to it.
  let addressAt = -1;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.used) continue;
    const a = postcodeCity(s.text);
    if (!a) continue;
    fields.postalCode = a.postalCode;
    fields.city = a.city;
    fields.countryCode = a.country;
    s.used = true;
    addressAt = i;
    break;
  }
  if (addressAt >= 0) {
    const at = segs[addressAt];
    for (let j = addressAt - 1; j >= 0; j--) {
      const s = segs[j];
      if (at.line - s.line > 4) break;
      if (s.used) continue;
      if (isStreet(s.text)) {
        fields.street = s.text;
        s.used = true;
        break;
      }
    }
  }

  // Country.
  if (fields.postalCode) {
    const evidence = countryEvidence(segs, fields);
    if (!fields.countryCode) fields.countryCode = evidence || (/^\d{5}$/.test(fields.postalCode) ? 'DE' : '');
  }
  if (!fields.vatId && bareVat) {
    const country = fields.countryCode || (/^\+?49|^0(?!0)/.test(fields.phone.replace(/[\s()/-]/g, '')) ? 'DE' : '');
    const prefix = country === 'AT' ? 'ATU' : country === 'GR' ? 'EL' : country;
    if (prefix && VAT_FORMATS[country === 'AT' ? 'AT' : prefix]?.test(prefix + bareVat)) fields.vatId = prefix + bareVat;
  }

  // Names. Without any contact detail the text is not a contact (an invoice, opening hours...).
  const hasContactDetail = Boolean(fields.email || fields.phone || fields.postalCode || fields.vatId);
  const domain = companyDomain(fields.email);
  let company = '';
  let companyBest = 0;
  let person = '';
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.used) continue;
    const text = s.text;
    if (GREETING.test(text) || DATE.test(text) || words(text).length > 7) continue;
    if (COUNTRY_WORDS[fold(text)]) continue;
    const label = CONTACT_LABEL.exec(text);
    if (label) {
      const restText = text.slice(label[0].length).trim();
      const named = restText ? personName(restText, emailLocal) : '';
      const next = !restText ? segs.slice(i + 1).find((n) => !n.used) : undefined;
      const fromNext = next ? personName(next.text, emailLocal) : '';
      if (!person && (named || fromNext)) {
        person = named || fromNext;
        if (next && fromNext) next.used = true;
      }
      continue;
    }
    if (LEGAL_TEXT.test(text)) continue;
    const asPerson = personName(text, emailLocal);
    const score = asPerson && !LEGAL_FORM.test(text) ? 0 : companyScore(text, domain);
    if (score > 0) {
      if (score > companyBest) {
        company = text;
        companyBest = score;
      } else if (isAllCaps(company) && fold(company) === fold(text) && !isAllCaps(text)) company = text;
      continue;
    }
    if (!person) person = asPerson;
  }
  const companyLegal = companyBest >= 100;
  if (company && isAllCaps(company)) {
    const mixed = segs.find((s) => fold(s.text) === fold(company) && !isAllCaps(s.text));
    if (mixed) company = mixed.text;
  }
  if (hasContactDetail || companyLegal) {
    if (company) {
      fields.kind = 'business';
      fields.name = company;
      fields.contact = person && fold(person) !== fold(company) ? person : '';
    } else if (person) {
      fields.kind = 'person';
      fields.name = person;
    }
  }
  if (!hasContactDetail && !companyLegal) return { fields: { ...EMPTY_CONTACT }, lines };
  return { fields, lines };
}

/** Country from a country line, the VAT id, the phone prefix, then the e-mail domain. */
function countryEvidence(segs: Seg[], fields: ContactFields): string {
  for (const s of segs) {
    if (s.line < 0) continue;
    const code = COUNTRY_WORDS[fold(s.text).replace(/[.,]$/, '')];
    if (code && !(s as Seg & { own?: boolean }).own) return code;
  }
  if (fields.vatId) {
    const p = fields.vatId.slice(0, 2);
    return p === 'EL' ? 'GR' : p;
  }
  const phone = fields.phone.replace(/[\s()/.-]/g, '');
  const intl = /^(?:\+|00)(\d+)/.exec(phone);
  if (intl) for (const [prefix, code] of PHONE_PREFIX) if (intl[1].startsWith(prefix)) return code;
  const tld = /\.([a-z]{2})$/.exec(fields.email)?.[1];
  return tld ? (TLD[tld] ?? '') : '';
}

/** Marks the user's own address block (a letter's recipient window) as used, so nothing is read from it. */
function markOwnBlock(segs: Seg[], lines: string[], own: OwnBusiness | undefined): void {
  if (!own) return;
  const eq = (a: string, b: string | undefined) => !!b && b.trim().length >= 3 && fold(collapse(a)) === fold(collapse(b));
  const ownLines = new Set<number>();
  lines.forEach((l, i) => {
    if (!(eq(l, own.name) || eq(l, own.street))) return;
    let start = i;
    while (start > 0 && i - start < 2 && /^(herrn?|frau|firma|an|z\.\s?hd\.?.*|attn\.?.*)$/i.test(lines[start - 1].trim())) start--;
    let end = i;
    for (let j = i; j < Math.min(lines.length, i + 5); j++) {
      end = j;
      if (postcodeCity(tidy(lines[j]))) break;
    }
    if (end + 1 < lines.length && COUNTRY_WORDS[fold(lines[end + 1].trim())]) end++;
    for (let j = start; j <= end; j++) ownLines.add(j);
  });
  for (const s of segs) {
    if (ownLines.has(s.line) || eq(s.text, own.street) || (own.email && fold(s.text).includes(fold(own.email)))) {
      s.used = true;
      (s as Seg & { own?: boolean }).own = true;
    }
  }
}
