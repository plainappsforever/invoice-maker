import type { Lang } from '@/engine/money';
import { DEFAULT_PATTERNS, validatePattern, type Series } from '@/engine/numbering';

import { queued, withRead } from './transaction';
import type { Db } from './types';

export type ThemePreference = 'system' | 'light' | 'dark';

const THEME_KEY = 'theme';
const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark'];

export function getSetting(db: Db, key: string): Promise<string | null> {
  return withRead(db, async (db) => {
    const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
    return row?.value ?? null;
  });
}

export const setSetting = queued(async (db: Db, key: string, value: string): Promise<void> => {
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value
  );
});

export async function getThemePreference(db: Db): Promise<ThemePreference> {
  const value = await getSetting(db, THEME_KEY);
  return THEMES.includes(value as ThemePreference) ? (value as ThemePreference) : 'system';
}

export function setThemePreference(db: Db, theme: ThemePreference): Promise<void> {
  return setSetting(db, THEME_KEY, theme);
}

/** Number pattern of a series (setting `pattern.<series>`), else the default for the business language (D17). */
export async function getNumberPattern(db: Db, series: Series, lang: Lang): Promise<string> {
  const stored = await getSetting(db, `pattern.${series}`);
  return stored && validatePattern(stored) === null ? stored : DEFAULT_PATTERNS[lang][series];
}

export const setNumberPattern = queued(async (db: Db, series: Series, pattern: string): Promise<void> => {
  const error = validatePattern(pattern);
  if (error) throw new Error(`invalid_pattern: ${error}`);
  await setSetting(db, `pattern.${series}`, pattern);
});

// ---------------------------------------------------------------------------------------------
// Reminders (D27, D73): settings keys of the planner (`reminder_time`, `remind_overdue`, `remind_due_tomorrow`) and the
// "asked once" flag. `notif_asked` is a device setting (not part of a backup, DEVICE_SETTINGS).
// ---------------------------------------------------------------------------------------------

export const REMINDER_TIME_KEY = 'reminder_time';
export const REMIND_OVERDUE_KEY = 'remind_overdue';
export const REMIND_DUE_TOMORROW_KEY = 'remind_due_tomorrow';
export const NOTIF_ASKED_KEY = 'notif_asked';

export type ReminderSettings = { reminderTime: string; remindOverdue: boolean; remindDueTomorrow: boolean };

export async function getReminderSettings(db: Db): Promise<ReminderSettings> {
  const time = await getSetting(db, REMINDER_TIME_KEY);
  const overdue = await getSetting(db, REMIND_OVERDUE_KEY);
  const tomorrow = await getSetting(db, REMIND_DUE_TOMORROW_KEY);
  return {
    reminderTime: time && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : '09:00',
    remindOverdue: overdue !== '0', // default on
    remindDueTomorrow: tomorrow === '1', // default off
  };
}

export async function getNotificationsAsked(db: Db): Promise<boolean> {
  return (await getSetting(db, NOTIF_ASKED_KEY)) === '1';
}

export function setNotificationsAsked(db: Db): Promise<void> {
  return setSetting(db, NOTIF_ASKED_KEY, '1');
}
