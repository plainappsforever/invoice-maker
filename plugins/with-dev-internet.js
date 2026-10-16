// Development variant only: undo the release-only removals of with-no-internet.js. `expo prebuild` runs without --clean,
// so an android/ folder that was last generated for preview/production still carries
// `<uses-permission android:name="android.permission.INTERNET" tools:node="remove"/>`; the dev build then crashes at
// start ("NsdService: Neither user nor current process has android.permission.INTERNET") because it needs Metro.
// Found during the iOS 27 port sweep (2026-10-14). Not registered for preview/production.
const { withAndroidManifest } = require('expo/config-plugins');

const DEV_NEEDS = ['android.permission.INTERNET', 'android.permission.SYSTEM_ALERT_WINDOW'];

function withDevInternet(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest['uses-permission'] = (manifest['uses-permission'] ?? []).filter(
      (p) => !(DEV_NEEDS.includes(p.$['android:name']) && p.$['tools:node'] === 'remove'),
    );
    if (!manifest['uses-permission'].some((p) => p.$['android:name'] === 'android.permission.INTERNET')) {
      manifest['uses-permission'].push({ $: { 'android:name': 'android.permission.INTERNET' } });
    }
    return cfg;
  });
}

module.exports = withDevInternet;
