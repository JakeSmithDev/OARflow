// Follow-ups: the staff queue + manual follow-ups + automation rules.
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { asyncHandler, badRequest, notFound, toInt } from '../../lib/http.js';
import { query, queryOne } from '../../lib/db.js';
import { updateTenantSettings } from '../../lib/tenants.js';
import { processDueFollowUps } from '../../lib/follow_ups.js';
import { zonedWallTimeToUtc } from '../../lib/dates.js';
import { randomToken } from '../../lib/crypto.js';
import { ownsId } from '../../lib/ownership.js';
import { requireWrite } from '../../lib/permissions.js';
import { assignmentsForAppointments } from '../../lib/technicians.js';

const router = express.Router();
router.use(requireAdmin());
router.use(requireWrite('followups.manage'));

// --- Queue ----------------------------------------------------------------
router.get('/', asyncHandler(async (req, res) => {
  const status = req.query.status || 'pending';
  const rows = await query(
    `SELECT f.*, c.name AS customer_name, c.email AS customer_email
       FROM follow_ups f LEFT JOIN customers c ON c.id=f.customer_id
      WHERE f.tenant_id=$1 ${status !== 'all' ? 'AND f.status=$2' : ''}
      ORDER BY f.due_at ${status === 'done' ? 'DESC' : 'ASC'} LIMIT 200`,
    status !== 'all' ? [req.tenant.id, status] : [req.tenant.id],
  );
  if (req.query.includeAssignments === '1') {
    const assignMap = await assignmentsForAppointments(req.tenant, rows.rows.map((followUp) => followUp.appointment_id));
    for (const followUp of rows.rows) followUp.technicians = assignMap[followUp.appointment_id] || [];
  }
  const counts = await query("SELECT status, count(*)::int n FROM follow_ups WHERE tenant_id=$1 GROUP BY status", [req.tenant.id]);
  const countMap = {}; for (const r of counts.rows) countMap[r.status] = r.n;
  res.json({ ok: true, followUps: rows.rows, counts: countMap, rules: req.tenant.settings.followups.rules || [] });
}));

// --- Create a manual follow-up -------------------------------------------
router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.title) return badRequest(res, 'Title is required.');
  const customerId = toInt(b.customerId); const appointmentId = toInt(b.appointmentId);
  if (!(await ownsId(req.tenant.id, 'customers', customerId))) return badRequest(res, 'Unknown customer.');
  if (!(await ownsId(req.tenant.id, 'appointments', appointmentId))) return badRequest(res, 'Unknown appointment.');
  let dueAt = b.dueAt;
  if (b.dueDate) dueAt = zonedWallTimeToUtc(b.dueDate, b.dueTime || '09:00', req.tenant.timezone).toISOString();
  if (!dueAt) return badRequest(res, 'A due date is required.');
  const row = await queryOne(
    `INSERT INTO follow_ups (tenant_id, customer_id, appointment_id, type, title, channel, template_type, due_at, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.tenant.id, customerId || null, appointmentId || null, b.channel === 'email' ? 'email' : 'task',
     b.title, b.channel || 'task', b.templateType || null, dueAt, b.note || null, req.admin.username],
  );
  res.json({ ok: true, followUp: row });
}));

// --- Update (complete / snooze / cancel) ---------------------------------
router.patch('/:id', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id); const b = req.body || {};
  const sets = []; const params = [id, req.tenant.id];
  if (b.status && ['pending', 'done', 'snoozed', 'canceled'].includes(b.status)) { params.push(b.status); sets.push(`status=$${params.length}`); if (b.status === 'done') sets.push('completed_at=now()'); }
  if (b.snoozeDays) { const until = new Date(Date.now() + Number(b.snoozeDays) * 86400000); params.push(until.toISOString()); sets.push(`due_at=$${params.length}`); sets.push("status='pending'"); }
  if (b.note !== undefined) { params.push(b.note); sets.push(`note=$${params.length}`); }
  if (!sets.length) return badRequest(res, 'Nothing to update.');
  sets.push('updated_at=now()');
  const row = await queryOne(`UPDATE follow_ups SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`, params);
  if (!row) return notFound(res);
  res.json({ ok: true, followUp: row });
}));

// --- Process due email follow-ups now ------------------------------------
router.post('/run-due', asyncHandler(async (req, res) => {
  const result = await processDueFollowUps(req.tenant);
  res.json({ ok: true, ...result });
}));

// --- Automation rules (stored in tenant settings) ------------------------
router.put('/rules', asyncHandler(async (req, res) => {
  const rules = Array.isArray(req.body?.rules) ? req.body.rules.map((r) => ({
    id: r.id || randomToken(6), name: String(r.name || 'Follow-up'), trigger: 'after_completion',
    offsetDays: Math.max(0, Number(r.offsetDays) || 0), channel: r.channel === 'email' ? 'email' : 'task',
    templateType: r.templateType || null, active: r.active !== false,
  })) : [];
  const t = await updateTenantSettings(req.tenant.id, { followups: { rules } });
  res.json({ ok: true, rules: t.settings.followups.rules });
}));

export default router;
