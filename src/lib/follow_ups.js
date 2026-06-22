// Follow-up automation. Rules live in tenants.settings.followups.rules and are
// edited in the admin suite. When a job completes we materialize follow-up
// instances; a processor (cron + manual "run due") sends email follow-ups.
import { query, queryOne } from './db.js';
import { addDays } from './dates.js';
import { sendTemplated } from './email_templates.js';

/** Create follow-up instances for a just-completed appointment, per active rules. */
export async function scheduleForCompletion(tenant, appt) {
  const rules = (tenant.settings.followups?.rules || []).filter((r) => r.active && r.trigger === 'after_completion');
  const base = appt.completed_at ? new Date(appt.completed_at) : new Date();
  for (const rule of rules) {
    const exists = await queryOne(
      'SELECT id FROM follow_ups WHERE tenant_id=$1 AND appointment_id=$2 AND rule_id=$3',
      [tenant.id, appt.id, rule.id],
    );
    if (exists) continue;
    const dueAt = addDays(base, rule.offsetDays || 0);
    await query(
      `INSERT INTO follow_ups (tenant_id, customer_id, appointment_id, rule_id, type, title, channel, template_type, due_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
      [tenant.id, appt.customer_id, appt.id, rule.id,
       rule.channel === 'email' ? 'email' : 'task', rule.name || 'Follow-up',
       rule.channel || 'task', rule.templateType || null, dueAt.toISOString()],
    );
  }
}

/** Send/complete due email follow-ups; return how many were processed. Task-type
 *  follow-ups are left for staff to action in the queue. */
export async function processDueFollowUps(tenant, { now = new Date(), limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT f.*, c.name AS customer_name, c.email AS customer_email, s.name AS service_name
       FROM follow_ups f
       LEFT JOIN customers c ON c.id=f.customer_id
       LEFT JOIN appointments a ON a.id=f.appointment_id
       LEFT JOIN service_types s ON s.id=a.service_type_id
      WHERE f.tenant_id=$1 AND f.status='pending' AND f.channel='email' AND f.due_at <= $2
      ORDER BY f.due_at LIMIT $3`,
    [tenant.id, now.toISOString(), limit],
  );
  let sent = 0;
  const company = tenant.settings.branding.logoText || tenant.name;
  for (const f of rows) {
    if (!f.customer_email) { await query("UPDATE follow_ups SET status='canceled', note='no email' WHERE id=$1", [f.id]); continue; }
    const r = await sendTemplated(tenant, f.template_type || 'follow_up', f.customer_email, {
      CUSTOMER_NAME: f.customer_name || 'there', COMPANY_NAME: company, SERVICE_NAME: f.service_name || 'service',
    }, { type: 'follow_up', id: f.id });
    if (r.ok) { await query("UPDATE follow_ups SET status='done', completed_at=now() WHERE id=$1", [f.id]); sent += 1; }
  }
  return { sent, considered: rows.length };
}

export default { scheduleForCompletion, processDueFollowUps };
