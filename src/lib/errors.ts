// Error texts for the UI (review #21): known failures get a sentence in the UI language; anything else keeps the raw
// message (it helps a bug report). PURE apart from the dictionary.
import { isLockedError } from '@/db/types';
import { t } from '@/i18n';

import { TimeoutError } from './timeout';

export function errorText(e: unknown): string {
  const message = String((e as { message?: unknown } | null)?.message ?? e);
  if (e instanceof TimeoutError || / took longer than \d+ s$/.test(message)) return t('error.pdfTimeout');
  if (isLockedError(e)) return t('error.locked');
  if (/numbers in a row already exist/.test(message)) return t('error.numbersExhausted');
  if (/SQLITE_FULL|database or disk is full|No space left/i.test(message)) return t('error.diskFull');
  return message;
}
