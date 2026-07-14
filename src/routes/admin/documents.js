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
import {
  AGREEMENT_DEFAULTS, generateServiceAgreementPdf, generateWdiiInspectionPdf, safePdfFilename,
} from '../../lib/customer_pdfs.js';

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

const PDF_TYPES = new Set(['wdii', 'service_agreement']);
const AGREEMENT_FREQUENCIES = new Set(['monthly', 'quarterly']);
function pdfMoney(value, fallback, label) {
  if (value === undefined) return { value: fallback };
  if (typeof value !== 'number' && typeof value !== 'string') return { error: `${label} must be a number.` };
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000) return { error: `${label} must be between $0 and $100,000.` };
  return { value: Math.round(amount) };
}
function pdfAttachment(res, bytes, filename) {
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.send(bytes);
}

// Built-in customer forms. These stream directly instead of relying on object
// storage, so document generation also works when S3/R2 is not configured.
router.post('/customer/:customerId/generate', requirePermission('documents.manage'), asyncHandler(async (req, res) => {
  const customerId = toInt(req.params.customerId);
  const customer = await queryOne('SELECT * FROM customers WHERE tenant_id=$1 AND id=$2', [req.tenant.id, customerId]);
  if (!customer) return notFound(res);
  const body = req.body || {};
  if (!PDF_TYPES.has(body.type)) return badRequest(res, 'Choose a supported customer document.');

  let bytes; let filename; let details;
  if (body.type === 'wdii') {
    bytes = await generateWdiiInspectionPdf(req.tenant, customer);
    filename = safePdfFilename(customer.name, 'WDII_Inspection_Report');
    details = { type: 'wdii' };
  } else {
    const subscription = await queryOne(
      `SELECT interval, price_cents, notes FROM subscriptions
        WHERE tenant_id=$1 AND customer_id=$2 AND status='active'
        ORDER BY started_at DESC, id DESC LIMIT 1`,
      [req.tenant.id, customerId],
    );
    const frequency = body.frequency ?? (AGREEMENT_FREQUENCIES.has(subscription?.interval) ? subscription.interval : AGREEMENT_DEFAULTS.frequency);
    if (!AGREEMENT_FREQUENCIES.has(frequency)) return badRequest(res, 'Frequency must be monthly or quarterly.');
    if (body.notes !== undefined && typeof body.notes !== 'string') return badRequest(res, 'Additional comments must be text.');
    if (String(body.notes ?? '').length > 500) return badRequest(res, 'Additional comments must be 500 characters or fewer.');
    if (body.coveredPests !== undefined && typeof body.coveredPests !== 'string') return badRequest(res, 'Covered pests must be text.');
    const coveredPests = String(body.coveredPests ?? AGREEMENT_DEFAULTS.coveredPests).trim();
    if (!coveredPests || coveredPests.length > 300) return badRequest(res, 'Covered pests must be between 1 and 300 characters.');
    const initial = pdfMoney(body.initialServiceFeeCents, AGREEMENT_DEFAULTS.initialServiceFeeCents, 'Initial service fee');
    if (initial.error) return badRequest(res, initial.error);
    const service = pdfMoney(body.serviceFeeCents, subscription?.price_cents ?? AGREEMENT_DEFAULTS.serviceFeeCents, 'Cost per service');
    if (service.error) return badRequest(res, service.error);
    const notes = body.notes ?? subscription?.notes ?? customer.notes ?? '';
    bytes = await generateServiceAgreementPdf(req.tenant, customer, {
      frequency, notes, coveredPests, initialServiceFeeCents: initial.value, serviceFeeCents: service.value,
    });
    filename = safePdfFilename(customer.name, 'Pest_Control_Service_Agreement');
    details = { type: 'service_agreement', frequency, initialServiceFeeCents: initial.value, serviceFeeCents: service.value };
  }
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'customer_pdf_generate', entityType: 'customer', entityId: customerId, details });
  return pdfAttachment(res, bytes, filename);
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
