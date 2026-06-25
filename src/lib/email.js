// Email delivery. Resolves a provider in this order: Mailgun (HTTP) → SMTP
// (nodemailer) → console outbox (dev). Every send is recorded in email_outbox
// so staff can see exactly what went out (and so dev has a visible inbox).
import { config, emailProviderName } from '../config.js';
import { query } from './db.js';

async function recordOutbox({ tenantId, to, subject, html, text, status, provider, error, relatedType, relatedId }) {
  try {
    const row = await query(
      `INSERT INTO email_outbox (tenant_id, to_email, subject, html, text, status, provider, error, related_type, related_id, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $6='sent' THEN now() ELSE NULL END) RETURNING id`,
      [tenantId || null, to, subject, html || null, text || null, status, provider, error || null, relatedType || null, relatedId || null],
    );
    return row.rows[0]?.id;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('outbox write failed', err.message);
    return null;
  }
}

async function sendViaMailgun({ from, to, subject, html, text, replyTo }) {
  const { apiKey, domain, baseUrl } = config.email.mailgun;
  const body = new URLSearchParams({ from, to, subject });
  if (html) body.set('html', html);
  if (text) body.set('text', text);
  if (replyTo) body.set('h:Reply-To', replyTo);
  const res = await fetch(`${baseUrl}/v3/${domain}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`api:${apiKey}`).toString('base64') },
    body,
  });
  if (!res.ok) throw new Error(`Mailgun ${res.status}: ${await res.text()}`);
}

let _transport = null;
async function sendViaSmtp({ from, to, subject, html, text, replyTo }) {
  const nodemailer = (await import('nodemailer')).default;
  if (!_transport) {
    _transport = nodemailer.createTransport({
      host: config.email.smtp.host,
      port: config.email.smtp.port,
      secure: config.email.smtp.secure,
      auth: config.email.smtp.user ? { user: config.email.smtp.user, pass: config.email.smtp.pass } : undefined,
    });
  }
  await _transport.sendMail({ from, to, subject, html, text, replyTo: replyTo || undefined });
}

/**
 * Send an email. Returns { ok, id, provider, status }.
 * `tenant` (optional) supplies branding/from-address overrides.
 */
export async function sendEmail({ tenant, to, subject, html, text, relatedType, relatedId }) {
  const tenantId = tenant?.id || null;
  const provider = emailProviderName();
  const from = tenant?.settings?.integrations?.email?.from || config.email.from;
  const replyTo = tenant?.settings?.integrations?.email?.replyTo || config.email.replyTo || tenant?.contact_email || '';

  if (!to) return { ok: false, status: 'failed', error: 'no recipient' };

  try {
    if (provider === 'mailgun') {
      await sendViaMailgun({ from, to, subject, html, text, replyTo });
    } else if (provider === 'smtp') {
      await sendViaSmtp({ from, to, subject, html, text, replyTo });
    } else {
      // console/dev: nothing leaves the building, but we record it and log it.
      // eslint-disable-next-line no-console
      console.log(`\n📧 [outbox] To: ${to}\n   Subject: ${subject}\n   (set MAILGUN_* or SMTP_* to actually send)\n`);
    }
    const id = await recordOutbox({ tenantId, to, subject, html, text, status: provider === 'console' ? 'sent' : 'sent', provider, relatedType, relatedId });
    return { ok: true, id, provider, status: 'sent' };
  } catch (err) {
    await recordOutbox({ tenantId, to, subject, html, text, status: 'failed', provider, error: err.message, relatedType, relatedId });
    // eslint-disable-next-line no-console
    console.error('email send failed', err.message);
    return { ok: false, status: 'failed', error: err.message };
  }
}

export default { sendEmail };
