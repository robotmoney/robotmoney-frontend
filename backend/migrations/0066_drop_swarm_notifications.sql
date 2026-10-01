-- compat: breaking
-- metadata_version: 1
--
-- Drop the swarm email notification schema — issue #1026 W5, decision D50
-- reversing D30.
--
-- WHAT GOES. `swarm_notification_outbox` (the durable queue every onboarding
-- email was written to, introduced as `committee_notification_outbox` by 0019,
-- extended by 0021/0022 and renamed by 0025) and `swarm_waitlist.notified_at`
-- (the stamp `enqueueSeatOpenNotifications` set once a waitlist address had been
-- mailed about an open seat). Both exist only to serve mail. With
-- backend/src/swarm/notifications.ts, the AgentMail adapter, the three
-- `swarm.send_*_notification` worker kinds and their triggers deleted in the
-- same change, nothing reads or writes either one.
--
-- WHY `breaking` AND NOT `additive`. §8.4 defines additive as "old code's
-- supported behavior is preserved". Old code INSERTs into
-- `swarm_notification_outbox` on every public application and every admin
-- approval, and SELECTs `notified_at` on the waitlist path. A pre-0066 release
-- booted against a 0066 database would take a 42P01 on its front door. That is
-- exactly what `breaking` is for, and declaring it is what closes code-only
-- rollback past this migration instead of letting a rollback discover it at
-- runtime.
--
-- WHY THE TABLE IS DROPPED RATHER THAN LEFT IN PLACE. It is not history worth
-- keeping: every row is a copy of an email body plus a delivery attempt count,
-- the recipient addresses are PII we have no remaining purpose for, and
-- `swarm_applications` / `audit_log` (both append-only) already carry the facts
-- the messages were derived from. Leaving an unreferenced table full of contact
-- addresses behind would be the worse outcome, not the safer one.
--
-- NOT append-only. Neither `swarm_notification_outbox` nor `swarm_waitlist` is
-- in `APPEND_ONLY_TABLES` (src/db/append-only-guard.ts) and neither carries a
-- 0032 guard trigger, so this DROP is refused by nothing and trips no guard.
-- The waitlist TABLE itself is deliberately kept: it is contact details people
-- gave us on purpose, and an operator still reads it by hand when a seat opens.

-- The FK from the outbox to swarm_members is dropped with the table.
DROP TABLE IF EXISTS swarm_notification_outbox;

ALTER TABLE swarm_waitlist DROP COLUMN IF EXISTS notified_at;

-- Retire any delivery job left queued by a pre-0066 deployment. Their handler
-- kinds are no longer registered, so the worker would otherwise fail each one
-- through its full retry budget before settling it 'dead' — noise about a
-- feature that no longer exists. 'cancelled' is the honest terminal state:
-- nothing went wrong, the work was withdrawn. `jobs` is not append-only and
-- carries no guard trigger.
UPDATE jobs
SET status = 'cancelled',
    last_error = 'swarm email removed (issue #1026 W5, decision D50)',
    updated_at = now()
WHERE kind IN (
        'swarm.send_application_received_notification',
        'swarm.send_activation_notification',
        'swarm.send_seat_open_notification'
      )
  AND status IN ('pending', 'running', 'failed');
