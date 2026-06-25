// Transactional appointment SMS (confirmation / reminder / on-my-way). Sends
// only when SMS is connected and the customer hasn't opted out. Idempotent for
// confirmation + reminder so they're never double-sent.
import { queryOne } from './db.js';
import { sendSms, isSmsConfigured } from './sms.js';
import { fillPlaceholders } from './email_templates.js';
import { formatDateLabel, formatTimeLabel } from './dates.js';

function templateFor(tenant, kind) {
  return tenant.settings.notifications?.sms?.templates?.[kind] || '';
}

export async function sendAppointmentSms(tenant, appointmentId, kind, extraVars = {}) {
  if (!isSmsConfigured(tenant) && tenant.settings.integrations.sms?.provider !== 'twilio') {
    // still allowed in dev (console outbox) — isSmsConfigured false just logs.
  }
  const a = await queryOne(
    `SELECT a.*, c.name AS customer_name, c.phone AS customer_phone, s.name AS service_name
       FROM appointments a JOIN customers c ON c.id=a.customer_id LEFT JOIN service_types s ON s.id=a.service_type_id
      WHERE a.tenant_id=$1 AND a.id=$2`,
    [tenant.id, appointmentId],
  );
  if (!a || !a.customer_phone) return { ok: false, error: 'No phone on file.' };
  const tpl = templateFor(tenant, kind);
  if (!tpl) return { ok: false, error: 'No template.' };
  const start = a.scheduled_start ? new Date(a.scheduled_start) : null;
  const body = fillPlaceholders(tpl, {
    CUSTOMER_NAME: a.customer_name, COMPANY_NAME: tenant.settings.branding.logoText || tenant.name,
    SERVICE_NAME: a.service_name || 'appointment',
    APPOINTMENT_DATE: start ? formatDateLabel(start, tenant.timezone) : '',
    APPOINTMENT_TIME: start ? formatTimeLabel(start, tenant.timezone) : '',
    ...extraVars,
  });
  const idempotencyKey = (kind === 'confirmation' || kind === 'reminder') ? `sms:${kind}:${appointmentId}` : undefined;
  return sendSms(tenant, { to: a.customer_phone, body, customerId: a.customer_id, appointmentId, purpose: 'transactional', idempotencyKey });
}

export default { sendAppointmentSms };
