// Event/job substrate. Inngest (when configured) handles scheduling, retries,
// delays, and orchestration; when it isn't, an in-process fallback runs the same
// handlers inline so OARFlow works fully keyless in dev/demo. Postgres is the
// source of truth (event_log, idempotency_keys, job_runs).
import { Inngest } from 'inngest';
import { config, inngestConfigured } from '../config.js';
import { query } from './db.js';

export const inngest = new Inngest({ id: 'oarflow', eventKey: config.inngest.eventKey || undefined });

const localRegistry = {};        // eventName -> [handlerFn]
export const inngestFunctions = []; // Inngest function objects for the serve endpoint

// A minimal shim of the Inngest `step` API used by the in-process fallback.
function makeLocalStep() {
  return {
    run: async (_id, fn) => fn(),
    sleep: async () => {},
    sleepUntil: async () => {},
    waitForEvent: async () => null,
    sendEvent: async (_id, payload) => {
      const list = Array.isArray(payload) ? payload : [payload];
      for (const e of list) await emitEvent(e.name, e.data, { source: 'local' });
    },
  };
}

/**
 * Register a workflow once. It becomes an Inngest function (production) and is
 * also wired into the in-process fallback (dev). `trigger` is { event } or { cron }.
 */
export function defineWorkflow({ id, trigger, fn }) {
  // Inngest v4: triggers live in the first argument.
  const inngestFn = inngest.createFunction({ id, retries: 3, triggers: [trigger] }, fn);
  inngestFunctions.push(inngestFn);
  if (trigger && trigger.event) (localRegistry[trigger.event] ||= []).push(fn);
  return inngestFn;
}

/** Emit a domain event. Sent to Inngest when configured; else handlers run inline. */
export async function emitEvent(name, data = {}, { source } = {}) {
  const tenantId = data.tenantId ?? data.tenant_id ?? null;
  await query(
    'INSERT INTO event_log (tenant_id, name, data, source) VALUES ($1,$2,$3::jsonb,$4)',
    [tenantId, name, JSON.stringify(data), source || (inngestConfigured() ? 'inngest' : 'local')],
  ).catch(() => {});

  // Fan out to any tenant-configured outbound webhooks (best-effort, isolated).
  if (tenantId) import('./webhooks.js').then(({ enqueue }) => enqueue(tenantId, name, data)).catch(() => {});

  if (inngestConfigured()) {
    try { await inngest.send({ name, data }); }
    catch (e) { console.error('inngest send failed:', e.message); }
    return { dispatched: 'inngest' };
  }

  const handlers = localRegistry[name] || [];
  for (const fn of handlers) {
    try { await fn({ event: { name, data }, step: makeLocalStep(), logger: console }); }
    catch (e) {
      console.error(`local workflow for "${name}" failed:`, e.message);
      await query('INSERT INTO job_runs (tenant_id, workflow, event_name, status, error) VALUES ($1,$2,$3,$4,$5)',
        [tenantId, name, name, 'error', e.message]).catch(() => {});
    }
  }
  return { dispatched: 'local', handlers: handlers.length };
}

/** Run `fn` at most once per (tenant, key) — guards against double-sends/creates. */
export async function oncePerKey(tenantId, key, fn) {
  const ins = await query(
    'INSERT INTO idempotency_keys (tenant_id, key) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING key',
    [tenantId, key],
  );
  if (!ins.rows.length) return { ran: false };
  const result = await fn();
  if (result !== undefined) {
    await query('UPDATE idempotency_keys SET result=$3::jsonb WHERE tenant_id=$1 AND key=$2',
      [tenantId, key, JSON.stringify(result)]).catch(() => {});
  }
  return { ran: true, result };
}

export async function recordJobRun(tenantId, workflow, detail) {
  await query('INSERT INTO job_runs (tenant_id, workflow, status, detail) VALUES ($1,$2,$3,$4::jsonb)',
    [tenantId ?? null, workflow, 'ok', JSON.stringify(detail || {})]).catch(() => {});
}

export default { inngest, defineWorkflow, emitEvent, oncePerKey, recordJobRun, inngestFunctions };
