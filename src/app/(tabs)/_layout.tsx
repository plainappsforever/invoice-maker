import { Tabs } from 'expo-router/js-tabs';

import { useTheme } from '@/hooks/use-theme';
import { t } from '@/i18n';

// JS tabs (expo-router/js-tabs, D15 stack): Invoices · Quotes · Receipts · Clients · Settings.
export default function TabsLayout() {
  const theme = useTheme();
  const common = { tabBarIconStyle: { display: 'none' as const }, tabBarLabelStyle: { fontSize: 11, fontWeight: '600' as const } };
  return (
    <Tabs
      screenOptions={{
        ...common,
        tabBarActiveTintColor: theme.tint,
        tabBarInactiveTintColor: theme.textSecondary,
        tabBarStyle: { backgroundColor: theme.backgroundElement },
        headerStyle: { backgroundColor: theme.backgroundElement },
        headerTintColor: theme.text,
      }}>
      <Tabs.Screen name="index" options={{ title: t('tabs.invoices'), tabBarButtonTestID: 'tab-invoices' }} />
      <Tabs.Screen name="quotes" options={{ title: t('tabs.quotes'), tabBarButtonTestID: 'tab-quotes' }} />
      <Tabs.Screen name="receipts" options={{ title: t('tabs.receipts'), tabBarButtonTestID: 'tab-receipts' }} />
      <Tabs.Screen name="clients" options={{ title: t('tabs.clients'), tabBarButtonTestID: 'tab-clients' }} />
      <Tabs.Screen name="settings" options={{ title: t('tabs.settings'), tabBarButtonTestID: 'tab-settings' }} />
    </Tabs>
  );
}
