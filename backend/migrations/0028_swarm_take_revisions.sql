-- Amendable takes: append-only REVISIONS of a member's take within one session
-- (issue #573, ADR D32).
--
-- WHAT CHANGES. `UNIQUE (session_id, member_id)` — declared in
-- 0004_committee.sql and renamed by 0025 to
-- `swarm_recommendations_session_id_member_id_key` — made "one take per member
-- per session" a schema fact. A member that learns something new inside the
-- window (a filing lands, a price moves) had no way to say so: its take was
-- frozen at the instant its container ran.
--
-- WHAT DOES NOT CHANGE. The table stays append-only in the strongest sense: an
-- accepted take's content is never UPDATEd. An amendment is a NEW immutable row
-- with its own `gen_random_uuid()` permalink, its own `received_at`, its own
-- nonce, and its own Ed25519 signature over its own content. Superseded rows
-- keep resolving at their permalink and keep verifying independently — which is
-- the whole reason the signature apparatus exists, and the reason the runbook
-- can go on telling members to "share that permalink as proof of
-- participation".
--
-- THE REPLACEMENT CONSTRAINT. `UNIQUE (session_id, member_id, revision)`.
-- Relaxing the old constraint without this would have admitted two rows
-- claiming to be the same revision, which is the one ambiguity a
-- latest-per-member read cannot resolve. It is also what makes the concurrent
-- double-submit safe: two racing INSERTs compute the same `max(revision)+1`,
-- and exactly one of them survives.
--
-- `UNIQUE (member_id, nonce)` is UNTOUCHED and still global and permanent. It
-- is what makes every revision a distinct signed artifact with NO protocol
-- change: `canonicalizeSubmission` (contract/src/signing.js) already signs
-- `nonce`, and the client already mints a fresh `crypto.randomUUID()` per
-- submit. No rmpc rebuild, no external-agent breakage.
--
-- BACKFILL. Every existing row is revision 1 — the DEFAULT does it, and there
-- is no ambiguity to resolve because the constraint being dropped guaranteed at
-- most one row per (session, member). The v0 archive import
-- (backend/scripts/v0-seed-bootstrap.ts) is unaffected for the same reason.
--
-- IDEMPOTENT: every statement is IF EXISTS / IF NOT EXISTS guarded, in the
-- style of every migration in this directory.

ALTER TABLE swarm_recommendations
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

-- A revision is a positive ordinal. Cheap, and it makes a bad backfill loud.
ALTER TABLE swarm_recommendations
  DROP CONSTRAINT IF EXISTS swarm_recommendations_revision_positive;
ALTER TABLE swarm_recommendations
  ADD CONSTRAINT swarm_recommendations_revision_positive CHECK (revision >= 1);

-- The relaxation. Both spellings are dropped: 0025 renamed the 0004 constraint,
-- but a database provisioned before that rename and never migrated through it
-- would still carry the old name.
ALTER TABLE swarm_recommendations
  DROP CONSTRAINT IF EXISTS swarm_recommendations_session_id_member_id_key;
ALTER TABLE swarm_recommendations
  DROP CONSTRAINT IF EXISTS committee_recommendations_session_id_member_id_key;

-- ...and its replacement. Declared as a UNIQUE INDEX rather than a table
-- constraint so `IF NOT EXISTS` is available (Postgres has no
-- `ADD CONSTRAINT IF NOT EXISTS`), which is what keeps this file re-runnable.
CREATE UNIQUE INDEX IF NOT EXISTS swarm_recommendations_session_member_revision_key
  ON swarm_recommendations (session_id, member_id, revision);

-- The latest-per-member read path (withTakes / aggregateSession /
-- getMemberTakes all resolve `DISTINCT ON (member) ... ORDER BY revision DESC`).
CREATE INDEX IF NOT EXISTS swarm_recommendations_session_member_latest_idx
  ON swarm_recommendations (session_id, member_id, revision DESC);

-- The amendment cap counts a member's rows in one session before the Ed25519
-- verify runs, so it must be an index hit rather than a scan of the session.
CREATE INDEX IF NOT EXISTS swarm_recommendations_member_session_idx
  ON swarm_recommendations (member_id, session_id);
