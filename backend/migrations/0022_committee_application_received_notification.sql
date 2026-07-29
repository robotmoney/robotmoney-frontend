-- Committee "application received" notification kind (onboarding funnel).
-- Forward-only and idempotent: applied once by the migration runner.

-- The application status page at /committee/apply/<memberId> is handed to an
-- operator exactly once, as a line their own coding agent prints into a chat
-- transcript, and nothing on the site links to it. Losing that message lost the
-- page. The fix is an email at apply time carrying the URL, which needs a third
-- kind in the outbox. Drop-and-recreate (rather than a second CHECK) so this
-- constraint keeps reading as one exhaustive list of the kinds we send, matching
-- how 0021 widened it for 'seat_open'.
ALTER TABLE committee_notification_outbox DROP CONSTRAINT IF EXISTS committee_notification_outbox_kind_check;
ALTER TABLE committee_notification_outbox ADD CONSTRAINT committee_notification_outbox_kind_check
  CHECK (kind IN ('activation_approved', 'seat_open', 'application_received'));
