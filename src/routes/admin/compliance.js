// Admin compliance: chemical/material catalog + state-report (CSV) export.
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { requirePermission } from '../../lib/permissions.js';
import { asyncHandler, badRequest, notFound, toInt } from '../../lib/http.js';
import { listProducts, createProduct, updateProduct, applicationsCsv } from '../../lib/compliance.js';
import { logAudit } from '../../lib/audit.js';

const router = express.Router();
router.use(requireAdmin());

router.get('/products', asyncHandler(async (req, res) => {
  res.json({ ok: true, products: await listProducts(req.tenant, { includeInactive: req.query.all === '1' }) });
}));
router.post('/products', requirePermission('compliance.manage'), asyncHandler(async (req, res) => {
  if (!(req.body || {}).name) return badRequest(res, 'Product name is required.');
  const p = await createProduct(req.tenant, req.body);
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'chem_product_create', entityType: 'chemical_product', entityId: p.id });
  res.json({ ok: true, product: p });
}));
router.patch('/products/:id', requirePermission('compliance.manage'), asyncHandler(async (req, res) => {
  const p = await updateProduct(req.tenant, toInt(req.params.id), req.body || {});
  if (!p) return notFound(res); res.json({ ok: true, product: p });
}));

// State-report export — applications in a date range. We never auto-submit.
router.get('/applications.csv', requirePermission('compliance.manage'), asyncHandler(async (req, res) => {
  const { csv } = await applicationsCsv(req.tenant, { from: req.query.from, to: req.query.to });
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'compliance_export', details: { from: req.query.from, to: req.query.to } });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="pesticide_use_${req.query.from || 'all'}_${req.query.to || 'now'}.csv"`);
  res.send(csv);
}));

router.get('/summary', asyncHandler(async (req, res) => {
  const { count } = await applicationsCsv(req.tenant, { from: req.query.from, to: req.query.to });
  res.json({ ok: true, applications: count });
}));

export default router;
