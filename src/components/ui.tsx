// Small shared UI pieces (P4): sections, rows, chips, switches, inputs with autosave. No business logic.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type ScrollViewProps,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** Scrolling form page: taps on buttons never dismiss the keyboard before the tap lands. */
export function Screen({ children, testID, ...rest }: ScrollViewProps & { children: ReactNode }) {
  const theme = useTheme();
  return (
    <ScrollView
      testID={testID}
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      keyboardDismissMode="on-drag"
      {...rest}>
      {children}
    </ScrollView>
  );
}

export function Section({ title, children, hint }: { title?: string; children: ReactNode; hint?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      {title ? (
        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
          {title.toUpperCase()}
        </ThemedText>
      ) : null}
      <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>{children}</View>
      {hint ? (
        <ThemedText type="small" themeColor="textSecondary" style={styles.hint}>
          {hint}
        </ThemedText>
      ) : null}
    </View>
  );
}

export function Row({
  title,
  value,
  onPress,
  testID,
  danger,
  right,
  accessibilityLabel,
}: {
  title: string;
  value?: string;
  onPress?: () => void;
  testID?: string;
  danger?: boolean;
  right?: ReactNode;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.backgroundSelected }]}>
      <ThemedText style={[styles.rowTitle, danger && { color: theme.danger }]}>{title}</ThemedText>
      {value ? (
        <ThemedText themeColor="textSecondary" numberOfLines={1} style={styles.rowValue}>
          {value}
        </ThemedText>
      ) : null}
      {right}
      {onPress && !right ? <ThemedText themeColor="textSecondary">›</ThemedText> : null}
    </Pressable>
  );
}

export function Divider() {
  const theme = useTheme();
  return <View style={[styles.divider, { backgroundColor: theme.backgroundSelected }]} />;
}

export function Chip({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      style={[styles.chip, { backgroundColor: selected ? theme.tint : theme.backgroundSelected }]}>
      <Text style={{ color: selected ? theme.onTint : theme.text, fontWeight: '600', fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

export function ChipRow({ children }: { children: ReactNode }) {
  return <View style={styles.chipRow}>{children}</View>;
}

export function SwitchRow({
  label,
  value,
  onValueChange,
  testID,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  testID?: string;
}) {
  return (
    <View style={styles.row}>
      <ThemedText style={styles.rowTitle}>{label}</ThemedText>
      <Switch testID={testID} value={value} onValueChange={onValueChange} accessibilityLabel={label} />
    </View>
  );
}

export function Label({ children }: { children: string }) {
  return (
    <ThemedText type="small" themeColor="textSecondary" style={styles.label}>
      {children}
    </ThemedText>
  );
}

export function ErrorText({ children, testID }: { children?: string | null; testID?: string }) {
  const theme = useTheme();
  if (!children) return null;
  return (
    <ThemedText testID={testID} type="small" style={[styles.errorText, { color: theme.danger }]}>
      {children}
    </ThemedText>
  );
}

// --- autosave -------------------------------------------------------------------------------------

/** Saves a field's pending text; resolves false when the typed text is invalid and was NOT saved (D85). */
type Flush = () => Promise<boolean> | boolean;
const FlushContext = createContext<{ add: (f: Flush) => () => void; flushAll: () => Promise<number> } | null>(null);

/**
 * Collects the pending autosaves of the fields below it; `flushAll()` saves them all before Issue/Check and returns
 * how many fields hold typed text that is invalid and therefore not saved (review #8: Issue must not go on with the
 * old stored value).
 */
export function FlushProvider({ children, controller }: { children: ReactNode; controller: ReturnType<typeof useFlushController> }) {
  return <FlushContext.Provider value={controller}>{children}</FlushContext.Provider>;
}

export function useFlushController() {
  const set = useRef(new Set<Flush>());
  const add = useCallback((f: Flush) => {
    set.current.add(f);
    return () => {
      set.current.delete(f);
    };
  }, []);
  const flushAll = useCallback(async () => {
    let invalid = 0;
    for (const f of [...set.current]) if (!(await f())) invalid++;
    return invalid;
  }, []);
  return { add, flushAll };
}

export const AUTOSAVE_MS = 400;

/**
 * Text that is kept locally while typing and written through `onSave` 400 ms after the last key, on blur, and when
 * the screen goes away (SPEC §10: draft autosave ≤ 500 ms). `validate` may refuse a value (nothing is saved).
 */
export function useAutosave(value: string, onSave: (text: string) => Promise<void> | void, validate?: (text: string) => boolean) {
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  const dirty = useRef(false);
  const latest = useRef({ text, onSave, validate });
  useEffect(() => {
    latest.current = { text, onSave, validate };
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current) return true;
    const { text: current, onSave: save, validate: ok } = latest.current;
    if (ok && !ok(current)) return false; // flagged under the field; Issue/Preview refuse (D85)
    try {
      await save(current);
    } catch (e) {
      // Stays dirty, so the next flush (or Issue's flushAll, which then refuses) tries again (review #28).
      if (__DEV__) console.warn('autosave failed', e);
      return false;
    }
    if (latest.current.text === current) dirty.current = false; // typed on while saving: still dirty
    return true;
  }, []);
  const flushCtx = useContext(FlushContext);
  useEffect(() => flushCtx?.add(flush), [flushCtx, flush]);
  useEffect(
    () => () => {
      void flush(); // leaving the screen never loses typed text
    },
    [flush]
  );
  // External changes (reload after another save) show up while the field is not being edited.
  useEffect(() => {
    if (!focused && !dirty.current) setText(value);
  }, [value, focused]);
  const change = (next: string) => {
    setText(next);
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  };
  return {
    text,
    setText,
    change,
    onFocus: () => setFocused(true),
    onBlur: () => {
      setFocused(false);
      void flush();
    },
    flush,
    focused,
  };
}

export type FieldProps = {
  label: string;
  value: string;
  onSave: (text: string) => Promise<void> | void;
  validate?: (text: string) => boolean;
  /** Error shown under the field. */
  error?: string | null;
  /** Shown under the field while `validate` refuses the typed text. */
  invalidText?: string;
  testID?: string;
  multiline?: boolean;
  keyboardType?: KeyboardTypeOptions;
  placeholder?: string;
  maxLength?: number;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  /** Text shown after a successful blur (e.g. reformatted number). */
  format?: (text: string) => string;
  style?: StyleProp<ViewStyle>;
  inputStyle?: TextInputProps['style'];
};

/** Labelled text input with autosave. */
export function Field({
  label,
  value,
  onSave,
  validate,
  error,
  invalidText,
  testID,
  multiline,
  keyboardType,
  placeholder,
  maxLength,
  autoCapitalize,
  format,
  style,
}: FieldProps) {
  const theme = useTheme();
  const a = useAutosave(value, onSave, validate);
  const invalid = !!error || (validate ? !validate(a.text) : false);
  return (
    <View style={[styles.field, style]}>
      <Label>{label}</Label>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={a.text}
        onChangeText={a.change}
        onFocus={a.onFocus}
        onBlur={() => {
          a.onBlur();
          if (format && (!validate || validate(a.text))) a.setText(format(a.text));
        }}
        multiline={multiline}
        keyboardType={keyboardType}
        placeholder={placeholder}
        placeholderTextColor={theme.textSecondary}
        maxLength={maxLength}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        style={[
          styles.input,
          multiline && styles.multiline,
          { color: theme.text, backgroundColor: theme.background, borderColor: invalid ? theme.danger : theme.backgroundSelected },
        ]}
      />
      <ErrorText>{error ?? (invalid ? invalidText : null)}</ErrorText>
    </View>
  );
}

/** Plain controlled input (forms with an explicit Save button). */
export function Input({
  label,
  value,
  onChangeText,
  testID,
  multiline,
  keyboardType,
  placeholder,
  error,
  autoCapitalize,
  maxLength,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  testID?: string;
  multiline?: boolean;
  keyboardType?: KeyboardTypeOptions;
  placeholder?: string;
  error?: string | null;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  maxLength?: number;
}) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <Label>{label}</Label>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        multiline={multiline}
        keyboardType={keyboardType}
        placeholder={placeholder}
        placeholderTextColor={theme.textSecondary}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        maxLength={maxLength}
        style={[
          styles.input,
          multiline && styles.multiline,
          { color: theme.text, backgroundColor: theme.background, borderColor: error ? theme.danger : theme.backgroundSelected },
        ]}
      />
      <ErrorText>{error}</ErrorText>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { padding: Spacing.three, gap: Spacing.three, paddingBottom: Spacing.six },
  section: { gap: Spacing.one },
  sectionTitle: { marginLeft: Spacing.two, letterSpacing: 0.5 },
  card: { borderRadius: 14, overflow: 'hidden', paddingVertical: Spacing.one },
  hint: { marginHorizontal: Spacing.two },
  row: {
    minHeight: 48,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  rowTitle: { flexShrink: 1 },
  rowValue: { flex: 1, textAlign: 'right' },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: Spacing.three },
  chip: { minHeight: 36, borderRadius: 18, paddingHorizontal: Spacing.three, justifyContent: 'center', alignItems: 'center' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two },
  label: { marginBottom: 2 },
  field: { paddingHorizontal: Spacing.three, paddingVertical: Spacing.one },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: Spacing.two, paddingVertical: 10, fontSize: 16, minHeight: 44 },
  multiline: { minHeight: 88, textAlignVertical: 'top' },
  errorText: { marginTop: 2 },
});
