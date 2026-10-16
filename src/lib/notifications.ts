import * as Notifications from 'expo-notifications';

/** Call once at startup so notifications also show while the app is open. Scheduling lives in `reminders.ts`. */
export function configureNotifications() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}
