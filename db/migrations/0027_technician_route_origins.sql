-- 0027_technician_route_origins.sql — optional per-rep route starting points.
-- A NULL address means the technician starts at the tenant's business address.
-- Coordinates are a server-managed geocoding cache for a custom address.
ALTER TABLE technicians
  ADD COLUMN IF NOT EXISTS route_start_address TEXT,
  ADD COLUMN IF NOT EXISTS route_start_lat NUMERIC(9,6) CHECK (route_start_lat BETWEEN -90 AND 90),
  ADD COLUMN IF NOT EXISTS route_start_lng NUMERIC(9,6) CHECK (route_start_lng BETWEEN -180 AND 180);
