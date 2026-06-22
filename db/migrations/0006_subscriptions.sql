-- 0006_subscriptions.sql — recurring revenue: a customer enrolled in a plan.

CREATE TABLE IF NOT EXISTS subscriptions (
  id                   BIGSERIAL PRIMARY KEY,
  tenant_id            BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id          BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  plan_id              BIGINT REFERENCES recurring_plans(id) ON DELETE SET NULL,

  status               TEXT NOT NULL DEFAULT 'active',  -- active | paused | canceled
  -- Snapshot of the plan terms at enrollment (so later plan edits don't rewrite history).
  interval             TEXT NOT NULL DEFAULT 'quarterly',
  interval_count       INTEGER NOT NULL DEFAULT 1,
  price_cents          INTEGER NOT NULL DEFAULT 0,
  service_type_id      BIGINT REFERENCES service_types(id) ON DELETE SET NULL,
  auto_schedule        BOOLEAN NOT NULL DEFAULT TRUE,
  auto_invoice         BOOLEAN NOT NULL DEFAULT TRUE,

  stripe_subscription_id TEXT,
  next_run_date        DATE,        -- next cycle to generate an appointment/invoice
  last_run_date        DATE,
  notes                TEXT,

  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  canceled_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_due ON subscriptions (tenant_id, status, next_run_date);
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions (customer_id);
