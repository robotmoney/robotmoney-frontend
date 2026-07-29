-- Committee waitlist capture + seat-open notifications (issue #238).
-- Forward-only and idempotent: applied once by the migration runner.

CREATE TABLE IF NOT EXISTS committee_waitlist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  email_norm  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  source      text
);
CREATE UNIQUE INDEX IF NOT EXISTS committee_waitlist_email_norm_uq ON committee_waitlist (email_norm);

-- Extend committee_notification_outbox constraints to support waitlist seat-open notifications
ALTER TABLE committee_notification_outbox DROP CONSTRAINT IF EXISTS committee_notification_outbox_kind_check;
ALTER TABLE committee_notification_outbox ALTER COLUMN member_id DROP NOT NULL;
ALTER TABLE committee_notification_outbox ADD CONSTRAINT committee_notification_outbox_kind_check CHECK (kind IN ('activation_approved', 'seat_open'));
