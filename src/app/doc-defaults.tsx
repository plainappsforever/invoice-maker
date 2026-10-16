import { Stack } from 'expo-router';

import { Chip, ChipRow, Field, Screen, Section, SwitchRow } from '@/components/ui';
import { getSetting, setSetting } from '@/db/settings';
import { useLoader } from '@/hooks/use-loader';
import { t } from '@/i18n';

const TEMPLATES = ['classic', 'modern', 'compact'] as const;
const ACCENTS = ['#1F4E79', '#0B7A4B', '#9B1C12', '#6A3FA0', '#B26A00', '#2B2F36'];
const HEX = /^#[0-9A-Fa-f]{6}$/;

/** Document defaults (F7 settings): template, accent colour, paper, logo position, GiroCode. They apply to new drafts. */
export default function DocDefaultsScreen() {
  const { data, reload, db } = useLoader(async (db) => ({
    template: (await getSetting(db, 'default_template')) ?? 'classic',
    accent: (await getSetting(db, 'default_accent')) ?? '#1F4E79',
    paper: (await getSetting(db, 'default_paper')) ?? 'A4',
    logoRight: (await getSetting(db, 'default_logo_right')) === '1',
    girocode: (await getSetting(db, 'default_girocode')) !== '0',
  }));
  if (!data) return <Screen testID="doc-defaults-loading">{null}</Screen>;
  const set = (key: string, value: string) => async () => {
    await setSetting(db, key, value);
    await reload();
  };
  return (
    <Screen testID="doc-defaults-screen">
      <Stack.Screen options={{ title: t('settings.documents') }} />
      <Section title={t('docdefaults.template')}>
        <ChipRow>
          {TEMPLATES.map((tpl) => (
            <Chip key={tpl} testID={`template-${tpl}`} label={t(`docdefaults.template.${tpl}`)} selected={data.template === tpl} onPress={set('default_template', tpl)} />
          ))}
        </ChipRow>
      </Section>
      <Section title={t('docdefaults.accent')}>
        <ChipRow>
          {ACCENTS.map((c) => (
            <Chip key={c} testID={`accent-${c.slice(1)}`} label={c} selected={data.accent.toLowerCase() === c.toLowerCase()} onPress={set('default_accent', c)} />
          ))}
        </ChipRow>
        <Field label={t('docdefaults.accentHex')} testID="accent-hex" value={data.accent} autoCapitalize="characters" validate={(v) => HEX.test(v.trim())} invalidText={t('docdefaults.accentInvalid')} onSave={(v) => set('default_accent', v.trim().toUpperCase())()} />
      </Section>
      <Section title={t('docdefaults.paper')}>
        <ChipRow>
          <Chip testID="paper-A4" label="A4" selected={data.paper === 'A4'} onPress={set('default_paper', 'A4')} />
          <Chip testID="paper-LETTER" label="Letter" selected={data.paper === 'LETTER'} onPress={set('default_paper', 'LETTER')} />
        </ChipRow>
      </Section>
      <Section>
        <SwitchRow testID="logo-right" label={t('docdefaults.logoRight')} value={data.logoRight} onValueChange={(v) => set('default_logo_right', v ? '1' : '0')()} />
        <SwitchRow testID="girocode-default" label={t('docdefaults.girocode')} value={data.girocode} onValueChange={(v) => set('default_girocode', v ? '1' : '0')()} />
      </Section>
    </Screen>
  );
}
