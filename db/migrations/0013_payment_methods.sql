-- 0013_payment_methods.sql — saved cards / charge-on-file. Stores a tokenized
-- payment method (never the PAN) plus an immutable authorization snapshot, so a
-- business can charge an invoice to a card the customer put on file.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS card_token TEXT; -- guards the hosted save-card link

CREATE TABLE IF NOT EXISTS payment_methods (
  id                   BIGSERIAL PRIMARY KEY,
  tenant_id            BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id          BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL DEFAULT 'stripe',
  provider_pm_id       TEXT NOT NULL,            -- Stripe payment_method id (or mock_ in dev)
  provider_customer_id TEXT,                     -- Stripe customer id
  brand                TEXT,                     -- visa, mastercard, amex…
  last4                TEXT,
  exp_month            INTEGER,
  exp_year             INTEGER,
  is_default           BOOLEAN NOT NULL DEFAULT FALSE,
  is_mock              BOOLEAN NOT NULL DEFAULT FALSE,
  status               TEXT NOT NULL DEFAULT 'active', -- active|removed
  -- authorization snapshot (card-on-file consent)
  consent_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  consent_name        TEXT,
  consent_ip          TEXT,
  consent_user_agent  TEXT,
  consent_source      TEXT NOT NULL DEFAULT 'in_person', -- in_person|online
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_tenant_provider ON payment_methods (tenant_id, provider_pm_id);
CREATE INDEX IF NOT EXISTS idx_pm_customer ON payment_methods (customer_id) WHERE status='active';
-- at most one default per customer
CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_one_default ON payment_methods (customer_id) WHERE is_default AND status='active';
