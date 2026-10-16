// Copied from warranty-wallet (its D42), adapted for Invoice Maker. Payment reminders are LOCAL
// notifications (V1_PLAN "Reminders"); the re-plan uses expo-background-task (P6). Two capabilities this
// app never uses are removed from the iOS build:
//  - aps-environment (push), added by expo-notifications; a signing team without Push would reject it;
//  - UIBackgroundModes "fetch", added by expo-task-manager (pulled in by expo-background-task).
// Registered BEFORE 'expo-notifications' in app.config.ts because config-plugin mods run in reverse order.
const { withEntitlementsPlist, withInfoPlist } = require('expo/config-plugins');

module.exports = function withNoPush(config) {
  config = withInfoPlist(config, (mod) => {
    const modes = mod.modResults.UIBackgroundModes;
    if (Array.isArray(modes)) mod.modResults.UIBackgroundModes = modes.filter((m) => m !== 'fetch');
    return mod;
  });
  return withEntitlementsPlist(config, (mod) => {
    delete mod.modResults['aps-environment'];
    return mod;
  });
};
