-- 0002_catalog.sql — what a tenant sells and when they're available.

-- Services a customer can book ("schedule someone to come out"). There is no
-- public technician selection — only services and time slots. booking_mode:
--   instant  → customer books a specific open slot, confirmed immediately
--   request  → customer proposes up to N preferred slots; staff confirm one
--   default  → inherit the tenant's default booking mode
CREATE TABLE IF NOT EXISTS service_types (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 60 CHECK (duration_minutes > 0),
  base_price_cents INTEGER NOT NULL DEFAULT 0 CHECK (base_price_cents >= 0),
  deposit_cents    INTEGER NOT NULL DEFAULT 0 CHECK (deposit_cents >= 0),
  booking_mode     TEXT NOT NULL DEFAULT 'default',
  color            TEXT NOT NULL DEFAULT '#2563eb',
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_service_types_tenant ON service_types (tenant_id, is_active);

-- Customizable, preselected invoice line items (the "preselected options" that
-- make building an invoice fast). Staff pick from these and/or add custom lines.
CREATE TABLE IF NOT EXISTS line_item_presets (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label               TEXT NOT NULL,
  description         TEXT,
  default_amount_cents INTEGER NOT NULL DEFAULT 0,
  taxable             BOOLEAN NOT NULL DEFAULT TRUE,
  category            TEXT,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_line_item_presets_tenant ON line_item_presets (tenant_id, is_active);

-- Recurring revenue plan templates (e.g. Quarterly Pest Control, Annual Plan).
CREATE TABLE IF NOT EXISTS recurring_plans (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  interval        TEXT NOT NULL DEFAULT 'quarterly', -- monthly|quarterly|semiannual|annual|custom
  interval_count  INTEGER NOT NULL DEFAULT 1,         -- months between visits when interval='custom'
  price_cents     INTEGER NOT NULL DEFAULT 0,
  service_type_id BIGINT REFERENCES service_types(id) ON DELETE SET NULL,
  auto_schedule   BOOLEAN NOT NULL DEFAULT TRUE,      -- auto-create the appointment each cycle
  auto_invoice    BOOLEAN NOT NULL DEFAULT TRUE,      -- auto-create the invoice each cycle
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recurring_plans_tenant ON recurring_plans (tenant_id, is_active);

-- One-off unavailable windows (holidays, full days, time blocks).
CREATE TABLE IF NOT EXISTS blackouts (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_blackouts_tenant_time ON blackouts (tenant_id, starts_at, ends_at);

-- Per-date overrides of the weekly availability (custom hours / closures / capacity).
CREATE TABLE IF NOT EXISTS schedule_overrides (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_date DATE NOT NULL,
  is_closed    BOOLEAN NOT NULL DEFAULT FALSE,
  hours_json   JSONB,           -- [{ "start": "09:00", "end": "17:00" }] or null to inherit
  capacity     INTEGER,         -- override concurrent-job capacity for the day
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_overrides_tenant_date
  ON schedule_overrides (tenant_id, service_date);
