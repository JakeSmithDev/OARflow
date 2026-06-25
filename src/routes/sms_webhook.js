// Inbound + status webhooks for SMS providers (Twilio today). Records inbound
// messages, handles STOP/START/HELP opt-out keywords, and updates delivery
// status. Validates the Twilio signature when a real signed request arrives.
import express from 'express';
import crypto from 'node:crypto';
import { asyncHandler } from '../lib/http.js';
import { query, queryOne } from '../lib/db.js';
import { getTenantById } from '../lib/tenants.js';
import { config } from '../config.js';
import { normalizeE164, getOrCreateConversation, setConsent, smsCreds } from '../lib/sms.js';

const router = express.Router();

async function resolveTenantByNumber(toPhone) {
  const reg = await queryOne('SELECT tenant_id FROM tenant_phone_numbers WHERE phone_e164=$1', [toPhone]);
  if (reg) return getTenantById(reg.tenant_id);
  const t = await queryOne("SELECT id FROM tenants WHERE settings->'integrations'->'sms'->>'fromNumber' = $1", [toPhone]);
  return t ? getTenantById(t.id) : null;
}

// Verify a Twilio request signature. Fails CLOSED in production: an unsigned or
// unverifiable request is rejected so the public endpoint can't be forged to
// inject inbound messages or flip STOP/START consent. In dev we allow unsigned
// requests for manual testing.
function verifyTwilioSignature(tenant, req) {
  const sig = req.headers['x-twilio-signature'];
  const authToken = tenant ? smsCreds(tenant).authToken : '';
  if (!sig || !authToken) return !config.isProduction;
  // Build the URL Twilio signed. Behind a proxy (Vercel) trust-proxy makes
  // req.protocol honor X-Forwarded-Proto; fall back to the configured base URL.
  const host = req.get('host');
  const url = host ? `${req.protocol}://${host}${req.originalUrl}` : `${config.baseUrl}${req.originalUrl}`;
  const params = req.body || {};
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}

const STOP = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const START = new Set(['START', 'YES', 'UNSTOP']);

router.post('/:provider', asyncHandler(async (req, res) => {
  const b = req.body || {};
  // Status callback? Resolve the message's tenant and VERIFY before mutating,
  // and scope the update by tenant so a forged SID can't touch another tenant.
  if (b.MessageStatus && b.MessageSid) {
    const msg = await queryOne('SELECT tenant_id FROM sms_messages WHERE provider_message_id=$1', [b.MessageSid]);
    const tenant = msg ? await getTenantById(msg.tenant_id) : null;
    if (!verifyTwilioSignature(tenant, req)) return res.status(403).send('bad signature');
    const status = ({ delivered: 'delivered', undelivered: 'failed', failed: 'failed', sent: 'sent' })[b.MessageStatus] || null;
    if (status && msg) {
      await query(
        "UPDATE sms_messages SET status=$2, delivered_at=CASE WHEN $2='delivered' THEN now() ELSE delivered_at END, error_code=COALESCE($3,error_code) WHERE provider_message_id=$1 AND tenant_id=$4",
        [b.MessageSid, status, b.ErrorCode || null, msg.tenant_id],
      );
    }
    return res.type('text/xml').send('<Response></Response>');
  }

  // Inbound message
  const toPhone = normalizeE164(b.To);
  const fromPhone = normalizeE164(b.From);
  if (!toPhone || !fromPhone) return res.type('text/xml').send('<Response></Response>');
  const tenant = await resolveTenantByNumber(toPhone);
  if (!tenant) return res.type('text/xml').send('<Response></Response>');
  if (!verifyTwilioSignature(tenant, req)) return res.status(403).send('bad signature');

  const customer = await queryOne(
    "SELECT id FROM customers WHERE tenant_id=$1 AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g') LIKE '%'||$2 LIMIT 1",
    [tenant.id, fromPhone.replace(/\D/g, '').slice(-10)],
  ).catch(() => null);
  const convo = await getOrCreateConversation(tenant.id, fromPhone, customer?.id);

  const media = [];
  const n = Number(b.NumMedia || 0);
  for (let i = 0; i < n; i++) if (b[`MediaUrl${i}`]) media.push(b[`MediaUrl${i}`]);

  await query(
    `INSERT INTO sms_messages (tenant_id, conversation_id, customer_id, direction, body, media, provider, provider_message_id, status)
     VALUES ($1,$2,$3,'inbound',$4,$5::jsonb,$6,$7,'received')`,
    [tenant.id, convo.id, customer?.id || null, b.Body || '', JSON.stringify(media), req.params.provider, b.MessageSid || null],
  );
  await query('UPDATE sms_conversations SET last_message_at=now(), last_inbound_at=now(), unread_count=unread_count+1, status=\'open\' WHERE id=$1', [convo.id]);

  // Keyword opt-out/opt-in.
  const word = String(b.Body || '').trim().toUpperCase();
  if (STOP.has(word)) await setConsent(tenant.id, { customerId: customer?.id, phone: fromPhone, status: 'opted_out', source: 'inbound_keyword' });
  else if (START.has(word)) await setConsent(tenant.id, { customerId: customer?.id, phone: fromPhone, status: 'opted_in', source: 'inbound_keyword' });

  res.type('text/xml').send('<Response></Response>');
}));

export default router;
