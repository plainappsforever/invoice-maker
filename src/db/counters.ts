// Number counters (D17, D32, D33). The caller runs takeNumber inside the Issue transaction (P2), so a
// number is only consumed when the document is really issued.
import { canSetNextValue, formatNumber, seriesKey, seriesOf, type DocumentType, type Series } from '@/engine/numbering';

import { queued } from './transaction';
import type { Db } from './types';

export type Counter = { seriesKey: string; nextValue: number; maxUsed: number };

export async function getCounter(db: Db, key: string): Promise<Counter> {
  const row = await db.getFirstAsync<{ next_value: number; max_used: number }>(
    'SELECT next_value, max_used FROM number_counters WHERE series_key = ?',
    key
  );
  return { seriesKey: key, nextValue: row?.next_value ?? 1, maxUsed: row?.max_used ?? 0 };
}

/** Consumes and returns the next value of a counter (creates it at 1). Run inside a transaction. */
export const takeNextValue = queued(async (db: Db, key: string): Promise<number> => {
  await db.runAsync('INSERT OR IGNORE INTO number_counters (series_key, next_value, max_used) VALUES (?, 1, 0)', key);
  const { nextValue } = await getCounter(db, key);
  await db.runAsync(
    'UPDATE number_counters SET next_value = ?, max_used = MAX(max_used, ?) WHERE series_key = ?',
    nextValue + 1,
    nextValue,
    key
  );
  return nextValue;
});

export class NextNumberError extends Error {
  constructor(readonly next: number, readonly maxUsed: number) {
    super(`next_number_used: ${next} must be at least ${maxUsed + 1}`);
    this.name = 'NextNumberError';
  }
}

/** "Next number" can be raised, or lowered back as long as no used value is reached again. */
export const setNextValue = queued(async (db: Db, key: string, next: number): Promise<void> => {
  const { maxUsed } = await getCounter(db, key);
  if (!canSetNextValue(next, maxUsed)) throw new NextNumberError(next, maxUsed);
  await db.runAsync(
    'INSERT INTO number_counters (series_key, next_value, max_used) VALUES (?, ?, 0) ON CONFLICT(series_key) DO UPDATE SET next_value = excluded.next_value',
    key,
    next
  );
});

export type AssignedNumber = { series: Series; seriesKey: string; value: number; number: string };

/** Takes the next number for a document type on its issue date. Run inside the Issue transaction. */
export const takeNumber = queued(async (db: Db, type: DocumentType, pattern: string, issueDate: string): Promise<AssignedNumber> => {
  const key = seriesKey(type, pattern, issueDate);
  const value = await takeNextValue(db, key);
  return { series: seriesOf(type), seriesKey: key, value, number: formatNumber(pattern, value, issueDate) };
});
