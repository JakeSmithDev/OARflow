// Admin documents: template library + sending documents for e-signature.
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { requirePermission } from '../../lib/permissions.js';
import { asyncHandler, badRequest, notFound, toInt } from '../../lib/http.js';
import { queryOne } from '../../lib/db.js';
import { getFile, signedUrl } from '../../lib/storage.js';
import {
  MERGE_FIELDS, listTemplates, getTemplate, createTemplate, updateTemplate,
  createDocument, listDocuments,
} from '../../lib/documents.js';
import { sendTemplated } from '../../lib/email_templates.js';
import { logAudit } from '../../lib/audit.js';
import { config } from '../../config.js';

const router = express.Router();
router.use(requireAdmin());

router.get('/meta', asyncHandler(async (req, res) => res.json({ ok: true, mergeFields: MERGE_FIELDS })));

// --- Templates ---
router.get('/templates', asyncHandler(async (req, res) => {
  res.json({ ok: true, templates: await listTemplates(req.tenant, { includeInactive: req.query.all === '1' }) });
}));
router.get('/templates/:id', asyncHandler(async (req, res) => {
  const t = await getTemplate(req.tenant, toInt(req.params.id)); if (!t) return notFound(res); res.json({ ok: true, template: t });
}));
router.post('/templates', requirePermission('documents.manage'), asyncHandler(async (req, res) => {
  const b = req.body || {}; if (!b.name) return badRequest(res, 'Name is required.');
  const t = await createTemplate(req.tenant, { name: b.name, body: b.body, requiresSignature: b.requiresSignature });
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'doc_template_create', entityType: 'document_template', entityId: t.id });
  res.json({ ok: true, template: t });
}));
router.patch('/templates/:id', requirePermission('documents.manage'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const t = await updateTemplate(req.tenant, toInt(req.params.id), { name: b.name, body: b.body, requiresSignature: b.requiresSignature, isActive: b.isActive });
  if (!t) return notFound(res); res.json({ ok: true, template: t });
}));

// --- Documents ---
router.get('/', asyncHandler(async (req, res) => {
  res.json({ ok: true, documents: await listDocuments(req.tenant, { status: req.query.status, customerId: toInt(req.query.customerId) }) });
}));
router.get('/:id', asyncHandler(async (req, res) => {
  const d = await queryOne('SELECT d.*, c.name AS customer_name, c.email AS customer_email FROM documents d JOIN customers c ON c.id=d.customer_id WHERE d.tenant_id=$1 AND d.id=$2', [req.tenant.id, toInt(req.params.id)]);
  if (!d) return notFound(res);
  let signatureUrl = null;
  if (d.signature_file_id) { const f = await getFile(req.tenant.id, d.signature_file_id); if (f) signatureUrl = await signedUrl(f); }
  res.json({ ok: true, document: d, signUrl: `${config.baseUrl}/document?token=${d.access_token}`, signatureUrl });
}));
router.post('/', requirePermission('documents.manage'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!toInt(b.customerId)) return badRequest(res, 'A customer is required.');
  if (!toInt(b.templateId) && !b.body) return badRequest(res, 'Choose a template or enter a body.');
  const r = await createDocument(req.tenant, { templateId: toInt(b.templateId), customerId: toInt(b.customerId), appointmentId: toInt(b.appointmentId), title: b.title, body: b.body }, req.admin.username);
  if (!r.ok) return badRequest(res, r.error);
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'document_create', entityType: 'document', entityId: r.document.id });
  res.json({ ok: true, document: r.document });
}));
router.post('/:id/send', requirePermission('documents.manage'), asyncHandler(async (req, res) => {
  const d = await queryOne('SELECT d.*, c.name AS customer_name, c.email AS customer_email FROM documents d JOIN customers c ON c.id=d.customer_id WHERE d.tenant_id=$1 AND d.id=$2', [req.tenant.id, toInt(req.params.id)]);
  if (!d) return notFound(res);
  if (!d.customer_email) return badRequest(res, 'This customer has no email on file.');
  await queryOne("UPDATE documents SET status=CASE WHEN status='draft' THEN 'sent' ELSE status END, sent_at=COALESCE(sent_at, now()), updated_at=now() WHERE id=$1 RETURNING id", [d.id]);
  const url = `${config.baseUrl}/document?token=${d.access_token}`;
  const r = await sendTemplated(req.tenant, 'document_request', d.customer_email, {
    CUSTOMER_NAME: d.customer_name, COMPANY_NAME: req.tenant.settings.branding.logoText || req.tenant.name, DOCUMENT_TITLE: d.title, DOCUMENT_URL: url,
  }, { type: 'document', id: d.id });
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'document_send', entityType: 'document', entityId: d.id });
  res.json({ ok: true, emailed: r.ok, signUrl: url });
}));

export default router;
