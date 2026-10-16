// Legal notes on documents (D21, SPEC F6): data, DE + EN, each with its official source. PURE.
// They are information printed on the document and pre-filled into the user-editable `legal_note`
// field; the app never says a document is compliant or gives tax advice (wording test in notes.test.ts).
// Texts from RESEARCH §2.1 (sources read on 2026-10-01). Sources marked `research: false` were added in P2
// from the law's structure and are linked to the official text so the owner can read them (V1_LOG P2).
import type { Lang } from './money';
import type { Treatment, VatMode } from './treatment';

export type NoteId = 'small_business' | 'reverse_charge' | 'intra_eu_goods' | 'export' | 'exempt';
export const NOTE_IDS: readonly NoteId[] = ['small_business', 'reverse_charge', 'intra_eu_goods', 'export', 'exempt'];

export type LegalSource = {
  /** Short citation shown in the app: "§ 19 UStG". Same in both languages (German law). */
  law: string;
  url: string;
  /** true = this source was read during the spec research (RESEARCH §2.1). */
  research: boolean;
};

export type LegalNote = {
  id: NoteId;
  text: Record<Lang, string>;
  /** What the note is about, for the settings/check screen. */
  title: Record<Lang, string>;
  sources: LegalSource[];
  /** True when the default text contains a [placeholder] the user fills in (check item until filled). */
  needsInput: boolean;
};

const GII = 'https://www.gesetze-im-internet.de';

export const SOURCES = {
  ustg14: { law: '§ 14 Abs. 4 UStG', url: `${GII}/ustg_1980/__14.html`, research: true },
  ustg14a: { law: '§ 14a UStG', url: `${GII}/ustg_1980/__14a.html`, research: true },
  ustg14b: { law: '§ 14b UStG', url: `${GII}/ustg_1980/__14b.html`, research: true },
  // read 2026-10-02 (v1.1): tax shown above what is owed is owed (Abs. 1)
  ustg14c: { law: '§ 14c UStG', url: `${GII}/ustg_1980/__14c.html`, research: true },
  ustg19: { law: '§ 19 UStG', url: `${GII}/ustg_1980/__19.html`, research: true },
  ustdv31: { law: '§ 31 UStDV', url: `${GII}/ustdv_1980/__31.html`, research: true },
  ustdv33: { law: '§ 33 UStDV', url: `${GII}/ustdv_1980/__33.html`, research: true },
  ustdv34a: { law: '§ 34a UStDV', url: `${GII}/ustdv_1980/__34a.html`, research: true },
  // Re-read on gesetze-im-internet.de 2026-10-02 (v1.1, review #15; L11 P2 row closed): § 4 Nr. 1a/1b exempts export
  // deliveries (§ 6) and intra-EU supplies (§ 6a); § 6 = Ausfuhrlieferung (goods to the third country); § 6a =
  // innergemeinschaftliche Lieferung (needs the buyer's valid VAT ID of another member state); § 13b = recipient as
  // tax debtor (context for the reverse-charge note, whose phrase comes from § 14a Abs. 5).
  ustg4: { law: '§ 4 UStG', url: `${GII}/ustg_1980/__4.html`, research: true },
  ustg6: { law: '§ 6 UStG', url: `${GII}/ustg_1980/__6.html`, research: true },
  ustg6a: { law: '§ 6a UStG', url: `${GII}/ustg_1980/__6a.html`, research: true },
  ustg13b: { law: '§ 13b UStG', url: `${GII}/ustg_1980/__13b.html`, research: true },
} as const satisfies Record<string, LegalSource>;

export const LEGAL_NOTES: Record<NoteId, LegalNote> = {
  small_business: {
    id: 'small_business',
    title: { de: 'Kleinunternehmerregelung (§ 19 UStG)', en: 'Small business scheme (§ 19 UStG)' },
    // RESEARCH §2.1: the law prescribes no exact wording; § 34a UStDV (re-read 2026-10-02) asks for a note that the
    // small-business EXEMPTION applies (since the 2025 reform § 19 is an exemption). v1.1 default follows that wording
    // (review #17); the v1.0 text stays recognised as the app's own (LEGACY_NOTE_TEXTS).
    text: {
      de: 'Für diese Leistung gilt die Steuerbefreiung für Kleinunternehmer (§ 19 UStG).',
      en: 'This supply is exempt from VAT under the small business scheme (§ 19 UStG).',
    },
    sources: [SOURCES.ustg19, SOURCES.ustdv34a],
    needsInput: false,
  },
  reverse_charge: {
    id: 'reverse_charge',
    title: { de: 'Steuerschuldnerschaft des Leistungsempfängers', en: 'Reverse charge' },
    // §14a Abs. 5 UStG names the exact phrase; the English text keeps it in brackets.
    text: {
      de: 'Steuerschuldnerschaft des Leistungsempfängers.',
      en: 'Reverse charge: VAT is payable by the recipient (Steuerschuldnerschaft des Leistungsempfängers).',
    },
    sources: [SOURCES.ustg14a, SOURCES.ustg13b],
    needsInput: false,
  },
  intra_eu_goods: {
    id: 'intra_eu_goods',
    title: { de: 'Innergemeinschaftliche Lieferung', en: 'Intra-EU supply of goods' },
    text: {
      de: 'Steuerfreie innergemeinschaftliche Lieferung.',
      en: 'VAT-exempt intra-Community supply of goods (steuerfreie innergemeinschaftliche Lieferung).',
    },
    sources: [SOURCES.ustg14a, SOURCES.ustg6a],
    needsInput: false,
  },
  export: {
    id: 'export',
    title: { de: 'Ausfuhrlieferung (außerhalb der EU)', en: 'Export outside the EU' },
    text: {
      de: 'Steuerfreie Ausfuhrlieferung.',
      en: 'VAT-exempt export delivery (steuerfreie Ausfuhrlieferung).',
    },
    sources: [SOURCES.ustg14, SOURCES.ustg4, SOURCES.ustg6],
    needsInput: false,
  },
  exempt: {
    id: 'exempt',
    title: { de: 'Steuerbefreiung / nicht steuerbar', en: 'VAT exemption / not taxable in Germany' },
    // §14 Abs. 4 Satz 1 Nr. 8 UStG: a note that an exemption applies; the reason is the user's.
    text: {
      de: 'Umsatzsteuerfrei: [Befreiungsgrund ergänzen, z. B. § 4 Nr. … UStG]',
      en: 'Exempt from VAT: [add the reason, e.g. § 4 Nr. … UStG]',
    },
    sources: [SOURCES.ustg14, SOURCES.ustg4],
    needsInput: true,
  },
};

/** Earlier default texts: still treated as the app's own note when a draft's treatment or §19 mode changes (D60). */
export const LEGACY_NOTE_TEXTS: readonly string[] = [
  'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
  'No VAT is charged under the small business scheme (§ 19 UStG).',
];

/** Which note a document needs: one per non-standard treatment; standard + §19 mode → the §19 note. */
export function noteIdFor(treatment: Treatment, vatMode: VatMode): NoteId | null {
  if (treatment === 'standard') return vatMode === 'small_business' ? 'small_business' : null;
  return treatment;
}

/** Default `legal_note` text for a new document ('' when none is needed). */
export function defaultLegalNote(treatment: Treatment, vatMode: VatMode, lang: Lang): string {
  const id = noteIdFor(treatment, vatMode);
  return id ? LEGAL_NOTES[id].text[lang] : '';
}

/**
 * §14 Abs. 4 Satz 1 Nr. 9 UStG: in the cases of §14b Abs. 1 Satz 5 (taxable work supplies or other services in
 * connection with a property, §14 Abs. 2 Satz 2 Nr. 3, to a private recipient) the invoice states the
 * recipient's retention duty: two years (§14b Abs. 1, both read 2026-10-01). The app cannot tell construction
 * work from other work, so the business switches it on (setting `retention_note`) and new invoices for
 * private clients get it appended to the editable note (D55, review #8).
 */
export const RETENTION_NOTE = {
  title: { de: 'Hinweis auf die Aufbewahrungspflicht (Bauleistungen an Privatkunden)', en: 'Retention note (construction work for private clients)' },
  text: {
    de: 'Hinweis: Diese Rechnung, ein Zahlungsbeleg oder eine andere beweiskräftige Unterlage ist vom Leistungsempfänger zwei Jahre aufzubewahren (§ 14b Abs. 1 UStG).',
    en: 'Note: the recipient keeps this invoice, a payment record or other conclusive document for two years (§ 14b Abs. 1 UStG).',
  } as Record<Lang, string>,
  sources: [SOURCES.ustg14, SOURCES.ustg14b] as LegalSource[],
};

/** The legal note with the retention note appended once (D55). */
export function withRetentionNote(note: string, lang: Lang): string {
  const text = RETENTION_NOTE.text[lang];
  if (note.includes(text)) return note;
  return note.trim() ? `${note.trimEnd()}\n${text}` : text;
}

/** A [placeholder] left in a note (e.g. the exemption reason) — check item until the user fills it in. */
export function hasPlaceholder(text: string): boolean {
  return /\[[^\]]*\]/.test(text);
}

