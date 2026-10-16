import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { AttachmentsSection } from '@/components/attachments-section';
import { Button } from '@/components/button';
import { SignatureView } from '@/components/signature-pad';
import { DocumentWeb } from '@/components/document-web';
import { SendActions } from '@/components/send-actions';
import { StatusChip } from '@/components/status-chip';
import { ThemedText } from '@/components/themed-text';
import { TotalsSummary } from '@/components/totals-bar';
import { Divider, Row, Screen, Section } from '@/components/ui';
import { getDocumentSignature } from '@/db/attachments';
import { deleteDocument, getDocument, totalsInputFor } from '@/db/documents';
import { acceptQuote, cancelInvoice, convertQuote, createPaymentReceipt, declineQuote, documentStatus, duplicateDocument, PaymentReceiptFullError, reopenQuote } from '@/db/lifecycle';
import { getClient } from '@/db/clients';
import { listLines } from '@/db/lines';
import { relatedDocuments } from '@/db/list';
import { addPayment, deletePayment, listPayments, type Payment } from '@/db/payments';
import { todayLocal } from '@/engine/dates';
import { formatPercent, formatPrice, formatQty } from '@/engine/money';
import { can } from '@/engine/status';
import { parseSignature } from '@/engine/signature';
import { computeTotals } from '@/engine/totals';
import { useLoader } from '@/hooks/use-loader';
import { getUiLanguage, t } from '@/i18n';
import { dateLabel, money, unitLabel } from '@/lib/format';
import { errorText } from '@/lib/errors';
import { documentHtml, documentPdf, signedQuotePdf } from '@/lib/pdf';
import { sharePdf } from '@/lib/send';
import { askOnceForReminders } from '@/lib/reminders';

/**
 * An issued document (SPEC §6 "Document"): number, status, balance, lines, totals and the lifecycle actions of the state
 * table, the first page of the PDF (tap → Preview) and Share · E-mail · Print with "Mark as sent" (P5), payments with
 * "Record payment", payment receipts and Cancel (Storno) with a corrected copy (P6).
 */
export default function DocumentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const docId = Number(id);
  const router = useRouter();
  const today = todayLocal();
  const { data, reload, db } = useLoader(async (db) => {
    const doc = await getDocument(db, docId);
    if (!doc) return null;
    return {
      doc,
      lines: await listLines(db, docId),
      totals: computeTotals(await totalsInputFor(db, docId)),
      status: await documentStatus(db, docId, today),
      client: doc.clientId ? await getClient(db, doc.clientId) : null,
      payments: await listPayments(db, docId),
      related: await relatedDocuments(db, docId),
      preview: doc.status === 'draft' ? null : await documentHtml(db, docId),
      signature: doc.type === 'quote' ? await getDocumentSignature(db, docId) : null,
    };
  });

  useEffect(() => {
    if (data?.doc.status === 'draft') router.replace({ pathname: '/document/[id]/edit', params: { id: String(docId) } });
  }, [data, docId, router]);

  // Issue → PDF stored (V1_PLAN P5): the issued document's PDF is written once (and again after a payment changes
  // the balance) in the background; Send/Print reuse it. A failure here is harmless: Send renders it again.
  const status = data?.doc.status;
  useEffect(() => {
    if (status && status !== 'draft') documentPdf(db, docId).catch(() => undefined);
  }, [db, docId, status]);

  // The one in-context question about reminders (D27): right after the first invoice with a due date was issued.
  const askable = data?.doc.type === 'invoice' && data.doc.status === 'issued' && !!data.doc.dueDate;
  useEffect(() => {
    if (askable) askOnceForReminders(db, true).catch(() => undefined);
  }, [askable, db]);

  if (!data) return <Screen testID="document-loading">{null}</Screen>;
  const { doc, lines, totals, status: derived, client, payments, related, preview } = data;
  const signatureShape = parseSignature(data.signature?.data);
  const lang = getUiLanguage();
  const clock = { today };
  const openDraft = (draftId: number) => router.push({ pathname: '/document/[id]/edit', params: { id: String(draftId) } });
  const openDocument = (otherId: number) => router.push({ pathname: '/document/[id]', params: { id: String(otherId) } });
  // The name the document carries is the snapshot's (issued documents never change, D20).
  let clientName = client?.name ?? '';
  try {
    const snap = doc.snapshot ? (JSON.parse(doc.snapshot) as { client?: { name?: string } | null }) : null;
    clientName = snap?.client?.name ?? clientName;
  } catch {
    // keep the live name
  }

  const isInvoice = doc.type === 'invoice';
  const paidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
  const balance = derived.balance;
  const canPay = can(doc, 'recordPayment') && isInvoice;
  const receiptable = isInvoice && can(doc, 'paymentReceipt') && paidCents > 0;

  async function payFull() {
    await addPayment(db, docId, { date: todayLocal(), amountCents: balance, method: 'bank' });
    await reload();
  }

  async function receipt(paymentId?: number) {
    try {
      openDraft(await createPaymentReceipt(db, docId, { ...clock, paymentId }));
    } catch (e) {
      if (e instanceof PaymentReceiptFullError) Alert.alert(t('payment.receipt'), t('payment.receiptFull'));
      else throw e;
    }
  }

  function paymentOptions(p: Payment) {
    const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [];
    if (p.amountCents > 0 && can(doc, 'paymentReceipt')) buttons.push({ text: t('payment.receiptOne'), onPress: () => void receipt(p.id) });
    buttons.push({
      text: t('payment.remove'),
      style: 'destructive',
      onPress: () =>
        Alert.alert(t('payment.removeTitle'), t('payment.removeBody', { amount: money(p.amountCents, doc.currency), date: dateLabel(p.date) }), [
          { text: t('action.cancel'), style: 'cancel' },
          { text: t('payment.remove'), style: 'destructive', onPress: async () => { await deletePayment(db, p.id); await reload(); } },
        ]),
    });
    buttons.push({ text: t('action.cancel'), style: 'cancel' });
    Alert.alert(`${money(p.amountCents, doc.currency)} · ${dateLabel(p.date)}`, undefined, buttons);
  }

  function askCancel() {
    Alert.alert(t('cancel.title', { number: doc.number ?? '' }), t('cancel.body'), [
      { text: t('cancel.keep'), style: 'cancel' },
      {
        text: t('cancel.confirm'),
        style: 'destructive',
        onPress: async () => {
          const result = await cancelInvoice(db, docId, clock);
          await reload();
          Alert.alert(t('cancel.copyTitle'), t('cancel.copyBody', { number: result.number }), [
            { text: t('cancel.copyNo'), style: 'cancel' },
            { text: t('cancel.copyYes'), onPress: async () => openDraft(await duplicateDocument(db, docId, clock)) },
          ]);
        },
      },
    ]);
  }

  return (
    <Screen testID="document-screen">
      <Stack.Screen options={{ title: doc.number ?? t(`doc.type.${doc.type}`) }} />
      <View style={{ gap: 4 }}>
        <ThemedText type="small" themeColor="textSecondary">{t(`doc.type.${doc.type}`)}</ThemedText>
        <ThemedText type="subtitle" testID="doc-number">{doc.number}</ThemedText>
        <StatusChip status={derived.status} testID="doc-status" />
        <ThemedText testID="doc-client">{clientName || t('documents.noClient')}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" testID="doc-dates">
          {dateLabel(doc.issueDate)}
          {doc.type === 'invoice' && (doc.dueDate ?? '') ? ` · ${t('editor.dueDate')} ${dateLabel(doc.dueDate)}` : ''}
          {doc.type === 'quote' && doc.validUntil ? ` · ${t('editor.validUntil')} ${dateLabel(doc.validUntil)}` : ''}
        </ThemedText>
        {isInvoice && doc.status === 'issued' ? (
          <ThemedText type="smallBold" testID="doc-balance">
            {balance > 0
              ? `${t('payment.balance')}: ${money(balance, doc.currency)}`
              : balance < 0
                ? `${t('payment.paidIn')} · ${t('payment.overpaid', { amount: money(-balance, doc.currency) })}`
                : t('payment.paidIn')}
          </ThemedText>
        ) : null}
      </View>

      {preview ? (
        <Pressable
          testID="open-preview"
          accessibilityRole="button"
          accessibilityLabel={t('preview.open')}
          onPress={() => router.push({ pathname: '/document/[id]/preview', params: { id: String(docId) } })}>
          <View pointerEvents="none">
            <DocumentWeb testID="document-thumb" html={preview.html} paper={preview.model.layout.paper} pages={1} crop={0.42} />
          </View>
          <View style={styles.openBadge} pointerEvents="none">
            <ThemedText type="smallBold" style={styles.openText}>{t('preview.open')}</ThemedText>
          </View>
        </Pressable>
      ) : null}
      <SendActions docId={docId} issued sentAt={doc.sentAt} canMarkSent={can(doc, 'markSent')} onChanged={reload} />
      <View style={{ gap: 8 }}>
        {canPay ? <Button testID="action-record-payment" label={t('payment.record')} onPress={() => router.push({ pathname: '/document/[id]/payment', params: { id: String(docId) } })} /> : null}
        {canPay && balance > 0 ? <Button testID="action-paid-full" variant="secondary" label={t('payment.paidFull')} onPress={payFull} /> : null}
        {receiptable ? <Button testID="action-receipt-all" variant="secondary" label={t('payment.receiptAll')} onPress={() => receipt()} /> : null}
        {can(doc, 'accept') ? <Button testID="action-accept" label={t('doc.action.accept')} onPress={async () => { await acceptQuote(db, docId); await reload(); }} /> : null}
        {doc.type === 'quote' && (doc.status === 'issued' || doc.status === 'accepted') && !data.signature ? (
          <Button testID="action-accept-sign" variant="secondary" label={t('quote.acceptSign')} onPress={() => router.push({ pathname: '/signature', params: { quote: String(docId) } })} />
        ) : null}
        {can(doc, 'decline') ? <Button testID="action-decline" variant="secondary" label={t('doc.action.decline')} onPress={async () => { await declineQuote(db, docId); await reload(); }} /> : null}
        {can(doc, 'convert') ? <Button testID="action-convert" label={t('doc.action.convert')} onPress={async () => openDraft(await convertQuote(db, docId, clock))} /> : null}
        {can(doc, 'reopen') ? <Button testID="action-reopen" variant="secondary" label={t('doc.action.reopen')} onPress={async () => { await reopenQuote(db, docId); router.replace({ pathname: '/document/[id]/edit', params: { id: String(docId) } }); }} /> : null}
        {can(doc, 'duplicate') ? <Button testID="action-duplicate" variant="secondary" label={t('doc.action.duplicate')} onPress={async () => openDraft(await duplicateDocument(db, docId, clock))} /> : null}
        {can(doc, 'cancel') ? <Button testID="action-cancel" variant="secondary" label={t('cancel.action')} onPress={askCancel} /> : null}
        {can(doc, 'delete') ? (
          <Button
            testID="action-delete"
            variant="secondary"
            label={t('action.delete')}
            onPress={() =>
              Alert.alert(t('editor.deleteTitle'), t('doc.deleteQuoteBody'), [
                { text: t('action.cancel'), style: 'cancel' },
                { text: t('action.delete'), style: 'destructive', onPress: async () => { await deleteDocument(db, docId); router.back(); } },
              ])
            }
          />
        ) : null}
      </View>

      {data.signature && (doc.status === 'accepted' || doc.status === 'invoiced') ? (
        <Section title={t('quote.signedTitle')}>
          <View style={{ padding: 16, gap: 8, alignItems: 'flex-start' }}>
            {signatureShape ? <SignatureView testID="quote-signature" d={signatureShape.d} w={signatureShape.w} h={signatureShape.h} /> : null}
            <ThemedText type="small" testID="quote-signed-by">
              {t('quote.signedBy', { name: data.signature.signer || '—', date: dateLabel(todayLocal(new Date(data.signature.signedAt))) })}
            </ThemedText>
            <Button
              testID="action-share-signed"
              variant="secondary"
              label={t('quote.shareSigned')}
              onPress={async () => {
                try {
                  await sharePdf(await signedQuotePdf(db, docId));
                } catch (e) {
                  Alert.alert(t('quote.shareSigned'), errorText(e));
                }
              }}
            />
          </View>
        </Section>
      ) : null}

      <AttachmentsSection docId={docId} draft={false} onChanged={() => void reload()} />

      {isInvoice ? (
        <Section title={t('payment.title')}>
          {payments.length === 0 ? (
            <ThemedText type="small" themeColor="textSecondary" style={{ padding: 16 }} testID="payments-empty">{t('payment.none')}</ThemedText>
          ) : (
            payments.map((p, i) => (
              <View key={p.id}>
                {i > 0 ? <Divider /> : null}
                <Row
                  testID={`payment-row-${p.id}`}
                  title={`${dateLabel(p.date)} · ${t(`payment.method.${p.method}`)}${p.note ? ` · ${p.note}` : ''}`}
                  value={money(p.amountCents, doc.currency)}
                  onPress={canPay ? () => paymentOptions(p) : undefined}
                />
              </View>
            ))
          )}
          {payments.length > 0 ? (
            <>
              <Divider />
              <Row title={t('payment.paidSoFar')} value={money(paidCents, doc.currency)} testID="payments-total" />
            </>
          ) : null}
        </Section>
      ) : null}

      {related.length > 0 ? (
        <Section title={t('related.title')}>
          {related.map((r, i) => (
            <View key={`${r.role}-${r.id}`}>
              {i > 0 ? <Divider /> : null}
              <Row
                testID={`related-${r.id}`}
                title={`${t(`doc.type.${r.type}`)} ${r.number ?? t('status.draft')}`}
                value={t(r.role === 'source' ? 'related.source' : 'related.derived')}
                onPress={() => (r.status === 'draft' ? openDraft(r.id) : openDocument(r.id))}
              />
            </View>
          ))}
        </Section>
      ) : null}

      <Section title={t('editor.lines')}>
        {lines.map((l, i) => (
          <View key={l.id}>
            {i > 0 ? <Divider /> : null}
            <Row
              title={l.name}
              value={`${formatQty(l.qtyMilli, lang)} ${unitLabel(l.unitCode)} × ${formatPrice(l.priceE4, lang)}${l.taxRateBp > 0 ? ` · ${formatPercent(l.taxRateBp, lang)} %` : ''}  =  ${money(l.netCents, doc.currency)}`}
            />
          </View>
        ))}
      </Section>
      <Section>
        <TotalsSummary totals={totals} currency={doc.currency} />
      </Section>
      {doc.legalNote ? (
        <Section title={t('editor.legalNote')}>
          <ThemedText type="small" style={{ padding: 16 }}>{doc.legalNote}</ThemedText>
        </Section>
      ) : null}

    </Screen>
  );
}

const styles = StyleSheet.create({
  openBadge: { position: 'absolute', right: 8, bottom: 8, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  openText: { color: '#fff' },
});
