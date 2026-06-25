// Admin AI receptionist (SCAFFOLD): status, settings, call logs, mock simulation.
import express from 'express';
import { requireAdmin, requireRole } from '../../lib/auth.js';
import { asyncHandler, badRequest, notFound, toInt } from '../../lib/http.js';
import { queryOne } from '../../lib/db.js';
import { updateTenantSettings } from '../../lib/tenants.js';
import { encryptSecret } from '../../lib/crypto.js';
import { voiceStatus, listCalls, simulateCall } from '../../lib/voice.js';
import { logAudit } from '../../lib/audit.js';

const router = express.Router();
router.use(requireAdmin());

function publicVoiceSettings(v = {}) {
  // Never return secrets to the client.
  return {
    provider: v.provider || 'none', enabled: Boolean(v.enabled), aiProvider: v.aiProvider || 'none',
    fromNumber: v.fromNumber || '', greeting: v.greeting || '', transcripts: v.transcripts !== false,
    handoff: v.handoff || {}, missedCall: v.missedCall || {},
    hasCredentials: Boolean(v.authToken), // API key / auth token is the secret
  };
}

router.get('/', asyncHandler(async (req, res) => {
  res.json({
    ok: true,
    status: voiceStatus(req.tenant),
    settings: publicVoiceSettings(req.tenant.settings.integrations.voice),
    calls: await listCalls(req.tenant, { limit: 50 }),
  });
}));

router.get('/calls/:id', asyncHandler(async (req, res) => {
  const call = await queryOne('SELECT * FROM call_logs WHERE tenant_id=$1 AND id=$2', [req.tenant.id, toInt(req.params.id)]);
  if (!call) return notFound(res);
  res.json({ ok: true, call });
}));

// Mock a call through the full pipeline (no provider needed).
router.post('/simulate', asyncHandler(async (req, res) => {
  const scenario = ['booking', 'missed', 'transfer'].includes((req.body || {}).scenario) ? req.body.scenario : 'booking';
  const r = await simulateCall(req.tenant, scenario);
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'voice_simulate', details: { scenario } });
  res.json({ ok: true, ...r });
}));

// Update receptionist settings (owner only; encrypts the auth token at rest).
router.put('/settings', requireRole('owner'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const patch = { integrations: { voice: {} } };
  const v = patch.integrations.voice;
  for (const k of ['provider', 'enabled', 'aiProvider', 'fromNumber', 'greeting', 'transcripts', 'accountSid']) if (b[k] !== undefined) v[k] = b[k];
  if (b.authToken) v.authToken = encryptSecret(b.authToken);
  if (b.handoff) v.handoff = b.handoff;
  if (b.missedCall) v.missedCall = b.missedCall;
  await updateTenantSettings(req.tenant.id, patch);
  await logAudit({ tenantId: req.tenant.id, adminUsername: req.admin.username, action: 'voice_settings_update' });
  res.json({ ok: true });
}));

export default router;
