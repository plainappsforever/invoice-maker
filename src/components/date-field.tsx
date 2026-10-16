import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Field } from '@/components/ui';
import { parseIsoDate, toIsoDate } from '@/engine/dates';
import { t } from '@/i18n';
import { dateInputText, parseDateInput } from '@/lib/format';

/**
 * A date typed as 01.10.2026 (German UI) or 2026-10-01 (English UI), or picked with the system date picker.
 * Autosaves like every other field; an impossible date is flagged and not saved (SPEC §10).
 */
export function DateField({
  label,
  value,
  onChange,
  allowEmpty,
  testID,
  error,
}: {
  label: string;
  value: string | null;
  onChange: (iso: string | null) => Promise<void> | void;
  allowEmpty?: boolean;
  testID?: string;
  error?: string | null;
}) {
  const [showIos, setShowIos] = useState(false);
  const current = value && parseIsoDate(value) ? parseIsoDate(value)! : null;
  const date = current ? new Date(current.y, current.m - 1, current.d) : new Date();
  const pick = (d?: Date) => {
    if (d) void onChange(toIsoDate(d.getFullYear(), d.getMonth() + 1, d.getDate()));
  };
  return (
    <View>
      <Field
        label={label}
        testID={testID}
        value={dateInputText(value)}
        validate={(text) => (allowEmpty && text.trim() === '') || parseDateInput(text) !== null}
        invalidText={t('field.invalidDate')}
        error={error}
        autoCapitalize="none"
        onSave={(text) => onChange(text.trim() === '' ? null : parseDateInput(text))}
      />
      <Pressable
        testID={testID ? `${testID}-pick` : undefined}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${t('date.pick')}`}
        style={styles.pick}
        hitSlop={8}
        onPress={() => {
          if (Platform.OS === 'android') {
            DateTimePickerAndroid.open({ value: date, mode: 'date', onChange: (e, d) => e.type === 'set' && pick(d) });
          } else {
            setShowIos((s) => !s);
          }
        }}>
        <ThemedText type="small" themeColor="tint">
          {t('date.pick')}
        </ThemedText>
      </Pressable>
      {showIos && Platform.OS === 'ios' ? (
        <DateTimePicker
          value={date}
          mode="date"
          display="inline"
          onChange={(_e, d) => {
            pick(d);
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pick: { position: 'absolute', right: 16, top: 6 },
});
