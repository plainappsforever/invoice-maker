import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatPercent } from '@/engine/money';
import type { Totals } from '@/engine/totals';
import { getUiLanguage, t } from '@/i18n';
import { money } from '@/lib/format';

/** Net, VAT per rate and the total, always visible above the buttons of the editor (SPEC §6). */
export function TotalsSummary({ totals, currency }: { totals: Totals; currency: string }) {
  const theme = useTheme();
  const vatGroups = totals.groups.filter((g) => g.tax !== 0);
  const lang = getUiLanguage();
  return (
    <View style={[styles.box, { backgroundColor: theme.backgroundElement }]}>
      <View style={styles.line}>
        <ThemedText type="small" themeColor="textSecondary">
          {t('totals.net')}
        </ThemedText>
        <ThemedText type="small" testID="totals-net">
          {money(totals.net, currency)}
        </ThemedText>
      </View>
      {vatGroups.map((g) => (
        <View key={`${g.category}-${g.rateBp}`} style={styles.line}>
          <ThemedText type="small" themeColor="textSecondary">
            {t('totals.vat', { rate: formatPercent(g.rateBp, lang) })}
          </ThemedText>
          <ThemedText type="small" testID={`totals-vat-${g.rateBp}`}>
            {money(g.tax, currency)}
          </ThemedText>
        </View>
      ))}
      <View style={styles.line}>
        <ThemedText type="smallBold">{t('totals.total')}</ThemedText>
        <ThemedText type="smallBold" testID="totals-gross" style={styles.total}>
          {money(totals.gross, currency)}
        </ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { paddingHorizontal: Spacing.three, paddingVertical: Spacing.two, gap: 2 },
  line: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  total: { fontSize: 18 },
});
