/**
 * @jest-environment node
 */
// The plugin marks INTERNET (and the permissions release builds never use) for removal in the manifest merge (SPEC A12,
// D74). The merged manifest of the release variant was also checked with Gradle (V1_LOG P6); this keeps the logic honest.
jest.mock('expo/config-plugins', () => ({
  withAndroidManifest: (config: { manifest: unknown }, action: (c: { modResults: { manifest: unknown } }) => unknown) =>
    action({ ...config, modResults: { manifest: config.manifest } }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const withNoInternet = require('./with-no-internet');

describe('with-no-internet', () => {
  it('removes INTERNET and keeps unrelated permissions', () => {
    const manifest: { $: Record<string, string>; 'uses-permission': { $: Record<string, string> }[] } = {
      $: {},
      'uses-permission': [
        { $: { 'android:name': 'android.permission.INTERNET' } },
        { $: { 'android:name': 'android.permission.VIBRATE' } },
        { $: { 'android:name': 'android.permission.SYSTEM_ALERT_WINDOW' } },
        { $: { 'android:name': 'android.permission.READ_EXTERNAL_STORAGE' } },
      ],
    };
    withNoInternet({ manifest });
    const names = manifest['uses-permission'].map((p) => `${p.$['android:name']}|${p.$['tools:node'] ?? ''}`);
    expect(names).toContain('android.permission.INTERNET|remove');
    expect(names).toContain('android.permission.SYSTEM_ALERT_WINDOW|remove');
    expect(names).toContain('android.permission.READ_EXTERNAL_STORAGE|remove');
    expect(names).toContain('android.permission.WRITE_EXTERNAL_STORAGE|remove');
    expect(names).toContain('android.permission.VIBRATE|');
    expect(names.filter((n) => n.startsWith('android.permission.INTERNET'))).toHaveLength(1);
    expect(manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools');
  });
});
