// Admin technicians (field staff) CRUD + field-app link. Assignment to jobs
// lives on the appointments router.
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { hasCapability } from '../../lib/permissions.js';
import { asyncHandler, badRequest, notFound, toInt } from '../../lib/http.js';
import {
  listTechnicians, createTechnician, updateTechnician, ensureFieldToken, revokeFieldToken,
  normalizeRouteStartAddress,
} from '../../lib/technicians.js';
import { logAudit } from '../../lib/audit.js';
import { config } from '../../config.js';

const router = express.Router();
router.use(requireAdmin());

function canManageTeam(admin) {
  return hasCapability(admin, 'team.manage') || hasCapability(admin, 'dispatch.manage');
}

function requireTeamManagement(req, res, next) {
  if (canManageTeam(req.admin)) return next();
  return res.status(403).json({ ok: false, error: 'You do not have permission to manage the team.' });
}

router.get('/', asyncHandler(async (req, res) => {
  const includeInactive = req.query.all === '1';
  const includeRouteOrigins = req.query.origins === '1';
  if (includeRouteOrigins && !canManageTeam(req.admin)) {
    return res.status(403).json({ ok: false, error: 'You do not have permission to manage the team.' });
  }
  res.json({
    ok: true,
    technicians: await listTechnicians(req.tenant, {
      includeInactive,
      // Route origins can be residential. Keep picker responses minimal and
      // expose them only on the permission-gated management view.
      includeRouteOrigins,
    }),
    ...(includeRouteOrigins ? { businessAddress: req.tenant.address || null } : {}),
  });
}));

router.post('/', requireTeamManagement, asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return badRequest(res, 'Name is required.');
  if (b.userId !== undefined && req.admin.role !== 'owner') {
    return res.status(403).json({ ok: false, error: 'Only an owner can link admin login access.' });
  }
  let routeStartAddress;
  try { routeStartAddress = normalizeRouteStartAddress(b.routeStartAddress); }
  catch (error) { return badRequest(res, error.message); }
  let t;
  try {
    t = await createTechnician(req.tenant, {
      name: b.name, email: b.email, phone: b.phone, color: b.color,
      userId: toInt(b.userId), routeStartAddress,
    });
  } catch (error) {
    if (error.statusCode === 400) return badRequest(res, error.message);
    throw error;
  }
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'technician_create', entityType: 'technician', entityId: t.id });
  res.json({ ok: true, technician: t });
}));

router.patch('/:id', requireTeamManagement, asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.userId !== undefined && req.admin.role !== 'owner') {
    return res.status(403).json({ ok: false, error: 'Only an owner can link admin login access.' });
  }
  let routeStartAddress;
  if (b.routeStartAddress !== undefined) {
    try { routeStartAddress = normalizeRouteStartAddress(b.routeStartAddress); }
    catch (error) { return badRequest(res, error.message); }
  }
  let t;
  try {
    t = await updateTechnician(req.tenant, toInt(req.params.id), {
      name: b.name, email: b.email, phone: b.phone, color: b.color,
      userId: b.userId !== undefined ? toInt(b.userId) : undefined,
      isActive: b.isActive, routeStartAddress,
    });
  } catch (error) {
    if (error.statusCode === 400) return badRequest(res, error.message);
    throw error;
  }
  if (!t) return notFound(res);
  res.json({ ok: true, technician: t });
}));

// Issue a fresh field-app (PWA) link — rotates the token, invalidating any prior
// link. The token is stored hashed; the plaintext only appears in this URL.
router.post('/:id/field-link', requireTeamManagement, asyncHandler(async (req, res) => {
  const token = await ensureFieldToken(req.tenant, toInt(req.params.id));
  if (!token) return notFound(res);
  res.json({ ok: true, url: `${config.baseUrl}/field?token=${token}` });
}));

// Revoke a technician's field-app access entirely.
router.post('/:id/field-link/revoke', requireTeamManagement, asyncHandler(async (req, res) => {
  await revokeFieldToken(req.tenant, toInt(req.params.id));
  res.json({ ok: true });
}));

export default router;
