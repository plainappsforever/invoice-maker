import { Stack } from 'expo-router';
import { useState } from 'react';

import { Chip, ChipRow, Field, Screen, Section } from '@/components/ui';
import { getSetting, setSetting } from '@/db/settings';
import type { Lang } from '@/engine/money';
import type { Series } from '@/engine/numbering';
import { useLoader } from '@/hooks/use-loader';
import { t } from '@/i18n';

const KINDS = ['intro', 'notes', 'payment', 'footer'] as const;

/** Default texts per document language and type (SPEC §4 settings `text.<lang>.<kind>.<type>`); new drafts start with them. */
export default function TextsScreen() {
  const [lang, setLang] = useState<Lang>('de');
  const [type, setType] = useState<Series>('invoice');
  const { data, reload, db } = useLoader(async (db) => {
    const out: Record<string, string> = {};
    for (const kind of KINDS) out[kind] = (await getSetting(db, `text.${lang}.${kind}.${type}`)) ?? '';
    return out;
  }, `${lang}-${type}`);
  return (
    <Screen testID="texts-screen">
      <Stack.Screen options={{ title: t('settings.texts') }} />
      <Section>
        <ChipRow>
          {(['de', 'en'] as const).map((l) => (
            <Chip key={l} testID={`texts-lang-${l}`} label={l === 'de' ? 'Deutsch' : 'English'} selected={lang === l} onPress={() => setLang(l)} />
          ))}
        </ChipRow>
        <ChipRow>
          {(['invoice', 'quote', 'receipt'] as const).map((s) => (
            <Chip key={s} testID={`texts-type-${s}`} label={t(`doc.type.${s}`)} selected={type === s} onPress={() => setType(s)} />
          ))}
        </ChipRow>
      </Section>
      {data ? (
        <Section hint={t('texts.hint')}>
          {KINDS.map((kind) => (
            <Field
              key={`${lang}-${type}-${kind}`}
              label={t(`texts.${kind}`)}
              testID={`texts-${kind}`}
              multiline
              maxLength={1500}
              value={data[kind] ?? ''}
              onSave={async (v) => {
                await setSetting(db, `text.${lang}.${kind}.${type}`, v);
                await reload();
              }}
            />
          ))}
        </Section>
      ) : null}
    </Screen>
  );
}
