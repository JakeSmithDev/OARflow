// Admin route optimization: a technician's ordered stops for a day + map link.
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { asyncHandler, badRequest, toInt } from '../../lib/http.js';
import { queryOne } from '../../lib/db.js';
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

const MAX_REVIEW_DAYS = 31;
const MAX_ISSUE_COUNT = 1_000_000;
const MAX_ISSUE_TYPES = 20;
const ISSUE_KEY_RE = /^[a-z][a-zA-Z0-9]{0,39}$/;

function reviewRange(body = {}) {
  const startDate = String(body.startDate ?? body.start ?? body.from ?? '');
  const endDate = String(body.endDate ?? body.end ?? body.to ?? '');
  if (!validDate(startDate) || !validDate(endDate)) {
    return { error: 'startDate and endDate must use YYYY-MM-DD.' };
  }
  const startMs = Date.parse(`${startDate}T00:00:00.000Z`);
  const endMs = Date.parse(`${endDate}T00:00:00.000Z`);
  if (endMs < startMs) return { error: 'endDate must be on or after startDate.' };
  const days = Math.round((endMs - startMs) / 86_400_000) + 1;
  if (days > MAX_REVIEW_DAYS) return { error: `Schedule reviews may cover at most ${MAX_REVIEW_DAYS} days.` };
  return { startDate, endDate, days };
}

function normalizeIssueCounts(value) {
  if (value === undefined || value === null) return { issueCounts: {} };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'issueCounts must be an object of non-negative numeric counts.' };
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_ISSUE_TYPES) {
    return { error: `issueCounts may contain at most ${MAX_ISSUE_TYPES} issue types.` };
  }
  const issueCounts = Object.create(null);
  for (const [key, raw] of entries) {
    if (!ISSUE_KEY_RE.test(key)) return { error: `Invalid issue count name: ${key}.` };
    const count = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (!Number.isFinite(count) || count < 0) {
      return { error: `${key} must be a non-negative number.` };
    }
    issueCounts[key] = Math.min(MAX_ISSUE_COUNT, Math.floor(count));
  }
  return { issueCounts };
}

function publicReview(entry) {
  if (!entry) return null;
  const details = entry.details && typeof entry.details === 'object' ? entry.details : {};
  return {
    id: entry.id,
    startDate: details.startDate || null,
    endDate: details.endDate || null,
    issueCounts: details.issueCounts && typeof details.issueCounts === 'object' ? details.issueCounts : {},
    reviewedBy: entry.admin_username || null,
    reviewedAt: entry.created_at,
  };
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

// The planning review is append-only: GET exposes the latest completed pass and
// POST records who reviewed which range, without pretending later schedule
// changes cannot make that review stale.
router.get('/review', asyncHandler(async (req, res) => {
  const entry = await queryOne(
    `SELECT id, admin_username, details, created_at
       FROM audit_log
      WHERE tenant_id=$1 AND action='schedule_review_complete' AND entity_type='schedule'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [req.tenant.id],
  );
  res.json({ ok: true, review: publicReview(entry) });
}));

router.post('/review', requirePermission('dispatch.manage'), asyncHandler(async (req, res) => {
  const range = reviewRange(req.body || {});
  if (range.error) return badRequest(res, range.error);
  const counts = normalizeIssueCounts(req.body?.issueCounts ?? req.body?.issues);
  if (counts.error) return badRequest(res, counts.error);
  const details = {
    startDate: range.startDate,
    endDate: range.endDate,
    days: range.days,
    issueCounts: counts.issueCounts,
  };
  const entry = await queryOne(
    `INSERT INTO audit_log (tenant_id, admin_username, action, entity_type, details)
     VALUES ($1,$2,'schedule_review_complete','schedule',$3::jsonb)
     RETURNING id, admin_username, details, created_at`,
    [req.tenant.id, req.admin.username, JSON.stringify(details)],
  );
  res.json({ ok: true, review: publicReview(entry) });
}));

router.get('/', asyncHandler(async (req, res) => {
  const technicianId = toInt(req.query.technicianId);
  const date = String(req.query.date || '');
  if (!technicianId || !validDate(date)) return badRequest(res, 'technicianId and date (YYYY-MM-DD) are required.');
  const route = await optimizeRoute(req.tenant, { technicianId, date });
  if (route.invalidTechnicianIds.length) return badRequest(res, 'Technician is unavailable.');
  res.json({ ok: true, geocoder: geocodingConfigured(req.tenant), ...route });
}));

export default router;
