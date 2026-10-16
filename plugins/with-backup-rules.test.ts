/**
 * @jest-environment node
 */
// D87: Google's phone backup gets no copy of the invoice database; old v1.0 rule references are removed.
jest.mock('expo/config-plugins', () => ({
  withAndroidManifest: (config: { manifest: unknown }, action: (c: { modResults: { manifest: unknown } }) => unknown) =>
    action({ ...config, modResults: { manifest: config.manifest } }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const withBackupRules = require('./with-backup-rules');

describe('with-backup-rules', () => {
  it('sets allowBackup=false and drops the v1.0 rule references', () => {
    const manifest = {
      application: [{ $: { 'android:allowBackup': 'true', 'android:dataExtractionRules': '@xml/data_extraction_rules', 'android:fullBackupContent': '@xml/backup_rules', 'android:name': '.MainApplication' } }],
    };
    withBackupRules({ manifest });
    expect(manifest.application[0].$).toEqual({ 'android:allowBackup': 'false', 'android:name': '.MainApplication' });
  });
});
