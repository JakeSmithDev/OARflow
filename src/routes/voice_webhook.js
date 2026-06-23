// Voice provider webhook (SCAFFOLD). Receives a provider's call event, verifies
// (stubbed), normalizes it, records a call_log, and runs the missed-call +
// handoff pipeline. No live telephony is connected.
import express from 'express';
import { asyncHandler, badRequest } from '../lib/http.js';
import { getDefaultTenant, getTenantById } from '../lib/tenants.js';
import { getVoiceProvider, recordCall, runMissedCallWorkflow } from '../lib/voice.js';

const router = express.Router();

router.post('/:provider', asyncHandler(async (req, res) => {
  const tenant = req.query.tenant ? await getTenantById(Number(req.query.tenant)).catch(() => null) || await getDefaultTenant() : await getDefaultTenant();
  if (!tenant) return badRequest(res, 'No tenant.');
  const provider = getVoiceProvider(tenant);
  if (!provider.verifyWebhook(req)) return res.status(401).json({ ok: false, error: 'Unverified webhook.' });
  const evt = provider.normalize(req.body || {});
  const { call, duplicate } = await recordCall(tenant, req.params.provider || provider.name || 'mock', evt);
  if (!duplicate) await runMissedCallWorkflow(tenant, call).catch(() => {});
  res.json({ ok: true, callId: call.id, handoff: call.handoff });
}));

export default router;
