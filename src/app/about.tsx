import Constants from 'expo-constants';
import { Stack } from 'expo-router';
import { Linking, Platform, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Divider, Row, Screen, Section } from '@/components/ui';
import { LICENCES } from '@/data/licences.generated';
import { t } from '@/i18n';

/** Placeholder address of the online privacy policy (owner to-do before the store listing, V1_PLAN "Owner to-dos"). */
export const PRIVACY_URL = 'https://plainapps.dfdsfdsfsdf.workers.dev/apps/invoice-maker/privacy';

/**
 * Settings → About & privacy (SPEC §11, A12). The privacy text states only what the code does: no account, no analytics,
 * no network code of its own, the phone backup per platform (D87), release builds without the Android INTERNET permission (plugins/with-no-internet.js, checked with
 * `aapt dump permissions`), data leaves the phone only through the share sheet and the user's own e-mail.
 */
export default function AboutScreen() {
  return (
    <Screen testID="about-screen">
      <Stack.Screen options={{ title: t('settings.about') }} />
      <View style={{ gap: 4 }}>
        <ThemedText type="subtitle">{t('app.name')}</ThemedText>
        <ThemedText themeColor="textSecondary" testID="about-version">
          {t('about.version', { version: Constants.expoConfig?.version ?? '' })}
        </ThemedText>
      </View>
      <Section title={t('about.privacy.title')}>
        <View style={{ padding: 16, gap: 12 }} testID="about-privacy">
          <ThemedText>{t('about.privacy.local')}</ThemedText>
          <ThemedText>{t('about.privacy.noNetwork')}</ThemedText>
          <ThemedText testID="about-privacy-backup">{t(Platform.OS === 'ios' ? 'about.privacy.backup.ios' : 'about.privacy.backup.android')}</ThemedText>
          <ThemedText>{t('about.privacy.permissions')}</ThemedText>
          <ThemedText>{t('about.privacy.delete')}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">{t('about.privacy.url')}</ThemedText>
          <ThemedText type="smallBold" testID="about-privacy-url">{PRIVACY_URL}</ThemedText>
          <Button testID="about-privacy-open" variant="secondary" label={t('about.privacy.open')} onPress={() => void Linking.openURL(PRIVACY_URL)} />
        </View>
      </Section>
      <Section title={t('about.einvoice.title')}>
        <View style={{ padding: 16, gap: 8 }} testID="about-einvoice">
          <ThemedText>{t('about.einvoice.body')}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">{t('about.einvoice.source')}</ThemedText>
        </View>
      </Section>
      <Section title={t('about.legal.title')}>
        <ThemedText style={{ padding: 16 }}>{t('about.legal.body')}</ThemedText>
      </Section>
      <Section title={t('about.licences.title')} hint={t('about.licences.hint')}>
        <View testID="about-licences">
          {LICENCES.map((l, i) => (
            <View key={l.name}>
              {i > 0 ? <Divider /> : null}
              <Row testID={`licence-${l.name}`} title={l.name} value={`${l.version} · ${l.license}`} />
            </View>
          ))}
        </View>
      </Section>
    </Screen>
  );
}
