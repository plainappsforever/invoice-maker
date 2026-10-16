// Send, e-mail and print a document (D25, SPEC §10). Never sends anything by itself: the user picks the app
// in the system share sheet or presses Send in the mail composer.
import * as Clipboard from 'expo-clipboard';
import * as MailComposer from 'expo-mail-composer';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import { listAttachments } from '@/db/attachments';
import { markSent } from '@/db/lifecycle';
import type { Db } from '@/db/types';
import { t } from '@/i18n';
import { clipboardText, mailContent } from '@/render/send-text';

import { storedUri } from './capture';
import type { DocumentPdf } from './pdf';

export type SendOutcome =
  /** Share sheet shown and closed (iOS/Android do not say whether something was sent). */
  | { kind: 'shared'; pdf: DocumentPdf }
  /** No share sheet on this device: the file stays in the app. */
  | { kind: 'noShare'; pdf: DocumentPdf }
  /** Mail composer closed; `sent` only from iOS (Android always says "sent", so it is not trusted). */
  | { kind: 'mail'; pdf: DocumentPdf; sent: boolean }
  /** No mail account: text copied, share sheet shown. */
  | { kind: 'mailFallback'; pdf: DocumentPdf };

/** Share sheet with the PDF (from `namedPdf`: "<number> <client>.pdf"). */
export async function sharePdf(pdf: DocumentPdf): Promise<SendOutcome> {
  if (!(await Sharing.isAvailableAsync())) return { kind: 'noShare', pdf };
  await Sharing.shareAsync(pdf.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: pdf.name });
  return { kind: 'shared', pdf };
}

/**
 * E-mail: the device's mail composer with recipient, subject, body and the PDF; without a mail account (iOS
 * Simulator, no Mail account) the text goes to the clipboard and the share sheet opens (`onFallback` runs first,
 * so the screen can say "Text copied"). A composer result "sent" on iOS marks the document sent (D25).
 */
export async function emailPdf(db: Db, id: number, pdf: DocumentPdf, onFallback?: () => void): Promise<SendOutcome> {
  const mail = mailContent(pdf.model, pdf.balanceCents);
  if (await MailComposer.isAvailableAsync()) {
    // Attachments marked "attach to the e-mail" travel as their own files next to the PDF (V1.5 P1, N3).
    const extra = (await listAttachments(db, id)).filter((a) => a.use === 'mail').map((a) => storedUri(a.file)).filter((u): u is string => !!u);
    const result = await MailComposer.composeAsync({ recipients: mail.to, subject: mail.subject, body: mail.body, attachments: [pdf.uri, ...extra] });
    const sent = Platform.OS === 'ios' && result.status === MailComposer.MailComposerStatus.SENT;
    if (sent && pdf.model.number !== null) await markSent(db, id);
    return { kind: 'mail', pdf, sent };
  }
  await Clipboard.setStringAsync(clipboardText(mail));
  onFallback?.();
  const shared = await sharePdf(pdf);
  return shared.kind === 'noShare' ? shared : { kind: 'mailFallback', pdf };
}

/** System print dialog (AirPrint / Android print service) with the PDF. */
export async function printPdf(pdf: DocumentPdf): Promise<void> {
  await Print.printAsync({ uri: pdf.uri });
}

/** Text of the "no share sheet" message. */
export function noShareText(pdf: DocumentPdf): string {
  return t('send.noShare', { path: pdf.uri });
}
