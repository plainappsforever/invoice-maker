import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useRef, useState } from 'react';

import { Button } from '@/components/button';
import { DateField } from '@/components/date-field';
import { formatNumber, readNumber } from '@/components/number-field';
import { Chip, ChipRow, ErrorText, FlushProvider, Input, Screen, Section, useFlushController } from '@/components/ui';
import { getDocument } from '@/db/documents';
import { addPayment, listPayments, type PaymentMethod } from '@/db/payments';
import { todayLocal } from '@/engine/dates';
import { useLoader } from '@/hooks/use-loader';
import { t } from '@/i18n';
import { errorText } from '@/lib/errors';
import { money } from '@/lib/format';

const METHODS: readonly PaymentMethod[] = ['bank', 'cash', 'card', 'paypal', 'other'];

/**
 * Record payment (SPEC §6/§7 flow 4): the amount is prefilled with the balance, so the full payment is one tap on Save;
 * a part payment or an overpayment is just a different amount (exact cents, D16). The date is today unless changed.
 */
export default function PaymentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const docId = Number(id);
  const { data } = useLoader(async (db) => {
    const doc = await getDocument(db, docId);
    if (!doc) return null;
    const paid = (await listPayments(db, docId)).reduce((sum, p) => sum + p.amountCents, 0);
    return { currency: doc.currency, number: doc.number, balance: doc.grossCents - paid };
  });
  if (!data) return <Screen testID="payment-loading">{null}</Screen>;
  return <PaymentForm docId={docId} currency={data.currency} number={data.number} balance={data.balance} />;
}

function PaymentForm({ docId, currency, number, balance }: { docId: number; currency: string; number: string | null; balance: number }) {
  const router = useRouter();
  const db = useSQLiteContext();
  const flush = useFlushController();
  const initial = balance > 0 ? balance : null;
  const [amountText, setAmountText] = useState(formatNumber('cents', initial));
  const [note, setNote] = useState('');
  const [date, setDateState] = useState<string | null>(todayLocal());
  const [method, setMethod] = useState<PaymentMethod>('bank');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The date field autosaves: its flush runs right before Save reads the value, so the latest value lives in a ref too.
  const dateRef = useRef<string | null>(todayLocal());
  const parsed = amountText.trim() === '' ? null : readNumber('cents', amountText);
  const amount = parsed && parsed.ok ? parsed.value : null;
  const setDate = (v: string | null) => {
    dateRef.current = v;
    setDateState(v);
  };

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      if ((await flush.flushAll()) > 0) {
        setError(t('editor.invalidFieldBody')); // e.g. a typed date that is not a date: never record today instead (D85)
        return;
      }
      if (amount === null || amount === 0) {
        setError(t('payment.amountInvalid'));
        return;
      }
      await addPayment(db, docId, { date: dateRef.current ?? todayLocal(), amountCents: amount, method, note: note.trim() });
      router.back();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen testID="payment-screen">
      <Stack.Screen options={{ title: t('payment.record') }} />
      <FlushProvider controller={flush}>
        <Section title={number ?? ''} hint={balance > 0 ? `${t('payment.balance')}: ${money(balance, currency)}` : undefined}>
          <Input label={t('payment.amount')} testID="payment-amount" keyboardType="decimal-pad" value={amountText} onChangeText={setAmountText} error={parsed && !parsed.ok ? t('field.invalidNumber') : null} />
          {amount !== null && amount > 0 && amount > Math.max(balance, 0) ? <ErrorText testID="payment-overpaid">{t('payment.overpaidHint')}</ErrorText> : null}
          <DateField label={t('payment.date')} testID="payment-date" value={date} onChange={setDate} />
          <ChipRow>
            {METHODS.map((m) => (
              <Chip key={m} testID={`payment-method-${m}`} label={t(`payment.method.${m}`)} selected={method === m} onPress={() => setMethod(m)} />
            ))}
          </ChipRow>
          <Input label={t('payment.note')} testID="payment-note" value={note} onChangeText={setNote} />
        </Section>
        <ErrorText testID="payment-error">{error}</ErrorText>
        <Button testID="payment-save" label={t('payment.save')} onPress={save} disabled={busy} />
      </FlushProvider>
    </Screen>
  );
}
