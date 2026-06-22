-- 0011_files_permissions.sql — file storage records + granular capabilities.

CREATE TABLE IF NOT EXISTS files (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_type    TEXT,                         -- appointment|customer|quote|document|job|tenant
  owner_id      BIGINT,
  kind          TEXT,                         -- photo|document|signature|attachment|logo|report
  filename      TEXT NOT NULL,
  content_type  TEXT,
  size_bytes    BIGINT,
  storage_driver TEXT NOT NULL DEFAULT 'local', -- local|s3
  storage_key   TEXT NOT NULL,
  access_token  TEXT NOT NULL,
  meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_files_owner ON files (tenant_id, owner_type, owner_id);

-- Per-user capability overrides on top of role defaults ('*' = everything).
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '[]'::jsonb;
