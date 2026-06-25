// Workflow registry. Importing this module registers every workflow (both as
// Inngest functions for production and in the in-process fallback for dev).
// New feature phases add their workflows here.
import { defineWorkflow, recordJobRun } from '../lib/events.js';
import { query } from '../lib/db.js';
import { getTenantById } from '../lib/tenants.js';
import { processDueReminders } from '../lib/reminders.js';
import { generateDueCycles } from '../lib/recurring.js';
import { processDueFollowUps } from '../lib/follow_ups.js';
import { processDueReviews } from '../lib/reviews.js';
import { processWebhooks } from '../lib/webhooks.js';

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
    const reviews = await processDueReviews(tenant).catch((e) => ({ error: e.message }));
    const webhooks = await processWebhooks(tenant).catch((e) => ({ error: e.message }));
    await recordJobRun(id, 'daily_maintenance', { cycles, followups, reminders, reviews, webhooks });
    summary.push({ tenant: id, cycles, followups, reminders, reviews, webhooks });
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
  fn: async ({ event }) => {
    await recordJobRun(event.data.tenantId, 'appointment.completed', { appointmentId: event.data.appointmentId });
    const t = await getTenantById(event.data.tenantId);
    const { queryOne } = await import('../lib/db.js');
    const appt = await queryOne('SELECT * FROM appointments WHERE id=$1 AND tenant_id=$2', [event.data.appointmentId, event.data.tenantId]);
    // Enqueue a post-service review request (idempotent per appointment).
    if (appt && t?.settings?.reviews?.enabled && t.settings.reviews.autoRequest) {
      const { maybeAutoRequest } = await import('../lib/reviews.js');
      await maybeAutoRequest(t, appt).catch(() => {});
    }
    // Accrue revenue/flat commissions for the assigned crew (idempotent).
    if (appt && t) { const { accrueForAppointment } = await import('../lib/commissions.js'); await accrueForAppointment(t, appt).catch(() => {}); }
  },
});

// Accrue collected-basis commissions when an invoice is paid (idempotent).
defineWorkflow({
  id: 'on-invoice-paid',
  trigger: { event: 'invoice.paid' },
  fn: async ({ event }) => {
    const t = await getTenantById(event.data.tenantId);
    const { queryOne } = await import('../lib/db.js');
    const inv = await queryOne('SELECT * FROM invoices WHERE id=$1 AND tenant_id=$2', [event.data.invoiceId, event.data.tenantId]);
    if (t && inv) { const { accrueForInvoicePaid } = await import('../lib/commissions.js'); await accrueForInvoicePaid(t, inv).catch(() => {}); }
  },
});

// Send an SMS appointment confirmation when one is scheduled (idempotent).
defineWorkflow({
  id: 'sms-appointment-confirmation',
  trigger: { event: 'appointment.scheduled' },
  fn: async ({ event, step }) => {
    const { getTenantById } = await import('../lib/tenants.js');
    const { sendAppointmentSms } = await import('../lib/notify_sms.js');
    const t = await getTenantById(event.data.tenantId);
    if (t?.settings?.notifications?.sms?.confirmationEnabled) {
      await step.run('send', () => sendAppointmentSms(t, event.data.appointmentId, 'confirmation'));
    }
  },
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
