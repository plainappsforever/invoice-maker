import { Field } from '@/components/ui';
import { parseBp, parseCents, parsePriceE4, parseQtyMilli, formatAmount, formatPercent, formatPrice, formatQty, type ParseResult } from '@/engine/money';
import { getUiLanguage, t } from '@/i18n';

export type NumberKind = 'cents' | 'price' | 'qty' | 'percent';

const PARSERS: Record<NumberKind, (text: string, lang: 'de' | 'en') => ParseResult> = {
  cents: parseCents,
  price: parsePriceE4,
  qty: parseQtyMilli,
  percent: parseBp,
};
const FORMATTERS: Record<NumberKind, (n: number, lang: 'de' | 'en') => string> = {
  cents: formatAmount,
  price: formatPrice,
  qty: formatQty,
  percent: formatPercent,
};

export function formatNumber(kind: NumberKind, value: number | null): string {
  return value === null ? '' : FORMATTERS[kind](value, getUiLanguage());
}

/** Reads a typed number in the UI language's convention (comma or dot); null = empty/invalid per `ok`. */
export function readNumber(kind: NumberKind, text: string): ParseResult {
  return PARSERS[kind](text, getUiLanguage());
}

/**
 * A number typed with comma or dot (D16: integers inside). Saves while typing when the text is a valid number,
 * shows an error otherwise; empty = `null` when `allowEmpty`.
 */
export function NumberField({
  label,
  kind,
  value,
  onValue,
  allowEmpty,
  min,
  max,
  testID,
  placeholder,
}: {
  label: string;
  kind: NumberKind;
  value: number | null;
  onValue: (value: number | null) => Promise<void> | void;
  allowEmpty?: boolean;
  min?: number;
  max?: number;
  testID?: string;
  placeholder?: string;
}) {
  const valid = (text: string) => {
    if (text.trim() === '') return !!allowEmpty;
    const r = readNumber(kind, text);
    return r.ok && (min === undefined || r.value >= min) && (max === undefined || r.value <= max);
  };
  return (
    <Field
      label={label}
      testID={testID}
      placeholder={placeholder}
      keyboardType="decimal-pad"
      value={formatNumber(kind, value)}
      validate={valid}
      invalidText={t('field.invalidNumber')}
      format={(text) => {
        const r = text.trim() === '' ? null : readNumber(kind, text);
        return r && r.ok ? FORMATTERS[kind](r.value, getUiLanguage()) : text;
      }}
      onSave={(text) => {
        const r = text.trim() === '' ? null : readNumber(kind, text);
        return onValue(r && r.ok ? r.value : null);
      }}
    />
  );
}
