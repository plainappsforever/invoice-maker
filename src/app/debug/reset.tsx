import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';

import { Screen } from '@/components/ui';
import { ThemedText } from '@/components/themed-text';
import { resetAll } from '@/db/debug';
import { isDevBuild } from '@/lib/debug';
import { saveLanguagePreference } from '@/lib/ui-language';

/** `invoicemaker-dev://debug/reset?lang=en|de[&ask=1]` — deletes all data, back to the factory state; lang sets the UI language; `ask=1` leaves the reminder question open (dev builds only). */
export default function DebugReset() {
  const { lang, ask } = useLocalSearchParams<{ lang?: string; ask?: string }>();
  const db = useSQLiteContext();
  const router = useRouter();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!isDevBuild) return;
    resetAll(db, { askReminders: ask === '1' })
      .then(() => saveLanguagePreference(db, lang === 'de' || lang === 'en' ? lang : 'system'))
      .then(() => {
        setDone(true);
        router.replace('/');
      });
  }, [db, lang, ask, router]);
  if (!isDevBuild) return <Redirect href="/" />;
  return (
    <Screen testID="debug-reset-screen">
      <ThemedText>{done ? 'reset done' : 'resetting'}</ThemedText>
    </Screen>
  );
}
