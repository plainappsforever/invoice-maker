import { StyleSheet, Text, View } from 'react-native';

import type { DisplayStatus } from '@/engine/status';
import { t } from '@/i18n';

const COLORS: Record<DisplayStatus, { bg: string; fg: string }> = {
  draft: { bg: '#E3E5E8', fg: '#3C4048' },
  issued: { bg: '#DCEBFF', fg: '#0B4EA2' },
  sent: { bg: '#DCEBFF', fg: '#0B4EA2' },
  partially_paid: { bg: '#FFEBC8', fg: '#8A5300' },
  paid: { bg: '#D9F2DD', fg: '#1B6B2E' },
  overdue: { bg: '#FFDAD6', fg: '#9B1C12' },
  cancelled: { bg: '#E3E5E8', fg: '#3C4048' },
  accepted: { bg: '#D9F2DD', fg: '#1B6B2E' },
  declined: { bg: '#E3E5E8', fg: '#3C4048' },
  invoiced: { bg: '#DCEBFF', fg: '#0B4EA2' },
  expired: { bg: '#FFEBC8', fg: '#8A5300' },
};

export function StatusChip({ status, testID }: { status: DisplayStatus; testID?: string }) {
  const c = COLORS[status];
  return (
    <View testID={testID} accessible accessibilityLabel={t(`status.${status}`)} style={[styles.chip, { backgroundColor: c.bg }]}>
      <Text style={[styles.text, { color: c.fg }]}>{t(`status.${status}`)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' },
  text: { fontSize: 12, fontWeight: '700' },
});
