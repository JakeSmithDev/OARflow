-- 0014_reviews.sql — review / NPS requests + responses. We ask every customer
-- (no rating-gating); the public-review platform links are shown regardless of
-- the private score they leave us.
CREATE TABLE IF NOT EXISTS review_requests (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id       BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  appointment_id    BIGINT REFERENCES appointments(id) ON DELETE SET NULL,
  channel           TEXT NOT NULL DEFAULT 'email',  -- email|sms
  status            TEXT NOT NULL DEFAULT 'pending', -- pending|sent|responded|skipped
  access_token      TEXT NOT NULL,
  send_after        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ,
  -- response
  rating            INTEGER,                         -- 1..5
  comment           TEXT,
  platform_clicked  TEXT,                            -- google|yelp|facebook
  responded_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reviews_tenant_status ON review_requests (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_reviews_due ON review_requests (status, send_after) WHERE status='pending';
-- one review request per appointment (idempotent automation)
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_appt ON review_requests (appointment_id) WHERE appointment_id IS NOT NULL;
