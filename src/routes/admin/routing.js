// Admin route optimization: a technician's ordered stops for a day + map link.
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { asyncHandler, badRequest, toInt } from '../../lib/http.js';
import { requirePermission } from '../../lib/permissions.js';
import { optimizeRoute, geocodingConfigured, planRoutes, applyRouteAssignments } from '../../lib/routing.js';
import { logAudit } from '../../lib/audit.js';

const router = express.Router();
router.use(requireAdmin());

function validDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function technicianIds(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(raw.map(toInt).filter((id) => id != null && id > 0))];
}

// Preview all selected reps' routes. Suggestions include only unassigned,
// scheduled jobs; current assignments are fixed anchors and never moved.
router.get('/plan', asyncHandler(async (req, res) => {
  const date = String(req.query.date || '');
  const ids = technicianIds(req.query.technicianIds);
  if (!validDate(date)) return badRequest(res, 'date (YYYY-MM-DD) is required.');
  if (!ids.length) return badRequest(res, 'Select at least one technician.');
  const plan = await planRoutes(req.tenant, {
    date,
    technicianIds: ids,
    includeUnassigned: req.query.includeUnassigned !== '0',
  });
  if (plan.invalidTechnicianIds.length) return badRequest(res, 'One or more technicians are unavailable.');
  res.json({ ok: true, ...plan });
}));

// Rebuild the plan at write time and apply it transactionally. The library
// locks each appointment and inserts only if it is still unassigned.
router.post('/auto-assign', requirePermission('dispatch.manage'), asyncHandler(async (req, res) => {
  const date = String(req.body?.date || '');
  const ids = technicianIds(req.body?.technicianIds);
  if (!validDate(date)) return badRequest(res, 'date (YYYY-MM-DD) is required.');
  if (!ids.length) return badRequest(res, 'Select at least one technician.');
  const result = await applyRouteAssignments(req.tenant, { date, technicianIds: ids });
  if (result.invalidTechnicianIds.length) return badRequest(res, 'One or more technicians are unavailable.');
  await logAudit({
    tenantId: req.tenant.id,
    adminUsername: req.admin.username,
    action: 'route_auto_assign',
    entityType: 'schedule',
    details: { date, technicianIds: ids, appliedCount: result.appliedCount, skippedCount: result.skippedCount },
  });
  res.json({ ok: true, ...result });
}));

router.get('/', asyncHandler(async (req, res) => {
  const technicianId = toInt(req.query.technicianId);
  const date = String(req.query.date || '');
  if (!technicianId || !validDate(date)) return badRequest(res, 'technicianId and date (YYYY-MM-DD) are required.');
  const route = await optimizeRoute(req.tenant, { technicianId, date });
  res.json({ ok: true, geocoder: geocodingConfigured(req.tenant), ...route });
}));

export default router;
