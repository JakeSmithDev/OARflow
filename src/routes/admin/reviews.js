// Admin reviews / NPS: list responses + metrics, request a review on demand.
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { requirePermission } from '../../lib/permissions.js';
import { asyncHandler, badRequest, notFound, toInt } from '../../lib/http.js';
import { queryOne } from '../../lib/db.js';
import { ownsId } from '../../lib/ownership.js';
import { updateTenantSettings } from '../../lib/tenants.js';
import { listReviews, reviewMetrics, createReviewRequest, sendReviewRequest } from '../../lib/reviews.js';
import { logAudit } from '../../lib/audit.js';

const router = express.Router();
router.use(requireAdmin());

router.get('/', asyncHandler(async (req, res) => {
  res.json({
    ok: true,
    reviews: await listReviews(req.tenant, { status: req.query.status }),
    metrics: await reviewMetrics(req.tenant),
    platforms: req.tenant.settings.reviews.platforms || {},
    settings: { enabled: req.tenant.settings.reviews.enabled, autoRequest: req.tenant.settings.reviews.autoRequest, delayHours: req.tenant.settings.reviews.delayHours, channel: req.tenant.settings.reviews.channel },
  });
}));

// Manually request a review now (e.g. right after finishing a job).
router.post('/request', requirePermission('reviews.manage'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const customerId = toInt(b.customerId);
  if (!customerId) return badRequest(res, 'A customer is required.');
  if (!(await ownsId(req.tenant.id, 'customers', customerId))) return badRequest(res, 'Unknown customer.');
  const appointmentId = toInt(b.appointmentId);
  if (appointmentId) {
    // Appointment must belong to THIS customer (not just the tenant), so the
    // request can't be tied to another customer's service context.
    const a = await queryOne('SELECT 1 FROM appointments WHERE tenant_id=$1 AND id=$2 AND customer_id=$3', [req.tenant.id, appointmentId, customerId]);
    if (!a) return badRequest(res, 'That appointment does not belong to this customer.');
  }
  const reqRow = await createReviewRequest(req.tenant, { customerId, appointmentId: appointmentId || null, channel: b.channel });
  const r = await sendReviewRequest(req.tenant, reqRow);
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'review_request', entityType: 'customer', entityId: customerId });
  res.json({ ok: true, sent: r.ok, request: reqRow });
}));

// Update review automation + public-platform links (gated by reviews.manage so
// managers can manage reputation without full owner settings access).
router.put('/settings', requirePermission('reviews.manage'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const patch = { reviews: {} };
  if (b.platforms) patch.reviews.platforms = { google: b.platforms.google || '', yelp: b.platforms.yelp || '', facebook: b.platforms.facebook || '' };
  if (b.autoRequest !== undefined) patch.reviews.autoRequest = Boolean(b.autoRequest);
  if (b.enabled !== undefined) patch.reviews.enabled = Boolean(b.enabled);
  if (b.delayHours !== undefined) patch.reviews.delayHours = Math.max(0, Math.round(Number(b.delayHours) || 0));
  if (b.channel) patch.reviews.channel = b.channel === 'sms' ? 'sms' : 'email';
  await updateTenantSettings(req.tenant.id, patch);
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'review_settings_update' });
  res.json({ ok: true });
}));

router.post('/:id/send', requirePermission('reviews.manage'), asyncHandler(async (req, res) => {
  const reqRow = await queryOne('SELECT * FROM review_requests WHERE tenant_id=$1 AND id=$2', [req.tenant.id, toInt(req.params.id)]);
  if (!reqRow) return notFound(res);
  const r = await sendReviewRequest(req.tenant, reqRow);
  res.json({ ok: true, sent: r.ok });
}));

export default router;
