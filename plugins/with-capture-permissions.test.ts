/**
 * @jest-environment node
 */
jest.mock('expo/config-plugins', () => ({
  withAndroidManifest: (config: { manifest: unknown }, action: (c: { modResults: { manifest: unknown } }) => unknown) =>
    action({ ...config, modResults: { manifest: config.manifest } }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const withCapturePermissions = require('./with-capture-permissions');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const en = require('../locales/en.json');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const de = require('../locales/de.json');

describe('with-capture-permissions', () => {
  it('marks the camera optional and removes WRITE_CONTACTS, keeping CAMERA and READ_CONTACTS', () => {
    type Node = { $: Record<string, string> };
    const manifest: { $: Record<string, string>; 'uses-permission': Node[]; 'uses-feature'?: Node[] } = {
      $: {},
      'uses-permission': [
        { $: { 'android:name': 'android.permission.CAMERA' } },
        { $: { 'android:name': 'android.permission.READ_CONTACTS' } },
        { $: { 'android:name': 'android.permission.WRITE_CONTACTS' } },
      ],
      'uses-feature': [{ $: { 'android:name': 'android.hardware.camera', 'android:required': 'true' } }],
    };
    withCapturePermissions({ manifest });
    const perms = manifest['uses-permission'].map((p) => `${p.$['android:name']}|${p.$['tools:node'] ?? ''}`);
    expect(perms).toEqual(['android.permission.CAMERA|', 'android.permission.READ_CONTACTS|', 'android.permission.WRITE_CONTACTS|remove']);
    expect(manifest['uses-feature']!.map((f) => `${f.$['android:name']}|${f.$['android:required']}`)).toEqual([
      'android.hardware.camera|false',
      'android.hardware.camera.autofocus|false',
    ]);
  });

  it('iOS purpose strings exist in English and German, say what the access is for, and match app.config.ts', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const source: string = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.config.ts'), 'utf8');
    for (const key of ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription', 'NSContactsUsageDescription']) {
      expect(en.ios[key]).toMatch(/^Invoice Maker /);
      expect(de.ios[key]).toMatch(/^Invoice Maker /);
      expect(source).toContain(en.ios[key]);
    }
  });
});
