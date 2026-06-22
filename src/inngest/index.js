// Workflow registry. Importing this module registers every workflow (both as
// Inngest functions for production and in the in-process fallback for dev).
// New feature phases add their workflows here.
import { defineWorkflow, recordJobRun } from '../lib/events.js';
import { query } from '../lib/db.js';
import { getTenantById } from '../lib/tenants.js';
import { processDueReminders } from '../lib/reminders.js';
import { generateDueCycles } from '../lib/recurring.js';
import { processDueFollowUps } from '../lib/follow_ups.js';

/** Daily maintenance across all tenants. Shared by the Inngest cron (prod) and
 *  the /api/cron/daily endpoint (dev / Vercel cron). Idempotent at the row level
 *  (reminder_sent_at, financial_events external_ref, subscription next_run_date). */
export async function runDailyMaintenance() {
  const { rows } = await query('SELECT id FROM tenants WHERE is_active = TRUE');
  const summary = [];
  for (const { id } of rows) {
    const tenant = await getTenantById(id);
    const cycles = await generateDueCycles(tenant).catch((e) => ({ error: e.message }));
    const followups = await processDueFollowUps(tenant).catch((e) => ({ error: e.message }));
    const reminders = await processDueReminders(tenant).catch((e) => ({ error: e.message }));
    await recordJobRun(id, 'daily_maintenance', { cycles, followups, reminders });
    summary.push({ tenant: id, cycles, followups, reminders });
  }
  return summary;
}

defineWorkflow({
  id: 'daily-maintenance',
  trigger: { cron: 'TZ=America/New_York 0 8 * * *' },
  fn: async ({ step }) => step.run('run', () => runDailyMaintenance()),
});

// Example domain-event handler. Feature phases attach notifications/automation
// to events like these; for now it just records an audit row.
defineWorkflow({
  id: 'on-appointment-completed',
  trigger: { event: 'appointment.completed' },
  fn: async ({ event }) => { await recordJobRun(event.data.tenantId, 'appointment.completed', { appointmentId: event.data.appointmentId }); },
});

// Async SMS send with retries. Callers emitEvent('notification.sms', { tenantId, ... }).
defineWorkflow({
  id: 'send-sms',
  trigger: { event: 'notification.sms' },
  fn: async ({ event, step }) => {
    const { sendSms } = await import('../lib/sms.js');
    const { getTenantById } = await import('../lib/tenants.js');
    const d = event.data;
    const tenant = await getTenantById(d.tenantId);
    if (!tenant) return;
    await step.run('send', () => sendSms(tenant, d));
  },
});
