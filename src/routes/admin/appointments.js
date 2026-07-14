// Admin appointments: list/detail, manual create, reschedule, status changes,
// and confirming a request-mode booking (choose one of the proposed slots).
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { asyncHandler, badRequest, notFound, toInt } from '../../lib/http.js';
import { query, queryOne, withTx } from '../../lib/db.js';
import { getService, findOrCreateCustomer, createAppointment, fetchDayConflicts, overlapCount, slotCapacity } from '../../lib/appointments.js';
import { ownsId } from '../../lib/ownership.js';
import { zonedWallTimeToUtc, ymdInTimeZone } from '../../lib/dates.js';
import { syncAppointment, deleteAppointmentEvent } from '../../lib/google_calendar.js';
import { scheduleForCompletion } from '../../lib/follow_ups.js';
import { sendAppointmentReminder } from '../../lib/reminders.js';
import { emitEvent } from '../../lib/events.js';
import { sendTemplated, detailsTable } from '../../lib/email_templates.js';
import { hasCapability, requirePermission, requireWrite } from '../../lib/permissions.js';
import {
  setAssignments, getAssignments, assignmentsForAppointments, findTechnicianConflict,
  withLockedAppointmentSchedule,
} from '../../lib/technicians.js';
import { saveFile, listFiles, getFile, deleteFile, signedUrl } from '../../lib/storage.js';
import { decodeUpload } from '../../lib/uploads.js';
import { recordApplication, listApplications, deleteApplication, serviceReport } from '../../lib/compliance.js';
import { logAudit } from '../../lib/audit.js';
import { formatDateLabel, formatTimeLabel } from '../../lib/dates.js';
import { config } from '../../config.js';
import { toCsv } from '../../lib/csv.js';

const router = express.Router();
router.use(requireAdmin());
router.use(requireWrite('appointments.manage')); // reads open to admins; writes gated

const SELECT = `
  SELECT a.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
         s.name AS service_name, s.color AS service_color, s.duration_minutes
    FROM appointments a
    JOIN customers c ON c.id=a.customer_id
    LEFT JOIN service_types s ON s.id=a.service_type_id`;

function redactAppointment(req, appt) {
  return hasCapability(req.admin, 'appointments.manage') ? appt : { ...appt, internal_notes: null };
}

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

// Returns a { reason } block if the window is on a closed/blackout day or at/over
// capacity (unless `force`). Used to warn staff before booking such a slot.
async function schedulingBlock(tenant, startISO, endISO, excludeId, force) {
  if (force) return null;
  const dateYmd = ymdInTimeZone(new Date(startISO), tenant.timezone);
  const { override, blackouts } = await fetchDayConflicts(tenant, dateYmd);
  const st = new Date(startISO).getTime(); const en = new Date(endISO).getTime();
  const closedByBlackout = (blackouts || []).some((b) => new Date(b.starts_at).getTime() < en && new Date(b.ends_at).getTime() > st);
  if ((override && override.is_closed) || closedByBlackout) return { reason: 'This day is marked closed (holiday or blackout).' };
  const cap = slotCapacity(tenant, override);
  const booked = await overlapCount(tenant.id, startISO, endISO, excludeId);
  if (booked >= cap) return { reason: `That time is at capacity (${booked}/${cap} crews booked).` };
  return null;
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
  const countParams = params.slice();
  params.push(limit); params.push(offset);
  const rows = await query(
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY COALESCE(a.scheduled_start, a.created_at) DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  if (req.query.includeAssignments === '1') {
    const assignMap = await assignmentsForAppointments(req.tenant, rows.rows.map((a) => a.id));
    for (const appointment of rows.rows) appointment.technicians = assignMap[appointment.id] || [];
  }
  const total = await queryOne(
    `SELECT count(*)::int n FROM appointments a JOIN customers c ON c.id=a.customer_id WHERE ${where.join(' AND ')}`,
    countParams,
  );
  const counts = await query(
    `SELECT status, count(*)::int n FROM appointments WHERE tenant_id=$1 GROUP BY status`, [tenantId],
  );
  const countMap = { all: 0 };
  for (const r of counts.rows) { countMap[r.status] = r.n; countMap.all += r.n; }
  res.json({ ok: true, appointments: rows.rows.map((a) => redactAppointment(req, a)), counts: countMap, total: total.n });
}));

router.get('/export.csv', asyncHandler(async (req, res) => {
  const { status, q, from, to } = req.query;
  const where = ['a.tenant_id=$1']; const params = [req.tenant.id];
  if (status && status !== 'all') { params.push(status); where.push(`a.status=$${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(c.name ILIKE $${params.length} OR c.email ILIKE $${params.length})`); }
  if (from) { params.push(from); where.push(`a.scheduled_start >= $${params.length}`); }
  if (to) { params.push(to); where.push(`a.scheduled_start < $${params.length}`); }
  const rows = await query(
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY COALESCE(a.scheduled_start, a.created_at) DESC`,
    params,
  );
  const csv = toCsv([
    { key: 'id', label: 'id' }, { key: 'status', label: 'status' }, { key: 'scheduled_start', label: 'scheduled_start' },
    { key: 'scheduled_end', label: 'scheduled_end' }, { key: 'customer_name', label: 'customer_name' },
    { key: 'customer_email', label: 'customer_email' }, { key: 'customer_phone', label: 'customer_phone' },
    { key: 'service_name', label: 'service_name' }, { key: 'service_address', label: 'service_address' },
    { key: 'price_cents', label: 'price_cents' }, { key: 'source', label: 'source' }, { key: 'created_at', label: 'created_at' },
  ], rows.rows.map((a) => redactAppointment(req, a)));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="appointments_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
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
  const assignMap = await assignmentsForAppointments(req.tenant, rows.rows.map((a) => a.id));
  for (const a of rows.rows) a.technicians = assignMap[a.id] || [];
  res.json({
    ok: true,
    appointments: rows.rows.map((a) => redactAppointment(req, a)),
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
  const technicians = await getAssignments(req.tenant, a.id);
  const files = await listFiles(req.tenant, 'appointment', a.id);
  res.json({ ok: true, appointment: redactAppointment(req, a), invoices: invoices.rows, technicians, files });
}));

// --- Job photos / files ---------------------------------------------------
router.get('/:id/files', asyncHandler(async (req, res) => {
  if (!(await ownsId(req.tenant.id, 'appointments', toInt(req.params.id)))) return notFound(res);
  res.json({ ok: true, files: await listFiles(req.tenant, 'appointment', toInt(req.params.id)) });
}));

router.post('/:id/files', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const appt = await queryOne('SELECT id, customer_id FROM appointments WHERE id=$1 AND tenant_id=$2', [id, req.tenant.id]);
  if (!appt) return notFound(res);
  const dec = decodeUpload(req.body || {});
  if (dec.error) return badRequest(res, dec.error);
  const kind = (req.body.kind === 'document' || dec.contentType === 'application/pdf') ? 'document' : 'photo';
  const file = await saveFile(req.tenant, {
    buffer: dec.buffer, filename: dec.filename, contentType: dec.contentType,
    ownerType: 'appointment', ownerId: id, kind, createdBy: req.admin.username,
    meta: { label: req.body.label || '', customerId: appt.customer_id, source: req.body.source || 'staff' },
  });
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'job_file_upload', entityType: 'appointment', entityId: id, details: { fileId: file.id, kind } });
  res.json({ ok: true, file: { id: file.id, kind: file.kind, filename: file.filename, contentType: file.content_type, url: await signedUrl(file) } });
}));

router.delete('/:id/files/:fileId', asyncHandler(async (req, res) => {
  const f = await getFile(req.tenant.id, toInt(req.params.fileId));
  if (!f || String(f.owner_type) !== 'appointment' || String(f.owner_id) !== String(toInt(req.params.id))) return notFound(res);
  await deleteFile(f);
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'job_file_delete', entityType: 'appointment', entityId: toInt(req.params.id), details: { fileId: f.id } });
  res.json({ ok: true });
}));

// --- Compliance: chemical/material applications + service report ----------
router.get('/:id/applications', asyncHandler(async (req, res) => {
  if (!(await ownsId(req.tenant.id, 'appointments', toInt(req.params.id)))) return notFound(res);
  res.json({ ok: true, applications: await listApplications(req.tenant, toInt(req.params.id)) });
}));
router.post('/:id/applications', asyncHandler(async (req, res) => {
  const r = await recordApplication(req.tenant, toInt(req.params.id), req.body || {}, req.admin.username);
  if (!r.ok) return badRequest(res, r.error);
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'chem_application', entityType: 'appointment', entityId: toInt(req.params.id), details: { product: r.application.product_name } });
  res.json({ ok: true, application: r.application });
}));
router.delete('/:id/applications/:appId', asyncHandler(async (req, res) => {
  await deleteApplication(req.tenant, toInt(req.params.appId));
  res.json({ ok: true });
}));
router.get('/:id/service-report', asyncHandler(async (req, res) => {
  const report = await serviceReport(req.tenant, toInt(req.params.id));
  if (!report) return notFound(res);
  res.json({ ok: true, report });
}));

// --- Assign technicians (dispatch) ---------------------------------------
router.post('/:id/assign', requirePermission('dispatch.manage'), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const b = req.body || {};
  const r = await setAssignments(req.tenant, id, b.technicianIds || [], b.leadId);
  if (r.notFound) return notFound(res);
  if (!r.ok) return badRequest(res, r.error);
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'appointment_assign', entityType: 'appointment', entityId: id, details: { technicianIds: b.technicianIds, lead: r.lead } });
  res.json({ ok: true, technicians: await getAssignments(req.tenant, id) });
}));

// --- Create (manual / admin) ---------------------------------------------
router.post('/', asyncHandler(async (req, res) => {
  const tenant = req.tenant;
  const b = req.body || {};
  const technicianId = b.technicianId == null || b.technicianId === '' ? null : toInt(b.technicianId);
  if (b.technicianId != null && b.technicianId !== '' && !technicianId) return badRequest(res, 'Unknown technician.');
  if (technicianId && !hasCapability(req.admin, 'dispatch.manage')) {
    return res.status(403).json({ ok: false, error: 'You do not have permission to assign reps.' });
  }
  let customerId = toInt(b.customerId);
  if (customerId) {
    if (!(await ownsId(tenant.id, 'customers', customerId))) return badRequest(res, 'Unknown customer.');
  } else {
    if (!b.customer?.name) return badRequest(res, 'Customer is required.');
  }
  const service = b.serviceId ? await getService(tenant.id, toInt(b.serviceId)) : null;
  const times = resolveTimes(tenant, b, service?.duration_minutes);
  if (!times) return badRequest(res, 'A date and time are required.');
  const block = await schedulingBlock(tenant, times.start.toISOString(), times.end.toISOString(), null, b.force);
  if (block) return res.status(409).json({ ok: false, code: 'SCHEDULE_WARN', error: `${block.reason} Book anyway?` });
  let appt;
  try {
    const createdResult = await withTx(async (cx) => {
      const resolvedCustomerId = customerId || await findOrCreateCustomer(tenant.id, b.customer, { cx });
      const created = await createAppointment(tenant.id, {
        customerId: resolvedCustomerId, serviceTypeId: service?.id || null, status: 'scheduled', bookingMode: 'instant', source: 'admin',
        scheduledStart: times.start.toISOString(), scheduledEnd: times.end.toISOString(),
        serviceAddress: b.serviceAddress || null, notes: b.notes || null, internalNotes: b.internalNotes || null,
        priceCents: service?.base_price_cents || 0,
      }, { cx });
      if (technicianId) {
        const assignment = await setAssignments(tenant, created.id, [technicianId], technicianId, { cx });
        if (!assignment.ok) {
          const error = new Error(assignment.error || 'Rep assignment failed.');
          error.code = 'ASSIGNMENT_INVALID';
          throw error;
        }
      }
      return { appointment: created, customerId: resolvedCustomerId };
    });
    appt = createdResult.appointment;
    customerId = createdResult.customerId;
  } catch (error) {
    if (error.code === 'ASSIGNMENT_INVALID') return badRequest(res, error.message);
    throw error;
  }
  const full = await queryOne(`${SELECT} WHERE a.id=$1`, [appt.id]);
  syncAppointment(tenant, full).catch(() => {});
  if (b.notify && full.customer_email) {
    await sendTemplated(tenant, 'booking_confirmation', full.customer_email, emailVars(tenant, full), { type: 'appointment', id: appt.id }).catch(() => {});
  }
  await logAudit({ tenantId: tenant.id, adminUsername: req.admin.username, action: 'appointment_create', entityType: 'appointment', entityId: appt.id });
  if (technicianId) {
    await logAudit({ tenantId: tenant.id, adminUsername: req.admin.username, action: 'appointment_assign', entityType: 'appointment', entityId: appt.id, details: { technicianIds: [technicianId], lead: technicianId } });
  }
  if (b.notify) emitEvent('appointment.scheduled', { tenantId: tenant.id, appointmentId: appt.id, customerId, source: 'admin' }).catch(() => {});
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
  let scheduleTimes = null;

  if (b.date || b.start) {
    const times = resolveTimes(tenant, b, a.duration_minutes);
    if (times) {
      const block = await schedulingBlock(tenant, times.start.toISOString(), times.end.toISOString(), id, b.force);
      if (block) return res.status(409).json({ ok: false, code: 'SCHEDULE_WARN', error: `${block.reason} Reschedule anyway?` });
      scheduleTimes = times;
      set('scheduled_start', times.start.toISOString()); set('scheduled_end', times.end.toISOString()); set('status', 'scheduled');
    }
  }
  if (b.serviceAddress !== undefined) {
    set('service_address', b.serviceAddress);
    // Coordinates describe the old address. Force the route planner to
    // geocode/fallback-group the new address instead of reusing stale data.
    set('service_lat', null); set('service_lng', null);
  }
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
  if (scheduleTimes) {
    const locked = await withLockedAppointmentSchedule(tenant, id, async ({ cx, technicianIds }) => {
      if (!b.force) {
        const conflict = await findTechnicianConflict(tenant, {
          appointmentId: id,
          technicianIds,
          start: scheduleTimes.start.toISOString(),
          end: scheduleTimes.end.toISOString(),
        }, cx);
        if (conflict) return { conflict };
      }
      await cx.query(`UPDATE appointments SET ${sets.join(', ')} WHERE id=$1`, params);
      return { updated: true };
    });
    if (locked.notFound) return notFound(res);
    if (locked.scheduleBusy) return res.status(409).json({ ok: false, code: 'SCHEDULE_CHANGED', error: 'The assigned crew changed. Refresh and try again.' });
    if (locked.conflict) {
      return res.status(409).json({ ok: false, code: 'SCHEDULE_WARN', error: `${locked.conflict.technician_name} already has an overlapping appointment. Reschedule anyway?` });
    }
  } else {
    await query(`UPDATE appointments SET ${sets.join(', ')} WHERE id=$1`, params);
  }
  const updated = await queryOne(`${SELECT} WHERE a.id=$1`, [id]);

  if (canceling) { deleteAppointmentEvent(tenant, updated).catch(() => {}); if (b.notify && updated.customer_email) await sendTemplated(tenant, 'appointment_canceled', updated.customer_email, emailVars(tenant, updated), { type: 'appointment', id }).catch(() => {}); }
  else { syncAppointment(tenant, updated).catch(() => {}); }
  if (completing) {
    await scheduleForCompletion(tenant, updated).catch(() => {});
    emitEvent('appointment.completed', { tenantId: tenant.id, appointmentId: id, customerId: updated.customer_id }).catch(() => {});
  }
  if ((b.date || b.start) && b.notify && updated.customer_email && !canceling) {
    await sendTemplated(tenant, 'appointment_rescheduled', updated.customer_email, emailVars(tenant, updated), { type: 'appointment', id }).catch(() => {});
  }
  await logAudit({ tenantId: tenant.id, adminUsername: req.admin.username, action: 'appointment_update', entityType: 'appointment', entityId: id, details: { status: b.status } });
  res.json({ ok: true, appointment: updated });
}));

// --- Send an appointment reminder now (manual) ---------------------------
router.post('/:id/send-reminder', asyncHandler(async (req, res) => {
  const r = await sendAppointmentReminder(req.tenant, toInt(req.params.id));
  if (!r.ok) return badRequest(res, r.error || 'Could not send reminder.');
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'appointment_reminder_sent', entityType: 'appointment', entityId: toInt(req.params.id) });
  res.json({ ok: true });
}));

// --- "On My Way" text (manual) -------------------------------------------
router.post('/:id/on-my-way', asyncHandler(async (req, res) => {
  const { sendAppointmentSms } = await import('../../lib/notify_sms.js');
  const eta = (req.body || {}).eta;
  const r = await sendAppointmentSms(req.tenant, toInt(req.params.id), 'onMyWay', { ETA: eta ? `We expect to arrive ${eta}.` : '' });
  if (!r.ok) return badRequest(res, r.error || 'Could not send text.');
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'appointment_omw', entityType: 'appointment', entityId: toInt(req.params.id) });
  res.json({ ok: true, status: r.status });
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

  const block = await schedulingBlock(tenant, start.toISOString(), end.toISOString(), id, b.force);
  if (block) return res.status(409).json({ ok: false, code: 'SCHEDULE_WARN', error: `${block.reason} Confirm anyway?` });
  const locked = await withLockedAppointmentSchedule(tenant, id, async ({ cx, appointment, technicianIds }) => {
    if (appointment.status !== 'requested') return { notRequested: true };
    if (!b.force) {
      const conflict = await findTechnicianConflict(tenant, {
        appointmentId: id,
        technicianIds,
        start: start.toISOString(),
        end: end.toISOString(),
      }, cx);
      if (conflict) return { conflict };
    }
    await cx.query(
      "UPDATE appointments SET status='scheduled', scheduled_start=$3, scheduled_end=$4, updated_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenant.id, id, start.toISOString(), end.toISOString()],
    );
    return { updated: true };
  });
  if (locked.notFound) return notFound(res);
  if (locked.notRequested) return badRequest(res, 'This booking is not awaiting confirmation.');
  if (locked.scheduleBusy) return res.status(409).json({ ok: false, code: 'SCHEDULE_CHANGED', error: 'The assigned crew changed. Refresh and try again.' });
  if (locked.conflict) {
    return res.status(409).json({ ok: false, code: 'SCHEDULE_WARN', error: `${locked.conflict.technician_name} already has an overlapping appointment. Confirm anyway?` });
  }
  const updated = await queryOne(`${SELECT} WHERE a.id=$1`, [id]);
  syncAppointment(tenant, updated).catch(() => {});
  if (updated.customer_email && b.notify !== false) {
    await sendTemplated(tenant, 'request_confirmed', updated.customer_email, emailVars(tenant, updated), { type: 'appointment', id }).catch(() => {});
  }
  await logAudit({ tenantId: tenant.id, adminUsername: req.admin.username, action: 'appointment_confirm', entityType: 'appointment', entityId: id });
  emitEvent('appointment.scheduled', { tenantId: tenant.id, appointmentId: id, customerId: updated.customer_id, source: 'admin' }).catch(() => {});
  res.json({ ok: true, appointment: updated });
}));

export default router;
