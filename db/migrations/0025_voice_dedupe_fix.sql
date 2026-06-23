-- 0025_voice_dedupe_fix.sql — make the call idempotency key tenant-scoped so a
-- provider call id in one tenant can never collide with or read another tenant's.
DROP INDEX IF EXISTS idx_calls_provider_ext;
CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_tenant_provider_ext
  ON call_logs (tenant_id, provider, external_id) WHERE external_id IS NOT NULL;
