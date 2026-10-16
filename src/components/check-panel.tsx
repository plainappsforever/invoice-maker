import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { Document } from '@/db/documents';
import { patchDraft } from '@/db/editing';
import { removeLineVat } from '@/db/lifecycle';
import type { DocumentLine } from '@/db/lines';
import type { CheckItem } from '@/engine/check';
import { todayLocal } from '@/engine/dates';
import { t } from '@/i18n';
import { dateLabel } from '@/lib/format';

const MARK: Record<CheckItem['severity'], string> = { error: '!', warn: '•', info: 'i' };

/**
 * The mandatory-details check (D21, D30): each item is information with its source and a Fix button; the panel
 * always ends with the "information, not advice" line (SPEC §10). Used by the check screen (P4) and the preview (P5).
 */
export function CheckPanel({ items, onFix, busy }: { items: CheckItem[]; onFix: (item: CheckItem, choice?: ServiceChoice) => void; busy?: boolean }) {
  const today = dateLabel(todayLocal());
  const theme = useTheme();
  const color = (s: CheckItem['severity']) => (s === 'error' ? theme.danger : s === 'warn' ? '#B26A00' : theme.tint);
  return (
    <View testID="check-panel" style={styles.panel}>
      {items.length === 0 ? (
        <ThemedText testID="check-none" themeColor="textSecondary">
          {t('check.none')}
        </ThemedText>
      ) : null}
      {items.map((item, i) => (
        <View
          key={`${item.id}-${item.line ?? ''}-${i}`}
          testID={`check-item-${item.id}`}
          style={[styles.item, { backgroundColor: theme.backgroundElement }]}>
          <View style={[styles.mark, { borderColor: color(item.severity) }]}>
            <ThemedText type="smallBold" style={{ color: color(item.severity) }}>
              {MARK[item.severity]}
            </ThemedText>
          </View>
          <View style={styles.body}>
            <ThemedText>{t(`check.${item.id}`, { line: (item.line ?? 0) + 1, date: dateLabel(item.date), today })}</ThemedText>
            {item.sources.length ? (
              <ThemedText type="small" themeColor="textSecondary">
                {t('check.source', { law: item.sources.map((s) => s.law).join(', ') })}
              </ThemedText>
            ) : null}
            {item.id === 'service_date_stale' ? (
              (['today', 'keep'] as const).map((choice) => (
                <Pressable
                  key={choice}
                  testID={`check-fix-service-${choice}`}
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => onFix(item, choice)}
                  style={styles.fix}
                  hitSlop={8}>
                  <ThemedText type="smallBold" themeColor="tint">
                    {t(choice === 'today' ? 'check.fix.serviceToday' : 'check.fix.serviceKeep', { date: dateLabel(item.date), today })}
                  </ThemedText>
                </Pressable>
              ))
            ) : (
            <Pressable
              testID={`check-fix-${item.id}`}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => onFix(item)}
              style={styles.fix}
              hitSlop={8}>
              <ThemedText type="smallBold" themeColor="tint">
                {item.fix === 'lines.removeVat' ? t('check.fix.removeVat') : t('check.fix')}
              </ThemedText>
            </Pressable>
            )}
          </View>
        </View>
      ))}
      <ThemedText type="small" themeColor="textSecondary" testID="check-not-advice">
        {t('check.notAdvice')}
      </ThemedText>
    </View>
  );
}

/**
 * The Fix action of a check item (D59), shared by the check screen and the preview: business → Business form,
 * client → client form (or picker), a line → its line form, `lines.removeVat` → the one-tap fix (D51), anything
 * else → the editor (`back` from the check screen, the editor screen from the preview).
 */
export type ServiceChoice = 'today' | 'keep';

export function useCheckFix(docId: number, reload: () => Promise<void>, other: 'back' | 'editor') {
  const router = useRouter();
  const db = useSQLiteContext();
  return async (item: CheckItem, doc: Document, lines: DocumentLine[], choice?: ServiceChoice) => {
    const editor = () =>
      other === 'back' ? router.back() : router.push({ pathname: '/document/[id]/edit', params: { id: String(docId) } });
    if (item.id === 'service_date_stale' && choice) {
      // Both are explicit choices (D82): today = the draft takes today's date (supply = issue date); keep = the
      // draft's old date becomes the typed date of supply.
      await patchDraft(db, docId, choice === 'today' ? { issueDate: todayLocal() } : { serviceMode: 'date', serviceFrom: doc.issueDate, serviceTo: null });
      return reload();
    }
    switch (item.fix) {
      case 'lines.removeVat':
        await removeLineVat(db, docId);
        return reload();
      case 'business':
      case 'business.address':
      case 'business.taxId':
      case 'business.vatId':
        return router.push('/business');
      case 'client':
      case 'client.address':
      case 'client.vatId':
        return doc.clientId
          ? router.push({ pathname: '/client/[id]', params: { id: String(doc.clientId) } })
          : router.push({ pathname: '/document/[id]/client', params: { id: String(docId) } });
      case 'lines': {
        const line = item.line !== undefined ? lines[item.line] : undefined;
        return line ? router.push({ pathname: '/document/[id]/line', params: { id: String(docId), lineId: String(line.id) } }) : editor();
      }
      default:
        return editor(); // the editor shows the field (dates, texts, discount, currency)
    }
  };
}

const styles = StyleSheet.create({
  panel: { gap: Spacing.two },
  item: { flexDirection: 'row', gap: Spacing.two, padding: Spacing.three, borderRadius: 12 },
  mark: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, gap: 2 },
  fix: { alignSelf: 'flex-start', paddingVertical: 4 },
});
