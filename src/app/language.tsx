import { Stack } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';

import { Chip, ChipRow, Screen, Section } from '@/components/ui';
import { getSetting, getThemePreference, setThemePreference, type ThemePreference } from '@/db/settings';
import { t } from '@/i18n';
import { applyThemePreference } from '@/lib/theme-preference';
import { saveLanguagePreference, type LanguagePreference } from '@/lib/ui-language';

const THEMES: ThemePreference[] = ['system', 'light', 'dark'];
const LANGS: LanguagePreference[] = ['system', 'de', 'en'];

export default function LanguageScreen() {
  const db = useSQLiteContext();
  const [lang, setLang] = useState<LanguagePreference>('system');
  const [theme, setTheme] = useState<ThemePreference>('system');
  useEffect(() => {
    getSetting(db, 'ui_language').then((v) => setLang(v === 'de' || v === 'en' ? v : 'system'));
    getThemePreference(db).then(setTheme);
  }, [db]);
  return (
    <Screen testID="language-screen">
      <Stack.Screen options={{ title: t('settings.language') }} />
      <Section title={t('language.ui')} hint={t('language.hint')}>
        <ChipRow>
          {LANGS.map((l) => (
            <Chip
              key={l}
              testID={`lang-${l}`}
              label={l === 'system' ? t('settings.theme.system') : l === 'de' ? 'Deutsch' : 'English'}
              selected={lang === l}
              onPress={async () => {
                setLang(l);
                await saveLanguagePreference(db, l);
              }}
            />
          ))}
        </ChipRow>
      </Section>
      <Section title={t('settings.appearance')}>
        <ChipRow>
          {THEMES.map((th) => (
            <Chip
              key={th}
              testID={`theme-${th}`}
              label={t(`settings.theme.${th}`)}
              selected={theme === th}
              onPress={async () => {
                setTheme(th);
                applyThemePreference(th);
                await setThemePreference(db, th);
              }}
            />
          ))}
        </ChipRow>
      </Section>
    </Screen>
  );
}
