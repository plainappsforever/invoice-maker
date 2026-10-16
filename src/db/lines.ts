// Document lines; every write requires the document to be a draft (D20).
import type { DiscountKind, TaxCategory } from '@/engine/totals';

import { assertDraft } from './documents';
import { fromRow, insertSql, updateSql } from './rows';
import { queued, withRead } from './transaction';
import type { Db } from './types';

export type DocumentLine = {
  id: number;
  documentId: number;
  position: number;
  catalogItemId: number | null;
  name: string;
  description: string;
  qtyMilli: number;
  unitCode: string;
  priceE4: number;
  taxCategory: TaxCategory;
  taxRateBp: number;
  discountKind: DiscountKind;
  discountValue: number;
  netCents: number;
  /** Photo copied from the catalog item when the line was added (V1.5 P1); printed next to the line. */
  imageFile: string | null;
};

export type LineInput = Partial<Omit<DocumentLine, 'id' | 'documentId' | 'position' | 'netCents'>> & {
  name: string;
  qtyMilli: number;
  priceE4: number;
  taxRateBp: number;
};

const FIELDS = [
  'documentId', 'position', 'catalogItemId', 'name', 'description', 'qtyMilli', 'unitCode', 'priceE4',
  'taxCategory', 'taxRateBp', 'discountKind', 'discountValue', 'imageFile',
] as const;

async function documentOf(db: Db, lineId: number): Promise<number> {
  const row = await db.getFirstAsync<{ document_id: number }>('SELECT document_id FROM document_lines WHERE id = ?', lineId);
  if (!row) throw new Error(`line ${lineId} not found`);
  return row.document_id;
}

export function listLines(db: Db, documentId: number): Promise<DocumentLine[]> {
  return withRead(db, async (db) => {
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM document_lines WHERE document_id = ? ORDER BY position, id',
      documentId
    );
    return rows.map((r) => fromRow<DocumentLine>(r));
  });
}

/** Appends a line at the end. */
export const addLine = queued(async (db: Db, documentId: number, input: LineInput): Promise<number> => {
  await assertDraft(db, documentId);
  const row = await db.getFirstAsync<{ next: number }>(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM document_lines WHERE document_id = ?',
    documentId
  );
  const { sql, values } = insertSql('document_lines', { ...input, documentId, position: row?.next ?? 0 }, FIELDS);
  return (await db.runAsync(sql, ...values)).lastInsertRowId;
});

export const updateLine = queued(async (db: Db, lineId: number, patch: Partial<LineInput>): Promise<void> => {
  await assertDraft(db, await documentOf(db, lineId));
  const update = updateSql('document_lines', lineId, patch, FIELDS);
  if (update) await db.runAsync(update.sql, ...update.values);
});

export const deleteLine = queued(async (db: Db, lineId: number): Promise<void> => {
  await assertDraft(db, await documentOf(db, lineId));
  await db.runAsync('DELETE FROM document_lines WHERE id = ?', lineId);
});

/** Sets positions 0…n−1 in the given order (all ids must belong to the document). */
export const reorderLines = queued(async (db: Db, documentId: number, lineIds: number[]): Promise<void> => {
  await assertDraft(db, documentId);
  const current = await listLines(db, documentId);
  const known = new Set(current.map((l) => l.id));
  if (lineIds.length !== current.length || !lineIds.every((id) => known.has(id))) {
    throw new Error('reorderLines: ids do not match the document lines');
  }
  for (let i = 0; i < lineIds.length; i++) {
    await db.runAsync('UPDATE document_lines SET position = ? WHERE id = ?', i, lineIds[i]);
  }
});
