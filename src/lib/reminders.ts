// Reminder glue (SPEC F9, D27, D73): turns the pure plan (reminder-plan.ts) into OS notifications. Adapted from
// warranty-wallet's proven glue (its D16/D42). The DATABASE is the truth: `sync()` rebuilds the pending list from it on
// app start (full), on return to the foreground, after every committed write (src/db/changes.ts), when a notification
// arrives or is answered, and in the best-effort background task `im-replan`. Imported by the entry (index.js) BEFORE
// expo-router, so the task and the response listener exist in every JS context, also when Android starts the app for them.
import { getCalendars } from 'expo-localization';
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { openDatabaseAsync } from 'expo-sqlite';
import * as TaskManager from 'expo-task-manager';
import { Alert, AppState, Linking, Platform } from 'react-native';

import { onDataChange } from '@/db/changes';
import { openDatabase } from '@/db/migrations';
import { getNotificationsAsked, setNotificationsAsked } from '@/db/settings';
import type { Db } from '@/db/types';
import { getUiLanguage, t } from '@/i18n';

import { readPlanInputs } from './reminder-inputs';
import { CHANNEL_ID, ID_PREFIX, plan, type Planned, type ReminderData } from './reminder-plan';
import { loadLanguagePreference } from './ui-language';

export const REPLAN_TASK = 'im-replan';
const TEST_ID = 'imtest-10s';
const DEBOUNCE_MS = 600;

// ---------------------------------------------------------------------------------------------------------
// Database: the app's connection once the UI has opened it; a background run opens its own (same file).

let appDb: Db | null = null;
let resolveAppReady: (db: Db) => void = () => undefined;
const appReady = new Promise<Db>((resolve) => {
  resolveAppReady = resolve;
});

async function databaseForBackground(): Promise<Db> {
  if (appDb) return appDb;
  const db = await openDatabaseAsync('app.db');
  await openDatabase(db); // foreign keys on, like the app's own connection, before any migration runs (review #19)
  return db;
}

// ---------------------------------------------------------------------------------------------------------
// Permission (D27): never at launch; explained once when the first invoice with a due date is issued.

export type PermissionState = { status: 'granted' | 'denied' | 'undetermined'; canAskAgain: boolean };

function granted(p: Notifications.NotificationPermissionsStatus): boolean {
  return p.granted || p.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}

export async function getPermissionState(): Promise<PermissionState> {
  const p = await Notifications.getPermissionsAsync();
  return { status: granted(p) ? 'granted' : p.status === 'denied' ? 'denied' : 'undetermined', canAskAgain: p.canAskAgain };
}

let channelReady = false;
/** Android 13+: the permission prompt only appears once a channel exists (D27), so this runs first. */
async function ensureChannel(): Promise<void> {
  if (channelReady) return;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: t('reminder.channel'),
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
  channelReady = true;
}

/** Shows the system prompt (or, when the phone will not ask again, opens this app's settings page). */
export async function requestPermission(db: Db): Promise<boolean> {
  await ensureChannel();
  const before = await getPermissionState();
  if (before.status === 'granted') return true;
  if (!before.canAskAgain) {
    await Linking.openSettings();
    return false;
  }
  const after = await Notifications.requestPermissionsAsync();
  await setNotificationsAsked(db);
  await sync(db);
  return granted(after);
}

/**
 * After an invoice with a due date is issued: if we never asked, one sentence why, then the system prompt. "Not now"
 * is remembered too; Settings → Reminders can turn reminders on later. Never again unprompted (SPEC §2).
 */
export async function askOnceForReminders(db: Db, hasDueDate: boolean): Promise<void> {
  if (!hasDueDate || (await getNotificationsAsked(db))) return;
  const state = await getPermissionState();
  // Android reports "denied" (not "undetermined") for a permission that can still be asked: canAskAgain decides.
  if (state.status === 'granted' || !state.canAskAgain) return;
  await setNotificationsAsked(db); // one question per install, whatever the answer
  Alert.alert(t('reminder.askTitle'), t('reminder.askBody'), [
    { text: t('reminder.askLater'), style: 'cancel' },
    { text: t('reminder.askContinue'), onPress: () => void requestPermission(db) },
  ]);
}

export function openNotificationSettings(): Promise<void> {
  return Linking.openSettings();
}

// ---------------------------------------------------------------------------------------------------------
// Planning and syncing.

/** Read from the OS on every plan: after a zone change the running JS engine still uses the old zone (D27). */
function currentTimeZone(): string | undefined {
  try {
    return getCalendars()[0]?.timeZone ?? undefined;
  } catch {
    return undefined;
  }
}

export async function buildPlan(db: Db, now = new Date()): Promise<Planned[]> {
  const { invoices, settings } = await readPlanInputs(db);
  return plan(invoices, { ...settings, language: getUiLanguage(), timeZone: currentTimeZone() }, now);
}

export type SyncResult = { permission: PermissionState['status']; planned: number; scheduled: number; added: number; cancelled: number };

async function syncOnce(db: Db, full: boolean): Promise<SyncResult> {
  const permission = (await getPermissionState()).status;
  const planned = permission === 'granted' ? await buildPlan(db) : [];
  const existing = (await Notifications.getAllScheduledNotificationsAsync()).filter((r) => r.identifier.startsWith(ID_PREFIX));
  const wanted = new Set(planned.map((p) => p.identifier));
  const have = new Set(existing.map((r) => r.identifier));
  let cancelled = 0;
  for (const r of existing) {
    if (wanted.has(r.identifier)) continue;
    await Notifications.cancelScheduledNotificationAsync(r.identifier);
    cancelled++;
  }
  if (planned.length > 0) await ensureChannel();
  let added = 0;
  for (const p of planned) {
    // Full rebuild (app start, background task): re-arm every alarm even if the OS list claims it exists — after a
    // force stop Android drops the alarms but expo-notifications still lists them.
    if (!full && have.has(p.identifier)) continue;
    await Notifications.scheduleNotificationAsync({
      identifier: p.identifier,
      content: { title: p.title, body: p.body, data: p.data, sound: 'default' },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: p.date, channelId: CHANNEL_ID },
    });
    added++;
  }
  const scheduled = (await Notifications.getAllScheduledNotificationsAsync()).filter((r) => r.identifier.startsWith(ID_PREFIX)).length;
  return { permission, planned: planned.length, scheduled, added, cancelled };
}

// One sync at a time; a request during a run schedules exactly one more run afterwards.
let running: Promise<SyncResult> | null = null;
let pending: { full: boolean } | null = null;

export function sync(db: Db, options: { full?: boolean } = {}): Promise<SyncResult> {
  if (running) {
    pending = { full: (pending?.full ?? false) || !!options.full };
    return running.then(() => (running ? running : sync(db)));
  }
  running = (async () => {
    try {
      return await syncOnce(db, !!options.full);
    } finally {
      running = null;
      const next = pending;
      pending = null;
      if (next) void sync(db, next);
    }
  })();
  return running;
}

let timer: ReturnType<typeof setTimeout> | null = null;
/** Debounced re-plan with the app's database (no-op until the app has started reminders). */
export function requestSync(): void {
  if (!appDb) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (appDb) sync(appDb).catch((e) => console.warn('reminder sync failed', e));
  }, DEBOUNCE_MS);
}

export type ReminderStatus = {
  permission: PermissionState;
  /** Our requests in the OS pending list. */
  scheduled: number;
  /** What the database says should be pending (0 while notifications are off). */
  planned: number;
  /** Planned identifiers that the OS holds. */
  matching: number;
  /** The soonest planned reminder the OS holds. */
  next: Planned | null;
};

/** Settings → Reminders "Reminder check": the OS pending list compared with the plan. */
export async function reminderStatus(db: Db): Promise<ReminderStatus> {
  const [permission, all] = await Promise.all([getPermissionState(), Notifications.getAllScheduledNotificationsAsync()]);
  const ours = new Set(all.map((r) => r.identifier).filter((id) => id.startsWith(ID_PREFIX)));
  const planned = permission.status === 'granted' ? await buildPlan(db) : [];
  const held = planned.filter((p) => ours.has(p.identifier));
  return { permission, scheduled: ours.size, planned: planned.length, matching: held.length, next: held[0] ?? null };
}

/** "Send a test reminder in 10 seconds" (asks for permission first if it was never asked). */
export async function sendTestReminder(db: Db): Promise<boolean> {
  const state = await getPermissionState();
  if (state.status !== 'granted' && !(await requestPermission(db))) return false;
  await ensureChannel();
  await Notifications.scheduleNotificationAsync({
    identifier: TEST_ID,
    content: { title: t('reminder.testTitle'), body: t('reminder.testBody'), sound: 'default' },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 10, channelId: CHANNEL_ID },
  });
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Answers: tap → the invoice (several → the Invoices tab).

function reminderData(content: Notifications.NotificationContent): ReminderData | null {
  const raw = (content.data ?? null) as { documentIds?: unknown } | null;
  if (!raw || !Array.isArray(raw.documentIds)) return null;
  const ids = raw.documentIds.filter((n): n is number => Number.isInteger(n));
  return ids.length ? { documentIds: ids, kinds: [] } : null;
}

const answered = new Set<string>();
let navigationReady: () => void = () => undefined;
const navigation = new Promise<void>((resolve) => {
  navigationReady = resolve;
});

async function handleResponse(response: Notifications.NotificationResponse): Promise<void> {
  const request = response.notification.request;
  const key = `${request.identifier}|${response.actionIdentifier}|${response.notification.date}`;
  if (answered.has(key)) return;
  answered.add(key);
  const data = reminderData(request.content);
  await Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
  if (!data) return;
  await appReady;
  await navigation;
  if (data.documentIds.length === 1) router.push({ pathname: '/document/[id]', params: { id: String(data.documentIds[0]) } });
  else router.navigate('/');
  requestSync();
}

// ---------------------------------------------------------------------------------------------------------
// App start (called once the database is open and the navigator is mounted).

export async function startReminders(db: Db): Promise<void> {
  appDb = db;
  resolveAppReady(db);
  navigationReady();
  const last = await Notifications.getLastNotificationResponseAsync();
  if (last) void handleResponse(last);
  await sync(db, { full: true });
  await registerBackgroundReplan();
}

async function registerBackgroundReplan(): Promise<void> {
  try {
    if ((await BackgroundTask.getStatusAsync()) !== BackgroundTask.BackgroundTaskStatus.Available) return;
    if (await TaskManager.isTaskRegisteredAsync(REPLAN_TASK)) return;
    await BackgroundTask.registerTaskAsync(REPLAN_TASK, { minimumInterval: 12 * 60 });
  } catch (e) {
    console.warn('background re-plan not registered', e);
  }
}

export async function backgroundReplanRegistered(): Promise<boolean> {
  return TaskManager.isTaskRegisteredAsync(REPLAN_TASK).catch(() => false);
}

/** Debug builds only: ask the OS to run the background task now. */
export function triggerBackgroundReplanForTesting(): Promise<boolean> {
  return BackgroundTask.triggerTaskWorkerForTestingAsync();
}

let lastBackgroundRun: { at: number; result: SyncResult | null; error?: string } | null = null;
export function lastBackgroundReplan() {
  return lastBackgroundRun;
}

// ---------------------------------------------------------------------------------------------------------
// Module top level: exists in every JS context (UI start, Android background worker).

TaskManager.defineTask(REPLAN_TASK, async () => {
  try {
    const db = await databaseForBackground();
    await loadLanguagePreference(db);
    const result = await sync(db, { full: true });
    lastBackgroundRun = { at: Date.now(), result };
    console.log(`im-replan: background re-plan done, ${result.scheduled} scheduled`);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (e) {
    lastBackgroundRun = { at: Date.now(), result: null, error: String(e) };
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

Notifications.addNotificationResponseReceivedListener((response) => {
  handleResponse(response).catch((e) => console.warn('reminder answer failed', e));
});
Notifications.addNotificationReceivedListener(() => requestSync());
onDataChange(requestSync);
AppState.addEventListener('change', (state) => {
  if (state === 'active') requestSync();
});
