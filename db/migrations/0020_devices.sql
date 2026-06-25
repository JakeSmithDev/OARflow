-- 0020_devices.sql — devices / traps / bait stations + QR-scannable inspections.
CREATE TABLE IF NOT EXISTS devices (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id    BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  unit_id        BIGINT,                       -- optional multi-unit link (P3f)
  label          TEXT NOT NULL,
  device_type    TEXT NOT NULL DEFAULT 'bait_station', -- bait_station|trap|monitor|sensor
  serial         TEXT,
  qr_token       TEXT NOT NULL,
  location_notes TEXT,
  status         TEXT NOT NULL DEFAULT 'active', -- active|removed
  installed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_qr ON devices (qr_token);
CREATE INDEX IF NOT EXISTS idx_devices_customer ON devices (customer_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS device_inspections (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id      BIGINT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  appointment_id BIGINT REFERENCES appointments(id) ON DELETE SET NULL,
  technician_id  BIGINT REFERENCES technicians(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'ok',   -- ok|activity|serviced|damaged|missing
  activity_level TEXT,                          -- none|low|moderate|high
  action_taken   TEXT,
  notes          TEXT,
  inspected_by   TEXT,
  inspected_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_devinsp_device ON device_inspections (device_id, inspected_at DESC);
