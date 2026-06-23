// Admin commissions: rules, accrued entries, per-tech summary, mark-paid, CSV.
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { requirePermission } from '../../lib/permissions.js';
import { asyncHandler, badRequest, notFound, toInt } from '../../lib/http.js';
import { listRules, createRule, updateRule, listEntries, commissionSummary, markPaid, entriesCsv } from '../../lib/commissions.js';
import { logAudit } from '../../lib/audit.js';

const router = express.Router();
router.use(requireAdmin());
router.use(requirePermission('commissions.manage'));

function opts(req) { return { status: req.query.status, technicianId: toInt(req.query.technicianId), from: req.query.from, to: req.query.to }; }

router.get('/', asyncHandler(async (req, res) => {
  res.json({ ok: true, rules: await listRules(req.tenant, { includeInactive: true }), entries: await listEntries(req.tenant, opts(req)), summary: await commissionSummary(req.tenant, opts(req)) });
}));

router.post('/rules', asyncHandler(async (req, res) => {
  if (!(req.body || {}).name) return badRequest(res, 'Name is required.');
  const r = await createRule(req.tenant, req.body);
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'commission_rule_create', entityType: 'commission_rule', entityId: r.id });
  res.json({ ok: true, rule: r });
}));
router.patch('/rules/:id', asyncHandler(async (req, res) => {
  const r = await updateRule(req.tenant, toInt(req.params.id), req.body || {});
  if (!r) return notFound(res); res.json({ ok: true, rule: r });
}));

router.post('/pay', asyncHandler(async (req, res) => {
  await markPaid(req.tenant, { technicianId: toInt((req.body || {}).technicianId), ids: (req.body || {}).ids });
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'commission_pay', details: req.body });
  res.json({ ok: true });
}));

router.get('/export.csv', asyncHandler(async (req, res) => {
  const csv = entriesCsv(await listEntries(req.tenant, opts(req)));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="commissions_${req.query.from || 'all'}_${req.query.to || 'now'}.csv"`);
  res.send(csv);
}));

export default router;
