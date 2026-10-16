import { addDays } from '@/engine/dates';
import { bannedIn } from '@/engine/wording';

import { hash8, MAX_SCHEDULED, parseTime, plan, reminderMoment, zoneOffsetMs, type PlanInvoice, type PlanSettings } from './reminder-plan';

// Jest runs in Europe/Berlin (D37). "Now" = 1 Oct 2026, 08:00 Berlin.
const NOW = new Date(2026, 9, 1, 8, 0);
const TODAY = '2026-10-01';
const DE: PlanSettings = { reminderTime: '09:00', remindOverdue: true, remindDueTomorrow: false, language: 'de' };
const EN: PlanSettings = { ...DE, language: 'en' };

let nextId = 1;
function inv(dueDate: string | null, over: Partial<PlanInvoice> = {}): PlanInvoice {
  const id = nextId++;
  return { id, number: `RE-2026-${String(id).padStart(4, '0')}`, clientName: 'Kunde GmbH', currency: 'EUR', balanceCents: 101_15, dueDate, status: 'issued', ...over };
}

/** formatMoney puts a non-breaking space before the symbol (German). */
const nb = (s: string) => s.replace(/ (€|\$)/g, '\u00a0$1');

describe('reminderMoment', () => {
  it('keeps the wall-clock time on Berlin daylight-saving days', () => {
    const spring = reminderMoment('2026-03-29', '09:00'); // CET → CEST
    const autumn = reminderMoment('2026-10-25', '09:00'); // CEST → CET
    expect([spring.getHours(), autumn.getHours()]).toEqual([9, 9]);
    expect(spring.toISOString()).toBe('2026-03-29T07:00:00.000Z');
    expect(autumn.toISOString()).toBe('2026-10-25T08:00:00.000Z');
    expect(spring.getTime() - reminderMoment('2026-03-28', '09:00').getTime()).toBe(23 * 3600_000);
    expect(autumn.getTime() - reminderMoment('2026-10-24', '09:00').getTime()).toBe(25 * 3600_000);
  });

  it('builds the moment in an explicit zone (the device zone, warranty-wallet D42)', () => {
    expect(reminderMoment('2026-03-29', '09:00', 'Europe/Berlin').toISOString()).toBe('2026-03-29T07:00:00.000Z');
    expect(reminderMoment('2026-10-25', '09:00', 'Europe/Berlin').toISOString()).toBe('2026-10-25T08:00:00.000Z');
    expect(reminderMoment('2026-10-25', '00:30', 'Europe/Berlin').toISOString()).toBe('2026-10-24T22:30:00.000Z');
    expect(reminderMoment('2026-12-01', '09:00', 'America/New_York').toISOString()).toBe('2026-12-01T14:00:00.000Z');
    expect(reminderMoment('2026-12-01', '09:00', 'Asia/Tokyo').toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(zoneOffsetMs('Asia/Kolkata', Date.UTC(2026, 0, 1))).toBe(5.5 * 3600_000);
  });

  it('falls back to 09:00 for a malformed time', () => {
    expect(parseTime('18:30')).toEqual([18, 30]);
    expect(parseTime('25:00')).toEqual([9, 0]);
    expect(parseTime('9')).toEqual([9, 0]);
  });
});

describe('plan', () => {
  it('overdue reminder: the day after the due date at the reminder time, German text', () => {
    const a = inv('2026-10-05');
    const [p, ...rest] = plan([a], DE, NOW);
    expect(rest).toEqual([]);
    expect(p.day).toBe('2026-10-06');
    expect(p.date.toISOString()).toBe('2026-10-06T07:00:00.000Z');
    expect(p.title).toBe(`Rechnung ${a.number} ist überfällig`);
    expect(p.body).toBe(nb('Kunde GmbH · 101,15 € offen · fällig am 05.10.2026'));
    expect(p.data).toEqual({ documentIds: [a.id], kinds: ['overdue'] });
    expect(p.identifier).toMatch(/^im-2026-10-06-[0-9a-f]{8}$/);
  });

  it('due-tomorrow reminder only when switched on (default off); English text', () => {
    const a = inv('2026-10-05');
    expect(plan([a], EN, NOW).map((p) => p.day)).toEqual(['2026-10-06']);
    const both = plan([a], { ...EN, remindDueTomorrow: true }, NOW);
    expect(both.map((p) => [p.day, p.data.kinds[0]])).toEqual([['2026-10-04', 'due_tomorrow'], ['2026-10-06', 'overdue']]);
    expect(both[0].title).toBe(`Invoice ${a.number} is due tomorrow`);
    expect(both[0].body).toBe('Kunde GmbH · €101.15 open · due 5 Oct 2026');
    expect(plan([a], { ...EN, remindOverdue: false }, NOW)).toEqual([]);
  });

  it('across month and year ends', () => {
    const settings = { ...DE, remindDueTomorrow: true };
    expect(plan([inv('2026-10-31')], settings, NOW).map((p) => p.day)).toEqual(['2026-10-30', '2026-11-01']);
    expect(plan([inv('2026-11-01')], settings, NOW).map((p) => p.day)).toEqual(['2026-10-31', '2026-11-02']);
    expect(plan([inv('2026-12-31')], settings, NOW).map((p) => p.day)).toEqual(['2026-12-30', '2027-01-01']);
    expect(plan([inv('2027-03-01')], settings, NOW).map((p) => p.day)).toEqual(['2027-02-28', '2027-03-02']);
    expect(plan([inv('2028-03-01')], settings, NOW).map((p) => p.day)).toEqual(['2028-02-29', '2028-03-02']);
  });

  it('across Berlin daylight-saving changes: 09:00 local on the day of the change', () => {
    const autumn = plan([inv('2026-10-24')], DE, NOW); // overdue reminder on Sun 25 Oct (CEST → CET)
    expect(autumn[0].day).toBe('2026-10-25');
    expect(autumn[0].date.getHours()).toBe(9);
    expect(autumn[0].date.toISOString()).toBe('2026-10-25T08:00:00.000Z');
    const spring = plan([inv('2027-03-27')], DE, NOW); // Sun 28 Mar 2027 (CET → CEST)
    expect(spring[0].day).toBe('2027-03-28');
    expect(spring[0].date.toISOString()).toBe('2027-03-28T07:00:00.000Z');
    const zoned = plan([inv('2026-10-24')], { ...DE, timeZone: 'Europe/Berlin' }, NOW);
    expect(zoned[0].date.toISOString()).toBe(autumn[0].date.toISOString());
  });

  it('groups invoices on the same day into one notification (at most one per day)', () => {
    const a = inv('2026-10-09', { clientName: 'Alpha' });
    const b = inv('2026-10-09', { clientName: 'Beta', balanceCents: 200_000 });
    const c = inv('2026-10-11', { clientName: 'Gamma', balanceCents: 50_00 }); // due tomorrow on the 10th
    const d = inv('2026-10-09', { clientName: 'Delta', currency: 'USD', balanceCents: 10_00 });
    const result = plan([a, b, c, d], { ...DE, remindDueTomorrow: true }, NOW);
    const days = result.map((p) => p.day);
    expect(new Set(days).size).toBe(days.length);
    const tenth = result.find((p) => p.day === '2026-10-10')!;
    // Overdue first (by due date, id), then due tomorrow; amounts per currency, never summed across currencies.
    expect(tenth.data).toEqual({ documentIds: [a.id, b.id, d.id, c.id], kinds: ['overdue', 'overdue', 'overdue', 'due_tomorrow'] });
    expect(tenth.title).toBe(nb('4 Rechnungen ansehen · 2.151,15 € + 10,00 $'));
    expect(tenth.body).toBe(nb(`${a.number}: Alpha, 101,15 € überfällig\n${b.number}: Beta, 2.000,00 € überfällig\n+ 2 weitere`));
    const eighth = result.find((p) => p.day === '2026-10-08')!;
    expect(eighth.title).toBe(nb('3 Rechnungen morgen fällig · 2.101,15 € + 10,00 $'));
  });

  it('several overdue only: "n invoices overdue · amount"', () => {
    const result = plan([inv('2026-10-02'), inv('2026-10-02', { clientName: '' })], EN, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('2 invoices overdue · €202.30');
    expect(result[0].body.split('\n')[1]).toMatch(/: No client, €101\.15 overdue$/);
  });

  it('drops past moments: today only before the reminder time', () => {
    const due = inv('2026-09-30'); // overdue reminder today 09:00
    expect(plan([due], DE, NOW).map((p) => p.day)).toEqual([TODAY]);
    expect(plan([due], DE, new Date(2026, 9, 1, 9, 0))).toEqual([]); // exactly 09:00 = past
    expect(plan([inv('2026-09-01')], DE, NOW)).toEqual([]); // long overdue: no new notification
  });

  it('excludes paid, overpaid, cancelled, draft and undated invoices', () => {
    const excluded = [
      inv('2026-10-05', { balanceCents: 0 }),
      inv('2026-10-05', { balanceCents: -500 }),
      inv('2026-10-05', { status: 'cancelled' }),
      inv('2026-10-05', { status: 'draft' }),
      inv(null),
      inv('2026-02-30'),
    ];
    expect(plan(excluded, { ...DE, remindDueTomorrow: true }, NOW)).toEqual([]);
  });

  it('keeps the soonest 48 days; slot 48 carries the "open the app" sentinel', () => {
    const many = Array.from({ length: 200 }, (_, i) => inv(addDays(TODAY, i + 1)));
    const result = plan(many, DE, NOW);
    expect(result).toHaveLength(MAX_SCHEDULED);
    const days = result.map((p) => p.day);
    expect([...days].sort()).toEqual(days);
    expect(days[0]).toBe(addDays(TODAY, 2));
    expect(days[MAX_SCHEDULED - 1]).toBe(addDays(TODAY, MAX_SCHEDULED + 1));
    expect(result.filter((p) => p.data.sentinel).map((p) => p.day)).toEqual([days[MAX_SCHEDULED - 1]]);
    expect(result[MAX_SCHEDULED - 1].body).toMatch(/\nInvoice Maker öffnen, damit spätere Erinnerungen geplant bleiben\.$/);
    const fits = plan(many.slice(0, MAX_SCHEDULED), DE, NOW);
    expect(fits).toHaveLength(MAX_SCHEDULED);
    expect(fits.some((p) => p.data.sentinel)).toBe(false);
  });

  it('stable identifiers: same data → same ids (also later); changed content, time or zone → new ids', () => {
    const a = inv('2027-05-10');
    const first = plan([a], DE, NOW);
    expect(plan([a], DE, new Date(2027, 0, 15, 12, 0)).map((p) => p.identifier)).toEqual(first.map((p) => p.identifier));
    expect(plan([{ ...a, balanceCents: 5_000 }], DE, NOW)[0].identifier).not.toBe(first[0].identifier);
    expect(plan([a], { ...DE, reminderTime: '18:30' }, NOW)[0].identifier).not.toBe(first[0].identifier);
    const ny = plan([a], { ...DE, timeZone: 'America/New_York' }, NOW);
    expect(ny[0].day).toBe(first[0].day);
    expect(ny[0].date.getTime() - first[0].date.getTime()).toBe(6 * 3600_000);
    expect(ny[0].identifier).not.toBe(first[0].identifier);
    expect(plan([a], { ...DE, timeZone: 'Europe/Berlin' }, NOW)[0].identifier).toBe(first[0].identifier);
  });

  it('reminder texts contain no banned phrase', () => {
    const texts = plan([inv('2026-10-03'), inv('2026-10-03'), inv('2026-10-05')], { ...EN, remindDueTomorrow: true }, NOW)
      .concat(plan([inv('2026-10-03'), inv('2026-10-04')], { ...DE, remindDueTomorrow: true }, NOW))
      .flatMap((p) => [p.title, p.body]);
    for (const text of texts) expect(bannedIn(text)).toEqual([]);
  });
});

describe('hash8', () => {
  it('is 8 hex characters and deterministic', () => {
    expect(hash8('abc')).toBe(hash8('abc'));
    expect(hash8('abc')).toMatch(/^[0-9a-f]{8}$/);
    expect(hash8('abc')).not.toBe(hash8('abd'));
  });
});
