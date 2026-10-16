import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { StatusChip } from '@/components/status-chip';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { getBusiness } from '@/db/business';
import { newDraft } from '@/db/lifecycle';
import { listDocumentRows, TAB_TYPES, type DocumentRow } from '@/db/list';
import { homeSummary, type CurrencyAmount } from '@/db/summary';
import { todayLocal } from '@/engine/dates';
import { useLoader } from '@/hooks/use-loader';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/i18n';
import { dateLabel, money } from '@/lib/format';

type Tab = keyof typeof TAB_TYPES;
const NEW_TYPE = { invoices: 'invoice', quotes: 'quote', receipts: 'receipt' } as const;

function AmountLines({ list, testID }: { list: CurrencyAmount[]; testID: string }) {
  return (
    <View>
      {(list.length ? list : [{ currency: 'EUR', cents: 0, count: 0 }]).map((a) => (
        <ThemedText key={a.currency} type="smallBold" testID={`${testID}-${a.currency}`}>
          {money(a.cents, a.currency)}
        </ThemedText>
      ))}
    </View>
  );
}

/** The Documents screen of one tab (SPEC §6): summary strip, search, rows, one-tap "New". */
export function DocumentList({ tab }: { tab: Tab }) {
  const router = useRouter();
  const theme = useTheme();
  const [search, setSearch] = useState('');
  const busy = useRef(false);
  const { data, db } = useLoader(
    async (db) => {
      const today = todayLocal();
      const [rows, summary, business] = await Promise.all([
        listDocumentRows(db, TAB_TYPES[tab], today, search),
        tab === 'invoices' ? homeSummary(db, today) : Promise.resolve(null),
        getBusiness(db),
      ]);
      return { rows, summary, business };
    },
    search
  );

  async function create() {
    if (busy.current) return;
    busy.current = true;
    try {
      const id = await newDraft(db, { type: NEW_TYPE[tab], today: todayLocal() });
      router.push({ pathname: '/document/[id]/edit', params: { id: String(id) } });
    } finally {
      busy.current = false;
    }
  }

  function open(row: DocumentRow) {
    router.push({ pathname: row.status === 'draft' ? '/document/[id]/edit' : '/document/[id]', params: { id: String(row.id) } });
  }

  const header = (
    <View style={styles.header}>
      {data?.business.name.trim() === '' && !search ? (
        <Pressable
          testID="setup-card"
          accessibilityRole="button"
          onPress={() => router.push('/business')}
          style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
          <ThemedText type="smallBold">{t('documents.setup')}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {t('documents.setup.hint')}
          </ThemedText>
        </Pressable>
      ) : null}
      {data?.summary ? (
        <View testID="summary-strip" style={styles.strip}>
          {(
            [
              ['outstanding', data.summary.outstanding],
              ['overdue', data.summary.overdue],
              ['paid', data.summary.paidThisMonth],
            ] as const
          ).map(([key, list]) => (
            <View key={key} style={[styles.tile, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="small" themeColor="textSecondary">
                {t(`summary.${key}`)}
              </ThemedText>
              <AmountLines list={list} testID={`summary-${key}`} />
            </View>
          ))}
        </View>
      ) : null}
      <TextInput
        testID="search"
        accessibilityLabel={t('documents.search')}
        placeholder={t('documents.search')}
        placeholderTextColor={theme.textSecondary}
        value={search}
        onChangeText={setSearch}
        autoCorrect={false}
        autoCapitalize="none"
        clearButtonMode="while-editing"
        style={[styles.search, { color: theme.text, backgroundColor: theme.backgroundElement }]}
      />
    </View>
  );

  return (
    <View style={[styles.flex, { backgroundColor: theme.background }]}>
      <FlatList
        testID={`list-${tab}`}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
        data={data?.rows ?? []}
        keyExtractor={(row) => String(row.id)}
        ListHeaderComponent={header}
        ListEmptyComponent={
          data ? (
            <ThemedText testID="documents-empty" themeColor="textSecondary" style={styles.empty}>
              {search ? t('documents.noMatch') : t(`documents.empty.${tab}`)}
            </ThemedText>
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            testID={`doc-row-${item.id}`}
            accessibilityRole="button"
            onPress={() => open(item)}
            style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement }]}>
            <View style={styles.rowMain}>
              <ThemedText type="smallBold">
                {item.number ?? t('status.draft')}
                {item.type === 'cancellation' ? ` · ${t('doc.type.cancellation')}` : ''}
              </ThemedText>
              <ThemedText numberOfLines={1} themeColor="textSecondary" type="small">
                {item.clientName || t('documents.noClient')} · {dateLabel(item.issueDate)}
              </ThemedText>
              <StatusChip status={item.derived.status} />
            </View>
            <ThemedText type="smallBold">{money(item.grossCents, item.currency)}</ThemedText>
          </Pressable>
        )}
      />
      <Pressable
        testID="new-document"
        accessibilityRole="button"
        accessibilityLabel={t(`documents.new.${tab}`)}
        onPress={create}
        style={[styles.fab, { backgroundColor: theme.tint }]}>
        <ThemedText type="smallBold" style={{ color: theme.onTint }}>
          + {t(`documents.new.${tab}`)}
        </ThemedText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: Spacing.three, gap: Spacing.two, paddingBottom: 100 },
  header: { gap: Spacing.two, marginBottom: Spacing.one },
  card: { padding: Spacing.three, borderRadius: 12, gap: 2 },
  strip: { flexDirection: 'row', gap: Spacing.two },
  tile: { flex: 1, borderRadius: 12, padding: Spacing.two, gap: 2 },
  search: { borderRadius: 10, paddingHorizontal: Spacing.three, minHeight: 40, fontSize: 16 },
  empty: { textAlign: 'center', marginTop: Spacing.five },
  row: { borderRadius: 12, padding: Spacing.three, flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  rowMain: { flex: 1, gap: 2 },
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
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
});
