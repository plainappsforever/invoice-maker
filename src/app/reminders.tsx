import { Stack } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Divider, Field, Row, Screen, Section, SwitchRow } from '@/components/ui';
import { REMIND_DUE_TOMORROW_KEY, REMIND_OVERDUE_KEY, REMINDER_TIME_KEY, getReminderSettings, setSetting } from '@/db/settings';
import { useLoader } from '@/hooks/use-loader';
import { t } from '@/i18n';
import { isDevBuild } from '@/lib/debug';
import { dateLabel } from '@/lib/format';
import {
  backgroundReplanRegistered,
  lastBackgroundReplan,
  openNotificationSettings,
  reminderStatus,
  requestPermission,
  sendTestReminder,
  sync,
  triggerBackgroundReplanForTesting,
} from '@/lib/reminders';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Settings → Reminders (SPEC F9, D27): what to remind about, at which time, and the "Reminder check". */
export default function RemindersScreen() {
  const { data, reload, db } = useLoader(async (db) => ({
    settings: await getReminderSettings(db),
    status: await reminderStatus(db),
  }));
  const [message, setMessage] = useState('');
  const [debug, setDebug] = useState('');

  async function change(key: string, value: string) {
    await setSetting(db, key, value);
    await sync(db);
    await reload();
  }

  if (!data) return <Screen testID="reminders-loading">{null}</Screen>;
  const { settings, status } = data;
  const permissionText = t(`reminders.permission.${status.permission.status}`);
  return (
    <Screen testID="reminders-screen">
      <Stack.Screen options={{ title: t('settings.reminders') }} />
      <Section hint={t('reminders.hint')}>
        <SwitchRow testID="remind-overdue" label={t('reminders.overdue')} value={settings.remindOverdue} onValueChange={(on) => change(REMIND_OVERDUE_KEY, on ? '1' : '0')} />
        <Divider />
        <SwitchRow testID="remind-due-tomorrow" label={t('reminders.dueTomorrow')} value={settings.remindDueTomorrow} onValueChange={(on) => change(REMIND_DUE_TOMORROW_KEY, on ? '1' : '0')} />
        <Field
          label={t('reminders.time')}
          testID="reminder-time"
          value={settings.reminderTime}
          validate={(text) => TIME.test(text.trim())}
          invalidText={t('reminders.timeInvalid')}
          autoCapitalize="none"
          maxLength={5}
          onSave={(text) => change(REMINDER_TIME_KEY, text.trim())}
        />
      </Section>

      <Section title={t('reminders.check')}>
        <Row testID="reminder-permission" title={t('reminders.permission')} value={permissionText} />
        <Divider />
        <Row
          testID="reminder-scheduled"
          title={t('reminders.scheduled')}
          value={t('reminders.scheduledValue', { n: status.scheduled, m: status.planned })}
        />
        <Divider />
        <Row
          testID="reminder-next"
          title={t('reminders.next')}
          value={status.next ? `${dateLabel(status.next.day)} ${settings.reminderTime}` : t('reminders.none')}
        />
        <View style={{ padding: 16, gap: 8 }}>
          {status.permission.status !== 'granted' ? (
            <Button
              testID="reminder-allow"
              label={status.permission.canAskAgain ? t('reminders.allow') : t('reminders.openSettings')}
              onPress={async () => {
                if (status.permission.canAskAgain) {
                  await requestPermission(db);
                  await reload();
                } else {
                  await openNotificationSettings();
                }
              }}
            />
          ) : null}
          <Button
            testID="reminder-test"
            variant="secondary"
            label={t('reminders.test')}
            onPress={async () => {
              const ok = await sendTestReminder(db);
              setMessage(ok ? t('reminders.testSent') : t('reminders.testDenied'));
              await reload();
            }}
          />
          <ThemedText type="small" themeColor="textSecondary" testID="reminder-message">{message}</ThemedText>
        </View>
      </Section>

      {isDevBuild ? (
        <Section title="Debug">
          <View style={{ padding: 16, gap: 8 }}>
            {[2, 5].map((minutes) => (
              <Button
                key={minutes}
                testID={`debug-reminder-now${minutes}`}
                variant="secondary"
                label={`Reminder time = now + ${minutes} min`}
                onPress={async () => {
                  const d = new Date(Date.now() + minutes * 60_000);
                  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                  await setSetting(db, REMINDER_TIME_KEY, time);
                  const result = await sync(db, { full: true });
                  setDebug(`time=${time} planned=${result.planned} scheduled=${result.scheduled}`);
                  await reload();
                }}
              />
            ))}
            <Button
              testID="debug-background-replan"
              variant="secondary"
              label="Run the background re-plan now"
              onPress={async () => {
                const registered = await backgroundReplanRegistered();
                const triggered = await triggerBackgroundReplanForTesting().catch((e) => `error ${String(e)}`);
                await new Promise((r) => setTimeout(r, 4000));
                const last = lastBackgroundReplan();
                setDebug(`registered=${registered} triggered=${String(triggered)} last=${last ? (last.error ?? `scheduled ${last.result?.scheduled}`) : 'none yet (runs in its own context)'}`);
              }}
            />
            <ThemedText type="small" testID="debug-reminder-label">{debug || `scheduled=${status.scheduled} planned=${status.planned} permission=${status.permission.status}`}</ThemedText>
          </View>
        </Section>
      ) : null}
    </Screen>
  );
}
