/**
 * @jest-environment node
 */
jest.mock('expo/config-plugins', () => ({
  withAndroidManifest: (config: { manifest: unknown }, action: (c: { modResults: { manifest: unknown } }) => unknown) =>
    action({ ...config, modResults: { manifest: config.manifest } }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const withDevInternet = require('./with-dev-internet');

describe('with-dev-internet', () => {
  it('drops a leftover INTERNET removal marker (android/ generated for preview) and keeps other removals', () => {
    const manifest: { 'uses-permission': { $: Record<string, string> }[] } = {
      'uses-permission': [
        { $: { 'android:name': 'android.permission.INTERNET', 'tools:node': 'remove' } },
        { $: { 'android:name': 'android.permission.READ_EXTERNAL_STORAGE', 'tools:node': 'remove' } },
      ],
    };
    withDevInternet({ manifest });
    const names = manifest['uses-permission'].map((p) => `${p.$['android:name']}|${p.$['tools:node'] ?? ''}`);
    expect(names).toEqual(['android.permission.READ_EXTERNAL_STORAGE|remove', 'android.permission.INTERNET|']);
  });
});
