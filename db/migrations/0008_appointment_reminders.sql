-- 0008_appointment_reminders.sql — track when an appointment reminder email was
-- sent so reminders are idempotent (never double-sent). This is for UPCOMING-
-- APPOINTMENT reminders only — not balance/invoice reminders.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_appointments_reminder_due
  ON appointments (tenant_id, status, scheduled_start)
  WHERE reminder_sent_at IS NULL;
