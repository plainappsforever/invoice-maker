// Files of the Data screen (SPEC F10, D28, D73): the backup file, the CSV files, the file picker for a restore, the
// logo files a backup carries, and the files "Delete all data" removes. The formats are PURE (src/data), the database
// side is src/db/restore.ts; this is only the glue to expo-file-system and expo-sharing.
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { backupFileName, buildBackup, buildBackupZip as zipBackup, FILE_PATH, referencedFiles } from '@/data/backup';
import { buildCsv, csvFileName, csvPeriod, type CsvKind, type CsvPeriodChoice } from '@/data/csv';
import { todayLocal } from '@/engine/dates';
import { readCsvInput } from '@/db/export';
import { LATEST_VERSION } from '@/db/migrations';
import { readAllData } from '@/db/restore';
import { withRead } from '@/db/transaction';
import type { Db } from '@/db/types';
import { getUiLanguage } from '@/i18n';
import { isDevBuild } from './debug';

const BACKUP_DIR = 'backup';
const CSV_DIR = 'csv';

function cacheFile(dir: string, name: string): File {
  const folder = new Directory(Paths.cache, dir);
  if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
  return new File(folder, name);
}

function writeText(file: File, text: string) {
  if (!file.exists) file.create({ intermediates: true });
  file.write(text);
}

/** Share sheet for a file we just wrote; false when this device has no share sheet. */
export async function shareFile(file: File, mimeType: string, UTI: string): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;
  await Sharing.shareAsync(file.uri, { mimeType, UTI, dialogTitle: file.name });
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Backup

/**
 * Backup format 2 (V1.5 P1): every row as backup.json plus every file the data refers to (logos, attachments, item
 * photos), byte for byte, in one ZIP. A referenced file that is gone from the phone is left out; the restore summary
 * then lists it as missing (never silently).
 */
export async function buildBackupBytes(db: Db, now: Date = new Date()): Promise<Uint8Array> {
  const data = await withRead(db, readAllData);
  const binaries: Record<string, Uint8Array> = {};
  for (const name of referencedFiles(data)) {
    const f = new File(Paths.document, name);
    if (f.exists) binaries[name] = await f.bytes();
  }
  const file = buildBackup(data, { schemaVersion: LATEST_VERSION, exportedAt: now.toISOString(), app: 'invoice-maker' });
  return zipBackup(file, binaries);
}

function writeBytes(file: File, bytes: Uint8Array) {
  if (!file.parentDirectory.exists) file.parentDirectory.create({ intermediates: true, idempotent: true });
  if (!file.exists) file.create();
  file.write(bytes);
}

/** Writes `invoice-maker-backup-YYYY-MM-DD.zip` into the cache and returns it for the share sheet. */
export async function writeBackupFile(db: Db): Promise<{ file: File; name: string; bytes: number }> {
  const bytes = await buildBackupBytes(db);
  const name = backupFileName(todayLocal());
  const file = cacheFile(BACKUP_DIR, name);
  writeBytes(file, bytes);
  if (isDevBuild) writeBytes(devBackupFile(), bytes); // survives "Delete all data" so a flow can restore it
  return { file, name, bytes: bytes.length };
}

const devBackupFile = () => new File(Paths.document, 'dev-backup', 'last.zip');

// Safety copy (review #14, D92): right before a restore replaces everything, the current data is written to
// `Paths.document/safety/before-restore.json` (one file, the newest replaces the older one), so "Undo the last restore"
// can bring it back. Not written when the phone has no documents and no clients (an empty copy would replace a useful
// one). "Delete all data" removes it with everything else: a delete must delete.
// V1.5 P1: the copy is a format-2 ZIP (with photos); a v1.x JSON copy is still offered until a newer one replaces it.
const safetyFile = () => new File(Paths.document, 'safety', 'before-restore.zip');
const oldSafetyFile = () => new File(Paths.document, 'safety', 'before-restore.json');

export async function writeSafetyCopy(db: Db, hasData: boolean): Promise<void> {
  if (!hasData) return;
  writeBytes(safetyFile(), await buildBackupBytes(db));
  const old = oldSafetyFile();
  if (old.exists) old.delete(); // replaced by the newer copy (the app's own file, as before: one copy only)
}

/** The safety copy and when it was written, or null. */
export function safetyCopy(): { file: File; modified: number | null } | null {
  for (const file of [safetyFile(), oldSafetyFile()]) if (file.exists) return { file, modified: file.modificationTime ?? null };
  return null;
}

/** Development builds: the last backup made on this phone (lets a flow run the whole restore path). */
export function lastBackupFile(): File | null {
  for (const file of [devBackupFile(), new File(Paths.document, 'dev-backup', 'last.json')]) if (file.exists) return file;
  return null;
}

export type PickedBackup = { canceled: true } | { canceled: false; bytes: Uint8Array } | { canceled: false; error: string };

/** The system file picker (Files / document UI), then the bytes of the chosen file (ZIP of V1.5 or JSON of v1.x). */
export async function pickBackupBytes(): Promise<PickedBackup> {
  const picked = await File.pickFileAsync({ mimeTypes: ['application/zip', 'application/json', 'text/plain', 'application/octet-stream', '*/*'] });
  if (picked.canceled) return { canceled: true };
  try {
    return { canceled: false, bytes: await picked.result.bytes() };
  } catch (e) {
    return { canceled: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The system file picker for a CSV file to import (V1.5 P1); UTF-8 text. */
export async function pickCsvText(): Promise<{ canceled: true } | { canceled: false; text: string } | { canceled: false; error: string }> {
  const picked = await File.pickFileAsync({ mimeTypes: ['text/csv', 'text/comma-separated-values', 'text/plain', 'application/vnd.ms-excel', '*/*'] });
  if (picked.canceled) return { canceled: true };
  try {
    return { canceled: false, text: await picked.result.text() };
  } catch (e) {
    return { canceled: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function readBackupBytes(file: File): Promise<Uint8Array> {
  return file.bytes();
}

/**
 * Files from a validated backup go back to `Paths.document` before the database is replaced (names are uuids, checked
 * against FILE_PATH again here): v1.x logos as base64, V1.5 files as bytes.
 */
export function writeBackupFiles(base64Files: Record<string, string>, binaries: Record<string, Uint8Array>): void {
  for (const [name, base64] of Object.entries(base64Files)) {
    if (!FILE_PATH.test(name)) continue;
    const target = new File(Paths.document, name);
    if (!target.parentDirectory.exists) target.parentDirectory.create({ intermediates: true, idempotent: true });
    if (!target.exists) target.create();
    target.write(base64, { encoding: 'base64' });
  }
  for (const [name, bytes] of Object.entries(binaries)) {
    if (!FILE_PATH.test(name)) continue;
    writeBytes(new File(Paths.document, name), bytes);
  }
}

// ---------------------------------------------------------------------------------------------------------
// CSV

export async function writeCsvFile(db: Db, kind: CsvKind, period: CsvPeriodChoice): Promise<File> {
  const today = todayLocal();
  const input = await withRead(db, readCsvInput);
  const text = buildCsv(kind, input, { lang: getUiLanguage(), period: csvPeriod(period, today), today });
  const file = cacheFile(CSV_DIR, csvFileName(kind, today));
  writeText(file, text);
  return file;
}

// ---------------------------------------------------------------------------------------------------------
// Delete all data

const DOCUMENT_DIRS = ['logo', 'pdf', 'pdf-probe', 'safety', 'attachments', 'items'];
const CACHE_DIRS = ['share', 'preview', BACKUP_DIR, CSV_DIR];

/** Removes the app's own files (logo, PDFs, shared copies, backups and CSV files written for sharing). */
export function deleteAppFiles(): void {
  for (const name of DOCUMENT_DIRS) {
    const dir = new Directory(Paths.document, name);
    if (dir.exists) dir.delete();
  }
  for (const name of CACHE_DIRS) {
    const dir = new Directory(Paths.cache, name);
    if (dir.exists) dir.delete();
  }
}
