// Public device endpoint for QR scans: view a device + history, and (with a
// technician field token) log an inspection.
import express from 'express';
import { asyncHandler, badRequest, notFound } from '../lib/http.js';
import { getTenantById } from '../lib/tenants.js';
import { getByQr, deviceHistory, recordInspection } from '../lib/devices.js';
import { technicianByFieldToken } from '../lib/technicians.js';
import { queryOne } from '../lib/db.js';
import { rateLimit } from '../lib/rate_limit.js';

const router = express.Router();
const limitView = rateLimit({ endpoint: 'device_get', windowMinutes: 10, maxCount: 60 });
const limitInspect = rateLimit({ endpoint: 'device_inspect', windowMinutes: 10, maxCount: 20 });

router.get('/:qr', limitView, asyncHandler(async (req, res) => {
  const device = await getByQr(req.params.qr);
  if (!device) return notFound(res, 'Device not found.');
  const tenant = await getTenantById(device.tenant_id);
  const customer = await queryOne('SELECT name FROM customers WHERE tenant_id=$1 AND id=$2', [device.tenant_id, device.customer_id]);
  res.json({
    ok: true,
    device: { label: device.label, type: device.device_type, serial: device.serial, locationNotes: device.location_notes, status: device.status, installedAt: device.installed_at },
    customer: { name: customer?.name || '' },
    tenant: { name: tenant.name, branding: tenant.settings.branding },
    history: (await deviceHistory(tenant, device.id, 20)).map((h) => ({ status: h.status, activityLevel: h.activity_level, actionTaken: h.action_taken, notes: h.notes, inspectedAt: h.inspected_at, technician: h.technician_name })),
  });
}));

router.post('/:qr/inspect', limitInspect, asyncHandler(async (req, res) => {
  const device = await getByQr(req.params.qr);
  if (!device) return notFound(res, 'Device not found.');
  const b = req.body || {};
  const tech = await technicianByFieldToken(String(b.fieldToken || ''));
  if (!tech || tech.tenant_id !== device.tenant_id) return badRequest(res, 'A valid technician sign-in is required to log an inspection.');
  const tenant = await getTenantById(device.tenant_id);
  const insp = await recordInspection(tenant, device, { status: b.status, activityLevel: b.activityLevel, actionTaken: b.actionTaken, notes: b.notes, technicianId: tech.id, inspectedBy: `tech:${tech.id}` });
  res.json({ ok: true, inspection: { status: insp.status, inspectedAt: insp.inspected_at } });
}));

export default router;
