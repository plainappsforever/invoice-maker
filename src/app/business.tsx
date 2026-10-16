import { Image } from 'expo-image';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/button';
import { SignatureView } from '@/components/signature-pad';
import { ThemedText } from '@/components/themed-text';
import { Chip, ChipRow, Field, Screen, Section } from '@/components/ui';
import { getBusiness, updateBusiness, type BusinessPatch } from '@/db/business';
import { useLoader } from '@/hooks/use-loader';
import { CURRENCIES } from '@/engine/money';
import { formatIban, isValidBic, normalizeBic, normalizeIban, validateIban } from '@/engine/iban';
import { parseSignature } from '@/engine/signature';
import { MAX_PAYMENT_DAYS } from '@/engine/status';
import { t } from '@/i18n';
import { errorText } from '@/lib/errors';
import { logoUri, pickLogo } from '@/lib/files';

const isDays = (v: string) => /^\d{1,3}$/.test(v.trim()) && Number(v) <= MAX_PAYMENT_DAYS;

/** Business profile (F1): every field autosaves; the check's "Fix" links of the business land here. */
export default function BusinessScreen() {
  const { data: b, reload, db } = useLoader((db) => getBusiness(db));
  const [logoError, setLogoError] = useState<string | null>(null);
  const router = useRouter();
  if (!b) return <Screen testID="business-loading">{null}</Screen>;
  const save = (patch: BusinessPatch) => async () => {
    await updateBusiness(db, patch);
    await reload();
  };
  const text = (label: string, key: keyof BusinessPatch & string, extra: Partial<React.ComponentProps<typeof Field>> = {}) => (
    <Field
      label={label}
      testID={`business-${key}`}
      value={String(b[key as keyof typeof b] ?? '')}
      onSave={async (v) => {
        await updateBusiness(db, { [key]: v.trim() } as BusinessPatch);
        await reload();
      }}
      {...extra}
    />
  );
  const logo = logoUri(b.logoFile);
  const signature = parseSignature(b.signature);
  return (
    <Screen testID="business-screen">
      <Stack.Screen options={{ title: t('settings.business') }} />
      <Section title={t('business.identity')}>
        {text(t('business.name'), 'name')}
        {text(t('field.street'), 'street')}
        {text(t('field.postalCode'), 'postalCode')}
        {text(t('field.city'), 'city')}
        {text(t('field.country'), 'countryCode', { autoCapitalize: 'characters', maxLength: 2 })}
      </Section>
      <Section title={t('business.contact')}>
        {text(t('field.email'), 'email', { keyboardType: 'email-address', autoCapitalize: 'none' })}
        {text(t('field.phone'), 'phone', { keyboardType: 'phone-pad' })}
        {text(t('business.website'), 'website', { autoCapitalize: 'none' })}
      </Section>
      <Section title={t('business.taxIds')}>
        {text(t('field.taxNumber'), 'taxNumber')}
        {text(t('field.vatId'), 'vatId', { autoCapitalize: 'characters' })}
      </Section>
      <Section title={t('business.bank')} hint={t('business.bank.hint')}>
        <Field
          label={t('field.iban')}
          testID="business-iban"
          value={formatIban(b.iban)}
          autoCapitalize="characters"
          validate={(v) => v.trim() === '' || validateIban(v) === null}
          invalidText={t('business.ibanInvalid')}
          onSave={async (v) => {
            await updateBusiness(db, { iban: normalizeIban(v) });
            await reload();
          }}
        />
        <Field
          label={t('field.bic')}
          testID="business-bic"
          value={b.bic}
          autoCapitalize="characters"
          validate={(v) => v.trim() === '' || isValidBic(v)}
          invalidText={t('business.bicInvalid')}
          onSave={async (v) => {
            await updateBusiness(db, { bic: normalizeBic(v) });
            await reload();
          }}
        />
        {text(t('business.bankName'), 'bankName')}
        {text(t('business.accountHolder'), 'accountHolder')}
      </Section>
      <Section title={t('business.logo')} hint={t('business.logo.hint')}>
        <View style={{ padding: 16, gap: 8, alignItems: 'flex-start' }}>
          {logo ? <Image testID="business-logo-image" source={{ uri: logo }} style={{ width: 160, height: 80 }} contentFit="contain" /> : null}
          <Button
            testID="business-logo-pick"
            variant="secondary"
            label={logo ? t('business.logo.change') : t('business.logo.pick')}
            onPress={async () => {
              try {
                const file = await pickLogo();
                if (file) await save({ logoFile: file })();
              } catch (e) {
                setLogoError(errorText(e));
              }
            }}
          />
          {logo ? <Button testID="business-logo-remove" variant="secondary" label={t('business.logo.remove')} onPress={save({ logoFile: null })} /> : null}
          {logoError ? <ThemedText type="small">{logoError}</ThemedText> : null}
        </View>
      </Section>
      <Section title={t('business.signature')} hint={t('business.signature.hint')}>
        <View style={{ padding: 16, gap: 8, alignItems: 'flex-start' }}>
          {signature ? <SignatureView testID="business-signature-image" d={signature.d} w={signature.w} h={signature.h} /> : null}
          <Button
            testID="business-signature-draw"
            variant="secondary"
            label={signature ? t('business.signature.redraw') : t('business.signature.draw')}
            onPress={() => router.push({ pathname: '/signature', params: { target: 'business' } })}
          />
          {signature ? <Button testID="business-signature-remove" variant="secondary" label={t('business.signature.remove')} onPress={save({ signature: null })} /> : null}
        </View>
      </Section>
      <Section title={t('business.defaults')}>
        <ChipRow>
          {(['de', 'en'] as const).map((l) => (
            <Chip key={l} testID={`business-lang-${l}`} label={l === 'de' ? 'Deutsch' : 'English'} selected={b.language === l} onPress={save({ language: l })} />
          ))}
        </ChipRow>
        <ChipRow>
          {CURRENCIES.map((c) => (
            <Chip key={c.code} label={c.code} selected={b.currency === c.code} onPress={save({ currency: c.code })} />
          ))}
        </ChipRow>
        <Field
          label={t('field.paymentDays')}
          testID="business-payment-days"
          keyboardType="number-pad"
          value={String(b.paymentDays)}
          validate={isDays}
          invalidText={t('field.invalidNumber')}
          onSave={async (v) => save({ paymentDays: Number(v) })()}
        />
        {text(t('business.footer'), 'footer', { multiline: true, maxLength: 1000 })}
      </Section>
    </Screen>
  );
}
