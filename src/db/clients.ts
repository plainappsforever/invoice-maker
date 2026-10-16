import type { Lang } from '@/engine/money';
import type { Treatment } from '@/engine/treatment';

import { fromRow, insertSql, updateSql } from './rows';
import { queued, withRead } from './transaction';
import type { Db } from './types';

/** Default tax treatment of a client (SPEC §5, D21); the document copies it. */
export type { Treatment };

export type Client = {
  id: number;
  kind: 'business' | 'person';
  name: string;
  contact: string;
  street: string;
  postalCode: string;
  city: string;
  countryCode: string;
  email: string;
  phone: string;
  vatId: string;
  /** Leitweg-ID (D18). */
  buyerReference: string;
  treatment: Treatment;
  language: Lang | null;
  currency: string | null;
  paymentDays: number | null;
  notes: string;
  /** Delivery address when it differs from the billing address (V1.5 P1, L141-a); all empty = none. */
  shipName: string;
  shipStreet: string;
  shipPostalCode: string;
  shipCity: string;
  shipCountryCode: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ClientInput = Partial<Omit<Client, 'id' | 'archived' | 'createdAt' | 'updatedAt'>> & { name: string };

const FIELDS = [
  'kind', 'name', 'contact', 'street', 'postalCode', 'city', 'countryCode', 'email', 'phone', 'vatId',
  'buyerReference', 'treatment', 'language', 'currency', 'paymentDays', 'notes', 'shipName', 'shipStreet', 'shipPostalCode',
  'shipCity', 'shipCountryCode', 'archived', 'createdAt', 'updatedAt',
] as const;

const map = (row: Record<string, unknown>) => fromRow<Client>(row, ['archived']);

export const createClient = queued(async (db: Db, input: ClientInput, now: number = Date.now()): Promise<number> => {
  const { sql, values } = insertSql('clients', { ...input, createdAt: now, updatedAt: now }, FIELDS);
  return (await db.runAsync(sql, ...values)).lastInsertRowId;
});

export function getClient(db: Db, id: number): Promise<Client | null> {
  return withRead(db, async (db) => {
    const row = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM clients WHERE id = ?', id);
    return row ? map(row) : null;
  });
}

/** Active clients by name; `search` matches name, contact, e-mail and city. */
export function listClients(db: Db, options: { search?: string; includeArchived?: boolean; recentFirst?: boolean } = {}): Promise<Client[]> {
  return withRead(db, async (db) => {
    const where: string[] = [];
    const params: string[] = [];
    if (!options.includeArchived) where.push('archived = 0');
    if (options.search?.trim()) {
      where.push('(name LIKE ? OR contact LIKE ? OR email LIKE ? OR city LIKE ?)');
      const like = `%${options.search.trim()}%`;
      params.push(like, like, like, like);
    }
    const rows = await db.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM clients ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${
        options.recentFirst ? '(SELECT MAX(d.created_at) FROM documents d WHERE d.client_id = clients.id) IS NULL, (SELECT MAX(d.created_at) FROM documents d WHERE d.client_id = clients.id) DESC, ' : ''
      }name COLLATE NOCASE, id`,
      ...params
    );
    return rows.map(map);
  });
}

export const updateClient = queued(async (db: Db, id: number, patch: Partial<ClientInput>, now: number = Date.now()): Promise<void> => {
  const update = updateSql('clients', id, { ...patch, updatedAt: now }, FIELDS);
  if (update) await db.runAsync(update.sql, ...update.values);
});

/** Clients are archived, never deleted: issued documents reference them. */
export const setClientArchived = queued(async (db: Db, id: number, archived: boolean, now: number = Date.now()): Promise<void> => {
  await updateClient(db, id, { archived } as Partial<ClientInput>, now);
});
