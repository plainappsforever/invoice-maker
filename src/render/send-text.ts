// File names and e-mail texts for sending a document (D25, P5). PURE: no React/Expo imports.
// - The PDF a client receives is named "<number> <client>.pdf" (drafts: "<type> – Entwurf <client>.pdf"),
//   with characters that file systems or mail clients reject removed (D66).
// - The stored PDF of an issued document is `pdf/<id>-<number>[-paid<cents>].pdf` under the app's document folder;
//   the paid part makes a payment re-render the file (balance + GiroCode amount are live data, model.ts).
// - Subject and body of the e-mail are in the DOCUMENT's language (D15), never the UI language.
import { formatDate } from '@/engine/dates';
import { formatMoney } from '@/engine/money';
import { translate, type TranslationKey } from '@/i18n';

import type { RenderModel } from './model';

const MAX_NAME = 80;

/** Removes characters that are invalid in file names on iOS/Android/Windows (and control characters); keeps umlauts. */
export function sanitizeFileName(text: string): string {
  return (
    text
      .normalize('NFC')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .replace(/[\\/:*?"<>|#%{}^~[\]`]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .replace(/[. ]+$/, '')
  );
}

function cut(text: string, max: number): string {
  const chars = Array.from(text); // never split a surrogate pair (emoji, CJK extension)
  return chars.length <= max ? text : chars.slice(0, max).join('').trim();
}

function title(model: RenderModel): string {
  const lang = model.language;
  if (model.type === 'receipt') return translate(lang, model.receiptKind === 'payment' ? 'render.title.receipt.payment' : 'render.title.receipt.cash');
  return translate(lang, `doc.type.${model.type}` as TranslationKey);
}

/** "RE-2026-0001 Müller GmbH.pdf"; a draft: "Rechnung – Entwurf Müller GmbH.pdf"; never empty. */
export function pdfFileName(model: RenderModel): string {
  const head = model.number ?? `${title(model)} ${translate(model.language, 'render.draft')}`;
  const client = model.client?.name ?? '';
  const base = sanitizeFileName(cut(`${head} ${client}`.trim(), MAX_NAME)) || sanitizeFileName(title(model)) || 'document';
  return `${base}.pdf`;
}

/** Relative path of the stored PDF of an issued document (V1_PLAN "Files"). */
export function storedPdfPath(id: number, number: string | null, paidCents: number): string {
  const safe = sanitizeFileName(number ?? 'draft').replace(/ /g, '_') || 'document';
  return `pdf/${id}-${safe}${paidCents !== 0 ? `-paid${paidCents}` : ''}.pdf`;
}

export type MailContent = { to: string[]; subject: string; body: string };

/**
 * Subject and body of the e-mail for a document (D25): per-language templates with number, date, amount and the due
 * date / validity. `balanceCents` = what is still to pay (invoices).
 */
export function mailContent(model: RenderModel, balanceCents: number = model.totals.gross): MailContent {
  const lang = model.language;
  const tr = (key: TranslationKey, params?: Record<string, string | number>) => translate(lang, key, params);
  const kind = title(model);
  const number = model.number ?? tr('render.draft');
  const date = formatDate(model.issueDate, lang);
  const amount = formatMoney(model.type === 'invoice' ? balanceCents : model.totals.gross, model.currency, lang);
  const business = model.business.name.trim();
  const subject = business ? tr('mail.subject', { kind, number, business }) : tr('mail.subjectNoBusiness', { kind, number });
  const greeting = model.client?.contact.trim() ? tr('mail.greetingName', { name: model.client.contact.trim() }) : tr('mail.greeting');
  let main: string;
  if (model.type === 'invoice' && model.dueDate && balanceCents > 0) main = tr('mail.invoiceDue', { number, date, amount, due: formatDate(model.dueDate, lang) });
  else if (model.type === 'invoice' && balanceCents > 0) main = tr('mail.invoice', { number, date, amount });
  else if (model.type === 'quote' && model.validUntil) main = tr('mail.quoteValid', { number, date, amount, valid: formatDate(model.validUntil, lang) });
  else main = tr('mail.document', { kind, number, date });
  const body = [greeting, '', main, '', tr('mail.closing'), business].join('\n').trim();
  const to = model.client?.email.trim() ? [model.client.email.trim()] : [];
  return { to, subject, body };
}

/** The text put on the clipboard when the device has no mail composer (D25: share sheet + "Text copied"). */
export function clipboardText(mail: MailContent): string {
  return `${mail.subject}\n\n${mail.body}`;
}

/**
 * Plain-text version of a document for "Share as text" when the PDF cannot be created (SPEC §10): title, number,
 * dates, parties, lines, totals and the bank details — in the document's language.
 */
export function documentText(model: RenderModel, balanceCents: number = model.totals.gross): string {
  const lang = model.language;
  const tr = (key: TranslationKey, params?: Record<string, string | number>) => translate(lang, key, params);
  const money = (cents: number) => formatMoney(cents, model.currency, lang);
  const out: string[] = [`${title(model)} ${model.number ?? tr('render.draft')}`, `${tr('render.date.issue')}: ${formatDate(model.issueDate, lang)}`];
  if (model.business.name.trim()) out.push(model.business.name.trim());
  if (model.client?.name.trim()) out.push(`→ ${model.client.name.trim()}`);
  out.push('');
  for (const line of model.lines) out.push(`${line.position}. ${line.name} — ${money(line.net)}`);
  out.push('');
  if (model.totals.tax !== 0) {
    out.push(`${tr('render.vat.col.net')}: ${money(model.totals.net)}`);
    out.push(`${tr('render.vat.col.tax')}: ${money(model.totals.tax)}`);
  }
  out.push(`${tr('render.total.gross')}: ${money(model.totals.gross)}`);
  if (model.type === 'invoice' && balanceCents !== model.totals.gross) out.push(`${tr('render.total.balance')}: ${money(balanceCents)}`);
  if (model.type === 'invoice' && model.dueDate) out.push(`${tr('render.date.due')}: ${formatDate(model.dueDate, lang)}`);
  if (model.business.iban.trim()) out.push(`IBAN: ${model.business.iban.trim()}${model.business.bic.trim() ? ` · BIC: ${model.business.bic.trim()}` : ''}`);
  if (model.texts.legalNote.trim()) out.push('', model.texts.legalNote.trim());
  return out.join('\n');
}
