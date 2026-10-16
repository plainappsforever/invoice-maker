import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEffect, useRef, useState } from 'react';
import { Alert, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { DateField } from '@/components/date-field';
import { NumberField } from '@/components/number-field';
import { ThemedText } from '@/components/themed-text';
import { TotalsSummary } from '@/components/totals-bar';
import { Chip, ChipRow, Divider, Field, FlushProvider, Row, Screen, Section, SwitchRow, useFlushController } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { getBusiness } from '@/db/business';
import { getClient } from '@/db/clients';
import { deleteDocument, getDocument, totalsInputFor, type CustomField } from '@/db/documents';
import { moveDraftLine, patchDraft, setDraftTreatment } from '@/db/editing';
import { onDataChange } from '@/db/changes';
import { checkStoredDocument, issueDocument, IssueBlockedError } from '@/db/lifecycle';
import { listLines } from '@/db/lines';
import { addDays, todayLocal } from '@/engine/dates';
import { formatPercent, formatQty, formatPrice } from '@/engine/money';
import { dueDateError } from '@/engine/status';
import { computeTotals, type DiscountKind, type Totals } from '@/engine/totals';
import { TREATMENTS } from '@/engine/treatment';
import { AttachmentsSection } from '@/components/attachments-section';
import { useLoader } from '@/hooks/use-loader';
import { useTheme } from '@/hooks/use-theme';
import { getUiLanguage, t } from '@/i18n';
import { errorText } from '@/lib/errors';
import { money, unitLabel } from '@/lib/format';

const SERVICE_MODES = ['same', 'date', 'period', 'month', 'none'] as const;
const DUE_CHIPS = [7, 14, 30];
const VALID_CHIPS = [14, 30, 60];
const MAX_CUSTOM = 5;

function parseCustomFields(json: string): CustomField[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => x && typeof x.label === 'string' && typeof x.value === 'string').slice(0, MAX_CUSTOM) : [];
  } catch {
    return [];
  }
}

export default function EditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const docId = Number(id);
  const router = useRouter();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const flush = useFlushController();
  const busy = useRef(false);
  const [issuing, setIssuing] = useState(false);
  const { data, reload, db } = useLoader(async (db) => {
    const doc = await getDocument(db, docId);
    if (!doc) return null;
    const lines = await listLines(db, docId);
    let totals: Totals | null = null;
    try {
      totals = computeTotals(await totalsInputFor(db, docId));
    } catch {
      totals = null; // an amount beyond the engine's range: the check says so
    }
    return { doc, lines, totals, business: await getBusiness(db), client: doc.clientId ? await getClient(db, doc.clientId) : null };
  });

  // A line form saves when it goes away (D84); that write may commit after this screen's focus reload.
  useEffect(() => onDataChange(() => void reload()), [reload]);

  useEffect(() => {
    // An issued document is never edited here (D20); quotes are reopened from their own screen.
    if (data?.doc && data.doc.status !== 'draft') router.replace({ pathname: '/document/[id]', params: { id: String(docId) } });
  }, [data, docId, router]);

  if (!data) return <Screen testID="editor-loading">{null}</Screen>;
  const { doc, lines, totals, business, client } = data;
  const lang = getUiLanguage();
  const today = todayLocal();
  const patch = (p: Parameters<typeof patchDraft>[2]) => async () => {
    await patchDraft(db, docId, p);
    await reload();
  };
  const isInvoice = doc.type === 'invoice';
  const isQuote = doc.type === 'quote';
  const custom = parseCustomFields(doc.customFields);
  const saveCustom = async (next: CustomField[]) => {
    await patchDraft(db, docId, { customFields: JSON.stringify(next) });
    await reload();
  };
  const dueChips = [...new Set([...DUE_CHIPS, ...(doc.paymentDays !== null ? [doc.paymentDays] : [])])].sort((a, b) => a - b);
  const dueIssue = dueDateError(doc.issueDate, doc.dueDate);

  async function goPreview() {
    Keyboard.dismiss();
    // the preview reads the stored draft (write queue keeps the order); an invalid typed value stops it (D85)
    if ((await flush.flushAll()) > 0) return Alert.alert(t('editor.invalidField'), t('editor.invalidFieldBody'));
    router.push({ pathname: '/document/[id]/preview', params: { id: String(docId) } });
  }

  async function issue() {
    if (busy.current) return;
    busy.current = true;
    setIssuing(true);
    try {
      Keyboard.dismiss();
      // typed text is saved before the check reads it (write queue keeps the order); a typed value that is not
      // valid (a date like 10/1/2026, a bad number) was not saved, so Issue would use the old one: refuse (D85)
      if ((await flush.flushAll()) > 0) {
        Alert.alert(t('editor.invalidField'), t('editor.invalidFieldBody'));
        return;
      }
      if ((await checkStoredDocument(db, docId, today)).length > 0) {
        router.push({ pathname: '/document/[id]/check', params: { id: String(docId) } });
        return;
      }
      await issueDocument(db, docId, { today });
      router.replace({ pathname: '/document/[id]', params: { id: String(docId) } });
    } catch (e) {
      if (e instanceof IssueBlockedError) router.push({ pathname: '/document/[id]/check', params: { id: String(docId) } });
      else Alert.alert(t('editor.issueFailed'), errorText(e));
    } finally {
      busy.current = false;
      setIssuing(false);
    }
  }

  function confirmDelete() {
    Alert.alert(t('editor.deleteTitle'), t('editor.deleteBody'), [
      { text: t('action.cancel'), style: 'cancel' },
      {
        text: t('action.delete'),
        style: 'destructive',
        onPress: async () => {
          await deleteDocument(db, docId);
          router.back();
        },
      },
    ]);
  }

  return (
    <FlushProvider controller={flush}>
      <Stack.Screen
        options={{
          title: t(`doc.type.${doc.type}`),
          headerRight: () => (
            <Pressable testID="delete-draft" accessibilityRole="button" onPress={confirmDelete} hitSlop={8}>
              <ThemedText themeColor="danger">{t('action.delete')}</ThemedText>
            </Pressable>
          ),
        }}
      />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={insets.top + 44}>
        <Screen testID="editor-screen" automaticallyAdjustKeyboardInsets={false}>
          <Section title={t('editor.client')}>
            <Row
              testID="client-row"
              title={client?.name ?? t('editor.selectClient')}
              value={client ? [client.postalCode, client.city].filter(Boolean).join(' ') : undefined}
              onPress={() => router.push({ pathname: '/document/[id]/client', params: { id: String(docId) } })}
            />
          </Section>

          <Section title={t('editor.dates')}>
            <DateField label={t('editor.issueDate')} testID="issue-date" value={doc.issueDate} onChange={(v) => (v ? patch({ issueDate: v })() : undefined)} />
            {isInvoice || doc.type === 'receipt' ? (
              <>
                <ChipRow>
                  {SERVICE_MODES.map((m) => (
                    <Chip key={m} testID={`service-${m}`} label={t(`editor.service.${m}`)} selected={doc.serviceMode === m} onPress={patch({ serviceMode: m, ...(m === 'same' || m === 'none' ? { serviceFrom: null, serviceTo: null } : {}) })} />
                  ))}
                </ChipRow>
                {doc.serviceMode === 'date' || doc.serviceMode === 'month' || doc.serviceMode === 'period' ? (
                  <DateField label={doc.serviceMode === 'month' ? t('editor.service.monthDay') : t('editor.service.from')} testID="service-from" value={doc.serviceFrom} onChange={(v) => patch({ serviceFrom: v })()} />
                ) : null}
                {doc.serviceMode === 'period' ? <DateField label={t('editor.service.to')} testID="service-to" value={doc.serviceTo} onChange={(v) => patch({ serviceTo: v })()} /> : null}
              </>
            ) : null}
            {isInvoice ? (
              <>
                <Divider />
                <ThemedText type="small" themeColor="textSecondary" style={styles.chipLabel}>
                  {t('editor.payWithin')}
                </ThemedText>
                <ChipRow>
                  {dueChips.map((d) => (
                    <Chip key={d} testID={`due-${d}`} label={t('editor.days', { n: d })} selected={doc.dueDate === null && doc.paymentDays === d} onPress={patch({ paymentDays: d, dueDate: null })} />
                  ))}
                  <Chip testID="due-custom" label={t('editor.custom')} selected={doc.dueDate !== null} onPress={patch({ dueDate: doc.dueDate ?? addDays(doc.issueDate, doc.paymentDays ?? 14) })} />
                </ChipRow>
                {doc.dueDate !== null ? (
                  <DateField label={t('editor.dueDate')} testID="due-date" value={doc.dueDate} error={dueIssue === 'before_issue' ? t('check.due_before_issue') : null} onChange={(v) => (v ? patch({ dueDate: v })() : undefined)} />
                ) : null}
              </>
            ) : null}
            {isQuote ? (
              <>
                <ChipRow>
                  {VALID_CHIPS.map((d) => (
                    <Chip key={d} testID={`valid-${d}`} label={t('editor.days', { n: d })} selected={doc.validUntil === addDays(doc.issueDate, d)} onPress={patch({ validUntil: addDays(doc.issueDate, d) })} />
                  ))}
                </ChipRow>
                <DateField label={t('editor.validUntil')} testID="valid-until" value={doc.validUntil} allowEmpty onChange={(v) => patch({ validUntil: v })()} />
              </>
            ) : null}
          </Section>

          <Section title={t('editor.lines')}>
            {lines.length === 0 ? (
              <ThemedText themeColor="textSecondary" style={styles.pad} testID="lines-empty">
                {t('editor.noLines')}
              </ThemedText>
            ) : null}
            {lines.map((l, i) => (
              <View key={l.id}>
                {i > 0 ? <Divider /> : null}
                <View style={styles.lineWrap}>
                  <Pressable
                    testID={`line-${i}`}
                    accessibilityRole="button"
                    accessibilityLabel={l.name}
                    style={styles.lineMain}
                    onPress={() => router.push({ pathname: '/document/[id]/line', params: { id: String(docId), lineId: String(l.id) } })}>
                    <ThemedText type="smallBold" numberOfLines={2}>{l.name || t('editor.unnamedLine')}</ThemedText>
                    <ThemedText type="small" themeColor="textSecondary">
                      {formatQty(l.qtyMilli, lang)} {unitLabel(l.unitCode)} × {formatPrice(l.priceE4, lang)}
                      {l.taxRateBp > 0 ? ` · ${formatPercent(l.taxRateBp, lang)} %` : l.taxCategory !== 'S' ? ` · ${l.taxCategory}` : ''}
                      {l.discountKind !== 'none' ? ` · −${l.discountKind === 'percent' ? `${formatPercent(l.discountValue, lang)} %` : money(l.discountValue, doc.currency)}` : ''}
                    </ThemedText>
                  </Pressable>
                  <ThemedText type="smallBold" testID={`line-amount-${i}`}>{money(l.netCents, doc.currency)}</ThemedText>
                  <View style={styles.arrows}>
                    <Pressable testID={`line-up-${i}`} accessibilityLabel={t('editor.moveUp')} hitSlop={6} disabled={i === 0} onPress={async () => { await moveDraftLine(db, docId, l.id, -1); await reload(); }}>
                      <ThemedText themeColor={i === 0 ? 'textSecondary' : 'tint'}>▲</ThemedText>
                    </Pressable>
                    <Pressable testID={`line-down-${i}`} accessibilityLabel={t('editor.moveDown')} hitSlop={6} disabled={i === lines.length - 1} onPress={async () => { await moveDraftLine(db, docId, l.id, 1); await reload(); }}>
                      <ThemedText themeColor={i === lines.length - 1 ? 'textSecondary' : 'tint'}>▼</ThemedText>
                    </Pressable>
                  </View>
                </View>
              </View>
            ))}
            <View style={styles.buttons}>
              <View style={styles.flex}>
                <Button testID="add-item" variant="secondary" label={t('editor.addItem')} onPress={() => router.push({ pathname: '/document/[id]/items', params: { id: String(docId) } })} />
              </View>
              <View style={styles.flex}>
                <Button testID="add-line" variant="secondary" label={t('editor.addLine')} onPress={() => router.push({ pathname: '/document/[id]/line', params: { id: String(docId), lineId: 'new' } })} />
              </View>
            </View>
          </Section>

          <Section title={t('editor.amounts')}>
            <SwitchRow testID="gross-switch" label={t('editor.pricesIncludeVat')} value={doc.pricesIncludeVat} onValueChange={(v) => patch({ pricesIncludeVat: v })()} />
            <ChipRow>
              {(['none', 'percent', 'amount'] as DiscountKind[]).map((k) => (
                <Chip key={k} testID={`discount-${k}`} label={t(`editor.discount.${k}`)} selected={doc.discountKind === k} onPress={patch({ discountKind: k, discountValue: k === doc.discountKind ? doc.discountValue : 0 })} />
              ))}
            </ChipRow>
            {doc.discountKind !== 'none' ? (
              <NumberField label={doc.discountKind === 'percent' ? t('editor.discount.percentValue') : t('editor.discount.amountValue')} testID="discount-value" kind={doc.discountKind === 'percent' ? 'percent' : 'cents'} value={doc.discountValue === 0 ? null : doc.discountValue} allowEmpty min={0} max={doc.discountKind === 'percent' ? 10_000 : undefined} onValue={(v) => patch({ discountValue: v ?? 0 })()} />
            ) : null}
            {isInvoice ? <NumberField label={t('editor.deposit')} testID="deposit" kind="cents" value={doc.depositCents} allowEmpty min={0} onValue={(v) => patch({ depositCents: v })()} /> : null}
          </Section>

          <Section title={t('editor.treatment')} hint={business.vatMode === 'small_business' ? t('editor.vatSmallBusiness') : undefined}>
            <ChipRow>
              {TREATMENTS.map((tr) => (
                <Chip key={tr} testID={`treatment-${tr}`} label={t(`treatment.${tr}`)} selected={doc.treatment === tr} onPress={async () => { await setDraftTreatment(db, docId, tr); await reload(); }} />
              ))}
            </ChipRow>
            <Field label={t('editor.legalNote')} testID="text-legal" multiline maxLength={1500} value={doc.legalNote} onSave={(v) => patch({ legalNote: v })()} />
          </Section>

          <Section title={t('editor.texts')}>
            <Field label={t('texts.intro')} testID="text-intro" multiline maxLength={1500} value={doc.intro} onSave={(v) => patch({ intro: v })()} />
            <Field label={t('texts.notes')} testID="text-notes" multiline maxLength={1500} value={doc.notes} onSave={(v) => patch({ notes: v })()} />
            <Field label={t('texts.payment')} testID="text-payment" multiline maxLength={1500} value={doc.paymentText} onSave={(v) => patch({ paymentText: v })()} />
            <Field label={t('texts.footer')} testID="text-footer" multiline maxLength={1500} value={doc.footer} onSave={(v) => patch({ footer: v })()} />
          </Section>

          <Section title={t('editor.details')}>
            <Field label={t('editor.reference')} testID="reference" value={doc.reference} onSave={(v) => patch({ reference: v.trim() })()} />
            <Field label={t('field.buyerReference')} testID="buyer-reference" value={doc.buyerReference} onSave={(v) => patch({ buyerReference: v.trim() })()} />
            {custom.map((c, i) => (
              <View key={i}>
                <Divider />
                <Field label={t('editor.customLabel', { n: i + 1 })} testID={`custom-label-${i}`} value={c.label} onSave={(v) => saveCustom(custom.map((x, j) => (j === i ? { ...x, label: v } : x)))} />
                <Field label={t('editor.customValue', { n: i + 1 })} testID={`custom-value-${i}`} value={c.value} onSave={(v) => saveCustom(custom.map((x, j) => (j === i ? { ...x, value: v } : x)))} />
                <Row testID={`custom-remove-${i}`} title={t('editor.customRemove')} danger onPress={() => saveCustom(custom.filter((_, j) => j !== i))} />
              </View>
            ))}
            {custom.length < MAX_CUSTOM ? <Row testID="custom-add" title={t('editor.customAdd')} onPress={() => saveCustom([...custom, { label: '', value: '' }])} /> : null}
          </Section>
          {doc.type !== 'cancellation' ? <AttachmentsSection docId={docId} draft onChanged={() => void reload()} /> : null}
        </Screen>

        <View style={[styles.bar, { borderTopColor: theme.backgroundSelected, backgroundColor: theme.background }]}>
          {totals ? <TotalsSummary totals={totals} currency={doc.currency} /> : null}
          <View style={styles.buttons}>
            <View style={styles.flex}>
              <Button testID="preview-button" variant="secondary" label={t('editor.preview')} onPress={goPreview} />
            </View>
            <View style={styles.flex}>
              <Button testID="issue-button" label={isQuote ? t('editor.issueQuote') : t('editor.issue')} disabled={issuing} onPress={issue} />
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </FlushProvider>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pad: { padding: Spacing.three },
  chipLabel: { paddingHorizontal: Spacing.three },
  lineWrap: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two },
  lineMain: { flex: 1, gap: 2, minHeight: 44, justifyContent: 'center' },
  arrows: { gap: 6 },
  buttons: { flexDirection: 'row', gap: Spacing.two, padding: Spacing.two },
  bar: { borderTopWidth: StyleSheet.hairlineWidth },
});
