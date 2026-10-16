// Attachments of documents (V1.5 P1, N3) and the client's signature on a quote (L140-a). Files live under the app's
// document folder ('attachments/<uuid>.jpg'); rows hold the relative name. `use`: 'page' = printed as a page after
// the document, 'mail' = attached to the e-mail as its own file, 'keep' = only kept with the document. Pages of a
// document that is no longer a draft belong to its PDF: the SQLite triggers of migration 5 refuse removing them,
// switching them off, and adding new pages (D20 for attachments).
import { queued, withRead } from './transaction';
import type { Db } from './types';

export type AttachmentUse = 'page' | 'mail' | 'keep';
export type AttachmentMime = 'image/jpeg' | 'image/png' | 'application/pdf';
export type Attachment = {
  id: number;
  documentId: number;
  file: string;
  name: string;
  mime: AttachmentMime;
  width: number | null;
  height: number | null;
  bytes: number;
  use: AttachmentUse;
  position: number;
  createdAt: number;
};
export type AttachmentInput = Pick<Attachment, 'file' | 'mime' | 'bytes'> & Partial<Pick<Attachment, 'name' | 'width' | 'height' | 'use'>>;

/** Per document (keeps PDFs and e-mails sendable): at most 20 attachments, 12 of them printed as pages. */
export const MAX_ATTACHMENTS = 20;
export const MAX_PAGE_ATTACHMENTS = 12;
/** Size cap of one stored file (images are downscaled before; a PDF is stored as picked). */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export class AttachmentLimitError extends Error {
  constructor(readonly reason: 'count' | 'pages' | 'size' | 'pdfPage') {
    super(`attachment_limit: ${reason}`);
    this.name = 'AttachmentLimitError';
  }
}

const SELECT = `SELECT id, document_id AS documentId, file, name, mime, width, height, bytes, use, position, created_at AS createdAt FROM attachments`;

export function listAttachments(db: Db, documentId: number): Promise<Attachment[]> {
  return withRead(db, (db) => db.getAllAsync<Attachment>(`${SELECT} WHERE document_id = ? ORDER BY position, id`, documentId));
}

/** Every attachment file name (backup, delete-all). */
export function listAttachmentFiles(db: Db): Promise<string[]> {
  return withRead(db, async (db) => (await db.getAllAsync<{ file: string }>('SELECT file FROM attachments ORDER BY id')).map((r) => r.file));
}

export const addAttachment = queued(async (db: Db, documentId: number, input: AttachmentInput, now: number = Date.now()): Promise<number> => {
  const doc = await db.getFirstAsync<{ status: string }>('SELECT status FROM documents WHERE id = ?', documentId);
  if (!doc) throw new Error(`document ${documentId} not found`);
  const use: AttachmentUse = input.use ?? (input.mime === 'application/pdf' || doc.status !== 'draft' ? 'mail' : 'page');
  if (use === 'page' && input.mime === 'application/pdf') throw new AttachmentLimitError('pdfPage');
  if (input.bytes > MAX_ATTACHMENT_BYTES) throw new AttachmentLimitError('size');
  const counts = await db.getFirstAsync<{ n: number; pages: number; next: number }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(use = 'page'), 0) AS pages, COALESCE(MAX(position), -1) + 1 AS next FROM attachments WHERE document_id = ?",
    documentId
  );
  if ((counts?.n ?? 0) >= MAX_ATTACHMENTS) throw new AttachmentLimitError('count');
  if (use === 'page' && (counts?.pages ?? 0) >= MAX_PAGE_ATTACHMENTS) throw new AttachmentLimitError('pages');
  const result = await db.runAsync(
    'INSERT INTO attachments (document_id, file, name, mime, width, height, bytes, use, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    documentId, input.file, input.name ?? '', input.mime, input.width ?? null, input.height ?? null, input.bytes, use, counts?.next ?? 0, now
  );
  return result.lastInsertRowId;
});

export const setAttachmentUse = queued(async (db: Db, id: number, use: AttachmentUse): Promise<void> => {
  const row = await db.getFirstAsync<{ documentId: number; mime: string; use: string }>('SELECT document_id AS documentId, mime, use FROM attachments WHERE id = ?', id);
  if (!row || row.use === use) return;
  if (use === 'page') {
    if (row.mime === 'application/pdf') throw new AttachmentLimitError('pdfPage');
    const pages = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM attachments WHERE document_id = ? AND use = 'page'", row.documentId);
    if ((pages?.n ?? 0) >= MAX_PAGE_ATTACHMENTS) throw new AttachmentLimitError('pages');
  }
  await db.runAsync('UPDATE attachments SET use = ? WHERE id = ?', use, id);
});

export const renameAttachment = queued(async (db: Db, id: number, name: string): Promise<void> => {
  await db.runAsync('UPDATE attachments SET name = ? WHERE id = ?', name.slice(0, 200), id);
});

/** Removes the row; returns its file name so the caller can delete the file (files of printed pages stay: D41 rule). */
export const deleteAttachment = queued(async (db: Db, id: number): Promise<string | null> => {
  const row = await db.getFirstAsync<{ file: string }>('SELECT file FROM attachments WHERE id = ?', id);
  if (!row) return null;
  await db.runAsync('DELETE FROM attachments WHERE id = ?', id);
  return row.file;
});

// ---------------------------------------------------------------------------------------------------------
// Client signature on a quote ("accepted by")

export type DocumentSignature = { documentId: number; signer: string; data: string; signedAt: number };

export function getDocumentSignature(db: Db, documentId: number): Promise<DocumentSignature | null> {
  return withRead(db, (db) =>
    db.getFirstAsync<DocumentSignature>('SELECT document_id AS documentId, signer, data, signed_at AS signedAt FROM signatures WHERE document_id = ?', documentId)
  );
}

/** Stores (or replaces) the client's signature of a quote. Only quotes that were issued can be signed. */
export const setDocumentSignature = queued(async (db: Db, documentId: number, signer: string, data: string, now: number = Date.now()): Promise<void> => {
  const doc = await db.getFirstAsync<{ type: string; status: string }>('SELECT type, status FROM documents WHERE id = ?', documentId);
  if (!doc || doc.type !== 'quote' || doc.status === 'draft') throw new Error('signature_not_allowed');
  await db.runAsync(
    'INSERT INTO signatures (document_id, signer, data, signed_at) VALUES (?, ?, ?, ?) ON CONFLICT(document_id) DO UPDATE SET signer = excluded.signer, data = excluded.data, signed_at = excluded.signed_at',
    documentId, signer.slice(0, 200), data, now
  );
});

export const deleteDocumentSignature = queued(async (db: Db, documentId: number): Promise<void> => {
  await db.runAsync('DELETE FROM signatures WHERE document_id = ?', documentId);
});
