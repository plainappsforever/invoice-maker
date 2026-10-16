import Constants from 'expo-constants';
import { useRouter } from 'expo-router';

import { Divider, Row, Screen, Section } from '@/components/ui';
import { ThemedText } from '@/components/themed-text';
import { getBusiness } from '@/db/business';
import { useLoader } from '@/hooks/use-loader';
import { t } from '@/i18n';

export default function SettingsScreen() {
  const router = useRouter();
  const { data: business } = useLoader((db) => getBusiness(db));
  const dev = Constants.expoConfig?.extra?.appVariant === 'development';
  return (
    <Screen testID="settings-screen">
      <Section>
        <Row testID="settings-business" title={t('settings.business')} value={business?.name} onPress={() => router.push('/business')} />
        <Divider />
        <Row testID="settings-tax" title={t('settings.tax')} value={business ? t(business.vatMode === 'small_business' ? 'tax.mode.small_business.short' : 'tax.mode.standard.short') : ''} onPress={() => router.push('/tax')} />
        <Divider />
        <Row testID="settings-numbering" title={t('settings.numbering')} onPress={() => router.push('/numbering')} />
        <Divider />
        <Row testID="settings-documents" title={t('settings.documents')} onPress={() => router.push('/doc-defaults')} />
        <Divider />
        <Row testID="settings-texts" title={t('settings.texts')} onPress={() => router.push('/texts')} />
        <Divider />
        <Row testID="settings-items" title={t('settings.items')} onPress={() => router.push('/items')} />
      </Section>
      <Section>
        <Row testID="settings-reminders" title={t('settings.reminders')} onPress={() => router.push('/reminders')} />
        <Divider />
        <Row testID="settings-data" title={t('settings.data')} onPress={() => router.push('/data')} />
        <Divider />
        <Row testID="settings-language" title={t('settings.language')} onPress={() => router.push('/language')} />
        <Divider />
        <Row testID="settings-about" title={t('settings.about')} onPress={() => router.push('/about')} />
      </Section>
      {dev ? (
        <Section>
          <Row testID="settings-debug" title={t('settings.debug')} onPress={() => router.push('/debug')} />
        </Section>
      ) : null}
      <ThemedText type="small" themeColor="textSecondary" testID="settings-version">
        {t('settings.version', { version: Constants.expoConfig?.version ?? '', variant: String(Constants.expoConfig?.extra?.appVariant) })}
      </ThemedText>
    </Screen>
  );
}
