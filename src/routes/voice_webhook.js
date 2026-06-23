// Voice provider webhook (SCAFFOLD). Receives a provider's call event, verifies
// (stubbed), normalizes it, records a call_log, and runs the missed-call +
// handoff pipeline. No live telephony is connected.
import express from 'express';
import { asyncHandler, badRequest } from '../lib/http.js';
import { getDefaultTenant, getTenantById } from '../lib/tenants.js';
import { getVoiceProvider, recordCall, runMissedCallWorkflow } from '../lib/voice.js';
import { config } from '../config.js';

const router = express.Router();

router.post('/:provider', asyncHandler(async (req, res) => {
  // SCAFFOLD: resolve the tenant from the deployment default. The client-supplied
  // ?tenant override is honored ONLY in non-production (local testing); a live
  // provider integration would resolve the tenant from a verified signature.
  const tenant = (!config.isProduction && req.query.tenant)
    ? (await getTenantById(Number(req.query.tenant)).catch(() => null)) || await getDefaultTenant()
    : await getDefaultTenant();
  if (!tenant) return badRequest(res, 'No tenant.');
  const provider = getVoiceProvider(tenant);
  if (!provider.verifyWebhook(req)) return res.status(401).json({ ok: false, error: 'Unverified webhook.' });
  const evt = provider.normalize(req.body || {});
  const { call, duplicate } = await recordCall(tenant, req.params.provider || provider.name || 'mock', evt);
  if (!duplicate) await runMissedCallWorkflow(tenant, call).catch(() => {});
  res.json({ ok: true, callId: call.id, handoff: call.handoff });
}));

export default router;
