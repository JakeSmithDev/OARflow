// Render typed emails: load a tenant's template (or fall back to defaults),
// substitute {{PLACEHOLDERS}}, and wrap the body in a branded HTML shell.
import { queryOne } from './db.js';
import { defaultEmailTemplates } from './defaults.js';
import { sendEmail } from './email.js';

const DEFAULTS = Object.fromEntries(defaultEmailTemplates().map((t) => [t.type, t]));

export function fillPlaceholders(str, vars) {
  if (!str) return '';
  return str.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_, key) => (vars[key] ?? ''));
}

export function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Render a simple two-column details table for the {{DETAILS}} placeholder. */
export function detailsTable(rows) {
  const trs = rows
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([label, value]) => `<tr><td style="padding:6px 14px 6px 0;color:#64748b;white-space:nowrap;vertical-align:top">${htmlEscape(label)}</td><td style="padding:6px 0;color:#0f172a;font-weight:600">${value}</td></tr>`)
    .join('');
  return `<table style="border-collapse:collapse;margin:14px 0;font-size:15px">${trs}</table>`;
}

export function buildShell(tenant, innerHtml) {
  const brand = tenant?.settings?.branding || {};
  const primary = brand.primaryColor || '#0e7c4b';
  const company = brand.logoText || tenant?.name || 'OARFlow';
  const phone = brand.supportPhone || tenant?.contact_phone || '';
  const email = brand.supportEmail || tenant?.contact_email || '';
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(15,23,42,.08)">
    <tr><td style="background:${primary};padding:22px 28px"><span style="color:#fff;font-size:18px;font-weight:700;letter-spacing:.2px">${htmlEscape(company)}</span></td></tr>
    <tr><td style="padding:28px;color:#0f172a;font-size:15px;line-height:1.6">
      ${innerHtml}
    </td></tr>
    <tr><td style="padding:18px 28px;background:#f8fafc;color:#94a3b8;font-size:12px;line-height:1.6;border-top:1px solid #e2e8f0">
      ${htmlEscape(company)}${phone ? ' · ' + htmlEscape(phone) : ''}${email ? ' · ' + htmlEscape(email) : ''}
    </td></tr>
  </table>
  <style>.btn{background:${primary};color:#fff !important;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;display:inline-block}</style>
  </body></html>`;
}

async function loadTemplate(tenantId, type) {
  const row = await queryOne(
    'SELECT subject, html, text FROM email_templates WHERE tenant_id = $1 AND type = $2 AND is_active = TRUE',
    [tenantId, type],
  );
  return row || DEFAULTS[type] || null;
}

/** Render { subject, html, text } for a given template type + variables. */
export async function renderEmail(tenant, type, vars) {
  const tpl = await loadTemplate(tenant.id, type);
  if (!tpl) throw new Error(`Unknown email template: ${type}`);
  const subject = fillPlaceholders(tpl.subject, vars);
  const innerHtml = fillPlaceholders(tpl.html, vars);
  const text = fillPlaceholders(tpl.text || '', vars);
  return { subject, html: buildShell(tenant, innerHtml), text };
}

/** Render + send a typed email in one call. */
export async function sendTemplated(tenant, type, to, vars, related = {}) {
  const { subject, html, text } = await renderEmail(tenant, type, vars);
  return sendEmail({ tenant, to, subject, html, text, relatedType: related.type, relatedId: related.id });
}

export default { renderEmail, sendTemplated, fillPlaceholders, detailsTable, buildShell, htmlEscape };
