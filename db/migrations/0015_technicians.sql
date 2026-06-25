-- 0015_technicians.sql — technicians (field staff) + per-appointment assignment.
-- Public booking NEVER selects a technician; assignment is an internal dispatch
-- action. Multiple techs per job are supported (one lead + helpers).
CREATE TABLE IF NOT EXISTS technicians (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  color         TEXT NOT NULL DEFAULT '#2563eb',
  -- optional link to an admin_users row so a tech can sign into the field PWA
  user_id       BIGINT REFERENCES admin_users(id) ON DELETE SET NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  -- per-tech field-app token (for the technician PWA, set lazily)
  field_token   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_techs_tenant ON technicians (tenant_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS appointment_assignments (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appointment_id  BIGINT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  technician_id   BIGINT NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
  is_lead         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assign_unique ON appointment_assignments (appointment_id, technician_id);
CREATE INDEX IF NOT EXISTS idx_assign_tech ON appointment_assignments (technician_id);
CREATE INDEX IF NOT EXISTS idx_assign_appt ON appointment_assignments (appointment_id);
