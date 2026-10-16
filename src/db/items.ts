// Catalog items ("Artikel/Leistungen") for fast line entry.
import type { TaxCategory } from '@/engine/totals';

import { fromRow, insertSql, updateSql } from './rows';
import { queued, withRead } from './transaction';
import type { Db } from './types';

export type CatalogItem = {
  id: number;
  name: string;
  description: string;
  /** UN/ECE Rec 20 (D18): C62 piece, HUR hour, DAY, MON, KMT, KGM, MTR, MTK, LTR, LS. */
  unitCode: string;
  sku: string;
  priceE4: number;
  priceIncludesVat: boolean;
  taxCategory: TaxCategory;
  taxRateBp: number;
  /** Product photo ('items/<uuid>.jpg' under the app's document folder; V1.5 P1, L153-a). */
  imageFile: string | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
};

export type CatalogItemInput = Partial<Omit<CatalogItem, 'id' | 'archived' | 'createdAt' | 'updatedAt'>> & { name: string };

export const UNIT_CODES = ['C62', 'HUR', 'DAY', 'MON', 'KMT', 'KGM', 'MTR', 'MTK', 'LTR', 'LS'] as const;

const FIELDS = [
  'name', 'description', 'unitCode', 'sku', 'priceE4', 'priceIncludesVat', 'taxCategory', 'taxRateBp', 'imageFile', 'archived',
  'createdAt', 'updatedAt',
] as const;

const map = (row: Record<string, unknown>) => fromRow<CatalogItem>(row, ['priceIncludesVat', 'archived']);

export const createCatalogItem = queued(async (db: Db, input: CatalogItemInput, now: number = Date.now()): Promise<number> => {
  const { sql, values } = insertSql('catalog_items', { ...input, createdAt: now, updatedAt: now }, FIELDS);
  return (await db.runAsync(sql, ...values)).lastInsertRowId;
});

export function getCatalogItem(db: Db, id: number): Promise<CatalogItem | null> {
  return withRead(db, async (db) => {
    const row = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM catalog_items WHERE id = ?', id);
    return row ? map(row) : null;
  });
}

export function listCatalogItems(db: Db, options: { search?: string; includeArchived?: boolean } = {}): Promise<CatalogItem[]> {
  return withRead(db, async (db) => {
    const where: string[] = [];
    const params: string[] = [];
    if (!options.includeArchived) where.push('archived = 0');
    if (options.search?.trim()) {
      where.push('(name LIKE ? OR sku LIKE ? OR description LIKE ?)');
      const like = `%${options.search.trim()}%`;
      params.push(like, like, like);
    }
    const rows = await db.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM catalog_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name COLLATE NOCASE, id`,
      ...params
    );
    return rows.map(map);
  });
}

export const updateCatalogItem = queued(async (db: Db, id: number, patch: Partial<CatalogItemInput>, now: number = Date.now()): Promise<void> => {
  const update = updateSql('catalog_items', id, { ...patch, updatedAt: now }, FIELDS);
  if (update) await db.runAsync(update.sql, ...update.values);
});

export const setCatalogItemArchived = queued(async (db: Db, id: number, archived: boolean, now: number = Date.now()): Promise<void> => {
  await updateCatalogItem(db, id, { archived } as Partial<CatalogItemInput>, now);
});
