import { Stack } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { ErrorText, Input, Screen, Section } from '@/components/ui';
import { getBusiness } from '@/db/business';
import { getCounter, NextNumberError, setNextValue } from '@/db/counters';
import { getNumberPattern, setNumberPattern } from '@/db/settings';
import { todayLocal } from '@/engine/dates';
import { formatNumber, seriesKey, validatePattern, type Series } from '@/engine/numbering';
import { useLoader } from '@/hooks/use-loader';
import { t } from '@/i18n';

const SERIES: Series[] = ['invoice', 'quote', 'receipt'];

function SeriesCard({ series, pattern: initialPattern, next: initialNext }: { series: Series; pattern: string; next: number }) {
  const [pattern, setPattern] = useState(initialPattern);
  const [next, setNext] = useState(String(initialNext));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const db = useSQLiteContext();
  const today = todayLocal();
  const patternError = validatePattern(pattern);
  const nextValue = /^\d{1,9}$/.test(next.trim()) ? Number(next) : null;
  const preview = !patternError && nextValue && nextValue >= 1 ? formatNumber(pattern, nextValue, today) : '';

  async function save() {
    setSaved(false);
    setError(null);
    if (patternError || nextValue === null || nextValue < 1) return setError(t('numbering.invalid'));
    try {
      await setNumberPattern(db, series, pattern);
      await setNextValue(db, seriesKey(series, pattern, today), nextValue);
      setSaved(true);
    } catch (e) {
      setError(e instanceof NextNumberError ? t('numbering.used', { max: e.maxUsed }) : e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Section title={t(`doc.type.${series}`)}>
      <Input
        label={t('numbering.pattern')}
        testID={`numbering-pattern-${series}`}
        value={pattern}
        autoCapitalize="characters"
        onChangeText={(v) => {
          setPattern(v);
          setSaved(false);
        }}
        error={patternError ? t(`numbering.error.${patternError}`) : null}
      />
      <Input
        label={t('numbering.next')}
        testID={`numbering-next-${series}`}
        value={next}
        keyboardType="number-pad"
        onChangeText={(v) => {
          setNext(v);
          setSaved(false);
        }}
      />
      <View style={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}>
        <ThemedText type="small" themeColor="textSecondary" testID={`numbering-preview-${series}`}>
          {preview ? t('numbering.preview', { number: preview }) : ' '}
        </ThemedText>
        <ErrorText testID={`numbering-error-${series}`}>{error}</ErrorText>
        {saved ? (
          <ThemedText type="small" testID={`numbering-saved-${series}`}>
            {t('numbering.saved')}
          </ThemedText>
        ) : null}
        <Button testID={`numbering-save-${series}`} label={t('action.save')} onPress={save} />
      </View>
    </Section>
  );
}

/** Numbering (SPEC §5 numbering examples): pattern per series and the next number; lowering below a used number is refused. */
export default function NumberingScreen() {
  const { data } = useLoader(async (db) => {
    const business = await getBusiness(db);
    const today = todayLocal();
    const rows = [];
    for (const series of SERIES) {
      const pattern = await getNumberPattern(db, series, business.language);
      rows.push({ series, pattern, next: (await getCounter(db, seriesKey(series, pattern, today))).nextValue });
    }
    return rows;
  });
  return (
    <Screen testID="numbering-screen">
      <Stack.Screen options={{ title: t('settings.numbering') }} />
      <ThemedText type="small" themeColor="textSecondary">
        {t('numbering.hint')}
      </ThemedText>
      {data?.map((row) => (
        <SeriesCard key={row.series} {...row} />
      ))}
    </Screen>
  );
}
