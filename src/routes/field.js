// Technician field app API (public; per-technician field_token auth). Every
// endpoint resolves the tech by token, then verifies the job is assigned to them.
import express from 'express';
import { asyncHandler, badRequest, notFound, toInt } from '../lib/http.js';
import { query, queryOne } from '../lib/db.js';
import { getTenantById } from '../lib/tenants.js';
import { technicianByFieldToken, technicianJobs, isAssigned } from '../lib/technicians.js';
import { saveFile, listFiles, signedUrl } from '../lib/storage.js';
import { decodeUpload, IMAGE_TYPES } from '../lib/uploads.js';
import { sendAppointmentSms } from '../lib/notify_sms.js';
import { mapsUrl } from '../lib/routing.js';
import { listProducts, recordApplication, listApplications } from '../lib/compliance.js';
import { scheduleForCompletion } from '../lib/follow_ups.js';
import { emitEvent } from '../lib/events.js';
import { zonedWallTimeToUtc, ymdInTimeZone } from '../lib/dates.js';

const router = express.Router();

async function auth(req) {
  const token = String(req.query.token || (req.body || {}).token || '');
  const tech = await technicianByFieldToken(token);
  if (!tech) return null;
  const tenant = await getTenantById(tech.tenant_id);
  return tenant ? { tenant, tech } : null;
}
async function authJob(req) {
  const ctx = await auth(req); if (!ctx) return null;
  const apptId = toInt(req.params.id);
  if (!(await isAssigned(ctx.tenant, ctx.tech.id, apptId))) return { ...ctx, forbidden: true };
  return { ...ctx, apptId };
}

router.get('/me', asyncHandler(async (req, res) => {
  const ctx = await auth(req);
  if (!ctx) return notFound(res, 'This field link is no longer valid.');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : ymdInTimeZone(new Date(), ctx.tenant.timezone);
  const from = zonedWallTimeToUtc(day, '00:00', ctx.tenant.timezone).toISOString();
  const to = new Date(zonedWallTimeToUtc(day, '00:00', ctx.tenant.timezone).getTime() + 86_400_000).toISOString();
  const jobs = await technicianJobs(ctx.tenant, ctx.tech.id, { from, to });
  res.json({
    ok: true, date: day,
    technician: { name: ctx.tech.name, color: ctx.tech.color },
    tenant: { name: ctx.tenant.name, branding: ctx.tenant.settings.branding, timezone: ctx.tenant.timezone },
    jobs,
    routeUrl: mapsUrl(jobs.map((j) => ({ address: j.service_address })), ctx.tenant.address),
  });
}));

router.get('/jobs/:id', asyncHandler(async (req, res) => {
  const ctx = await authJob(req);
  if (!ctx) return notFound(res, 'Invalid link.');
  if (ctx.forbidden) return notFound(res, 'This job is not assigned to you.');
  const a = await queryOne(
    `SELECT a.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, s.name AS service_name
       FROM appointments a JOIN customers c ON c.id=a.customer_id LEFT JOIN service_types s ON s.id=a.service_type_id
      WHERE a.id=$1 AND a.tenant_id=$2`, [ctx.apptId, ctx.tenant.id]);
  const files = await listFiles(ctx.tenant, 'appointment', ctx.apptId);
  const applications = await listApplications(ctx.tenant, ctx.apptId);
  const products = await listProducts(ctx.tenant);
  res.json({ ok: true, job: a, files, applications, products });
}));

// Log a chemical/material application from the field (snapshots the applicator).
router.post('/jobs/:id/applications', asyncHandler(async (req, res) => {
  const ctx = await authJob(req);
  if (!ctx || ctx.forbidden) return notFound(res);
  const body = { ...(req.body || {}), technicianId: ctx.tech.id, applicatorName: ctx.tech.name, applicatorLicense: ctx.tech.license_no };
  const r = await recordApplication(ctx.tenant, ctx.apptId, body, `tech:${ctx.tech.id}`);
  if (!r.ok) return badRequest(res, r.error);
  res.json({ ok: true, application: r.application });
}));

router.post('/jobs/:id/on-my-way', asyncHandler(async (req, res) => {
  const ctx = await authJob(req);
  if (!ctx || ctx.forbidden) return notFound(res);
  const r = await sendAppointmentSms(ctx.tenant, ctx.apptId, 'onMyWay', { ETA: (req.body || {}).eta || '' }).catch(() => ({ ok: false }));
  res.json({ ok: true, texted: r.ok !== false });
}));

router.post('/jobs/:id/status', asyncHandler(async (req, res) => {
  const ctx = await authJob(req);
  if (!ctx || ctx.forbidden) return notFound(res);
  const status = (req.body || {}).status;
  if (!['scheduled', 'completed', 'no_show'].includes(status)) return badRequest(res, 'Invalid status.');
  const updated = await queryOne(
    `UPDATE appointments SET status=$3, completed_at=CASE WHEN $3='completed' THEN now() ELSE completed_at END, updated_at=now()
      WHERE id=$1 AND tenant_id=$2 RETURNING *`, [ctx.apptId, ctx.tenant.id, status]);
  if (status === 'completed') {
    await scheduleForCompletion(ctx.tenant, updated).catch(() => {});
    emitEvent('appointment.completed', { tenantId: ctx.tenant.id, appointmentId: ctx.apptId, customerId: updated.customer_id }).catch(() => {});
  }
  res.json({ ok: true, status });
}));

router.post('/jobs/:id/photos', asyncHandler(async (req, res) => {
  const ctx = await authJob(req);
  if (!ctx || ctx.forbidden) return notFound(res);
  const dec = decodeUpload(req.body || {}, { allow: IMAGE_TYPES });
  if (dec.error) return badRequest(res, dec.error);
  const appt = await queryOne('SELECT customer_id FROM appointments WHERE id=$1 AND tenant_id=$2', [ctx.apptId, ctx.tenant.id]);
  const file = await saveFile(ctx.tenant, {
    buffer: dec.buffer, filename: dec.filename, contentType: dec.contentType, ownerType: 'appointment', ownerId: ctx.apptId,
    kind: 'photo', createdBy: `tech:${ctx.tech.id}`, meta: { source: 'tech', technicianId: ctx.tech.id, customerId: appt?.customer_id },
  });
  res.json({ ok: true, file: { id: file.id, url: await signedUrl(file) } });
}));

router.post('/jobs/:id/signature', asyncHandler(async (req, res) => {
  const ctx = await authJob(req);
  if (!ctx || ctx.forbidden) return notFound(res);
  const dec = decodeUpload(req.body || {}, { allow: ['image/png'] });
  if (dec.error) return badRequest(res, dec.error);
  const file = await saveFile(ctx.tenant, {
    buffer: dec.buffer, filename: 'signature.png', contentType: 'image/png', ownerType: 'appointment', ownerId: ctx.apptId,
    kind: 'signature', createdBy: `tech:${ctx.tech.id}`, meta: { source: 'tech', name: (req.body || {}).name || '', technicianId: ctx.tech.id },
  });
  res.json({ ok: true, file: { id: file.id, url: await signedUrl(file) } });
}));

export default router;
