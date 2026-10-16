import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { addCatalogLine } from '@/db/editing';
import { listCatalogItems } from '@/db/items';
import { formatPrice } from '@/engine/money';
import { useLoader } from '@/hooks/use-loader';
import { useTheme } from '@/hooks/use-theme';
import { getUiLanguage, t } from '@/i18n';

/** Catalog search (F3): one tap on an item adds it as a line (quantity 1); stay and add more, then Done. */
export default function ItemPicker() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const docId = Number(id);
  const router = useRouter();
  const theme = useTheme();
  const [search, setSearch] = useState('');
  const [added, setAdded] = useState<Record<number, number>>({});
  const { data, db } = useLoader((db) => listCatalogItems(db, { search }), search);
  return (
    <View style={[styles.flex, { backgroundColor: theme.background }]}>
      <Stack.Screen options={{ title: t('editor.addItem') }} />
      <FlatList
        testID="item-picker"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
        data={data ?? []}
        keyExtractor={(i) => String(i.id)}
        ListHeaderComponent={
          <TextInput
            testID="item-picker-search"
            accessibilityLabel={t('items.search')}
            placeholder={t('items.search')}
            placeholderTextColor={theme.textSecondary}
            value={search}
            onChangeText={setSearch}
            autoCorrect={false}
            style={[styles.search, { color: theme.text, backgroundColor: theme.backgroundElement }]}
          />
        }
        ListEmptyComponent={
          data ? (
            <View style={styles.empty}>
              <ThemedText themeColor="textSecondary" testID="item-picker-empty">{t('items.empty')}</ThemedText>
              <Button variant="secondary" testID="item-picker-new" label={t('items.new')} onPress={() => router.push({ pathname: '/item/[id]', params: { id: 'new' } })} />
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            testID={`pick-item-${item.id}`}
            accessibilityRole="button"
            onPress={async () => {
              await addCatalogLine(db, docId, item.id);
              setAdded((a) => ({ ...a, [item.id]: (a[item.id] ?? 0) + 1 }));
            }}
            style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement }]}>
            <ThemedText type="smallBold" style={styles.grow}>
              {item.name}
              {added[item.id] ? `  ×${added[item.id]}` : ''}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">{formatPrice(item.priceE4, getUiLanguage())}</ThemedText>
          </Pressable>
        )}
      />
      <View style={[styles.bar, { backgroundColor: theme.background }]}>
        <Button testID="picker-done" label={t('action.done')} onPress={() => router.back()} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: Spacing.three, gap: Spacing.two },
  search: { borderRadius: 10, paddingHorizontal: Spacing.three, minHeight: 44, fontSize: 16, marginBottom: Spacing.one },
  empty: { gap: Spacing.two, alignItems: 'center', marginTop: Spacing.four },
  row: { borderRadius: 12, padding: Spacing.three, flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  grow: { flex: 1 },
  bar: { padding: Spacing.three },
});
