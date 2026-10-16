// Logo file handling (V1_PLAN "Files"): the picked image is downscaled to ≤ 600 px wide, stored as PNG under
// Paths.document/logo/<uuid>.png and referenced by its relative name. A snapshot may refer to an older logo, so
// files are never deleted here (D41).
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { launchImageLibraryAsync } from 'expo-image-picker';

const LOGO_DIR = 'logo';
export const LOGO_MAX_WIDTH = 600;

function uuid(): string {
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}`;
}

/** URI of a stored logo ('logo/<uuid>.png' relative to the app's document folder). */
export function logoUri(file: string | null | undefined): string | null {
  if (!file) return null;
  const f = new File(Paths.document, file);
  return f.exists ? f.uri : null;
}

/**
 * Opens the system photo picker (no permission needed on either platform, D29) and stores the choice.
 * Returns the relative file name, or null when the picker was cancelled (nothing changes).
 */
export async function pickLogo(): Promise<string | null> {
  const result = await launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 1 });
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  const context = ImageManipulator.manipulate(asset.uri);
  if (asset.width > LOGO_MAX_WIDTH) context.resize({ width: LOGO_MAX_WIDTH });
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.PNG });
  const dir = new Directory(Paths.document, LOGO_DIR);
  dir.create({ idempotent: true, intermediates: true });
  const name = `${LOGO_DIR}/${uuid()}.png`;
  await new File(saved.uri).copy(new File(Paths.document, name)); // finished before the name is stored (the PDF reads it)
  return name;
}
