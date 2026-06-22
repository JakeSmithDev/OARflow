-- 0017_routing.sql — optional geocodes for route optimization. Coordinates are
-- only populated when a geocoding provider is configured; the multi-stop map
-- link works from raw addresses even without them.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_lat NUMERIC(9,6);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_lng NUMERIC(9,6);
