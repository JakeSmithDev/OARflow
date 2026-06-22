-- 0009_events_jobs.sql — durable event log + idempotency keys.
-- Postgres remains the source of truth for business records and audit history.
-- Inngest (when configured) handles scheduling/retries/orchestration; in dev the
-- in-process fallback runs handlers inline. Both paths record here.

CREATE TABLE IF NOT EXISTS event_log (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT REFERENCES tenants(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  source     TEXT,                          -- inngest | local | api
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_log_tenant ON event_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_name ON event_log (name, created_at DESC);

-- Generic idempotency guard: a key is consumed at most once per tenant, so a
-- retried job never double-sends an SMS or double-creates an invoice.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id  BIGINT NOT NULL,
  key        TEXT NOT NULL,
  result     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- Optional audit of background work (run outcomes) for observability.
CREATE TABLE IF NOT EXISTS job_runs (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT,
  workflow    TEXT NOT NULL,
  event_name  TEXT,
  status      TEXT NOT NULL DEFAULT 'ok',   -- ok | error
  detail      JSONB,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_runs_tenant ON job_runs (tenant_id, created_at DESC);
