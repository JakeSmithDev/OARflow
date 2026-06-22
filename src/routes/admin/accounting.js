// Admin accounting export: summary + CSV / IIF (QuickBooks Desktop) downloads.
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { requirePermission } from '../../lib/permissions.js';
import { asyncHandler } from '../../lib/http.js';
import { accountingSummary, getAccountingProvider } from '../../lib/accounting.js';
import { logAudit } from '../../lib/audit.js';

const router = express.Router();
router.use(requireAdmin());
router.use(requirePermission('reports.view'));

function opts(req) {
  const types = req.query.types ? String(req.query.types).split(',').map((s) => s.trim()).filter(Boolean) : null;
  return { from: req.query.from || undefined, to: req.query.to || undefined, types };
}

router.get('/', asyncHandler(async (req, res) => {
  const provider = getAccountingProvider(req.tenant);
  res.json({ ok: true, provider: { name: provider.name, supportsSync: provider.supportsSync }, summary: await accountingSummary(req.tenant, opts(req)) });
}));

router.get('/export.csv', asyncHandler(async (req, res) => {
  const csv = await getAccountingProvider(req.tenant).csv(opts(req));
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'accounting_export', details: { format: 'csv', from: req.query.from, to: req.query.to } });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="accounting_${req.query.from || 'all'}_${req.query.to || 'now'}.csv"`);
  res.send(csv);
}));

router.get('/export.iif', asyncHandler(async (req, res) => {
  const iif = await getAccountingProvider(req.tenant).iif(opts(req));
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'accounting_export', details: { format: 'iif', from: req.query.from, to: req.query.to } });
  res.set('Content-Type', 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="quickbooks_${req.query.from || 'all'}_${req.query.to || 'now'}.iif"`);
  res.send(iif);
}));

export default router;
