import { useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { listClients } from '@/db/clients';
import { useLoader } from '@/hooks/use-loader';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/i18n';

export default function ClientsScreen() {
  const router = useRouter();
  const theme = useTheme();
  const [search, setSearch] = useState('');
  const { data } = useLoader((db) => listClients(db, { search }), search);
  return (
    <View style={[styles.flex, { backgroundColor: theme.background }]}>
      <FlatList
        testID="clients-list"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
        data={data ?? []}
        keyExtractor={(c) => String(c.id)}
        ListHeaderComponent={
          <TextInput
            testID="client-search"
            accessibilityLabel={t('clients.search')}
            placeholder={t('clients.search')}
            placeholderTextColor={theme.textSecondary}
            value={search}
            onChangeText={setSearch}
            autoCorrect={false}
            style={[styles.search, { color: theme.text, backgroundColor: theme.backgroundElement }]}
          />
        }
        ListEmptyComponent={
          data ? (
            <ThemedText testID="clients-empty" themeColor="textSecondary" style={styles.empty}>
              {t('clients.empty')}
            </ThemedText>
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            testID={`client-row-${item.id}`}
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/client/[id]', params: { id: String(item.id) } })}
            style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement }]}>
            <ThemedText type="smallBold">{item.name}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
              {[item.postalCode, item.city].filter(Boolean).join(' ') || item.email || t('clients.noAddress')}
            </ThemedText>
          </Pressable>
        )}
      />
      <Pressable
        testID="new-client"
        accessibilityRole="button"
        onPress={() => router.push({ pathname: '/client/[id]', params: { id: 'new' } })}
        style={[styles.fab, { backgroundColor: theme.tint }]}>
        <ThemedText type="smallBold" style={{ color: theme.onTint }}>
          + {t('clients.new')}
        </ThemedText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: Spacing.three, gap: Spacing.two, paddingBottom: 100 },
  search: { borderRadius: 10, paddingHorizontal: Spacing.three, minHeight: 40, fontSize: 16, marginBottom: Spacing.one },
  empty: { textAlign: 'center', marginTop: Spacing.five },
  row: { borderRadius: 12, padding: Spacing.three, gap: 2 },
  fab: {
    position: 'absolute',
    right: Spacing.three,
    bottom: Spacing.three,
    minHeight: 52,
    borderRadius: 26,
    paddingHorizontal: Spacing.four,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
});
