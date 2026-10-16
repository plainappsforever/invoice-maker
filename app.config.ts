import type { ConfigContext, ExpoConfig } from 'expo/config';

// One codebase, three installable variants that can sit side by side on a device.
// Select with APP_VARIANT (set by scripts/native.sh and eas.json).
const VARIANTS = {
  development: { name: 'Invoice Maker Dev', id: 'com.tim.invoicemaker.dev', scheme: 'invoicemaker-dev' },
  preview: { name: 'Invoice Maker Preview', id: 'com.tim.invoicemaker.preview', scheme: 'invoicemaker-preview' },
  production: { name: 'Invoice Maker', id: 'com.tim.invoicemaker', scheme: 'invoicemaker' },
} as const;

type Variant = keyof typeof VARIANTS;

const variant = (process.env.APP_VARIANT ?? 'development') as Variant;
if (!(variant in VARIANTS)) {
  throw new Error(`Unknown APP_VARIANT "${variant}". Use development, preview or production.`);
}
const { name, id, scheme } = VARIANTS[variant];

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name,
  slug: 'invoice-maker',
  // v1.1 (RELEASE_KIT 1c item 12): marketing version and a build number that grows with every store upload.
  version: '1.1.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme,
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: id,
    buildNumber: '10100',
    icon: './assets/expo.icon',
    // No encryption beyond the OS's own (no network code, no crypto in src/): App Store Connect stops asking (kit 1c item 6).
    config: { usesNonExemptEncryption: false },
    // English + German: the system permission prompts follow the phone language (V1.5 P1, as warranty-wallet).
    infoPlist: { CFBundleLocalizations: ['en', 'de'], CFBundleAllowMixedLocalizations: true },
  },
  // Localised iOS permission prompts (camera, photos, contacts). The English base strings are the plugin options below
  // and must match locales/en.json (Jest: plugins/with-capture-permissions.test.ts).
  locales: { en: './locales/en.json', de: './locales/de.json' },
  android: {
    package: id,
    versionCode: 10100,
    adaptiveIcon: {
      backgroundColor: '#3949AB',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    // FIRST, so its mods run after the others: preview/production carry no dev-client keys, even from an earlier dev
    // prebuild (prebuild runs without --clean). D90, review #11, kit 1c items 6/21.
    ...(variant === 'development' ? [] : ['./plugins/without-dev-client-residue.js' as const]),
    'expo-router',
    ['expo-splash-screen', { backgroundColor: '#3949AB', image: './assets/images/splash-icon.png', imageWidth: 76 }],
    'expo-sqlite',
    // Before 'expo-notifications': mods run in reverse order, so this strips push/fetch after it adds them.
    './plugins/with-no-push.js',
    'expo-notifications',
    // Best-effort background re-plan of the payment reminders (P6, D73); iOS needs this plugin entry.
    'expo-background-task',
    // Dev builds reopen the last Metro server directly, so Maestro can launch them unattended. Development only (D90).
    ...(variant === 'development' ? [['expo-dev-client', { launchMode: 'most-recent' }] as [string, object], './plugins/with-dev-menu-defaults.js'] : []),
    // Firebase push pieces of expo-notifications out of the Android manifest, every variant (D89, kit 1c item 8).
    './plugins/without-firebase-push.js',
    './plugins/with-backup-rules.js',
    'expo-localization',
    '@react-native-community/datetimepicker',
    // Photos from the system photo picker need no permission (D29). The camera (V1.5 P1, D96) is asked for at the first
    // tap of Scan/Photo, never at launch; microphone blocked.
    [
      'expo-image-picker',
      {
        photosPermission: 'Invoice Maker lets you pick your logo, receipt photos and product photos.',
        cameraPermission: 'Invoice Maker uses the camera to scan business cards, receipts and documents. Photos and scans stay on your phone.',
        microphonePermission: false,
      },
    ],
    // System document scanner: VisionKit on iOS, ML Kit (Google Play services) on Android (D96).
    [
      'react-native-document-scanner-plugin',
      { cameraPermission: 'Invoice Maker uses the camera to scan business cards, receipts and documents. Photos and scans stay on your phone.' },
    ],
    // Client from the phone's contacts (D97): iOS uses the system picker (no access to the address book); Android reads
    // the picked contact and needs READ_CONTACTS (asked at the first tap). The purpose string is required because the
    // library links the contacts framework.
    ['expo-contacts', { contactsPermission: 'Invoice Maker reads only the contact you pick, to fill in a client. Nothing leaves your phone.' }],
    './plugins/with-capture-permissions.js',
    // The app has no network code, so release builds have no INTERNET permission (SPEC A12, D74). Dev builds need it for Metro.
    ...(variant === 'development' ? ['./plugins/with-dev-internet.js' as const] : ['./plugins/with-no-internet.js' as const]),
    // Xcode 27 / iOS 27 SDK: apps without the UIScene lifecycle trap at launch. SDK 57 opt-in (expo >= 57.0.23,
    // expo-build-properties >= 57.0.20); SDK 58+ has it by default, then remove this line. See docs/DECISIONS.md.
    ['expo-build-properties', { ios: { enableSceneSupport: true } }],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    appVariant: variant,
  },
});
