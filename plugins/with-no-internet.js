// P6 (D74, SPEC A12): the app has no network code (documents, PDFs, backups and reminders are all on the phone), so
// preview and production Android builds ship WITHOUT android.permission.INTERNET. A `tools:node="remove"` entry
// also strips it from library manifests during the manifest merge. Development builds keep it: they load JavaScript
// from Metro. Adapted from warranty-wallet's plugin (its D25/D55/D63); registered by app.config.ts only for
// APP_VARIANT preview/production. Verified with `aapt dump permissions` (V1_LOG P6).
// The same mechanism strips permissions release builds never use: the overlay permission from the Expo template (dev
// menu only), Firebase push (c2dm; no push in this app) and the launcher-badge permissions of expo-notifications
// (shouldSetBadge is false; no badges). P7 added the legacy storage permissions (READ/WRITE_EXTERNAL_STORAGE, maxSdk 32,
// pulled in by expo-file-system/image-picker): the app only uses its own folders, the system photo and file pickers and
// the share sheet. ACCESS_NETWORK_STATE, WAKE_LOCK and FOREGROUND_SERVICE stay: WorkManager (background re-plan) uses them.
const { withAndroidManifest } = require('expo/config-plugins');

const INTERNET = 'android.permission.INTERNET';

const RELEASE_REMOVED = [
  INTERNET,
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'com.google.android.c2dm.permission.RECEIVE',
  'android.permission.READ_APP_BADGE',
  'com.sec.android.provider.badge.permission.READ',
  'com.sec.android.provider.badge.permission.WRITE',
  'com.htc.launcher.permission.READ_SETTINGS',
  'com.htc.launcher.permission.UPDATE_SHORTCUT',
  'com.sonyericsson.home.permission.BROADCAST_BADGE',
  'com.sonymobile.home.permission.PROVIDER_INSERT_BADGE',
  'com.anddoes.launcher.permission.UPDATE_COUNT',
  'com.majeur.launcher.permission.UPDATE_BADGE',
  'com.huawei.android.launcher.permission.CHANGE_BADGE',
  'com.huawei.android.launcher.permission.READ_SETTINGS',
  'com.huawei.android.launcher.permission.WRITE_SETTINGS',
  'com.oppo.launcher.permission.READ_SETTINGS',
  'com.oppo.launcher.permission.WRITE_SETTINGS',
  'me.everything.badger.permission.BADGE_COUNT_READ',
  'me.everything.badger.permission.BADGE_COUNT_WRITE',
  'com.android.launcher.permission.READ_SETTINGS',
  'com.android.launcher.permission.WRITE_SETTINGS',
  'com.android.launcher.permission.INSTALL_SHORTCUT',
  'com.android.launcher.permission.UNINSTALL_SHORTCUT',
];

function withNoInternet(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.$['xmlns:tools'] = manifest.$['xmlns:tools'] ?? 'http://schemas.android.com/tools';
    const others = (manifest['uses-permission'] ?? []).filter((p) => !RELEASE_REMOVED.includes(p.$['android:name']));
    for (const name of RELEASE_REMOVED) others.push({ $: { 'android:name': name, 'tools:node': 'remove' } });
    manifest['uses-permission'] = others;
    return cfg;
  });
}

module.exports = withNoInternet;
module.exports.RELEASE_REMOVED = RELEASE_REMOVED;
