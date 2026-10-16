// PDF glue (V1_PLAN "Files and PDF glue", D23): HTML from the pure renderer → expo-print → a file with its final
// name. Issued documents keep their PDF under Paths.document/pdf (regenerated from the snapshot when missing or
// when payments changed the balance); drafts and the share copies live in the cache.
import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import { Platform } from 'react-native';

import { getDocumentSignature } from '@/db/attachments';
import { getDocument, updateDocumentState } from '@/db/documents';
import { renderModelFor } from '@/db/lifecycle';
import { listPayments } from '@/db/payments';
import type { Db } from '@/db/types';
import { formatDate, todayLocal } from '@/engine/dates';
import { t } from '@/i18n';
import { renderHtml } from '@/render/html';
import { PAPER_PX, type Paper } from '@/render/html/din5008';
import type { RenderModel } from '@/render/model';
import { inspectPdf, type PdfInfo } from '@/render/pdf-inspect';
import { PRINT_ZOOM, printHtml } from '@/render/preview';
import { pdfFileName, storedPdfPath } from '@/render/send-text';

import { imageDataUris } from './capture';
import { withTimeout } from './timeout';

/** A PDF normally takes 0.4–1.5 s (P5 measurements); far beyond that the print engine is stuck. */
export const PDF_TIMEOUT_MS = 60_000;

export type PdfResult = {
  uri: string;
  /** Pages counted in the file (the print engines' own count is not reliable on Android, D67). */
  pages: number;
  /** What expo-print reported. */
  reportedPages: number;
  bytes: number;
  /** Time spent in printToFileAsync. */
  ms: number;
  info: PdfInfo;
};

export type DocumentPdf = PdfResult & { model: RenderModel; name: string; balanceCents: number; cached: boolean };

/** `data:image/png;base64,…` of a stored logo, or null when there is none (D41: the snapshot names the file). */
export async function logoDataUri(file: string | null | undefined): Promise<string | null> {
  if (!file) return null;
  const f = new File(Paths.document, file);
  if (!f.exists) return null;
  return `data:image/png;base64,${await f.base64()}`;
}

/**
 * HTML of a document as the PDF shows it: snapshot (issued) or live rows (draft), its payments, its logo, and the photos
 * the model names (item photos, attachment pages; V1.5 P1). `signed`: the client's acceptance signature of an issued
 * quote is added (the signed copy; the stored PDF stays the quote as issued).
 */
export async function documentHtml(db: Db, id: number, options: { signed?: boolean } = {}): Promise<{ model: RenderModel; html: string; paidCents: number }> {
  const model = await renderModelFor(db, id);
  const payments = model.type === 'invoice' ? (await listPayments(db, id)).map((p) => ({ date: p.date, amountCents: p.amountCents })) : [];
  const paidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
  const images = await imageDataUris([...model.lines.map((l) => l.imageFile), ...(model.attachments ?? []).map((a) => a.file)]);
  const sig = options.signed ? await getDocumentSignature(db, id) : null;
  const acceptance = sig ? { signer: sig.signer, signedAt: formatDate(todayLocal(new Date(sig.signedAt)), model.language), signature: sig.data } : null;
  const html = renderHtml(model, { payments, logoDataUri: await logoDataUri(model.business.logoFile), images, acceptance });
  return { model, html, paidCents };
}

/** The signed copy of an accepted quote ("<number> <client> signed.pdf" in the cache, for the share sheet). */
export async function signedQuotePdf(db: Db, id: number): Promise<DocumentPdf> {
  const { model, html } = await documentHtml(db, id, { signed: true });
  const name = pdfFileName(model).replace(/\.pdf$/, ` ${t('quote.signedSuffix')}.pdf`);
  const result = await makePdf(html, model.layout.paper, new File(Paths.cache, 'share', String(id), name));
  return { ...result, model, name, balanceCents: model.totals.gross, cached: false };
}

function ensureParent(file: File) {
  const dir = file.parentDirectory;
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
}

/**
 * HTML → PDF file at `dest` (overwritten). Page size from the paper (A4 595×842, Letter 612×792 pt), no engine
 * margins: the CSS positions everything (D23).
 */
export async function makePdf(html: string, paper: Paper, dest: File, zoom: number = PRINT_ZOOM[Platform.OS === 'ios' ? 'ios' : 'android']): Promise<PdfResult> {
  const { w, h } = PAPER_PX[paper] ?? PAPER_PX.A4;
  const started = Date.now();
  const out = await withTimeout(
    Print.printToFileAsync({
      html: printHtml(html, zoom, paper),
      width: w,
      height: h,
      ...(Platform.OS === 'ios' ? { margins: { left: 0, right: 0, top: 0, bottom: 0 } } : { textZoom: 100 }),
    }),
    PDF_TIMEOUT_MS,
    'Creating the PDF'
  );
  const ms = Date.now() - started;
  ensureParent(dest);
  await new File(out.uri).move(dest, { overwrite: true });
  const bytes = await dest.bytes();
  const info = inspectPdf(bytes);
  return { uri: dest.uri, pages: info.pages || info.treeCount || out.numberOfPages, reportedPages: out.numberOfPages, bytes: bytes.length, ms, info };
}

const running = new Map<string, Promise<DocumentPdf>>();

/**
 * The PDF of a document. Issued: the stored file when it exists for the current payments, else rendered from the
 * snapshot and stored (pdf_file = the copy as issued, updated through the write queue; D91). Draft: rendered into the cache every time.
 * Two calls for the same document share one render.
 */
export function documentPdf(db: Db, id: number): Promise<DocumentPdf> {
  const key = String(id);
  const busy = running.get(key);
  if (busy) return busy;
  const job = (async (): Promise<DocumentPdf> => {
    const doc = await getDocument(db, id);
    if (!doc) throw new Error(`document ${id} not found`);
    const { model, html, paidCents } = await documentHtml(db, id);
    const name = pdfFileName(model);
    const balanceCents = model.totals.gross - paidCents;
    if (doc.status === 'draft') {
      const result = await makePdf(html, model.layout.paper, new File(Paths.cache, 'preview', String(id), name));
      return { ...result, model, name, balanceCents, cached: false };
    }
    // `pdf_file` points at the PDF as issued (no payments); a copy with the payment status (paid amount, balance,
    // GiroCode of the rest) is a separate file next to it and never replaces that pointer (review #13, D91).
    const rel = storedPdfPath(id, doc.number, paidCents);
    const stored = new File(Paths.document, rel);
    const asIssued = paidCents === 0;
    if (stored.exists && (!asIssued || doc.pdfFile === rel)) {
      const bytes = await stored.bytes();
      const info = inspectPdf(bytes);
      return { uri: stored.uri, pages: info.pages || info.treeCount, reportedPages: 0, bytes: bytes.length, ms: 0, info, model, name, balanceCents, cached: true };
    }
    const result = await makePdf(html, model.layout.paper, stored);
    if (asIssued && doc.pdfFile !== rel) await updateDocumentState(db, id, { pdfFile: rel });
    return { ...result, model, name, balanceCents, cached: false };
  })();
  running.set(key, job);
  return job.finally(() => running.delete(key));
}

/**
 * A copy of the document's PDF named for the recipient ("RE-2026-0001 Müller GmbH.pdf", D66) for the share
 * sheet and the mail composer. Drafts are already rendered under that name.
 */
export async function namedPdf(db: Db, id: number): Promise<DocumentPdf> {
  const pdf = await documentPdf(db, id);
  if (pdf.model.number === null) return pdf;
  const copy = new File(Paths.cache, 'share', String(id), pdf.name);
  ensureParent(copy);
  await new File(pdf.uri).copy(copy, { overwrite: true });
  return { ...pdf, uri: copy.uri };
}
