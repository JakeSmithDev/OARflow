// Document/template library + e-signature. Templates hold {{MERGE}} fields; a
// sent document snapshots the rendered body (immutable) and captures a typed
// (clickwrap) signature plus an optional drawn signature image.
import { query, queryOne } from './db.js';
import { randomToken } from './crypto.js';
import { fillPlaceholders, htmlEscape } from './email_templates.js';
import { saveFile } from './storage.js';
import { formatDateLabel } from './dates.js';

export const MERGE_FIELDS = ['CUSTOMER_NAME', 'CUSTOMER_EMAIL', 'CUSTOMER_PHONE', 'CUSTOMER_ADDRESS', 'COMPANY_NAME', 'COMPANY_PHONE', 'SERVICE_NAME', 'APPOINTMENT_DATE', 'TODAY', 'PRICE'];

export async function listTemplates(tenant, { includeInactive = false } = {}) {
  const r = await query(
    `SELECT id, name, requires_signature, is_active, updated_at FROM document_templates
      WHERE tenant_id=$1 ${includeInactive ? '' : 'AND is_active=TRUE'} ORDER BY name`,
    [tenant.id],
  );
  return r.rows;
}
export async function getTemplate(tenant, id) { return queryOne('SELECT * FROM document_templates WHERE tenant_id=$1 AND id=$2', [tenant.id, id]); }

export async function createTemplate(tenant, { name, body, requiresSignature = true }) {
  return queryOne('INSERT INTO document_templates (tenant_id, name, body, requires_signature) VALUES ($1,$2,$3,$4) RETURNING *', [tenant.id, name, body || '', requiresSignature !== false]);
}
export async function updateTemplate(tenant, id, fields) {
  const cols = { name: fields.name, body: fields.body, requires_signature: fields.requiresSignature, is_active: fields.isActive };
  const sets = []; const params = [id, tenant.id];
  for (const [k, v] of Object.entries(cols)) { if (v !== undefined) { params.push(v); sets.push(`${k}=$${params.length}`); } }
  if (!sets.length) return getTemplate(tenant, id);
  sets.push('updated_at=now()');
  return queryOne(`UPDATE document_templates SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`, params);
}

/** Merge a template/raw body with customer + company + appointment variables. */
export async function renderBody(tenant, body, { customer, appointment }) {
  const vars = {
    CUSTOMER_NAME: customer?.name || '', CUSTOMER_EMAIL: customer?.email || '', CUSTOMER_PHONE: customer?.phone || '',
    CUSTOMER_ADDRESS: [customer?.address, customer?.city, customer?.state].filter(Boolean).join(', '),
    COMPANY_NAME: tenant.settings.branding.logoText || tenant.name, COMPANY_PHONE: tenant.contact_phone || tenant.settings.branding.supportPhone || '',
    SERVICE_NAME: appointment?.service_name || '', APPOINTMENT_DATE: appointment?.scheduled_start ? formatDateLabel(new Date(appointment.scheduled_start), tenant.timezone) : '',
    TODAY: formatDateLabel(new Date(), tenant.timezone), PRICE: '',
  };
  return fillPlaceholders(body, vars);
}

export async function createDocument(tenant, { templateId, customerId, appointmentId, title, body }, createdBy) {
  const customer = await queryOne('SELECT * FROM customers WHERE tenant_id=$1 AND id=$2', [tenant.id, customerId]);
  if (!customer) return { ok: false, error: 'Unknown customer.' };
  let tpl = null; let rawBody = body; let requiresSig = true; let docTitle = title;
  if (templateId) { tpl = await getTemplate(tenant, templateId); if (!tpl) return { ok: false, error: 'Unknown template.' }; rawBody = tpl.body; requiresSig = tpl.requires_signature; docTitle = docTitle || tpl.name; }
  let appointment = null;
  if (appointmentId) appointment = await queryOne('SELECT a.*, s.name AS service_name FROM appointments a LEFT JOIN service_types s ON s.id=a.service_type_id WHERE a.tenant_id=$1 AND a.id=$2', [tenant.id, appointmentId]);
  const rendered = await renderBody(tenant, rawBody || '', { customer, appointment });
  const doc = await queryOne(
    `INSERT INTO documents (tenant_id, customer_id, appointment_id, template_id, title, body, requires_signature, access_token, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [tenant.id, customerId, appointmentId || null, templateId || null, docTitle || 'Document', rendered, requiresSig, randomToken(), createdBy || null],
  );
  return { ok: true, document: doc };
}

export async function getByToken(token) {
  if (!token) return null;
  return queryOne('SELECT * FROM documents WHERE access_token=$1', [token]);
}

/** Record a clickwrap signature (+ optional drawn signature image file). */
export async function signDocument(tenant, doc, { name, ip, userAgent, signatureDataUrl }) {
  if (doc.status === 'signed') return { ok: true, already: true };
  if (doc.status === 'declined') return { ok: false, error: 'This document was declined.' };
  if (doc.requires_signature && !name) return { ok: false, error: 'Please type your name to sign.' };
  let signatureFileId = null;
  if (signatureDataUrl && /^data:image\/png;base64,/.test(signatureDataUrl)) {
    try {
      const buffer = Buffer.from(signatureDataUrl.split(',')[1], 'base64');
      if (buffer.length && buffer.length < 2_000_000) {
        const f = await saveFile(tenant, { buffer, filename: 'signature.png', contentType: 'image/png', ownerType: 'document', ownerId: doc.id, kind: 'signature', meta: { name } });
        signatureFileId = f.id;
      }
    } catch { /* ignore signature image errors; typed name still binds */ }
  }
  const updated = await queryOne(
    `UPDATE documents SET status='signed', signed_at=now(), signed_name=$3, signed_ip=$4, signed_user_agent=$5, signature_file_id=$6, updated_at=now()
      WHERE tenant_id=$1 AND id=$2 RETURNING *`,
    [tenant.id, doc.id, name || null, ip || null, userAgent || null, signatureFileId],
  );
  return { ok: true, document: updated };
}

export async function declineDocument(tenant, doc) {
  return queryOne("UPDATE documents SET status='declined', declined_at=now(), updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status<>'signed' RETURNING *", [tenant.id, doc.id]);
}

export async function listDocuments(tenant, { status, customerId } = {}) {
  const where = ['d.tenant_id=$1']; const params = [tenant.id];
  if (status && status !== 'all') { params.push(status); where.push(`d.status=$${params.length}`); }
  if (customerId) { params.push(customerId); where.push(`d.customer_id=$${params.length}`); }
  const r = await query(
    `SELECT d.id, d.title, d.status, d.requires_signature, d.sent_at, d.signed_at, d.signed_name, d.created_at, c.name AS customer_name
       FROM documents d JOIN customers c ON c.id=d.customer_id WHERE ${where.join(' AND ')} ORDER BY d.id DESC LIMIT 200`,
    params,
  );
  return r.rows;
}

export function summaryHtml(doc) { return `<div style="white-space:pre-wrap">${htmlEscape(doc.body)}</div>`; }

export default { MERGE_FIELDS, listTemplates, getTemplate, createTemplate, updateTemplate, renderBody, createDocument, getByToken, signDocument, declineDocument, listDocuments };
