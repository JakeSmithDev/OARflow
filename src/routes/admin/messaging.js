// Admin two-way SMS: conversation inbox + send. UI lives in the messaging view.
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { asyncHandler, badRequest, notFound, toInt } from '../../lib/http.js';
import { query, queryOne } from '../../lib/db.js';
import { sendSms, isSmsConfigured } from '../../lib/sms.js';
import { ownsId } from '../../lib/ownership.js';
import { requireWrite } from '../../lib/permissions.js';

const router = express.Router();
router.use(requireAdmin());
router.use(requireWrite('messaging.use'));

router.get('/meta', asyncHandler(async (req, res) => {
  res.json({ ok: true, configured: isSmsConfigured(req.tenant), fromNumber: req.tenant.settings.integrations.sms?.fromNumber || '' });
}));

router.get('/conversations', asyncHandler(async (req, res) => {
  const rows = await query(
    `SELECT c.id, c.phone_e164, c.unread_count, c.last_message_at, c.status, cu.name AS customer_name, cu.id AS customer_id,
            (SELECT body FROM sms_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
            (SELECT direction FROM sms_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_dir
       FROM sms_conversations c LEFT JOIN customers cu ON cu.id=c.customer_id
      WHERE c.tenant_id=$1 ORDER BY c.last_message_at DESC NULLS LAST LIMIT 200`,
    [req.tenant.id],
  );
  const totalUnread = rows.rows.reduce((s, r) => s + (r.unread_count || 0), 0);
  res.json({ ok: true, conversations: rows.rows, totalUnread, configured: isSmsConfigured(req.tenant) });
}));

router.get('/conversations/:id', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const convo = await queryOne(
    `SELECT c.*, cu.name AS customer_name FROM sms_conversations c LEFT JOIN customers cu ON cu.id=c.customer_id WHERE c.tenant_id=$1 AND c.id=$2`,
    [req.tenant.id, id],
  );
  if (!convo) return notFound(res);
  const messages = await query('SELECT id, direction, body, media, status, purpose, created_at, created_by FROM sms_messages WHERE conversation_id=$1 ORDER BY created_at', [id]);
  await query('UPDATE sms_conversations SET unread_count=0 WHERE id=$1', [id]);
  res.json({ ok: true, conversation: convo, messages: messages.rows });
}));

router.post('/conversations/:id/read', asyncHandler(async (req, res) => {
  await query('UPDATE sms_conversations SET unread_count=0 WHERE tenant_id=$1 AND id=$2', [req.tenant.id, toInt(req.params.id)]);
  res.json({ ok: true });
}));

router.post('/send', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.body) return badRequest(res, 'Message body is required.');
  let to = b.to; let customerId = toInt(b.customerId);
  if (b.conversationId) {
    const c = await queryOne('SELECT phone_e164, customer_id FROM sms_conversations WHERE tenant_id=$1 AND id=$2', [req.tenant.id, toInt(b.conversationId)]);
    if (!c) return notFound(res);
    to = c.phone_e164; customerId = c.customer_id || customerId;
  }
  if (customerId && !(await ownsId(req.tenant.id, 'customers', customerId))) return badRequest(res, 'Unknown customer.');
  if (!to) return badRequest(res, 'A recipient phone number is required.');
  const r = await sendSms(req.tenant, { to, body: b.body, customerId, purpose: b.purpose || 'conversational', createdBy: req.admin.username });
  if (!r.ok && r.reason === 'opted_out') return badRequest(res, 'This contact has opted out of texts.');
  if (!r.ok) return badRequest(res, r.error || 'Could not send.');
  res.json({ ok: true, status: r.status });
}));

export default router;
