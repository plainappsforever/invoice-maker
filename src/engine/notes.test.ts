import { dictionaries } from '@/i18n';

import { defaultLegalNote, hasPlaceholder, LEGAL_NOTES, NOTE_IDS, noteIdFor, RETENTION_NOTE, SOURCES, withRetentionNote } from './notes';
import { lineConflicts, lineTax, suggestTreatment, treatmentCategory, TREATMENTS } from './treatment';
import { BANNED_PHRASES, bannedIn, EINVOICE_INFO_KEYS } from './wording';

const LANGS = ['de', 'en'] as const;

describe('legal notes (D21): data with official sources', () => {
  it('one note per non-standard treatment and one for § 19, in German and English', () => {
    expect(NOTE_IDS).toEqual(['small_business', 'reverse_charge', 'intra_eu_goods', 'export', 'exempt']);
    for (const id of NOTE_IDS) {
      const note = LEGAL_NOTES[id];
      expect(note.id).toBe(id);
      for (const lang of LANGS) {
        expect(note.text[lang].trim().length).toBeGreaterThan(10);
        expect(note.title[lang].trim()).not.toBe('');
      }
      expect(hasPlaceholder(note.text.de)).toBe(note.needsInput);
      expect(hasPlaceholder(note.text.en)).toBe(note.needsInput);
    }
  });

  it('keeps the wording the sources name (RESEARCH §2.1)', () => {
    expect(LEGAL_NOTES.reverse_charge.text.de).toBe('Steuerschuldnerschaft des Leistungsempfängers.');
    // The English text keeps the German phrase §14a Abs. 5 UStG names.
    expect(LEGAL_NOTES.reverse_charge.text.en).toContain('Steuerschuldnerschaft des Leistungsempfängers');
    // § 34a UStDV: a note that the small-business exemption applies (v1.1, review #17)
    expect(LEGAL_NOTES.small_business.text.de).toBe('Für diese Leistung gilt die Steuerbefreiung für Kleinunternehmer (§ 19 UStG).');
    expect(LEGAL_NOTES.small_business.text.en).toContain('§ 19 UStG');
    expect(LEGAL_NOTES.intra_eu_goods.text.de).toBe('Steuerfreie innergemeinschaftliche Lieferung.');
    expect(LEGAL_NOTES.export.text.de).toBe('Steuerfreie Ausfuhrlieferung.');
  });

  it('every note links official sources: https on gesetze-im-internet.de, citation text, no duplicates', () => {
    for (const id of NOTE_IDS) {
      const { sources } = LEGAL_NOTES[id];
      expect(sources.length).toBeGreaterThan(0);
      expect(new Set(sources.map((s) => s.url)).size).toBe(sources.length);
      for (const s of sources) {
        const url = new URL(s.url);
        expect(url.protocol).toBe('https:');
        expect(url.hostname).toBe('www.gesetze-im-internet.de');
        expect(s.law).toMatch(/^§ \d+[a-z]?( Abs\. \d+)? (UStG|UStDV)$/);
      }
    }
    // The research-read sources (RESEARCH §2.1) carry the main citation of each note.
    expect(LEGAL_NOTES.small_business.sources[0]).toBe(SOURCES.ustg19);
    expect(LEGAL_NOTES.reverse_charge.sources[0]).toBe(SOURCES.ustg14a);
    expect(LEGAL_NOTES.intra_eu_goods.sources[0]).toBe(SOURCES.ustg14a);
    expect(LEGAL_NOTES.export.sources[0]).toBe(SOURCES.ustg14);
    expect(LEGAL_NOTES.exempt.sources[0]).toBe(SOURCES.ustg14);
    for (const id of NOTE_IDS) expect(LEGAL_NOTES[id].sources[0].research).toBe(true);
    // v1.1 (review #15): every cited page has been read, none is left unread.
    for (const s of Object.values(SOURCES)) expect([s.law, s.research]).toEqual([s.law, true]);
  });

  it('picks the note for a treatment and § 19 mode', () => {
    expect(noteIdFor('standard', 'standard')).toBeNull();
    expect(noteIdFor('standard', 'small_business')).toBe('small_business');
    expect(noteIdFor('reverse_charge', 'small_business')).toBe('reverse_charge');
    for (const t of TREATMENTS.filter((x) => x !== 'standard')) expect(noteIdFor(t, 'standard')).toBe(t);
    expect(defaultLegalNote('standard', 'standard', 'de')).toBe('');
    expect(defaultLegalNote('export', 'standard', 'en')).toBe(LEGAL_NOTES.export.text.en);
  });
});

describe('§ 14 Abs. 4 Nr. 9 retention note (D55, review #8)', () => {
  it('names the two-year retention with its source, in both languages, without advice wording', () => {
    for (const lang of LANGS) {
      expect(RETENTION_NOTE.text[lang]).toContain('§ 14b Abs. 1 UStG');
      expect(RETENTION_NOTE.text[lang]).toMatch(lang === 'de' ? /zwei Jahre/ : /two years/);
      expect(bannedIn(RETENTION_NOTE.text[lang])).toEqual([]);
      expect(bannedIn(RETENTION_NOTE.title[lang])).toEqual([]);
    }
    expect(RETENTION_NOTE.sources).toEqual([SOURCES.ustg14, SOURCES.ustg14b]);
  });

  it('is appended once, after an existing note', () => {
    expect(withRetentionNote('', 'de')).toBe(RETENTION_NOTE.text.de);
    const both = withRetentionNote(LEGAL_NOTES.small_business.text.de, 'de');
    expect(both).toBe(`${LEGAL_NOTES.small_business.text.de}\n${RETENTION_NOTE.text.de}`);
    expect(withRetentionNote(both, 'de')).toBe(both);
  });
});

describe('wording: information, never a compliance claim or advice (D21, STRATEGY.md)', () => {
  const noteTexts = NOTE_IDS.flatMap((id) => LANGS.flatMap((l) => [LEGAL_NOTES[id].text[l], LEGAL_NOTES[id].title[l]]));

  it('legal notes contain no banned phrase in either language', () => {
    for (const text of noteTexts) expect([text, bannedIn(text)]).toEqual([text, []]);
  });

  it.each(LANGS)('every %s UI string (check items, statuses, reminders, notes) is free of banned phrases', (lang) => {
    for (const [key, text] of Object.entries(dictionaries[lang])) {
      if (EINVOICE_INFO_KEYS.includes(key)) continue; // negated e-invoice info, tested in i18n.test.ts (D88)
      expect([key, bannedIn(text)]).toEqual([key, []]);
    }
  });

  it('the ban list catches compliance and advice wording in both languages', () => {
    const shouldFail = [
      'This invoice is compliant.', 'GoBD-konforme Rechnung', 'rechtssicher schreiben', 'E-Rechnung inklusive', 'XRechnung export',
      'ZUGFeRD ready', 'Send e-invoices', 'You must add your VAT ID.', 'This is a valid invoice.', 'Required by law.',
      'Sie müssen die USt-IdNr. angeben.', 'Diese Rechnung ist gültig.', 'steuerlich korrekt', 'garantiert richtig',
      'Alle Pflichtangaben vorhanden', 'All mandatory details present', 'gesetzlich vorgeschrieben',
    ];
    for (const text of shouldFail) expect([text, bannedIn(text).length > 0]).toEqual([text, true]);
    expect(BANNED_PHRASES.length).toBeGreaterThan(20);
  });

  it('the check screen says it is information, not tax advice', () => {
    expect(dictionaries.en['check.notAdvice']).toMatch(/^Information, not tax advice\./);
    expect(dictionaries.de['check.notAdvice']).toMatch(/^Information, keine Steuerberatung\./);
  });
});

describe('treatments', () => {
  it('maps treatments and § 19 mode to VAT categories (D21, D35)', () => {
    expect(treatmentCategory('standard', 'standard')).toBeNull();
    expect(treatmentCategory('standard', 'small_business')).toBe('E');
    expect(treatmentCategory('reverse_charge', 'standard')).toBe('AE');
    expect(treatmentCategory('intra_eu_goods', 'standard')).toBe('K');
    expect(treatmentCategory('export', 'standard')).toBe('G');
    expect(treatmentCategory('exempt', 'standard')).toBe('E');
    expect(lineTax('standard', 'standard', 700)).toEqual({ category: 'S', rateBp: 700 });
    expect(lineTax('standard', 'standard', 0)).toEqual({ category: 'Z', rateBp: 0 }); // not S 0 % (review #15)
    expect(lineTax('standard', 'small_business', 1900)).toEqual({ category: 'E', rateBp: 0 });
    expect(lineTax('reverse_charge', 'standard', 1900)).toEqual({ category: 'AE', rateBp: 0 });
  });

  it('flags VAT lines only where the treatment has no VAT', () => {
    expect(lineConflicts('standard', 'standard', { category: 'S', rateBp: 1900 })).toBe(false);
    expect(lineConflicts('standard', 'standard', { category: 'E', rateBp: 0 })).toBe(false);
    expect(lineConflicts('standard', 'small_business', { category: 'S', rateBp: 1900 })).toBe(true);
    expect(lineConflicts('export', 'standard', { category: 'S', rateBp: 0 })).toBe(false);
    expect(lineConflicts('export', 'standard', { category: 'G', rateBp: 0 })).toBe(false);
  });

  it('suggests a client treatment from country and VAT id — a suggestion, the user decides', () => {
    expect(suggestTreatment({ countryCode: 'DE', vatId: 'DE123456789', kind: 'business' })).toEqual({ treatment: 'standard', reason: 'domestic' });
    expect(suggestTreatment({ countryCode: '', vatId: '', kind: 'person' })).toEqual({ treatment: 'standard', reason: 'domestic' });
    expect(suggestTreatment({ countryCode: 'at', vatId: 'ATU12345678', kind: 'business' })).toEqual({ treatment: 'reverse_charge', reason: 'eu_business_with_vat_id' });
    expect(suggestTreatment({ countryCode: 'GR', vatId: 'EL123456789', kind: 'business' }).treatment).toBe('reverse_charge');
    expect(suggestTreatment({ countryCode: 'FR', vatId: '', kind: 'business' })).toEqual({ treatment: 'standard', reason: 'eu_without_vat_id' });
    expect(suggestTreatment({ countryCode: 'FR', vatId: 'FR12345678901', kind: 'person' })).toEqual({ treatment: 'standard', reason: 'eu_without_vat_id' });
    expect(suggestTreatment({ countryCode: 'CH', vatId: 'CHE-123.456.789', kind: 'business' })).toEqual({ treatment: null, reason: 'non_eu' });
    expect(suggestTreatment({ countryCode: 'GB', vatId: 'GB123456789', kind: 'business' })).toEqual({ treatment: null, reason: 'non_eu' });
  });

  it('every suggestion reason and treatment has a label in both languages', () => {
    for (const lang of LANGS) {
      for (const t of TREATMENTS) expect(dictionaries[lang][`treatment.${t}`]).toBeTruthy();
      for (const r of ['domestic', 'eu_business_with_vat_id', 'eu_without_vat_id', 'non_eu'] as const) {
        expect(dictionaries[lang][`treatment.suggest.${r}`]).toBeTruthy();
      }
    }
  });
});
