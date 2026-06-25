// SMS/MMS sending. Provider-agnostic (Twilio adapter today) with per-tenant BYO
// credentials (default) or a platform fallback. Consent + opt-out aware, idempotent,
// and a console fallback so it works keyless in dev/demo.
import { query, queryOne } from './db.js';
import { decryptSecret } from './crypto.js';
import { oncePerKey } from './events.js';
import { config } from '../config.js';

export function smsSettings(tenant) {
  return tenant?.settings?.integrations?.sms || {};
}
export function smsCreds(tenant) {
  const s = smsSettings(tenant);
  const accountSid = s.accountSid || config.twilio?.accountSid || '';
  const authToken = decryptSecret(s.authToken) || config.twilio?.authToken || '';
  const from = s.messagingServiceSid || s.fromNumber || config.twilio?.fromNumber || '';
  return { provider: s.provider || 'twilio', accountSid, authToken, from, fromNumber: s.fromNumber, messagingServiceSid: s.messagingServiceSid };
}
export function isSmsConfigured(tenant) {
  const c = smsCreds(tenant);
  return Boolean(c.accountSid && c.authToken && c.from);
}

/** Best-effort E.164 normalization (US default). */
export function normalizeE164(raw) {
  if (!raw) return '';
  const t = String(raw).trim();
  if (t.startsWith('+')) return '+' + t.slice(1).replace(/\D/g, '');
  const digits = t.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return digits ? '+' + digits : '';
}

async function consentStatus(tenantId, phone) {
  const row = await queryOne(
    "SELECT status FROM customer_contact_consents WHERE tenant_id=$1 AND channel='sms' AND address=$2 ORDER BY captured_at DESC LIMIT 1",
    [tenantId, phone],
  );
  return row?.status || 'unknown';
}

export async function setConsent(tenantId, { customerId, phone, status, purpose = 'transactional', source = 'admin', consentText, ip, ua }) {
  await query(
    `INSERT INTO customer_contact_consents (tenant_id, customer_id, channel, address, purpose, status, source, consent_text, captured_ip, captured_user_agent)
     VALUES ($1,$2,'sms',$3,$4,$5,$6,$7,$8,$9)`,
    [tenantId, customerId || null, phone, purpose, status, source, consentText || null, ip || null, ua || null],
  );
}

export async function getOrCreateConversation(tenantId, phone, customerId) {
  const existing = await queryOne('SELECT * FROM sms_conversations WHERE tenant_id=$1 AND phone_e164=$2', [tenantId, phone]);
  if (existing) {
    if (customerId && !existing.customer_id) await query('UPDATE sms_conversations SET customer_id=$2 WHERE id=$1', [existing.id, customerId]);
    return existing;
  }
  return queryOne(
    'INSERT INTO sms_conversations (tenant_id, customer_id, phone_e164) VALUES ($1,$2,$3) RETURNING *',
    [tenantId, customerId || null, phone],
  );
}

async function twilioSend({ accountSid, authToken, from, messagingServiceSid }, to, body, mediaUrls) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const form = new URLSearchParams({ To: to, Body: body });
  if (messagingServiceSid) form.set('MessagingServiceSid', messagingServiceSid); else form.set('From', from);
  (mediaUrls || []).forEach((m) => form.append('MediaUrl', m));
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Twilio ${res.status}`);
  return { sid: data.sid };
}

/**
 * Send an SMS. Respects opt-out, records the message + conversation, and is
 * idempotent when `idempotencyKey` is supplied. Returns { ok, status, id }.
 */
export async function sendSms(tenant, { to, body, mediaUrls, customerId, appointmentId, invoiceId, purpose = 'transactional', createdBy, idempotencyKey }) {
  const phone = normalizeE164(to);
  if (!phone) return { ok: false, error: 'No phone number.' };

  const doSend = async () => {
    const convo = await getOrCreateConversation(tenant.id, phone, customerId);
    // Opt-out guard (STOP applies to everything).
    if ((await consentStatus(tenant.id, phone)) === 'opted_out') {
      const m = await queryOne(
        `INSERT INTO sms_messages (tenant_id, conversation_id, customer_id, direction, body, appointment_id, invoice_id, status, purpose, created_by)
         VALUES ($1,$2,$3,'outbound',$4,$5,$6,'suppressed',$7,$8) RETURNING id`,
        [tenant.id, convo.id, customerId || null, body, appointmentId || null, invoiceId || null, purpose, createdBy || null],
      );
      return { ok: false, status: 'suppressed', id: m.id, reason: 'opted_out' };
    }
    const msg = await queryOne(
      `INSERT INTO sms_messages (tenant_id, conversation_id, customer_id, direction, body, media, appointment_id, invoice_id, provider, status, purpose, created_by)
       VALUES ($1,$2,$3,'outbound',$4,$5::jsonb,$6,$7,$8,'queued',$9,$10) RETURNING id`,
      [tenant.id, convo.id, customerId || null, body, JSON.stringify(mediaUrls || []), appointmentId || null, invoiceId || null, smsCreds(tenant).provider, purpose, createdBy || null],
    );

    if (!isSmsConfigured(tenant)) {
      // Dev/demo: no provider configured — record as a console "sent".
      // eslint-disable-next-line no-console
      console.log(`\n💬 [sms-outbox] To: ${phone}\n   ${body}\n   (configure Twilio in Settings → Integrations to actually send)\n`);
      await query("UPDATE sms_messages SET status='sent', provider='console' WHERE id=$1", [msg.id]);
      await query('UPDATE sms_conversations SET last_message_at=now() WHERE id=$1', [convo.id]);
      return { ok: true, status: 'sent', id: msg.id, provider: 'console' };
    }
    try {
      const { sid } = await twilioSend(smsCreds(tenant), phone, body, mediaUrls);
      await query("UPDATE sms_messages SET status='sent', provider_message_id=$2 WHERE id=$1", [msg.id, sid]);
      await query('UPDATE sms_conversations SET last_message_at=now() WHERE id=$1', [convo.id]);
      return { ok: true, status: 'sent', id: msg.id, sid };
    } catch (err) {
      await query("UPDATE sms_messages SET status='failed', error_code=$2 WHERE id=$1", [msg.id, err.message.slice(0, 200)]);
      return { ok: false, status: 'failed', id: msg.id, error: err.message };
    }
  };

  if (idempotencyKey) {
    const r = await oncePerKey(tenant.id, idempotencyKey, doSend);
    return r.ran ? r.result : { ok: true, status: 'duplicate' };
  }
  return doSend();
}

export default { sendSms, isSmsConfigured, smsCreds, normalizeE164, setConsent, getOrCreateConversation };
