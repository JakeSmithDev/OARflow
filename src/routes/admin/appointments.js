// Admin appointments: list/detail, manual create, reschedule, status changes,
// and confirming a request-mode booking (choose one of the proposed slots).
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { asyncHandler, badRequest, notFound, toInt } from '../../lib/http.js';
import { query, queryOne } from '../../lib/db.js';
import { getService, findOrCreateCustomer, createAppointment, fetchDayConflicts, overlapCount, slotCapacity } from '../../lib/appointments.js';
import { zonedWallTimeToUtc, ymdInTimeZone } from '../../lib/dates.js';
import { syncAppointment, deleteAppointmentEvent } from '../../lib/google_calendar.js';
import { scheduleForCompletion } from '../../lib/follow_ups.js';
import { sendTemplated, detailsTable } from '../../lib/email_templates.js';
import { logAudit } from '../../lib/audit.js';
import { formatDateLabel, formatTimeLabel } from '../../lib/dates.js';
import { config } from '../../config.js';

const router = express.Router();
router.use(requireAdmin());

const SELECT = `
  SELECT a.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
         s.name AS service_name, s.color AS service_color, s.duration_minutes
    FROM appointments a
    JOIN customers c ON c.id=a.customer_id
    LEFT JOIN service_types s ON s.id=a.service_type_id`;

// Resolve a UTC start/end from {start ISO} or {date,time} + service duration.
function resolveTimes(tenant, body, durationMin) {
  if (body.start) {
    const start = new Date(body.start);
    const end = body.end ? new Date(body.end) : new Date(start.getTime() + (durationMin || 60) * 60000);
    return { start, end };
  }
  if (body.date && body.time) {
    const start = zonedWallTimeToUtc(body.date, body.time, tenant.timezone);
    const end = new Date(start.getTime() + (durationMin || 60) * 60000);
    return { start, end };
  }
  return null;
}

// Returns a block descriptor if the window is at/over capacity (unless forced).
async function capacityBlock(tenant, startISO, endISO, excludeId, force) {
  if (force) return null;
  const dateYmd = ymdInTimeZone(new Date(startISO), tenant.timezone);
  const { override } = await fetchDayConflicts(tenant, dateYmd);
  const cap = slotCapacity(tenant, override);
  const booked = await overlapCount(tenant.id, startISO, endISO, excludeId);
  return booked >= cap ? { capacity: cap, booked } : null;
}

function emailVars(tenant, appt, extra = {}) {
  const company = tenant.settings.branding.logoText || tenant.name;
  return {
    CUSTOMER_NAME: appt.customer_name, COMPANY_NAME: company, SERVICE_NAME: appt.service_name || 'service',
    APPOINTMENT_DATE: appt.scheduled_start ? formatDateLabel(new Date(appt.scheduled_start), tenant.timezone) : '',
    APPOINTMENT_TIME: appt.scheduled_start ? formatTimeLabel(new Date(appt.scheduled_start), tenant.timezone) : '',
    MANAGE_URL: `${config.baseUrl}/book?appt=${appt.access_token}`,
    DETAILS: detailsTable([
      ['Service', appt.service_name || ''],
      ['When', appt.scheduled_start ? `${formatDateLabel(new Date(appt.scheduled_start), tenant.timezone)} · ${formatTimeLabel(new Date(appt.scheduled_start), tenant.timezone)}` : ''],
      ['Address', appt.service_address || ''],
    ]),
    ...extra,
  };
}

// --- List + counts --------------------------------------------------------
router.get('/', asyncHandler(async (req, res) => {
  const tenantId = req.tenant.id;
  const { status, q, from, to } = req.query;
  const limit = Math.min(toInt(req.query.limit) || 50, 200);
  const offset = toInt(req.query.offset) || 0;
  const where = ['a.tenant_id=$1']; const params = [tenantId];
  if (status && status !== 'all') { params.push(status); where.push(`a.status=$${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(c.name ILIKE $${params.length} OR c.email ILIKE $${params.length})`); }
  if (from) { params.push(from); where.push(`a.scheduled_start >= $${params.length}`); }
  if (to) { params.push(to); where.push(`a.scheduled_start < $${params.length}`); }
  params.push(limit); params.push(offset);
  const rows = await query(
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY COALESCE(a.scheduled_start, a.created_at) DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const counts = await query(
    `SELECT status, count(*)::int n FROM appointments WHERE tenant_id=$1 GROUP BY status`, [tenantId],
  );
  const countMap = { all: 0 };
  for (const r of counts.rows) { countMap[r.status] = r.n; countMap.all += r.n; }
  res.json({ ok: true, appointments: rows.rows, counts: countMap });
}));

// --- Calendar range (schedule view). Accepts either ISO from/to, or a single
//     date=YYYY-MM-DD which is resolved to that day in the tenant timezone. ----
router.get('/calendar', asyncHandler(async (req, res) => {
  let { from, to } = req.query;
  if (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) {
    const dayStart = zonedWallTimeToUtc(req.query.date, '00:00', req.tenant.timezone);
    from = dayStart.toISOString();
    to = new Date(dayStart.getTime() + 86_400_000).toISOString();
  }
  if (!from || !to) return badRequest(res, 'from and to required.');
  const rows = await query(
    `${SELECT} WHERE a.tenant_id=$1 AND a.status IN ('scheduled','completed','no_show')
       AND a.scheduled_start >= $2 AND a.scheduled_start < $3 ORDER BY a.scheduled_start`,
    [req.tenant.id, from, to],
  );
  // Capacity + exceptions so the schedule can flag over-capacity + closed days.
  const overrides = await query(
    'SELECT service_date, is_closed, capacity FROM schedule_overrides WHERE tenant_id=$1', [req.tenant.id],
  );
  const blackouts = await query(
    'SELECT starts_at, ends_at FROM blackouts WHERE tenant_id=$1 AND starts_at < $3 AND ends_at > $2',
    [req.tenant.id, from, to],
  );
  res.json({
    ok: true,
    appointments: rows.rows,
    capacity: req.tenant.settings.availability.capacityPerSlot || 1,
    overrides: overrides.rows,
    blackouts: blackouts.rows,
  });
}));

// --- Form metadata (active services) -------------------------------------
router.get('/meta/services', asyncHandler(async (req, res) => {
  const { rows } = await query(
    'SELECT id, name, duration_minutes, base_price_cents, color, booking_mode FROM service_types WHERE tenant_id=$1 AND is_active=TRUE ORDER BY sort_order, name',
    [req.tenant.id],
  );
  res.json({ ok: true, services: rows });
}));

// --- Detail ---------------------------------------------------------------
router.get('/:id', asyncHandler(async (req, res) => {
  const a = await queryOne(`${SELECT} WHERE a.tenant_id=$1 AND a.id=$2`, [req.tenant.id, toInt(req.params.id)]);
  if (!a) return notFound(res);
  const invoices = await query(
    'SELECT id, number, status, total_cents, amount_paid_cents, created_at FROM invoices WHERE tenant_id=$1 AND appointment_id=$2 ORDER BY id DESC',
    [req.tenant.id, a.id],
  );
  res.json({ ok: true, appointment: a, invoices: invoices.rows });
}));

// --- Create (manual / admin) ---------------------------------------------
router.post('/', asyncHandler(async (req, res) => {
  const tenant = req.tenant;
  const b = req.body || {};
  let customerId = toInt(b.customerId);
  if (!customerId) {
    if (!b.customer?.name) return badRequest(res, 'Customer is required.');
    customerId = await findOrCreateCustomer(tenant.id, b.customer);
  }
  const service = b.serviceId ? await getService(tenant.id, toInt(b.serviceId)) : null;
  const times = resolveTimes(tenant, b, service?.duration_minutes);
  if (!times) return badRequest(res, 'A date and time are required.');
  const block = await capacityBlock(tenant, times.start.toISOString(), times.end.toISOString(), null, b.force);
  if (block) return res.status(409).json({ ok: false, code: 'SLOT_FULL', error: `That time is at capacity (${block.booked}/${block.capacity} crews booked). Book anyway?` });
  const appt = await createAppointment(tenant.id, {
    customerId, serviceTypeId: service?.id || null, status: 'scheduled', bookingMode: 'instant', source: 'admin',
    scheduledStart: times.start.toISOString(), scheduledEnd: times.end.toISOString(),
    serviceAddress: b.serviceAddress || null, notes: b.notes || null, internalNotes: b.internalNotes || null,
    priceCents: service?.base_price_cents || 0,
  });
  const full = await queryOne(`${SELECT} WHERE a.id=$1`, [appt.id]);
  syncAppointment(tenant, full).catch(() => {});
  if (b.notify && full.customer_email) {
    await sendTemplated(tenant, 'booking_confirmation', full.customer_email, emailVars(tenant, full), { type: 'appointment', id: appt.id }).catch(() => {});
  }
  await logAudit({ tenantId: tenant.id, adminUsername: req.admin.username, action: 'appointment_create', entityType: 'appointment', entityId: appt.id });
  res.json({ ok: true, appointment: full });
}));

// --- Update / reschedule / status ----------------------------------------
router.patch('/:id', asyncHandler(async (req, res) => {
  const tenant = req.tenant;
  const id = toInt(req.params.id);
  const a = await queryOne(`${SELECT} WHERE a.tenant_id=$1 AND a.id=$2`, [tenant.id, id]);
  if (!a) return notFound(res);
  const b = req.body || {};
  const sets = []; const params = [id];
  const set = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };

  if (b.date || b.start) {
    const times = resolveTimes(tenant, b, a.duration_minutes);
    if (times) {
      const block = await capacityBlock(tenant, times.start.toISOString(), times.end.toISOString(), id, b.force);
      if (block) return res.status(409).json({ ok: false, code: 'SLOT_FULL', error: `That time is at capacity (${block.booked}/${block.capacity} crews booked). Reschedule anyway?` });
      set('scheduled_start', times.start.toISOString()); set('scheduled_end', times.end.toISOString()); set('status', 'scheduled');
    }
  }
  if (b.serviceAddress !== undefined) set('service_address', b.serviceAddress);
  if (b.internalNotes !== undefined) set('internal_notes', b.internalNotes);
  if (b.notes !== undefined) set('notes', b.notes);
  let completing = false; let canceling = false;
  if (b.status && ['scheduled', 'completed', 'canceled', 'no_show'].includes(b.status)) {
    set('status', b.status);
    if (b.status === 'completed') { set('completed_at', new Date().toISOString()); completing = true; }
    if (b.status === 'canceled') { set('canceled_at', new Date().toISOString()); if (b.reason) set('canceled_reason', b.reason); canceling = true; }
  }
  if (!sets.length) return badRequest(res, 'Nothing to update.');
  set('updated_at', new Date().toISOString());
  await query(`UPDATE appointments SET ${sets.join(', ')} WHERE id=$1`, params);
  const updated = await queryOne(`${SELECT} WHERE a.id=$1`, [id]);

  if (canceling) { deleteAppointmentEvent(tenant, updated).catch(() => {}); if (b.notify && updated.customer_email) await sendTemplated(tenant, 'appointment_canceled', updated.customer_email, emailVars(tenant, updated), { type: 'appointment', id }).catch(() => {}); }
  else { syncAppointment(tenant, updated).catch(() => {}); }
  if (completing) await scheduleForCompletion(tenant, updated).catch(() => {});
  if ((b.date || b.start) && b.notify && updated.customer_email && !canceling) {
    await sendTemplated(tenant, 'appointment_rescheduled', updated.customer_email, emailVars(tenant, updated), { type: 'appointment', id }).catch(() => {});
  }
  await logAudit({ tenantId: tenant.id, adminUsername: req.admin.username, action: 'appointment_update', entityType: 'appointment', entityId: id, details: { status: b.status } });
  res.json({ ok: true, appointment: updated });
}));

// --- Confirm a requested booking -----------------------------------------
router.post('/:id/confirm', asyncHandler(async (req, res) => {
  const tenant = req.tenant;
  const id = toInt(req.params.id);
  const a = await queryOne(`${SELECT} WHERE a.tenant_id=$1 AND a.id=$2`, [tenant.id, id]);
  if (!a) return notFound(res);
  if (a.status !== 'requested') return badRequest(res, 'This booking is not awaiting confirmation.');
  const b = req.body || {};
  let start; let end;
  if (b.start) { start = new Date(b.start); end = b.end ? new Date(b.end) : new Date(start.getTime() + (a.duration_minutes || 60) * 60000); }
  else if (Number.isInteger(b.slotIndex) && Array.isArray(a.requested_slots) && a.requested_slots[b.slotIndex]) {
    const s = a.requested_slots[b.slotIndex]; start = new Date(s.start); end = new Date(s.end);
  } else if (b.date && b.time) {
    start = zonedWallTimeToUtc(b.date, b.time, tenant.timezone); end = new Date(start.getTime() + (a.duration_minutes || 60) * 60000);
  } else return badRequest(res, 'Choose a time to confirm.');

  const block = await capacityBlock(tenant, start.toISOString(), end.toISOString(), id, b.force);
  if (block) return res.status(409).json({ ok: false, code: 'SLOT_FULL', error: `That time is at capacity (${block.booked}/${block.capacity} crews booked). Confirm anyway?` });
  await query(
    "UPDATE appointments SET status='scheduled', scheduled_start=$2, scheduled_end=$3, updated_at=now() WHERE id=$1",
    [id, start.toISOString(), end.toISOString()],
  );
  const updated = await queryOne(`${SELECT} WHERE a.id=$1`, [id]);
  syncAppointment(tenant, updated).catch(() => {});
  if (updated.customer_email && b.notify !== false) {
    await sendTemplated(tenant, 'request_confirmed', updated.customer_email, emailVars(tenant, updated), { type: 'appointment', id }).catch(() => {});
  }
  await logAudit({ tenantId: tenant.id, adminUsername: req.admin.username, action: 'appointment_confirm', entityType: 'appointment', entityId: id });
  res.json({ ok: true, appointment: updated });
}));

export default router;
