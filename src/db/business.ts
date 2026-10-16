// The one business profile (v1) and its VAT rate list.
import type { Lang } from '@/engine/money';
import type { VatMode } from '@/engine/treatment';

import { fromRow, updateSql } from './rows';
import { queued, withRead } from './transaction';
import type { Db } from './types';

export type { VatMode };

export type Business = {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  countryCode: string;
  email: string;
  phone: string;
  website: string;
  taxNumber: string;
  vatId: string;
  iban: string;
  bic: string;
  bankName: string;
  accountHolder: string;
  /** Relative to Paths.document. */
  logoFile: string | null;
  /** Drawn signature (src/engine/signature.ts JSON); printed on documents when set (V1.5 P1, L140-a). */
  signature: string | null;
  vatMode: VatMode;
  currency: string;
  language: Lang;
  paymentDays: number;
  footer: string;
  updatedAt: number;
};

export type BusinessPatch = Partial<Omit<Business, 'updatedAt'>>;

const BUSINESS_FIELDS = [
  'name', 'street', 'postalCode', 'city', 'countryCode', 'email', 'phone', 'website', 'taxNumber', 'vatId',
  'iban', 'bic', 'bankName', 'accountHolder', 'logoFile', 'signature', 'vatMode', 'currency', 'language', 'paymentDays',
  'footer', 'updatedAt',
] as const;

export function getBusiness(db: Db): Promise<Business> {
  return withRead(db, async (db) => {
    const row = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM business WHERE id = 1');
    if (!row) throw new Error('business row missing (migration 2 creates it)');
    const { id: _id, ...business } = fromRow<Business & { id: number }>(row);
    return business;
  });
}

export const updateBusiness = queued(async (db: Db, patch: BusinessPatch, now: number = Date.now()): Promise<void> => {
  const update = updateSql('business', 1, { ...patch, updatedAt: now }, BUSINESS_FIELDS);
  if (update) await db.runAsync(update.sql, ...update.values);
});

export type TaxRate = { id: number; label: string; rateBp: number; isDefault: boolean; archived: boolean; sort: number };

export function listTaxRates(db: Db, options: { includeArchived?: boolean } = {}): Promise<TaxRate[]> {
  return withRead(db, async (db) => {
    const rows = await db.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM tax_rates ${options.includeArchived ? '' : 'WHERE archived = 0'} ORDER BY sort, id`
    );
    return rows.map((r) => fromRow<TaxRate>(r, ['isDefault', 'archived']));
  });
}

export const addTaxRate = queued(async (db: Db, label: string, rateBp: number): Promise<number> => {
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10_000) throw new RangeError('rate must be 0–100 %');
  const result = await db.runAsync(
    'INSERT INTO tax_rates (label, rate_bp, sort) VALUES (?, ?, (SELECT COALESCE(MAX(sort), -1) + 1 FROM tax_rates))',
    label,
    rateBp
  );
  return result.lastInsertRowId;
});

export const setDefaultTaxRate = queued(async (db: Db, id: number): Promise<void> => {
  await db.runAsync('UPDATE tax_rates SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END', id);
});

/** Archived rates stay on existing documents (lines store the rate itself) but are not offered any more. */
export const setTaxRateArchived = queued(async (db: Db, id: number, archived: boolean): Promise<void> => {
  await db.runAsync('UPDATE tax_rates SET archived = ? WHERE id = ?', archived ? 1 : 0, id);
});
