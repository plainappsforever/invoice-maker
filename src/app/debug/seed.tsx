import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect } from 'react';

import { Screen } from '@/components/ui';
import { ThemedText } from '@/components/themed-text';
import { FIXTURES, seedFixture, type FixtureName } from '@/db/debug';
import { isDevBuild } from '@/lib/debug';

/** `invoicemaker-dev://debug/seed?fixture=business|repeat|examples|issued` — adds fixture data (dev builds only). */
export default function DebugSeed() {
  const { fixture } = useLocalSearchParams<{ fixture?: string }>();
  const db = useSQLiteContext();
  const router = useRouter();
  useEffect(() => {
    if (!isDevBuild || !FIXTURES.includes(fixture as FixtureName)) return;
    seedFixture(db, fixture as FixtureName).then(() => router.replace('/'));
  }, [db, fixture, router]);
  if (!isDevBuild) return <Redirect href="/" />;
  return (
    <Screen testID="debug-seed-screen">
      <ThemedText>{FIXTURES.includes(fixture as FixtureName) ? `seeding ${fixture}` : `unknown fixture ${fixture}`}</ThemedText>
    </Screen>
  );
}
