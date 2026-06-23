// Admin multi-unit properties + units + unit diagrams (floorplan + markers).
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { asyncHandler, badRequest, notFound, toInt } from '../../lib/http.js';
import { ownsId } from '../../lib/ownership.js';
import { saveFile, signedUrl } from '../../lib/storage.js';
import { decodeUpload, IMAGE_TYPES } from '../../lib/uploads.js';
import {
  listProperties, createProperty, updateProperty, deleteProperty,
  listUnits, createUnit, updateUnit, saveDiagram, setFloorplan, unitDetail,
} from '../../lib/properties.js';
import { logAudit } from '../../lib/audit.js';

const router = express.Router();
router.use(requireAdmin());

router.get('/', asyncHandler(async (req, res) => {
  const customerId = toInt(req.query.customerId);
  if (!customerId) return badRequest(res, 'customerId is required.');
  res.json({ ok: true, properties: await listProperties(req.tenant, customerId) });
}));
router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!toInt(b.customerId) || !b.name) return badRequest(res, 'customerId and name are required.');
  if (!(await ownsId(req.tenant.id, 'customers', toInt(b.customerId)))) return badRequest(res, 'Unknown customer.');
  const p = await createProperty(req.tenant, { ...b, customerId: toInt(b.customerId) });
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'property_create', entityType: 'property', entityId: p.id });
  res.json({ ok: true, property: p });
}));
router.patch('/:id', asyncHandler(async (req, res) => { const p = await updateProperty(req.tenant, toInt(req.params.id), req.body || {}); if (!p) return notFound(res); res.json({ ok: true, property: p }); }));
router.delete('/:id', asyncHandler(async (req, res) => { await deleteProperty(req.tenant, toInt(req.params.id)); res.json({ ok: true }); }));

router.get('/:id/units', asyncHandler(async (req, res) => { res.json({ ok: true, units: await listUnits(req.tenant, toInt(req.params.id)) }); }));
router.post('/units', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!toInt(b.propertyId) || !b.label) return badRequest(res, 'propertyId and label are required.');
  const u = await createUnit(req.tenant, { ...b, propertyId: toInt(b.propertyId) });
  if (!u) return badRequest(res, 'Unknown property.');
  res.json({ ok: true, unit: u });
}));
router.patch('/units/:id', asyncHandler(async (req, res) => { const u = await updateUnit(req.tenant, toInt(req.params.id), req.body || {}); if (!u) return notFound(res); res.json({ ok: true, unit: u }); }));
router.get('/units/:id', asyncHandler(async (req, res) => { const d = await unitDetail(req.tenant, toInt(req.params.id)); if (!d) return notFound(res); res.json({ ok: true, ...d }); }));

router.post('/units/:id/diagram', asyncHandler(async (req, res) => {
  const u = await saveDiagram(req.tenant, toInt(req.params.id), (req.body || {}).markers || []);
  if (!u) return notFound(res); res.json({ ok: true, unit: u });
}));
router.post('/units/:id/floorplan', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const dec = decodeUpload(req.body || {}, { allow: IMAGE_TYPES });
  if (dec.error) return badRequest(res, dec.error);
  const file = await saveFile(req.tenant, { buffer: dec.buffer, filename: dec.filename, contentType: dec.contentType, ownerType: 'unit', ownerId: id, kind: 'floorplan', createdBy: req.admin.username });
  await setFloorplan(req.tenant, id, file.id);
  res.json({ ok: true, floorplanUrl: await signedUrl(file) });
}));

export default router;
