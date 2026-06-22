-- 0018_documents.sql — document/template library + e-signature. Templates carry
-- {{MERGE}} fields; a sent document snapshots the rendered body (immutable) and
-- captures a clickwrap/typed (and optional drawn) signature.
CREATE TABLE IF NOT EXISTS document_templates (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  body               TEXT NOT NULL DEFAULT '',
  requires_signature BOOLEAN NOT NULL DEFAULT TRUE,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_doctpl_tenant ON document_templates (tenant_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS documents (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id         BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  appointment_id      BIGINT REFERENCES appointments(id) ON DELETE SET NULL,
  template_id         BIGINT REFERENCES document_templates(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  body                TEXT NOT NULL,                 -- rendered snapshot (immutable)
  requires_signature  BOOLEAN NOT NULL DEFAULT TRUE,
  status              TEXT NOT NULL DEFAULT 'draft', -- draft|sent|signed|declined
  access_token        TEXT NOT NULL,
  sent_at             TIMESTAMPTZ,
  -- signature snapshot
  signed_at           TIMESTAMPTZ,
  signed_name         TEXT,
  signed_ip           TEXT,
  signed_user_agent   TEXT,
  signature_file_id   BIGINT REFERENCES files(id) ON DELETE SET NULL,
  declined_at         TIMESTAMPTZ,
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_tenant_status ON documents (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_documents_customer ON documents (customer_id);
