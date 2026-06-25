// Public review landing. Token-guarded. We capture the private rating/comment,
// then show the public-review platform links to EVERYONE (no rating gating).
import express from 'express';
import { asyncHandler, badRequest, notFound } from '../lib/http.js';
import { getTenantById } from '../lib/tenants.js';
import { getByToken, recordResponse } from '../lib/reviews.js';
import { query } from '../lib/db.js';

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  const reqRow = await getByToken(String(req.query.token || ''));
  if (!reqRow) return notFound(res, 'This review link is no longer valid.');
  const tenant = await getTenantById(reqRow.tenant_id);
  const p = tenant.settings.reviews.platforms || {};
  res.json({
    ok: true,
    tenant: { name: tenant.name, branding: tenant.settings.branding },
    platforms: Object.fromEntries(Object.entries(p).filter(([, v]) => v)),
    already: reqRow.status === 'responded' ? { rating: reqRow.rating } : null,
  });
}));

router.post('/respond', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const reqRow = await getByToken(String(b.token || ''));
  if (!reqRow) return notFound(res, 'This review link is no longer valid.');
  if (!b.rating) return badRequest(res, 'Please choose a rating.');
  const tenant = await getTenantById(reqRow.tenant_id);
  await recordResponse(reqRow, { rating: b.rating, comment: b.comment });
  const p = tenant.settings.reviews.platforms || {};
  res.json({ ok: true, platforms: Object.fromEntries(Object.entries(p).filter(([, v]) => v)) });
}));

// Beacon: which public platform the customer chose (best-effort).
router.post('/click', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const reqRow = await getByToken(String(b.token || ''));
  if (reqRow && b.platform) await query('UPDATE review_requests SET platform_clicked=$2, updated_at=now() WHERE id=$1', [reqRow.id, String(b.platform).slice(0, 20)]);
  res.json({ ok: true });
}));

export default router;
