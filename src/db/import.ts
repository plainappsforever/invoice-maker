// Database side of the CSV import (V1.5 P1, Idea-b): what the duplicate check compares with, and the import itself
// in ONE transaction (a failure part-way leaves nothing behind). The format and the plan are src/data/csv-import.ts.
import type { ClientImport, Existing, ItemImport } from '@/data/csv-import';

import { insertSql } from './rows';
import { withRead, withTransaction } from './transaction';
import type { Db } from './types';

export function readImportExisting(db: Db): Promise<Existing> {
  return withRead(db, async (db) => ({
    clients: await db.getAllAsync<{ id: number; name: string; email: string; postalCode: string }>(
      'SELECT id, name, email, postal_code AS postalCode FROM clients'
    ),
    items: await db.getAllAsync<{ id: number; name: string; sku: string }>('SELECT id, name, sku FROM catalog_items'),
  }));
}

const CLIENT_COLUMNS = [
  'kind', 'name', 'contact', 'street', 'postalCode', 'city', 'countryCode', 'email', 'phone', 'vatId', 'buyerReference',
  'treatment', 'language', 'currency', 'paymentDays', 'notes', 'shipName', 'shipStreet', 'shipPostalCode', 'shipCity',
  'shipCountryCode', 'archived', 'createdAt', 'updatedAt',
] as const;
const ITEM_COLUMNS = [
  'name', 'description', 'unitCode', 'sku', 'priceE4', 'priceIncludesVat', 'taxCategory', 'taxRateBp', 'archived', 'createdAt', 'updatedAt',
] as const;

/** Inserts the clients in file order, all or nothing. Returns the new ids. */
export function importClients(db: Db, records: readonly ClientImport[], now: number = Date.now()): Promise<number[]> {
  return withTransaction(db, async (db) => {
    const ids: number[] = [];
    for (const r of records) {
      const { sql, values } = insertSql('clients', { ...r, createdAt: now, updatedAt: now }, CLIENT_COLUMNS);
      ids.push((await db.runAsync(sql, ...values)).lastInsertRowId);
    }
    return ids;
  });
}

/** Inserts the catalog items in file order, all or nothing. Returns the new ids. */
export function importItems(db: Db, records: readonly ItemImport[], now: number = Date.now()): Promise<number[]> {
  return withTransaction(db, async (db) => {
    const ids: number[] = [];
    for (const r of records) {
      const { sql, values } = insertSql('catalog_items', { ...r, createdAt: now, updatedAt: now }, ITEM_COLUMNS);
      ids.push((await db.runAsync(sql, ...values)).lastInsertRowId);
    }
    return ids;
  });
}
