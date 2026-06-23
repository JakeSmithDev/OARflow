// Admin devices / traps / stations: CRUD + inspection history + QR scan link.
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { asyncHandler, badRequest, notFound, toInt } from '../../lib/http.js';
import { ownsId } from '../../lib/ownership.js';
import { listDevices, createDevice, updateDevice, getDevice, deviceHistory, recordInspection, deviceScanUrl } from '../../lib/devices.js';
import { logAudit } from '../../lib/audit.js';
import { requireWrite } from '../../lib/permissions.js';

const router = express.Router();
router.use(requireAdmin());
router.use(requireWrite('appointments.manage'));

router.get('/', asyncHandler(async (req, res) => {
  const customerId = toInt(req.query.customerId);
  if (!customerId) return badRequest(res, 'customerId is required.');
  const devices = (await listDevices(req.tenant, customerId, { includeRemoved: req.query.all === '1' })).map((d) => ({ ...d, scanUrl: deviceScanUrl(d.qr_token) }));
  res.json({ ok: true, devices });
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!toInt(b.customerId)) return badRequest(res, 'A customer is required.');
  if (!b.label) return badRequest(res, 'A label is required.');
  if (!(await ownsId(req.tenant.id, 'customers', toInt(b.customerId)))) return badRequest(res, 'Unknown customer.');
  const d = await createDevice(req.tenant, { ...b, customerId: toInt(b.customerId) }, req.admin.username);
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'device_create', entityType: 'device', entityId: d.id });
  res.json({ ok: true, device: { ...d, scanUrl: deviceScanUrl(d.qr_token) } });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const d = await updateDevice(req.tenant, toInt(req.params.id), req.body || {});
  if (!d) return notFound(res); res.json({ ok: true, device: { ...d, scanUrl: deviceScanUrl(d.qr_token) } });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const d = await getDevice(req.tenant, toInt(req.params.id));
  if (!d) return notFound(res);
  res.json({ ok: true, device: { ...d, scanUrl: deviceScanUrl(d.qr_token) }, history: await deviceHistory(req.tenant, d.id) });
}));

router.post('/:id/inspect', asyncHandler(async (req, res) => {
  const d = await getDevice(req.tenant, toInt(req.params.id));
  if (!d) return notFound(res);
  const insp = await recordInspection(req.tenant, d, { ...(req.body || {}), inspectedBy: req.admin.username, technicianId: toInt((req.body || {}).technicianId) });
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'device_inspect', entityType: 'device', entityId: d.id, details: { status: insp.status } });
  res.json({ ok: true, inspection: insp });
}));

export default router;
