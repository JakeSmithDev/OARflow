-- 0019_compliance.sql — pest-control compliance: chemical/material catalog,
-- per-service application records (what was applied, where, by whom), and
-- applicator licensing on technicians. Supports state-report exports; we never
-- auto-submit to any agency.
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS license_no TEXT;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS license_state TEXT;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS license_expires DATE;

CREATE TABLE IF NOT EXISTS chemical_products (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  epa_reg_no         TEXT,
  active_ingredient  TEXT,
  signal_word        TEXT,                 -- Caution|Warning|Danger
  unit               TEXT NOT NULL DEFAULT 'oz',
  default_rate       TEXT,                 -- e.g. "0.5 oz/gal"
  target_pests       TEXT,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chem_products_tenant ON chemical_products (tenant_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS chemical_applications (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appointment_id     BIGINT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  product_id         BIGINT REFERENCES chemical_products(id) ON DELETE SET NULL,
  technician_id      BIGINT REFERENCES technicians(id) ON DELETE SET NULL,
  -- snapshot product fields so a record stays accurate even if the catalog changes
  product_name       TEXT NOT NULL,
  epa_reg_no         TEXT,
  active_ingredient  TEXT,
  target_pest        TEXT,
  area_treated       TEXT,
  rate               TEXT,
  quantity           NUMERIC(12,3),
  unit               TEXT,
  method             TEXT,                 -- spray|granular|bait|dust|fog…
  location_notes     TEXT,
  applicator_name    TEXT,
  applicator_license TEXT,
  applied_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chem_appl_tenant_date ON chemical_applications (tenant_id, applied_at);
CREATE INDEX IF NOT EXISTS idx_chem_appl_appt ON chemical_applications (appointment_id);
