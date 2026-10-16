-- compat: additive
-- metadata_version: 1
--
-- The instant a seat's consecutive missed sessions are counted from (issue 1269,
-- v0.6.0 upgrade post-mortem finding 9).
--
-- WHY. The v0.6.0 submit rules refused or hid sessions from members for days
-- after the 2026-10-08 cutover (post-mortem findings 1 to 6), and every one of
-- those sessions recorded an `absent` row against every seated member. Those
-- absences say nothing about the member. The owner decided 2026-10-09 that the
-- count restarts from the moment the upgrade carrying this feature goes
-- through, and that nothing removes a member automatically.
--
-- WHAT IT HOLDS. One row: `counted_from`, set to now() when this file applies.
-- src/swarm/dormancy.ts counts a member-role seat's `absent` rows on sessions
-- that convened after the latest of its newest take, its activation and this
-- instant. Nothing is deactivated, excused or revoked by that count; it is
-- shown on the member page and the admin list only.
--
-- THE ONLY WRITE. This migration is the one writer of the row, per the owner
-- rule that production data changes only through a migration. No runtime role
-- may write it: rm_app and rm_worker read it, schema/grants.sql lists it with
-- the read-only-for-runtime tables so reconciliation re-asserts that.
--
-- ADDITIVE and IDEMPOTENT. The table is created only if absent and the row is
-- inserted only if there is none, so a second run keeps the first counted_from
-- (tests/prod-baseline.test.ts re-applies the newest migration).

CREATE TABLE IF NOT EXISTS swarm_dormancy_baseline (
  id           boolean     PRIMARY KEY DEFAULT true,
  counted_from timestamptz NOT NULL,
  CONSTRAINT swarm_dormancy_baseline_singleton_check CHECK (id)
);

INSERT INTO swarm_dormancy_baseline (id, counted_from)
VALUES (true, now())
ON CONFLICT (id) DO NOTHING;

-- Everything first, whoever runs this and whatever default privileges that
-- login carries, then exactly the grants the row needs: every role reads it.
REVOKE ALL ON swarm_dormancy_baseline FROM PUBLIC, rm_app, rm_worker, rm_readonly;
GRANT SELECT ON swarm_dormancy_baseline TO rm_app, rm_worker, rm_readonly;

COMMENT ON TABLE swarm_dormancy_baseline IS
  'One row: the instant consecutive missed sessions are counted from (issue 1269). Written once by migration 0122; no runtime role writes it.';
