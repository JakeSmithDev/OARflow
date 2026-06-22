-- 0007_followups.sql — follow-up tasks & automations.
--
-- Follow-up *rules* (when to create follow-ups) live in tenants.settings.followups
-- so they're fully editable in the admin suite. This table holds the concrete
-- follow-up *instances* that show up in the staff queue and may send an email.

CREATE TABLE IF NOT EXISTS follow_ups (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id    BIGINT REFERENCES customers(id) ON DELETE CASCADE,
  appointment_id BIGINT REFERENCES appointments(id) ON DELETE SET NULL,
  subscription_id BIGINT REFERENCES subscriptions(id) ON DELETE SET NULL,

  rule_id        TEXT,                       -- references a rule id in settings.followups
  type           TEXT NOT NULL DEFAULT 'task', -- task | email | renewal
  title          TEXT NOT NULL,
  channel        TEXT NOT NULL DEFAULT 'task', -- task | email
  template_type  TEXT,                       -- email template to use when channel='email'
  due_at         TIMESTAMPTZ NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | done | snoozed | canceled
  note           TEXT,
  snoozed_until  TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_follow_ups_tenant_status ON follow_ups (tenant_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_follow_ups_customer ON follow_ups (customer_id);
CREATE INDEX IF NOT EXISTS idx_follow_ups_appointment ON follow_ups (appointment_id);
