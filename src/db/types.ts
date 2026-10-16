import type { SQLiteDatabase } from 'expo-sqlite';

/** The subset of expo-sqlite used by data functions. Tests supply a Node SQLite implementation. */
export type Db = Pick<SQLiteDatabase, 'execAsync' | 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;

/** Thrown when a write would change an issued (locked) document (D20). The SQLite triggers raise 'document_locked' too. */
export class DocumentLockedError extends Error {
  constructor(readonly documentId: number) {
    super(`document_locked: document ${documentId} is not a draft`);
    this.name = 'DocumentLockedError';
  }
}

export function isLockedError(error: unknown): boolean {
  // Not `instanceof Error`: native SQLite errors can come from another JS realm.
  const message = (error as { message?: unknown } | null)?.message;
  return error instanceof DocumentLockedError || (typeof message === 'string' && message.includes('document_locked'));
}
