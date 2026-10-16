// UI language: follows the device (expo-localization) unless the user chose one in Settings → Language (D15).
import { getLocales } from 'expo-localization';
import { useSyncExternalStore } from 'react';

import { getSetting, setSetting } from '@/db/settings';
import type { Db } from '@/db/types';
import { getUiLanguage, languageFromLocale, setUiLanguage } from '@/i18n';

export type LanguagePreference = 'system' | 'de' | 'en';
const KEY = 'ui_language';
const listeners = new Set<() => void>();
let version = 0;

export function deviceLanguage() {
  return languageFromLocale(getLocales()[0]?.languageTag);
}

export function applyLanguagePreference(pref: LanguagePreference) {
  const next = pref === 'system' ? deviceLanguage() : pref;
  if (next === getUiLanguage()) return;
  setUiLanguage(next);
  version++;
  listeners.forEach((l) => l());
}

export async function loadLanguagePreference(db: Db): Promise<LanguagePreference> {
  const value = await getSetting(db, KEY);
  const pref: LanguagePreference = value === 'de' || value === 'en' ? value : 'system';
  applyLanguagePreference(pref);
  return pref;
}

export async function saveLanguagePreference(db: Db, pref: LanguagePreference) {
  await setSetting(db, KEY, pref);
  applyLanguagePreference(pref);
}

/** Changes whenever the UI language changes: the root layout uses it as a key so every screen re-renders. */
export function useLanguageVersion() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version
  );
}
