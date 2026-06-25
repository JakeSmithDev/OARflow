-- 0023_commissions.sql — technician/salesperson commission rules + accruals.
CREATE TABLE IF NOT EXISTS commission_rules (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  technician_id   BIGINT REFERENCES technicians(id) ON DELETE CASCADE, -- NULL = all techs
  service_type_id BIGINT REFERENCES service_types(id) ON DELETE CASCADE, -- NULL = all services
  basis           TEXT NOT NULL DEFAULT 'revenue', -- revenue|collected|flat
  percent         NUMERIC(6,3) NOT NULL DEFAULT 0,
  flat_cents      INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comm_rules_tenant ON commission_rules (tenant_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS commission_entries (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id        BIGINT REFERENCES commission_rules(id) ON DELETE SET NULL,
  technician_id  BIGINT NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
  appointment_id BIGINT REFERENCES appointments(id) ON DELETE SET NULL,
  invoice_id     BIGINT REFERENCES invoices(id) ON DELETE SET NULL,
  basis          TEXT NOT NULL,
  basis_cents    INTEGER NOT NULL DEFAULT 0,
  amount_cents   INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'accrued', -- accrued|paid
  dedupe_key     TEXT NOT NULL,
  note           TEXT,
  accrued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_entries_dedupe ON commission_entries (tenant_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_comm_entries_tech ON commission_entries (tenant_id, technician_id, status);
