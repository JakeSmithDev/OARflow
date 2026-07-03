// Public document view + e-signature (token-guarded; no auth).
import express from 'express';
import { asyncHandler, badRequest, notFound, getClientIp } from '../lib/http.js';
import { getTenantById } from '../lib/tenants.js';
import { getByToken, signDocument, declineDocument } from '../lib/documents.js';
import { rateLimit } from '../lib/rate_limit.js';

const router = express.Router();
const limitView = rateLimit({ endpoint: 'document_get', windowMinutes: 10, maxCount: 60 });
const limitAction = rateLimit({ endpoint: 'document_post', windowMinutes: 10, maxCount: 12 });

router.get('/', limitView, asyncHandler(async (req, res) => {
  const doc = await getByToken(String(req.query.token || ''));
  if (!doc) return notFound(res, 'This document link is no longer valid.');
  const tenant = await getTenantById(doc.tenant_id);
  res.json({
    ok: true,
    document: { title: doc.title, body: doc.body, status: doc.status, requiresSignature: doc.requires_signature, signedName: doc.signed_name, signedAt: doc.signed_at },
    tenant: { name: tenant.name, branding: tenant.settings.branding },
  });
}));

router.post('/sign', limitAction, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const doc = await getByToken(String(b.token || ''));
  if (!doc) return notFound(res, 'This document link is no longer valid.');
  const tenant = await getTenantById(doc.tenant_id);
  const r = await signDocument(tenant, doc, { name: b.name, ip: getClientIp(req), userAgent: req.headers['user-agent'], signatureDataUrl: b.signatureDataUrl });
  if (!r.ok) return badRequest(res, r.error);
  res.json({ ok: true });
}));

router.post('/decline', limitAction, asyncHandler(async (req, res) => {
  const doc = await getByToken(String((req.body || {}).token || ''));
  if (!doc) return notFound(res, 'This document link is no longer valid.');
  const tenant = await getTenantById(doc.tenant_id);
  await declineDocument(tenant, doc);
  res.json({ ok: true });
}));

export default router;
