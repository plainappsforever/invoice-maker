/**
 * @jest-environment node
 */
// D89: Firebase push components and the install-referrer permission are marked for removal in the manifest merge.
jest.mock('expo/config-plugins', () => ({
  withAndroidManifest: (config: { manifest: unknown }, action: (c: { modResults: { manifest: unknown } }) => unknown) =>
    action({ ...config, modResults: { manifest: config.manifest } }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const withoutFirebasePush = require('./without-firebase-push');

type Entry = { $: Record<string, string> };

describe('without-firebase-push', () => {
  it('marks the Firebase services, receivers and provider for removal and keeps the app\'s own components', () => {
    const manifest: { $: Record<string, string>; 'uses-permission': Entry[]; application: Record<string, Entry[] | Record<string, string>>[] } = {
      $: {},
      'uses-permission': [{ $: { 'android:name': 'android.permission.POST_NOTIFICATIONS' } }],
      application: [{ $: {}, receiver: [{ $: { 'android:name': 'expo.modules.notifications.service.NotificationsService' } }] }],
    };
    withoutFirebasePush({ manifest });
    const app = manifest.application[0] as Record<string, Entry[]>;
    const removed = (tag: string) => app[tag].filter((e) => e.$['tools:node'] === 'remove').map((e) => e.$['android:name']);
    expect(removed('service')).toContain('com.google.firebase.messaging.FirebaseMessagingService');
    expect(removed('service')).toContain('expo.modules.notifications.service.ExpoFirebaseMessagingService');
    expect(removed('receiver')).toContain('com.google.firebase.iid.FirebaseInstanceIdReceiver');
    expect(removed('provider')).toEqual(['com.google.firebase.provider.FirebaseInitProvider']);
    expect(app.receiver.map((e) => e.$['android:name'])).toContain('expo.modules.notifications.service.NotificationsService');
    expect(manifest['uses-permission'].map((p) => `${p.$['android:name']}|${p.$['tools:node'] ?? ''}`)).toEqual([
      'android.permission.POST_NOTIFICATIONS|',
      'com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE|remove',
    ]);
  });
});
