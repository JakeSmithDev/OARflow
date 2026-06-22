// Admin technicians (field staff) CRUD + field-app link. Assignment to jobs
// lives on the appointments router.
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { requirePermission } from '../../lib/permissions.js';
import { asyncHandler, badRequest, notFound, toInt } from '../../lib/http.js';
import { listTechnicians, createTechnician, updateTechnician, ensureFieldToken } from '../../lib/technicians.js';
import { logAudit } from '../../lib/audit.js';
import { config } from '../../config.js';

const router = express.Router();
router.use(requireAdmin());

router.get('/', asyncHandler(async (req, res) => {
  res.json({ ok: true, technicians: await listTechnicians(req.tenant, { includeInactive: req.query.all === '1' }) });
}));

router.post('/', requirePermission('dispatch.manage'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return badRequest(res, 'Name is required.');
  const t = await createTechnician(req.tenant, { name: b.name, email: b.email, phone: b.phone, color: b.color, userId: toInt(b.userId) });
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'technician_create', entityType: 'technician', entityId: t.id });
  res.json({ ok: true, technician: t });
}));

router.patch('/:id', requirePermission('dispatch.manage'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const t = await updateTechnician(req.tenant, toInt(req.params.id), { name: b.name, email: b.email, phone: b.phone, color: b.color, userId: b.userId !== undefined ? toInt(b.userId) : undefined, isActive: b.isActive });
  if (!t) return notFound(res);
  res.json({ ok: true, technician: t });
}));

// Generate/return the technician's field-app (PWA) link.
router.post('/:id/field-link', requirePermission('dispatch.manage'), asyncHandler(async (req, res) => {
  const token = await ensureFieldToken(req.tenant, toInt(req.params.id));
  if (!token) return notFound(res);
  res.json({ ok: true, url: `${config.baseUrl}/field?token=${token}` });
}));

export default router;
