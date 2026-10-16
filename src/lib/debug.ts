// Dev-only switch: debug screens and `invoicemaker-dev://debug/...` links work in development builds only (rule 14).
import { Asset } from 'expo-asset';
import Constants from 'expo-constants';

export const isDevBuild = Constants.expoConfig?.extra?.appVariant === 'development';

// Fixture photos for the Maestro flows of V1.5 P1 (development builds only; the Simulator has no camera and Maestro
// cannot drive the system pickers): a German business card, a receipt and a product photo, bundled under
// assets/fixtures. Returns a local file:// URI the capture code treats like a picked photo.
const FIXTURES = {
  card: require('../../assets/fixtures/card-de.jpg'),
  receipt: require('../../assets/fixtures/receipt.jpg'),
  item: require('../../assets/fixtures/item.jpg'),
} as const;

export async function fixtureImage(name: string): Promise<string | null> {
  if (!isDevBuild) return null;
  const module = FIXTURES[name as keyof typeof FIXTURES] ?? FIXTURES.card;
  const asset = Asset.fromModule(module);
  await asset.downloadAsync();
  return asset.localUri ?? asset.uri;
}
