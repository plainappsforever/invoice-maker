// Minimal i18n: flat keys, {placeholder} interpolation, UI language set at startup.
// The UI language follows the device (expo-localization, P4); documents use their own language (D15).
import type { Lang } from '@/engine/money';

import { de } from './de';
import { en, type TranslationKey } from './en';

export type { TranslationKey };
export const LANGUAGES: readonly Lang[] = ['de', 'en'];
export const dictionaries: Record<Lang, Record<TranslationKey, string>> = { en, de };

let uiLanguage: Lang = 'en';

export function setUiLanguage(lang: Lang) {
  uiLanguage = lang;
}

export function getUiLanguage(): Lang {
  return uiLanguage;
}

/** Picks 'de' for German device locales ('de', 'de-AT', 'de_CH' …), else English. */
export function languageFromLocale(locale: string | null | undefined): Lang {
  return locale?.toLowerCase().startsWith('de') ? 'de' : 'en';
}

export function translate(lang: Lang, key: TranslationKey, params: Record<string, string | number> = {}): string {
  const text = dictionaries[lang][key] ?? en[key];
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** UI string in the current UI language. */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate(uiLanguage, key, params);
}
