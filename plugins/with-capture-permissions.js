// V1.5 P1 "Capture" (DECISIONS D96): the camera is optional hardware on Android, so Google Play does not hide the app
// from devices without a camera (a CAMERA permission alone implies a required camera feature). Contacts: the app only
// READS the one contact the user picks; WRITE_CONTACTS (added by the expo-contacts plugin) is removed in the manifest
// merge. Every variant. Permissions are requested at the first tap of the feature, never at launch (D29).
const { withAndroidManifest } = require('expo/config-plugins');

const OPTIONAL_FEATURES = ['android.hardware.camera', 'android.hardware.camera.autofocus'];
const REMOVED = ['android.permission.WRITE_CONTACTS'];

function withCapturePermissions(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.$['xmlns:tools'] = manifest.$['xmlns:tools'] ?? 'http://schemas.android.com/tools';
    const features = (manifest['uses-feature'] ?? []).filter((f) => !OPTIONAL_FEATURES.includes(f.$['android:name']));
    for (const name of OPTIONAL_FEATURES) features.push({ $: { 'android:name': name, 'android:required': 'false' } });
    manifest['uses-feature'] = features;
    const permissions = (manifest['uses-permission'] ?? []).filter((p) => !REMOVED.includes(p.$['android:name']));
    for (const name of REMOVED) permissions.push({ $: { 'android:name': name, 'tools:node': 'remove' } });
    manifest['uses-permission'] = permissions;
    return cfg;
  });
}

module.exports = withCapturePermissions;
module.exports.OPTIONAL_FEATURES = OPTIONAL_FEATURES;
module.exports.REMOVED = REMOVED;
