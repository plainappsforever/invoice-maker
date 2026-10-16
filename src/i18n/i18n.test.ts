import { BANNED_ADVICE, bannedIn, EINVOICE_INFO_KEYS, NEGATION } from '@/engine/wording';

import { de } from './de';
import { en } from './en';
import { dictionaries, languageFromLocale, setUiLanguage, t, translate } from './index';

const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();

describe('EN/DE parity', () => {
  it('both languages have exactly the same keys', () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
  });
  it('no empty strings, and the same {placeholders} in both', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect([key, en[key].trim().length > 0, de[key].trim().length > 0]).toEqual([key, true, true]);
      expect([key, placeholders(de[key])]).toEqual([key, placeholders(en[key])]);
    }
  });
});

// D21 / V1_PLAN rule 11: v1 never claims compliance or e-invoicing, and never gives advice, in any
// user-facing string. The list lives in src/engine/wording.ts (shared with the legal-note tests).
describe('banned phrases (D21)', () => {
  it.each(Object.entries(dictionaries))('%s strings contain none', (_lang, dict) => {
    for (const [key, text] of Object.entries(dict)) {
      if (EINVOICE_INFO_KEYS.includes(key)) continue;
      expect([key, bannedIn(text)]).toEqual([key, []]);
    }
  });
  it.each(Object.entries(dictionaries))('%s: the e-invoice info texts name the formats only to say the app does not create them (D88)', (_lang, dict) => {
    for (const key of EINVOICE_INFO_KEYS) {
      const text = (dict as Record<string, string>)[key];
      expect([key, BANNED_ADVICE.filter((p) => p.test(text)).map(String)]).toEqual([key, []]);
      if (key !== 'about.einvoice.title' && key !== 'about.einvoice.source') expect([key, NEGATION.test(text)]).toEqual([key, true]);
    }
  });
});

describe('translate', () => {
  it('interpolates and leaves unknown placeholders visible', () => {
    expect(translate('de', 'settings.version', { version: '1.0.0', variant: 'development' })).toBe('Version 1.0.0 (development)');
    expect(translate('en', 'settings.version', { version: '1.0.0' })).toBe('Version 1.0.0 ({variant})');
  });
  it('t uses the UI language', () => {
    setUiLanguage('de');
    expect(t('nav.documents')).toBe('Dokumente');
    setUiLanguage('en');
    expect(t('nav.documents')).toBe('Documents');
  });
  it('maps device locales', () => {
    expect(languageFromLocale('de-DE')).toBe('de');
    expect(languageFromLocale('de_AT')).toBe('de');
    expect(languageFromLocale('en-US')).toBe('en');
    expect(languageFromLocale('fr-FR')).toBe('en');
    expect(languageFromLocale(null)).toBe('en');
  });
});
