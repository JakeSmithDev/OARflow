-- 0024_properties.sql — multi-unit properties (buildings) + units with a simple
-- diagram (annotation markers over an optional floorplan image). Devices (0020)
-- already carry an optional unit_id; appointments gain optional property/unit.
CREATE TABLE IF NOT EXISTS properties (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id  BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  address      TEXT, city TEXT, state TEXT, postal_code TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_properties_customer ON properties (customer_id);

CREATE TABLE IF NOT EXISTS units (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  property_id       BIGINT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  label             TEXT NOT NULL,
  floor             TEXT,
  notes             TEXT,
  diagram           JSONB NOT NULL DEFAULT '{"markers":[]}'::jsonb, -- [{x,y,label,deviceId}]
  floorplan_file_id BIGINT REFERENCES files(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_units_property ON units (property_id);

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS property_id BIGINT REFERENCES properties(id) ON DELETE SET NULL;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS unit_id BIGINT REFERENCES units(id) ON DELETE SET NULL;
