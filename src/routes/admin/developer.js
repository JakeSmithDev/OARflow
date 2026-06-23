// Admin developer settings: API keys + outbound webhook endpoints + deliveries.
import express from 'express';
import { requireAdmin, requireRole } from '../../lib/auth.js';
import { asyncHandler, badRequest, toInt } from '../../lib/http.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../../lib/api_keys.js';
import { listEndpoints, createEndpoint, deleteEndpoint, recentDeliveries, deliverDue, WEBHOOK_EVENTS } from '../../lib/webhooks.js';
import { checkConfig } from '../../lib/preflight.js';
import { backendKind } from '../../lib/db.js';
import { logAudit } from '../../lib/audit.js';

const router = express.Router();
router.use(requireAdmin());
router.use(requireRole('owner')); // developer/API access is owner-only

router.get('/', asyncHandler(async (req, res) => {
  res.json({ ok: true, apiKeys: await listApiKeys(req.tenant), endpoints: await listEndpoints(req.tenant), deliveries: await recentDeliveries(req.tenant), events: WEBHOOK_EVENTS });
}));

// Go-live system status (owner-only): config readiness + live driver detection.
router.get('/system', asyncHandler(async (req, res) => {
  const pf = checkConfig();
  let dbDriver = 'unknown'; try { dbDriver = await backendKind(); } catch { /* */ }
  res.json({ ok: true, preflight: pf, drivers: { database: dbDriver, storage: pf.info.storage, email: pf.info.email, inngest: pf.info.inngest } });
}));

router.post('/keys', asyncHandler(async (req, res) => {
  const r = await createApiKey(req.tenant, { name: (req.body || {}).name, scopes: (req.body || {}).scopes }, req.admin.username);
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'api_key_create', entityType: 'api_key', entityId: r.id });
  res.json({ ok: true, key: r }); // secret returned once
}));
router.delete('/keys/:id', asyncHandler(async (req, res) => {
  await revokeApiKey(req.tenant, toInt(req.params.id));
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'api_key_revoke', entityType: 'api_key', entityId: toInt(req.params.id) });
  res.json({ ok: true });
}));

router.post('/webhooks', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.url || !/^https?:\/\//.test(b.url)) return badRequest(res, 'A valid URL is required.');
  const ep = await createEndpoint(req.tenant, { url: b.url, events: b.events }, req.admin.username);
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'webhook_create', entityType: 'webhook_endpoint', entityId: ep.id });
  res.json({ ok: true, endpoint: ep }); // secret returned once
}));
router.delete('/webhooks/:id', asyncHandler(async (req, res) => {
  await deleteEndpoint(req.tenant, toInt(req.params.id));
  res.json({ ok: true });
}));
router.post('/webhooks/deliver', asyncHandler(async (req, res) => {
  res.json({ ok: true, ...(await deliverDue(req.tenant.id)) });
}));

export default router;
