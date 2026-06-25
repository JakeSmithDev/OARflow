-- 0021_voice.sql — AI voice receptionist SCAFFOLD. Stores call logs, transcripts,
-- and a normalized booking-intake "intent" payload. NO live telephony is wired;
-- this captures the data model + webhook surface so a provider (Vapi/Retell/
-- Twilio) can be connected later without schema changes.
CREATE TABLE IF NOT EXISTS call_logs (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL DEFAULT 'mock',  -- mock|vapi|retell|twilio
  external_id      TEXT,                          -- provider call id (idempotency)
  direction        TEXT NOT NULL DEFAULT 'inbound', -- inbound|outbound
  from_number      TEXT,
  to_number        TEXT,
  status           TEXT NOT NULL DEFAULT 'received', -- received|completed|missed|voicemail|transferred
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ,
  duration_seconds INTEGER,
  recording_url    TEXT,
  transcript       TEXT,
  intent           JSONB NOT NULL DEFAULT '{}'::jsonb, -- booking-intake payload
  customer_id      BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  appointment_id   BIGINT REFERENCES appointments(id) ON DELETE SET NULL,
  handoff          BOOLEAN NOT NULL DEFAULT FALSE,
  handoff_reason   TEXT,
  follow_up_sent   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_provider_ext ON call_logs (provider, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calls_tenant_time ON call_logs (tenant_id, started_at DESC);
