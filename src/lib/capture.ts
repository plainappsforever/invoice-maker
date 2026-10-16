// Camera, scanner, photo and file pickers, on-device text recognition, and storing captured files (V1.5 P1, D95-D97).
// Glue only: the parsers are PURE (src/engine/contact-parse.ts). Every permission is asked at the first tap of the
// feature (D29). Nothing leaves the phone: recognition is Apple Vision / bundled ML Kit, files stay in the app folder.
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';
import DocumentScanner, { ScanDocumentResponseStatus } from 'react-native-document-scanner-plugin';

import type { AttachmentMime } from '@/db/attachments';
import type { TranslationKey } from '@/i18n';

import TextScan from '../../modules/text-scan/src/TextScanModule';

export type Picked = { uri: string; kind: 'image' | 'pdf'; name?: string };
export type PickResult = { status: 'ok'; files: Picked[] } | { status: 'cancel' } | { status: 'error'; message: TranslationKey };
export type CaptureSource = 'scan' | 'camera' | 'photos' | 'file';

/** Longest side of stored photos: attachment pages (readable when printed on A4), item photos (thumbnails). */
export const ATTACHMENT_MAX_PX = 1600;
export const ITEM_MAX_PX = 800;
/** Text recognition input: big enough for small print on a card, small enough to stay fast. */
const OCR_MAX_PX = 2400;

/**
 * The system document scanner (VisionKit / ML Kit through Google Play services): edge detection, perspective fix.
 * Any error — unsupported device, no Play services, scanner module not downloaded — falls back to the plain camera,
 * so the user is never stuck (warranty-wallet D18/D33).
 */
export async function scanDocument(maxPages = 10): Promise<PickResult> {
  try {
    const status = await TextScan.documentScannerStatus().catch(() => 'unavailable' as const);
    if (status !== 'ready') return takePhoto();
    const result = await DocumentScanner.scanDocument({ croppedImageQuality: 90, maxNumDocuments: maxPages });
    if (result.status === ScanDocumentResponseStatus.Cancel) return { status: 'cancel' };
    const images = result.scannedImages ?? [];
    if (images.length === 0) return { status: 'cancel' };
    return { status: 'ok', files: images.map((uri) => ({ uri: uri.startsWith('/') ? `file://${uri}` : uri, kind: 'image' as const })) };
  } catch (error) {
    if (__DEV__) console.info('[capture] document scanner unavailable, using the camera:', String(error));
    return takePhoto();
  }
}

/** Plain camera photo (scanner fallback, item photos). Asks for the camera permission only now. */
export async function takePhoto(): Promise<PickResult> {
  try {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return { status: 'error', message: 'capture.cameraDenied' };
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9 });
    if (result.canceled || result.assets.length === 0) return { status: 'cancel' };
    return { status: 'ok', files: result.assets.map((a) => ({ uri: a.uri, kind: 'image' as const })) };
  } catch (error) {
    // The iOS Simulator has no camera; some devices have none either.
    if (__DEV__) console.info('[capture] camera unavailable:', String(error));
    return { status: 'error', message: 'capture.noCamera' };
  }
}

/** System photo picker (no permission needed), one or several images. */
export async function pickPhotos(limit = 1): Promise<PickResult> {
  try {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: limit > 1,
      orderedSelection: limit > 1,
      selectionLimit: limit,
      quality: 1,
    });
    if (result.canceled || result.assets.length === 0) return { status: 'cancel' };
    return { status: 'ok', files: result.assets.map((a) => ({ uri: a.uri, kind: 'image' as const, name: a.fileName ?? undefined })) };
  } catch (error) {
    if (__DEV__) console.info('[capture] photo picker failed:', String(error));
    return { status: 'error', message: 'capture.failed' };
  }
}

/** System file picker: a PDF or an image (iOS returns a temporary copy; Android a content:// URI). */
export async function pickFile(): Promise<PickResult> {
  try {
    const picked = await File.pickFileAsync({ mimeTypes: ['application/pdf', 'image/jpeg', 'image/png'] });
    if (picked.canceled || !picked.result) return { status: 'cancel' };
    const file = picked.result;
    const pdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    return { status: 'ok', files: [{ uri: file.uri, kind: pdf ? 'pdf' : 'image', name: file.name }] };
  } catch (error) {
    if (__DEV__) console.info('[capture] file picker failed:', String(error));
    return { status: 'error', message: 'capture.failed' };
  }
}

export function pick(source: CaptureSource, limit = 1): Promise<PickResult> {
  switch (source) {
    case 'scan':
      return scanDocument(limit);
    case 'camera':
      return takePhoto();
    case 'photos':
      return pickPhotos(limit);
    case 'file':
      return pickFile();
  }
}

// ---------------------------------------------------------------------------------------------------------
// Stored files ('attachments/<uuid>.jpg', 'items/<uuid>.jpg' under the app's document folder)

function uuid(): string {
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}`;
}

export type StoredFile = { file: string; mime: AttachmentMime; width: number | null; height: number | null; bytes: number; name: string };

/** Downscales an image to `maxPx` on its longest side, saves it as JPEG and returns the relative name. */
export async function storeImage(uri: string, dir: 'attachments' | 'items', maxPx: number, name = ''): Promise<StoredFile> {
  const context = ImageManipulator.manipulate(uri);
  const probe = await context.renderAsync();
  const { width, height } = probe;
  const scale = Math.min(1, maxPx / Math.max(width, height));
  const image = scale < 1 ? await ImageManipulator.manipulate(uri).resize({ width: Math.round(width * scale), height: Math.round(height * scale) }).renderAsync() : probe;
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.72 });
  new Directory(Paths.document, dir).create({ idempotent: true, intermediates: true });
  const rel = `${dir}/${uuid()}.jpg`;
  const target = new File(Paths.document, rel);
  await new File(saved.uri).copy(target); // finished before the name is stored (the PDF reads it)
  return { file: rel, mime: 'image/jpeg', width: saved.width, height: saved.height, bytes: target.size ?? 0, name };
}

/** Copies a picked PDF into the app folder as is. */
export async function storePdf(uri: string, name: string): Promise<StoredFile> {
  new Directory(Paths.document, 'attachments').create({ idempotent: true, intermediates: true });
  const rel = `attachments/${uuid()}.pdf`;
  const target = new File(Paths.document, rel);
  await new File(uri).copy(target);
  return { file: rel, mime: 'application/pdf', width: null, height: null, bytes: target.size ?? 0, name };
}

/** file:// URI of a stored file, or null when it is gone. */
export function storedUri(rel: string | null | undefined): string | null {
  if (!rel) return null;
  const f = new File(Paths.document, rel);
  return f.exists ? f.uri : null;
}

/** Removes a stored file the database no longer refers to (an attachment or item photo the user removed). */
export function removeStored(rel: string | null | undefined): void {
  if (!rel || !/^(attachments|items)\/[A-Za-z0-9._-]+$/.test(rel)) return;
  const f = new File(Paths.document, rel);
  if (f.exists) f.delete();
}

/** `data:image/jpeg;base64,…` per stored image file, for the PDF renderer; files that are gone are left out. */
export async function imageDataUris(files: readonly (string | null | undefined)[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of new Set(files.filter((f): f is string => !!f))) {
    const f = new File(Paths.document, rel);
    if (!f.exists) continue;
    const mime = /\.png$/i.test(rel) ? 'image/png' : /\.jpe?g$/i.test(rel) ? 'image/jpeg' : null;
    if (mime) out[rel] = `data:${mime};base64,${await f.base64()}`;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Text recognition

/** Lines of text on a photo (business card, letterhead, screenshot of an e-mail signature), in reading order. */
export async function recognizeLines(uri: string): Promise<string[]> {
  const context = ImageManipulator.manipulate(uri);
  const probe = await context.renderAsync();
  const scale = Math.min(1, OCR_MAX_PX / Math.max(probe.width, probe.height));
  const input = scale < 1
    ? await (await ImageManipulator.manipulate(uri).resize({ width: Math.round(probe.width * scale), height: Math.round(probe.height * scale) }).renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress: 0.9 })
    : await probe.saveAsync({ format: SaveFormat.JPEG, compress: 0.9 });
  // Language correction off: a card is names, numbers and addresses, which correction can "fix" wrongly (D95).
  const result = await TextScan.recognize(input.uri, false);
  return result.lines.map((l) => l.text);
}

export const isIos = Platform.OS === 'ios';
