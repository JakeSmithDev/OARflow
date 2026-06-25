-- 0016_portal.sql — customer self-service portal access (magic-link token).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS portal_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_portal_token ON customers (portal_token) WHERE portal_token IS NOT NULL;
