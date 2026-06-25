-- 0026_field_token_hash.sql — store only a HASH of the technician field-app token
-- (like API keys), with rotation + optional expiry. The plaintext token lives
-- only in the link handed to the tech.
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS field_token_hash TEXT;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS field_token_expires TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_techs_field_hash ON technicians (field_token_hash) WHERE field_token_hash IS NOT NULL;
-- Legacy plaintext column is no longer written; drop its data so a stale token
-- can't be used. (Pre-launch: no production tokens exist yet.)
UPDATE technicians SET field_token=NULL WHERE field_token IS NOT NULL;
