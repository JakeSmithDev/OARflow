-- 0012_estimates.sql — quotes/estimates that a customer can accept online and
-- that convert to a job + invoice. Mirrors the invoice model + clickwrap accept.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS estimate_seq BIGINT NOT NULL DEFAULT 1000;

CREATE TABLE IF NOT EXISTS estimates (
  id                   BIGSERIAL PRIMARY KEY,
  tenant_id            BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id          BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  service_type_id      BIGINT REFERENCES service_types(id) ON DELETE SET NULL,
  number               TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft', -- draft|sent|accepted|declined|expired|converted
  currency             TEXT NOT NULL DEFAULT 'USD',
  line_items           JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal_cents       INTEGER NOT NULL DEFAULT 0,
  discount_cents       INTEGER NOT NULL DEFAULT 0,
  tax_rate_percent     NUMERIC(6,3) NOT NULL DEFAULT 0,
  tax_cents            INTEGER NOT NULL DEFAULT 0,
  total_cents          INTEGER NOT NULL DEFAULT 0,
  notes                TEXT,
  terms                TEXT,
  valid_until          DATE,
  access_token         TEXT NOT NULL,
  -- clickwrap acceptance snapshot
  accepted_at          TIMESTAMPTZ,
  accepted_name        TEXT,
  accepted_ip          TEXT,
  accepted_user_agent  TEXT,
  declined_at          TIMESTAMPTZ,
  converted_invoice_id BIGINT REFERENCES invoices(id) ON DELETE SET NULL,
  converted_appointment_id BIGINT REFERENCES appointments(id) ON DELETE SET NULL,
  created_by           TEXT,
  sent_at              TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_estimates_tenant_number ON estimates (tenant_id, number);
CREATE INDEX IF NOT EXISTS idx_estimates_tenant_status ON estimates (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_estimates_customer ON estimates (customer_id);
