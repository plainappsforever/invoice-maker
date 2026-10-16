import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { createClient, listClients } from '@/db/clients';
import { setDraftClient } from '@/db/editing';
import { useLoader } from '@/hooks/use-loader';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/i18n';

/** Client picker: recent clients first, search, and "create" with just a name (details later, SPEC §6). */
export default function ClientPicker() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const docId = Number(id);
  const router = useRouter();
  const theme = useTheme();
  const [search, setSearch] = useState('');
  const { data, db } = useLoader((db) => listClients(db, { search, recentFirst: true }), search);
  const name = search.trim();
  const exact = !!data?.some((c) => c.name.toLowerCase() === name.toLowerCase());

  async function choose(clientId: number | null) {
    await setDraftClient(db, docId, clientId);
    router.back();
  }

  return (
    <View style={[styles.flex, { backgroundColor: theme.background }]}>
      <Stack.Screen options={{ title: t('editor.client') }} />
      <FlatList
        testID="client-picker"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
        data={data ?? []}
        keyExtractor={(c) => String(c.id)}
        ListHeaderComponent={
          <View style={styles.gap}>
            <TextInput
              testID="client-picker-search"
              accessibilityLabel={t('picker.clientSearch')}
              placeholder={t('picker.clientSearch')}
              placeholderTextColor={theme.textSecondary}
              value={search}
              onChangeText={setSearch}
              autoCorrect={false}
              autoFocus={false}
              style={[styles.search, { color: theme.text, backgroundColor: theme.backgroundElement }]}
            />
            {name && !exact ? (
              <Pressable
                testID="create-client"
                accessibilityRole="button"
                style={[styles.row, { backgroundColor: theme.backgroundElement }]}
                onPress={async () => choose(await createClient(db, { name }))}>
                <ThemedText type="smallBold" themeColor="tint">
                  {t('picker.createClient', { name })}
                </ThemedText>
              </Pressable>
            ) : null}
          </View>
        }
        ListFooterComponent={
          <Pressable testID="clear-client" accessibilityRole="button" style={styles.clear} onPress={() => choose(null)}>
            <ThemedText type="small" themeColor="textSecondary">{t('picker.noClient')}</ThemedText>
          </Pressable>
        }
        renderItem={({ item }) => (
          <Pressable
            testID={`pick-client-${item.id}`}
            accessibilityRole="button"
            onPress={() => choose(item.id)}
            style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement }]}>
            <ThemedText type="smallBold">{item.name}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
              {[item.postalCode, item.city].filter(Boolean).join(' ') || t('clients.noAddress')}
            </ThemedText>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: Spacing.three, gap: Spacing.two },
  gap: { gap: Spacing.two },
  search: { borderRadius: 10, paddingHorizontal: Spacing.three, minHeight: 44, fontSize: 16 },
  row: { borderRadius: 12, padding: Spacing.three, gap: 2 },
  clear: { alignItems: 'center', padding: Spacing.three },
});
