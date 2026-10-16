import { useSQLiteContext } from 'expo-sqlite';
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Share, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { markSent } from '@/db/lifecycle';
import { todayLocal } from '@/engine/dates';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/i18n';
import { errorText } from '@/lib/errors';
import { isDevBuild } from '@/lib/debug';
import { dateLabel } from '@/lib/format';
import { documentHtml, namedPdf, type DocumentPdf } from '@/lib/pdf';
import { emailPdf, noShareText, printPdf, sharePdf } from '@/lib/send';
import { documentText } from '@/render/send-text';

type Kind = 'share' | 'email' | 'print';

function isPrintCancel(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code ?? '';
  const message = e instanceof Error ? e.message : String(e);
  return /PrintIncomplete|PRINT_INCOMPLETE/i.test(code) || /did not complete/i.test(message);
}

/**
 * Share · E-mail · Print for one document (D25, SPEC §6) and, for issued documents, the "Mark as sent" bar. Nothing
 * is marked by itself except an iOS mail composer that reports "sent". When the PDF cannot be created the user can
 * try again or share the document as text (SPEC §10).
 */
export function SendActions({
  docId,
  issued,
  sentAt,
  canMarkSent,
  onChanged,
}: {
  docId: number;
  issued: boolean;
  sentAt: number | null;
  canMarkSent: boolean;
  onChanged: () => void;
}) {
  const db = useSQLiteContext();
  const theme = useTheme();
  const busy = useRef(false);
  const [working, setWorking] = useState<Kind | null>(null);
  const [info, setInfo] = useState('');
  const [copied, setCopied] = useState(false);

  async function shareAsText() {
    const { model, paidCents } = await documentHtml(db, docId);
    await Share.share({ message: documentText(model, model.totals.gross - paidCents) });
  }

  async function run(kind: Kind) {
    if (busy.current) return;
    busy.current = true;
    setWorking(kind);
    setCopied(false);
    let pdf: DocumentPdf | null = null;
    try {
      pdf = await namedPdf(db, docId);
      setInfo(`PDF ${pdf.pages} p · ${Math.round(pdf.bytes / 1024)} KB · ${pdf.cached ? 'stored' : `${pdf.ms} ms`}`);
    } catch (e) {
      busy.current = false;
      setWorking(null);
      Alert.alert(t('send.failed'), errorText(e), [
        { text: t('action.cancel'), style: 'cancel' },
        { text: t('send.shareAsText'), onPress: () => void shareAsText() },
        { text: t('send.tryAgain'), onPress: () => void run(kind) },
      ]);
      return;
    }
    try {
      if (kind === 'print') await printPdf(pdf);
      else {
        const out = kind === 'share' ? await sharePdf(pdf) : await emailPdf(db, docId, pdf, () => setCopied(true));
        if (out.kind === 'noShare') Alert.alert(t('send.share'), noShareText(pdf));
        if (out.kind === 'mail' && out.sent) onChanged();
      }
    } catch (e) {
      // Closing the print dialog rejects with "Printing did not complete" (expo-print): a normal cancel, no message.
      if (kind === 'print' && isPrintCancel(e)) return;
      // the system sheet failed or was refused: the PDF exists, nothing was sent
      Alert.alert(t(kind === 'print' ? 'send.print' : kind === 'email' ? 'send.email' : 'send.share'), errorText(e));
    } finally {
      busy.current = false;
      setWorking(null);
    }
  }

  return (
    <View style={styles.wrap} testID="send-actions">
      <View style={styles.row}>
        <View style={styles.flex}>
          <Button testID="action-share" label={t('send.share')} disabled={working !== null} onPress={() => run('share')} />
        </View>
        <View style={styles.flex}>
          <Button testID="action-email" variant="secondary" label={t('send.email')} disabled={working !== null} onPress={() => run('email')} />
        </View>
        <View style={styles.flex}>
          <Button testID="action-print" variant="secondary" label={t('send.print')} disabled={working !== null} onPress={() => run('print')} />
        </View>
      </View>
      {working ? (
        <View style={styles.row} testID="pdf-working">
          <ActivityIndicator />
          <ThemedText type="small" themeColor="textSecondary">{t('send.working')}</ThemedText>
        </View>
      ) : null}
      {copied ? (
        <View style={[styles.banner, { backgroundColor: theme.backgroundElement }]} testID="text-copied">
          <ThemedText type="smallBold">{t('send.textCopiedTitle')}</ThemedText>
          <ThemedText type="small">{t('send.textCopied')}</ThemedText>
        </View>
      ) : null}
      {isDevBuild && info ? (
        <ThemedText type="small" themeColor="textSecondary" testID="pdf-info">{info}</ThemedText>
      ) : null}
      {issued && sentAt !== null ? (
        <ThemedText type="small" themeColor="textSecondary" testID="sent-on">{t('send.sentOn', { date: dateLabel(todayLocal(new Date(sentAt))) })}</ThemedText>
      ) : null}
      {issued && sentAt === null && canMarkSent ? (
        <View style={[styles.banner, styles.sentBar, { backgroundColor: theme.backgroundElement }]} testID="mark-sent-bar">
          <ThemedText type="small" style={styles.flex}>{t('send.markSentHint')}</ThemedText>
          <Button
            testID="mark-sent"
            label={t('send.markSent')}
            onPress={async () => {
              await markSent(db, docId);
              onChanged();
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.two },
  row: { flexDirection: 'row', gap: Spacing.two, alignItems: 'center' },
  flex: { flex: 1 },
  banner: { padding: Spacing.three, borderRadius: 12, gap: 4 },
  sentBar: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
});
