-- 0003_customers.sql — the CRM record. One row per customer per tenant.

CREATE TABLE IF NOT EXISTS customers (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  email             TEXT,
  phone             TEXT,
  address           TEXT,
  city              TEXT,
  state             TEXT,
  postal_code       TEXT,
  notes             TEXT,
  tags              JSONB NOT NULL DEFAULT '[]'::jsonb,
  stripe_customer_id TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customers_tenant_email ON customers (tenant_id, lower(email));
CREATE INDEX IF NOT EXISTS idx_customers_tenant_name ON customers (tenant_id, lower(name));
