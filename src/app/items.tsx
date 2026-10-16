import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { listCatalogItems } from '@/db/items';
import { useLoader } from '@/hooks/use-loader';
import { useTheme } from '@/hooks/use-theme';
import { formatPrice } from '@/engine/money';
import { getUiLanguage, t } from '@/i18n';

export default function ItemsScreen() {
  const router = useRouter();
  const theme = useTheme();
  const [search, setSearch] = useState('');
  const { data } = useLoader((db) => listCatalogItems(db, { search }), search);
  return (
    <View style={[styles.flex, { backgroundColor: theme.background }]}>
      <Stack.Screen options={{ title: t('settings.items') }} />
      <FlatList
        testID="items-list"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
        data={data ?? []}
        keyExtractor={(i) => String(i.id)}
        ListHeaderComponent={
          <TextInput
            testID="item-search"
            accessibilityLabel={t('items.search')}
            placeholder={t('items.search')}
            placeholderTextColor={theme.textSecondary}
            value={search}
            onChangeText={setSearch}
            autoCorrect={false}
            style={[styles.search, { color: theme.text, backgroundColor: theme.backgroundElement }]}
          />
        }
        ListEmptyComponent={data ? <ThemedText testID="items-empty" themeColor="textSecondary" style={styles.empty}>{t('items.empty')}</ThemedText> : null}
        renderItem={({ item }) => (
          <Pressable
            testID={`item-row-${item.id}`}
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/item/[id]', params: { id: String(item.id) } })}
            style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement }]}>
            <ThemedText type="smallBold" style={styles.grow}>{item.name}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">{formatPrice(item.priceE4, getUiLanguage())}</ThemedText>
          </Pressable>
        )}
      />
      <Pressable
        testID="new-item"
        accessibilityRole="button"
        onPress={() => router.push({ pathname: '/item/[id]', params: { id: 'new' } })}
        style={[styles.fab, { backgroundColor: theme.tint }]}>
        <ThemedText type="smallBold" style={{ color: theme.onTint }}>+ {t('items.new')}</ThemedText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: Spacing.three, gap: Spacing.two, paddingBottom: 100 },
  search: { borderRadius: 10, paddingHorizontal: Spacing.three, minHeight: 40, fontSize: 16, marginBottom: Spacing.one },
  empty: { textAlign: 'center', marginTop: Spacing.five },
  row: { borderRadius: 12, padding: Spacing.three, flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  grow: { flex: 1 },
  fab: { position: 'absolute', right: Spacing.three, bottom: Spacing.three, minHeight: 52, borderRadius: 26, paddingHorizontal: Spacing.four, alignItems: 'center', justifyContent: 'center', elevation: 4 },
});
