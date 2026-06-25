// AI voice receptionist — SCAFFOLD ONLY. No live telephony/voice is implemented.
// This module defines the provider abstraction, the normalized call + booking-
// intake data model, the missed-call workflow, and the transfer/handoff rules,
// plus a mock call simulator so the whole pipeline is testable without any paid
// provider. Connecting Vapi/Retell/Twilio later means implementing the provider
// interface — callers below do not change.
import { query, queryOne } from './db.js';
import { config } from '../config.js';

export function voiceConfigured(tenant) {
  const v = tenant?.settings?.integrations?.voice || {};
  return Boolean(v.enabled && v.provider && v.provider !== 'none');
}
export function voiceStatus(tenant) {
  const v = tenant?.settings?.integrations?.voice || {};
  return { enabled: Boolean(v.enabled), provider: v.provider || 'none', live: false, scaffold: true, greeting: v.greeting || '' };
}

/**
 * The normalized booking-intake payload an AI receptionist produces. Stored on
 * call_logs.intent. Documented here so any provider maps onto the same shape.
 * @typedef {Object} BookingIntent
 * @property {('book'|'message'|'reschedule'|'question'|'unknown')} type
 * @property {string} [customerName]
 * @property {string} [phone]
 * @property {string} [address]
 * @property {string} [serviceRequested]
 * @property {string[]} [preferredTimes]
 * @property {('low'|'normal'|'urgent')} [urgency]
 * @property {string} [notes]
 */
export function emptyIntent() { return { type: 'unknown', preferredTimes: [], urgency: 'normal' }; }

/** Provider interface. Only the mock provider is functional in this scaffold. */
export function getVoiceProvider(tenant) {
  const name = tenant?.settings?.integrations?.voice?.provider || 'none';
  return {
    name,
    live: false, // scaffold: never live
    // Real providers would verify a signature here. Scaffold accepts in dev.
    verifyWebhook(/* req */) { return !config.isProduction || name === 'mock'; },
    // Map a raw provider webhook body to our normalized event.
    normalize(body = {}) {
      return {
        externalId: body.call_id || body.id || body.CallSid || null,
        direction: body.direction || 'inbound',
        from: body.from || body.From || body.caller || null,
        to: body.to || body.To || null,
        status: body.status || body.CallStatus || 'completed',
        durationSeconds: Number(body.duration || body.CallDuration || 0) || null,
        recordingUrl: body.recording_url || body.RecordingUrl || null,
        transcript: body.transcript || null,
        intent: body.intent || null,
      };
    },
  };
}

/** Heuristic intent extraction (placeholder for a real model/provider). */
export function deriveIntent(evt) {
  if (evt.intent && typeof evt.intent === 'object') return { ...emptyIntent(), ...evt.intent };
  const t = (evt.transcript || '').toLowerCase();
  const intent = emptyIntent();
  if (/book|schedule|appointment|come out|service/.test(t)) intent.type = 'book';
  else if (/reschedul|move|change/.test(t)) intent.type = 'reschedule';
  else if (/\?|question|how much|price/.test(t)) intent.type = 'question';
  else if (t) intent.type = 'message';
  if (/urgent|emergency|asap|right away|infestation/.test(t)) intent.urgency = 'urgent';
  if (evt.transcript) intent.notes = evt.transcript.slice(0, 500);
  return intent;
}

/** Evaluate transfer/handoff rules. Returns { handoff, reason }. */
export function evaluateHandoff(tenant, evt, intent) {
  const h = tenant.settings.integrations.voice.handoff || {};
  if (h.onUrgent && intent.urgency === 'urgent') return { handoff: true, reason: 'Urgent request' };
  if (h.onRequest && /agent|human|representative|person|manager/.test((evt.transcript || '').toLowerCase())) return { handoff: true, reason: 'Caller asked for a person' };
  return { handoff: false, reason: null };
}

async function matchCustomer(tenant, phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '').slice(-10);
  if (!digits) return null;
  return queryOne("SELECT id FROM customers WHERE tenant_id=$1 AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g') LIKE $2 LIMIT 1", [tenant.id, `%${digits}`]);
}

/** Persist a normalized call event (idempotent on provider+external_id). */
export async function recordCall(tenant, providerName, evt) {
  if (evt.externalId) {
    const dup = await queryOne('SELECT * FROM call_logs WHERE tenant_id=$1 AND provider=$2 AND external_id=$3', [tenant.id, providerName, evt.externalId]);
    if (dup) return { call: dup, duplicate: true };
  }
  const intent = deriveIntent(evt);
  const { handoff, reason } = evaluateHandoff(tenant, evt, intent);
  const customer = await matchCustomer(tenant, evt.from);
  const status = handoff ? 'transferred' : (evt.status || 'completed');
  const call = await queryOne(
    `INSERT INTO call_logs (tenant_id, provider, external_id, direction, from_number, to_number, status, duration_seconds, recording_url, transcript, intent, customer_id, handoff, handoff_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14) RETURNING *`,
    [tenant.id, providerName, evt.externalId || null, evt.direction || 'inbound', evt.from || null, evt.to || null, status,
     evt.durationSeconds || null, evt.recordingUrl || null, evt.transcript || null, JSON.stringify(intent), customer?.id || null, handoff, reason],
  );
  return { call, duplicate: false };
}

/** Missed-call / voicemail workflow: text the caller back + optional follow-up. */
export async function runMissedCallWorkflow(tenant, call) {
  if (!['missed', 'voicemail'].includes(call.status) || call.follow_up_sent) return { ran: false };
  const cfg = tenant.settings.integrations.voice.missedCall || {};
  let texted = false;
  if (cfg.textBack && call.from_number) {
    try {
      const { sendSms, isSmsConfigured } = await import('./sms.js');
      if (isSmsConfigured(tenant) || !config.isProduction) {
        const r = await sendSms(tenant, { to: call.from_number, body: cfg.message, customerId: call.customer_id, purpose: 'missed_call', idempotencyKey: `missedcall:${call.id}` });
        texted = r.ok !== false;
      }
    } catch { /* SMS not available */ }
  }
  if (cfg.createFollowUp) {
    try {
      await query(
        `INSERT INTO follow_ups (tenant_id, customer_id, title, due_at, status, channel)
         VALUES ($1,$2,$3, now(), 'pending','task')`,
        [tenant.id, call.customer_id, `Return missed call from ${call.from_number || 'unknown'}`],
      );
    } catch { /* follow_ups schema differences are non-fatal here */ }
  }
  await query('UPDATE call_logs SET follow_up_sent=TRUE WHERE id=$1', [call.id]);
  return { ran: true, texted };
}

/** Mock a call end-to-end so the pipeline is testable without a provider. */
export async function simulateCall(tenant, scenario = 'booking') {
  const base = { externalId: `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, direction: 'inbound', from: '+14105550199', to: tenant.contact_phone || '+14105551169', durationSeconds: 75 };
  let evt;
  if (scenario === 'missed') evt = { ...base, status: 'missed', durationSeconds: 0, transcript: null };
  else if (scenario === 'transfer') evt = { ...base, status: 'completed', transcript: 'This is urgent, I have a serious infestation and need to speak to a person right away.' };
  else evt = { ...base, status: 'completed', transcript: 'Hi, I would like to book a general pest control service for my house. Mornings work best.', intent: { type: 'book', customerName: 'Sample Caller', phone: base.from, serviceRequested: 'General Pest Control', preferredTimes: ['Weekday mornings'], urgency: 'normal' } };
  const { call } = await recordCall(tenant, 'mock', evt);
  const missed = await runMissedCallWorkflow(tenant, call);
  return { call, missed };
}

export async function listCalls(tenant, { limit = 50 } = {}) {
  const r = await query('SELECT * FROM call_logs WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT $2', [tenant.id, limit]);
  return r.rows;
}

export default {
  voiceConfigured, voiceStatus, getVoiceProvider, deriveIntent, evaluateHandoff,
  recordCall, runMissedCallWorkflow, simulateCall, listCalls, emptyIntent,
};
