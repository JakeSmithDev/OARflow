// Upcoming-appointment reminder emails. Deliberately separate from invoicing —
// these remind a customer that their visit is coming up; they never mention a
// balance. Idempotent via appointments.reminder_sent_at.
import { query, queryOne } from './db.js';
import { sendTemplated, detailsTable } from './email_templates.js';
import { formatDateLabel, formatTimeLabel } from './dates.js';
import { config } from '../config.js';

const SELECT = `
  SELECT a.id, a.scheduled_start, a.scheduled_end, a.service_address, a.access_token,
         c.name AS customer_name, c.email AS customer_email, s.name AS service_name
    FROM appointments a
    JOIN customers c ON c.id = a.customer_id
    LEFT JOIN service_types s ON s.id = a.service_type_id`;

function reminderVars(tenant, a) {
  const company = tenant.settings.branding.logoText || tenant.name;
  const start = a.scheduled_start ? new Date(a.scheduled_start) : null;
  return {
    CUSTOMER_NAME: a.customer_name, COMPANY_NAME: company, SERVICE_NAME: a.service_name || 'appointment',
    APPOINTMENT_DATE: start ? formatDateLabel(start, tenant.timezone) : '',
    APPOINTMENT_TIME: start ? formatTimeLabel(start, tenant.timezone) : '',
    DETAILS: detailsTable([
      ['Service', a.service_name || ''],
      ['When', start ? `${formatDateLabel(start, tenant.timezone)} · ${formatTimeLabel(start, tenant.timezone)}` : ''],
      ['Address', a.service_address || ''],
    ]),
    MANAGE_URL: `${config.baseUrl}/book?appt=${a.access_token}`,
  };
}

/** Send a reminder for one appointment now and stamp reminder_sent_at. */
export async function sendAppointmentReminder(tenant, appointmentId, { force = false } = {}) {
  const a = await queryOne(`${SELECT} WHERE a.tenant_id=$1 AND a.id=$2`, [tenant.id, appointmentId]);
  if (!a) return { ok: false, error: 'Appointment not found.' };
  if (!a.customer_email) return { ok: false, error: 'No email on file for this customer.' };
  if (!a.scheduled_start) return { ok: false, error: 'Appointment has no scheduled time.' };
  const r = await sendTemplated(tenant, 'appointment_reminder', a.customer_email, reminderVars(tenant, a), { type: 'appointment', id: a.id });
  if (r.ok) await query('UPDATE appointments SET reminder_sent_at = now() WHERE id=$1', [a.id]);
  return r;
}

/** Cron: send reminders for scheduled appointments starting within leadHours
 *  that haven't been reminded yet. Returns how many were sent. */
export async function processDueReminders(tenant, { now = new Date() } = {}) {
  const cfg = tenant.settings.notifications?.appointmentReminder || {};
  if (!cfg.enabled) return { sent: 0, considered: 0, disabled: true };
  const leadHours = Number(cfg.leadHours) || 24;
  const windowEnd = new Date(now.getTime() + leadHours * 3600_000);
  const { rows } = await query(
    `${SELECT} WHERE a.tenant_id=$1 AND a.status='scheduled' AND a.reminder_sent_at IS NULL
       AND a.scheduled_start > $2 AND a.scheduled_start <= $3
     ORDER BY a.scheduled_start LIMIT 500`,
    [tenant.id, now.toISOString(), windowEnd.toISOString()],
  );
  let sent = 0;
  for (const a of rows) {
    if (!a.customer_email) { await query('UPDATE appointments SET reminder_sent_at = now() WHERE id=$1', [a.id]); continue; }
    const r = await sendTemplated(tenant, 'appointment_reminder', a.customer_email, reminderVars(tenant, a), { type: 'appointment', id: a.id });
    if (r.ok) { await query('UPDATE appointments SET reminder_sent_at = now() WHERE id=$1', [a.id]); sent += 1; }
  }
  return { sent, considered: rows.length };
}

export default { sendAppointmentReminder, processDueReminders };
