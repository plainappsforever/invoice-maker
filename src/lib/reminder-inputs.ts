// What the reminder planner reads from the database (D27, D73): open invoices and the three reminder settings.
import { getReminderSettings, type ReminderSettings } from '@/db/settings';
import { openInvoices } from '@/db/summary';
import type { Db } from '@/db/types';

import type { PlanInvoice } from './reminder-plan';

export async function readPlanInputs(db: Db): Promise<{ invoices: PlanInvoice[]; settings: ReminderSettings }> {
  const open = await openInvoices(db);
  return {
    invoices: open.map((i) => ({
      id: i.id,
      number: i.number,
      clientName: i.clientName,
      currency: i.currency,
      balanceCents: i.balanceCents,
      dueDate: i.dueDate,
      status: 'issued',
    })),
    settings: await getReminderSettings(db),
  };
}
