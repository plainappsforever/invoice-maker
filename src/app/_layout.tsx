import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { SQLiteProvider, useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { useEffect } from 'react';
import { LogBox, useColorScheme } from 'react-native';

import { openDatabase } from '@/db/migrations';
import { getThemePreference } from '@/db/settings';
import { t } from '@/i18n';
import { configureNotifications } from '@/lib/notifications';
import { startReminders } from '@/lib/reminders';
import { applyThemePreference } from '@/lib/theme-preference';
import { applyLanguagePreference, loadLanguagePreference, useLanguageVersion } from '@/lib/ui-language';

// Dev-only toast from expo-router's start-up link handling (fork/useLinking.native.js sets state before the root has
// mounted when the app is opened by a link). Not app code; the toast covered the tab bar in a Maestro run (P5).
LogBox.ignoreLogs(["Can't perform a React state update on a component that hasn't mounted yet"]);

configureNotifications();
applyLanguagePreference('system'); // right language from the first frame; the stored choice is applied after the database opens

async function initDatabase(db: SQLiteDatabase) {
  await openDatabase(db);
  applyThemePreference(await getThemePreference(db));
  await loadLanguagePreference(db);
}

export default function RootLayout() {
  return (
    <SQLiteProvider databaseName="app.db" onInit={initDatabase}>
      <Navigator />
    </SQLiteProvider>
  );
}

function Navigator() {
  const scheme = useColorScheme();
  const db = useSQLiteContext();
  // Reminders (D73): rebuild the OS notification list from the database once the navigator exists.
  useEffect(() => {
    startReminders(db).catch((e) => console.warn('reminders did not start', e));
  }, [db]);
  const languageVersion = useLanguageVersion(); // a new UI language remounts every screen with the new strings
  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack key={languageVersion} screenOptions={{ headerBackTitle: t('nav.back') }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      </Stack>
    </ThemeProvider>
  );
}
