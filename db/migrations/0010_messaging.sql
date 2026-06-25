-- 0010_messaging.sql — SMS/MMS messaging substrate (provider-agnostic).
-- BYO per-tenant credentials (default) or platform-managed later. Compliance
-- fields for 10DLC/A2P; consent + opt-out tracking; two-way conversations.

CREATE TABLE IF NOT EXISTS tenant_phone_numbers (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL DEFAULT 'twilio',
  phone_e164          TEXT NOT NULL,
  capabilities        JSONB NOT NULL DEFAULT '{"sms":true,"mms":false,"voice":false}'::jsonb,
  credential_mode     TEXT NOT NULL DEFAULT 'byo',     -- byo | platform
  provider_account_ref TEXT,
  messaging_service_sid TEXT,
  a2p_brand_id        TEXT,
  a2p_campaign_id     TEXT,
  registration_status TEXT NOT NULL DEFAULT 'not_started', -- not_started|pending|approved|rejected
  is_default          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_e164)
);

CREATE TABLE IF NOT EXISTS customer_contact_consents (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id       BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  channel           TEXT NOT NULL DEFAULT 'sms',       -- sms | email
  address           TEXT NOT NULL,                     -- phone E.164 or email
  purpose           TEXT NOT NULL DEFAULT 'transactional', -- transactional|marketing|review
  status            TEXT NOT NULL DEFAULT 'unknown',   -- opted_in|opted_out|unknown
  source            TEXT,                              -- booking_form|admin|inbound_keyword|import
  consent_text      TEXT,
  captured_ip       TEXT,
  captured_user_agent TEXT,
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_consents_lookup ON customer_contact_consents (tenant_id, channel, address);

CREATE TABLE IF NOT EXISTS sms_conversations (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id     BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  phone_e164      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',         -- open | closed
  unread_count    INTEGER NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  last_inbound_at TIMESTAMPTZ,
  assigned_user_id BIGINT REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_e164)
);
CREATE INDEX IF NOT EXISTS idx_sms_convos_tenant ON sms_conversations (tenant_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS sms_messages (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id    BIGINT REFERENCES sms_conversations(id) ON DELETE CASCADE,
  customer_id        BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  direction          TEXT NOT NULL,                      -- outbound | inbound
  body               TEXT NOT NULL DEFAULT '',
  media              JSONB NOT NULL DEFAULT '[]'::jsonb,
  appointment_id     BIGINT REFERENCES appointments(id) ON DELETE SET NULL,
  invoice_id         BIGINT REFERENCES invoices(id) ON DELETE SET NULL,
  provider           TEXT,
  provider_message_id TEXT,
  status             TEXT NOT NULL DEFAULT 'queued',     -- queued|sent|delivered|failed|received|suppressed
  error_code         TEXT,
  purpose            TEXT,
  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sms_messages_convo ON sms_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sms_messages_tenant ON sms_messages (tenant_id, created_at DESC);
