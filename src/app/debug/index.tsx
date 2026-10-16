import { Stack, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useState } from 'react';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Screen, Section } from '@/components/ui';
import { FIXTURES, resetAll, runProbes, seedFixture, type ProbeResult } from '@/db/debug';
import { isDevBuild } from '@/lib/debug';

/** Settings → Debug (development builds only): reset, fixtures and the on-device database probes. */
export default function DebugScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const [results, setResults] = useState<ProbeResult[] | null>(null);
  const [message, setMessage] = useState('');
  if (!isDevBuild) return null;
  const passed = results?.filter((r) => r.ok).length ?? 0;
  return (
    <Screen testID="debug-screen">
      <Stack.Screen options={{ title: 'Debug' }} />
      <Section title="Data">
        <Button
          testID="debug-reset"
          variant="secondary"
          label="Reset all data"
          onPress={async () => {
            await resetAll(db);
            setMessage('reset done');
          }}
        />
        {FIXTURES.map((f) => (
          <Button
            key={f}
            testID={`debug-seed-${f}`}
            variant="secondary"
            label={`Seed: ${f}`}
            onPress={async () => {
              await seedFixture(db, f);
              setMessage(`seeded ${f}`);
            }}
          />
        ))}
        <ThemedText testID="debug-message">{message}</ThemedText>
      </Section>
      <Section title="Database probes (resets the data first)">
        <Button
          testID="debug-probes"
          label="Run probes"
          onPress={async () => {
            setResults(null);
            setResults(await runProbes(db));
          }}
        />
        {results ? (
          <>
            <ThemedText testID="probe-summary">{`PROBES ${passed}/${results.length} ok`}</ThemedText>
            {results.map((r, i) => (
              <ThemedText key={i} testID={`probe-${i}`} type="small">{`${r.ok ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}`}</ThemedText>
            ))}
          </>
        ) : null}
      </Section>
      <Button testID="debug-pdf" variant="secondary" label="PDF probes" onPress={() => router.push('/debug/pdf')} />
      <Button testID="debug-home" variant="secondary" label="Home" onPress={() => router.replace('/')} />
    </Screen>
  );
}
