-- 0001_core.sql — tenants, admin auth, audit, rate limiting, email.
-- OARFlow is multi-tenant from the ground up: every domain row carries a
-- tenant_id so the platform can be resold to additional companies.

CREATE TABLE IF NOT EXISTS tenants (
  id            BIGSERIAL PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  timezone      TEXT NOT NULL DEFAULT 'America/New_York',
  currency      TEXT NOT NULL DEFAULT 'USD',
  contact_email TEXT,
  contact_phone TEXT,
  address       TEXT,
  -- All tunable configuration lives here: branding, booking rules, availability,
  -- invoicing defaults, follow-up rules, and integration credentials.
  settings      JSONB NOT NULL DEFAULT '{}'::jsonb,
  invoice_seq   BIGINT NOT NULL DEFAULT 1000,
  config_version BIGINT NOT NULL DEFAULT 1,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_users (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  username        TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  display_name    TEXT,
  role            TEXT NOT NULL DEFAULT 'owner',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  totp_secret     TEXT,
  is_totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  totp_enabled_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_tenant_username
  ON admin_users (tenant_id, lower(username));

CREATE TABLE IF NOT EXISTS admin_sessions (
  id                 BIGSERIAL PRIMARY KEY,
  admin_user_id      BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  tenant_id          BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_token_hash TEXT NOT NULL UNIQUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions (admin_user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT REFERENCES tenants(id) ON DELETE CASCADE,
  admin_username TEXT,
  action         TEXT NOT NULL,
  entity_type    TEXT,
  entity_id      BIGINT,
  details        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  id         BIGSERIAL PRIMARY KEY,
  ip         TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup ON rate_limits (ip, endpoint, created_at);

-- A durable record of every email the system sends (and, in dev, the body).
CREATE TABLE IF NOT EXISTS email_outbox (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT REFERENCES tenants(id) ON DELETE SET NULL,
  to_email     TEXT NOT NULL,
  subject      TEXT NOT NULL,
  html         TEXT,
  text         TEXT,
  status       TEXT NOT NULL DEFAULT 'queued',  -- queued | sent | failed | suppressed
  provider     TEXT,
  error        TEXT,
  related_type TEXT,
  related_id   BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_email_outbox_tenant ON email_outbox (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS email_templates (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  subject    TEXT NOT NULL,
  html       TEXT,
  text       TEXT,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_templates_tenant_type
  ON email_templates (tenant_id, type);
