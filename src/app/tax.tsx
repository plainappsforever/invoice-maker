import { Stack } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/button';
import { NumberField } from '@/components/number-field';
import { ThemedText } from '@/components/themed-text';
import { Divider, Field, Row, Screen, Section, SwitchRow } from '@/components/ui';
import { addTaxRate, getBusiness, listTaxRates, setDefaultTaxRate, setTaxRateArchived } from '@/db/business';
import { setVatMode } from '@/db/editing';
import { RETENTION_NOTE_SETTING } from '@/db/lifecycle';
import { getSetting, setSetting } from '@/db/settings';
import { formatPercent } from '@/engine/money';
import { LEGAL_NOTES } from '@/engine/notes';
import { useLoader } from '@/hooks/use-loader';
import { getUiLanguage, t } from '@/i18n';

/** Tax settings: § 19 small-business mode, the retention note (D55) and the rate list. */
export default function TaxScreen() {
  const { data, reload, db } = useLoader(async (db) => ({
    business: await getBusiness(db),
    rates: await listTaxRates(db, { includeArchived: true }),
    retention: (await getSetting(db, RETENTION_NOTE_SETTING)) === '1',
  }));
  const [label, setLabel] = useState('');
  const [rateBp, setRateBp] = useState<number | null>(null);
  const [formKey, setFormKey] = useState(0);
  if (!data) return <Screen testID="tax-loading">{null}</Screen>;
  const lang = getUiLanguage();
  const sources = LEGAL_NOTES.small_business.sources.map((s) => s.law).join(', ');
  return (
    <Screen testID="tax-screen">
      <Stack.Screen options={{ title: t('settings.tax') }} />
      <Section title={t('tax.vatMode')} hint={t('tax.vatMode.hint', { source: sources })}>
        <SwitchRow
          testID="vat-small-business"
          label={t('tax.smallBusiness')}
          value={data.business.vatMode === 'small_business'}
          onValueChange={async (on) => {
            await setVatMode(db, on ? 'small_business' : 'standard');
            await reload();
          }}
        />
      </Section>
      <Section hint={t('settings.retentionNote.hint')}>
        <SwitchRow
          testID="retention-note"
          label={t('settings.retentionNote')}
          value={data.retention}
          onValueChange={async (on) => {
            await setSetting(db, RETENTION_NOTE_SETTING, on ? '1' : '0');
            await reload();
          }}
        />
      </Section>
      <Section title={t('tax.rates')} hint={t('tax.rates.hint')}>
        {data.rates.map((r, i) => (
          <View key={r.id}>
            {i > 0 ? <Divider /> : null}
            <Row
              testID={`rate-${r.rateBp}`}
              title={`${r.label}${r.isDefault ? ` · ${t('tax.default')}` : ''}${r.archived ? ` · ${t('tax.archived')}` : ''}`}
              value={`${formatPercent(r.rateBp, lang)} %`}
              onPress={async () => {
                if (!r.isDefault && !r.archived) await setDefaultTaxRate(db, r.id);
                else if (r.archived) await setTaxRateArchived(db, r.id, false);
                await reload();
              }}
            />
            {!r.isDefault && !r.archived ? (
              <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
                <ThemedText
                  type="small"
                  themeColor="tint"
                  testID={`rate-archive-${r.rateBp}`}
                  onPress={async () => {
                    await setTaxRateArchived(db, r.id, true);
                    await reload();
                  }}>
                  {t('tax.archive')}
                </ThemedText>
              </View>
            ) : null}
          </View>
        ))}
      </Section>
      <Section title={t('tax.addRate')}>
        <Field key={`l${formKey}`} label={t('tax.rateLabel')} testID="rate-label" value="" onSave={(v) => setLabel(v.trim())} />
        <NumberField key={`n${formKey}`} label={t('tax.ratePercent')} testID="rate-percent" kind="percent" value={null} min={0} max={10_000} allowEmpty onValue={setRateBp} />
        <View style={{ padding: 16 }}>
          <Button
            testID="rate-add"
            label={t('tax.add')}
            disabled={rateBp === null}
            onPress={async () => {
              if (rateBp === null) return;
              await addTaxRate(db, label || `${formatPercent(rateBp, lang)} %`, rateBp);
              setLabel('');
              setRateBp(null);
              setFormKey((k) => k + 1);
              await reload();
            }}
          />
        </View>
      </Section>
    </Screen>
  );
}
