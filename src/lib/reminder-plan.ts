// Reminder planner (D27, SPEC F9): PURE, adapted from warranty-wallet's proven planner (its D42/D43).
// The database is the truth; the OS pending list is rebuilt from this plan on start, foreground, every
// write, notification response and the background task (`src/lib/reminders.ts`, P6).
// Moments are built from LOCAL calendar components (due day ± 1 at the reminder time) in the device's
// CURRENT time zone, passed in explicitly: a running JS engine keeps the zone it started with (measured on
// Android in warranty-wallet D42), so after a zone change the same plan gives the same wall-clock time.
import { addDays, formatDate, parseIsoDate } from '@/engine/dates';
import { formatMoney, type Lang } from '@/engine/money';
import { translate } from '@/i18n';

/** iOS keeps only the soonest 64 pending local notifications; we use at most 48. */
export const MAX_SCHEDULED = 48;
export const ID_PREFIX = 'im-';
export const CHANNEL_ID = 'invoices';
export const DEFAULT_REMINDER_TIME = '09:00';

export type PlanInvoice = {
  id: number;
  number: string;
  clientName: string;
  currency: string;
  /** Balance due in cents; ≤ 0 = paid → no reminder. */
  balanceCents: number;
  dueDate: string | null;
  /** Only 'issued' invoices are reminded; cancelled/drafts are excluded. */
  status: string;
};

export type PlanSettings = {
  /** 'HH:MM' local time of day (setting `reminder_time`). */
  reminderTime: string;
  /** Setting `remind_overdue` (default on): due date + 1 day. */
  remindOverdue: boolean;
  /** Setting `remind_due_tomorrow` (default off): due date − 1 day. */
  remindDueTomorrow: boolean;
  language: Lang;
  /** IANA zone of the device now (expo-localization). Missing = the JS engine's local zone. */
  timeZone?: string;
};

export type ReminderKind = 'overdue' | 'due_tomorrow';

export type ReminderData = {
  /** Tap: one id → that invoice; several → Home filtered to overdue/open. */
  documentIds: number[];
  kinds: ReminderKind[];
  /** True on the last slot when later reminders did not fit. */
  sentinel?: boolean;
};

export type Planned = {
  identifier: string;
  /** Local calendar day the notification fires on. */
  day: string;
  date: Date;
  title: string;
  body: string;
  data: ReminderData;
};

type Entry = { invoice: PlanInvoice; kind: ReminderKind };

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Offset of `timeZone` from UTC at instant `t` (ms), e.g. +7_200_000 for Berlin in summer. */
export function zoneOffsetMs(timeZone: string, t: number): number {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(t))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second);
  return wall - (t - (((t % 1000) + 1000) % 1000));
}

/** 'HH:MM' → [h, m]; anything else → the default 09:00. */
export function parseTime(time: string): [number, number] {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return m ? [Number(m[1]), Number(m[2])] : [9, 0];
}

/** Wall-clock moment for a calendar day and 'HH:MM' in `timeZone` (default: the engine's local zone). */
export function reminderMoment(day: string, time: string, timeZone?: string): Date {
  const ymd = parseIsoDate(day);
  if (!ymd) throw new RangeError(`invalid day: ${day}`);
  const [hh, mm] = parseTime(time);
  if (!timeZone) return new Date(ymd.y, ymd.m - 1, ymd.d, hh, mm, 0, 0);
  const wall = Date.UTC(ymd.y, ymd.m - 1, ymd.d, hh, mm);
  // Two passes settle the offset on daylight-saving days.
  const first = wall - zoneOffsetMs(timeZone, wall);
  return new Date(wall - zoneOffsetMs(timeZone, first));
}

/** FNV-1a 32 bit, 8 hex characters: stable across runs and platforms. */
export function hash8(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** "1.234,00 € + 50,00 $" — per currency, never summed across currencies. */
function amountText(entries: Entry[], lang: Lang): string {
  const sums = new Map<string, number>();
  for (const { invoice } of entries) sums.set(invoice.currency, (sums.get(invoice.currency) ?? 0) + invoice.balanceCents);
  return [...sums.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, cents]) => formatMoney(cents, currency, lang))
    .join(' + ');
}

function groupContent(settings: PlanSettings, entries: Entry[]): { title: string; body: string } {
  const lang = settings.language;
  const client = (inv: PlanInvoice) => inv.clientName.trim() || translate(lang, 'reminder.noClient');
  const amount = (inv: PlanInvoice) => formatMoney(inv.balanceCents, inv.currency, lang);
  if (entries.length === 1) {
    const { invoice, kind } = entries[0];
    return {
      title: translate(lang, kind === 'overdue' ? 'reminder.overdue.one' : 'reminder.dueTomorrow.one', { number: invoice.number }),
      body: translate(lang, 'reminder.body.one', {
        client: client(invoice),
        amount: amount(invoice),
        date: formatDate(invoice.dueDate as string, lang),
      }),
    };
  }
  const kinds = new Set(entries.map((e) => e.kind));
  const titleKey =
    kinds.size > 1 ? 'reminder.mixed.several' : kinds.has('overdue') ? 'reminder.overdue.several' : 'reminder.dueTomorrow.several';
  const lines = entries.slice(0, 2).map((e) =>
    translate(lang, e.kind === 'overdue' ? 'reminder.line.overdue' : 'reminder.line.dueTomorrow', {
      number: e.invoice.number,
      client: client(e.invoice),
      amount: amount(e.invoice),
    })
  );
  if (entries.length > 2) lines.push(translate(lang, 'reminder.more', { n: entries.length - 2 }));
  return { title: translate(lang, titleKey, { n: entries.length, amount: amountText(entries, lang) }), body: lines.join('\n') };
}

/**
 * All future reminder moments, at most one notification per local day, soonest first, ≤ MAX_SCHEDULED.
 * Candidates: issued invoices with a balance > 0 and a valid due date. Moments: due − 1 day (if
 * remindDueTomorrow) and due + 1 day (if remindOverdue) at the reminder time. Past moments are dropped
 * (an invoice already overdue for longer gets no new notification; Home shows it as overdue).
 * If more days exist, the last slot also says "Open Invoice Maker so later reminders stay scheduled".
 */
export function plan(invoices: PlanInvoice[], settings: PlanSettings, now: Date): Planned[] {
  const byDay = new Map<string, Entry[]>();
  for (const invoice of invoices) {
    if (invoice.status !== 'issued' || invoice.balanceCents <= 0) continue;
    if (invoice.dueDate === null || !parseIsoDate(invoice.dueDate)) continue;
    const moments: [ReminderKind, string][] = [];
    if (settings.remindDueTomorrow) moments.push(['due_tomorrow', addDays(invoice.dueDate, -1)]);
    if (settings.remindOverdue) moments.push(['overdue', addDays(invoice.dueDate, 1)]);
    for (const [kind, day] of moments) {
      if (reminderMoment(day, settings.reminderTime, settings.timeZone).getTime() <= now.getTime()) continue;
      byDay.set(day, [...(byDay.get(day) ?? []), { invoice, kind }]);
    }
  }

  const days = [...byDay.keys()].sort();
  const truncated = days.length > MAX_SCHEDULED;
  return days.slice(0, MAX_SCHEDULED).map((day, index) => {
    // Overdue first, then by due date, then id: stable text for the same data.
    const entries = (byDay.get(day) as Entry[]).sort(
      (a, b) =>
        (a.kind === b.kind ? 0 : a.kind === 'overdue' ? -1 : 1) ||
        (a.invoice.dueDate as string).localeCompare(b.invoice.dueDate as string) ||
        a.invoice.id - b.invoice.id
    );
    const date = reminderMoment(day, settings.reminderTime, settings.timeZone);
    let { title, body } = groupContent(settings, entries);
    const data: ReminderData = { documentIds: entries.map((e) => e.invoice.id), kinds: entries.map((e) => e.kind) };
    if (truncated && index === MAX_SCHEDULED - 1) {
      body = `${body}\n${translate(settings.language, 'reminder.sentinel', { app: translate(settings.language, 'app.name') })}`;
      data.sentinel = true;
    }
    const identifier = `${ID_PREFIX}${day}-${hash8(`${date.getTime()}|${title}|${body}|${JSON.stringify(data)}`)}`;
    return { identifier, day, date, title, body, data };
  });
}
