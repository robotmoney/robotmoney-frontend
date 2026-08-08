-- A brief belongs to the SESSION it opened, not to the day it was opened on.
--
-- 0001_backends.sql gave briefs `UNIQUE (date, subject_id)`, matching sessions'
-- identity at the time. 0022_committee_session_convened_at.sql then moved
-- sessions off the day key to `UNIQUE (subject_id, convened_at)` — "a subject
-- may convene as often as its cadence says" — but briefs were not moved with
-- them. publishBrief() (src/swarm/domain.ts) kept upserting
-- `ON CONFLICT (date, subject_id) DO UPDATE SET body = EXCLUDED.body`, so at
-- the production cadence every session of a day overwrote the previous
-- session's brief row. The body carries `windowClosesAt` — the deadline that
-- session advertised to its members — so each overwrite destroyed the only
-- record of what an earlier session actually promised, and left the surviving
-- row silently misdated relative to every take filed against it.
--
-- After this migration:
--   * `session_id uuid REFERENCES swarm_sessions(id) ON DELETE CASCADE` is the
--     brief's identity, unique one-per-session. A second session on the same
--     day INSERTs its own row.
--   * `UNIQUE (date, subject_id)` is dropped. `date` and `subject_id` stay as
--     denormalized columns (exactly as swarm_recommendations carries all three)
--     so the day-scoped public read — `GET /api/swarm/brief?date=&subject=` —
--     keeps working; it now resolves to the LATEST session of that day, the
--     same rule getSession(date, subject) has followed since 0022.
--
-- BACKFILL — what happens to existing rows, stated plainly:
--
--   Each surviving brief is attached to the NEWEST session of its
--   (subject_id, date). That is not an approximation: last-write-wins on the
--   old constraint means the body still in the row IS the last session of that
--   day's body, so the newest session is its true and only owner.
--
--   Earlier sessions of a multi-session day get NO brief row. Their bodies were
--   destroyed by the upsert before this migration ran and cannot be
--   reconstructed. This migration deliberately does NOT copy the surviving body
--   onto them: that would fabricate a `windowClosesAt` those sessions never
--   advertised — inventing history is worse than admitting a gap. The gap is
--   bounded and forward-closing: every session convened after this migration
--   keeps its own brief.
--
--   Briefs with no QUALIFYING session for their (subject_id, date) are KEPT with
--   `session_id IS NULL`, not deleted. 19 of the 73 briefs in the committed v0
--   archive (seed-data/v0-committee-archive.json.gz) are exactly this shape —
--   v0 archived a brief for days whose session it did not archive. That is why
--   `session_id` is NULLABLE rather than NOT NULL: dropping them to buy a NOT
--   NULL would delete real archived content to satisfy a constraint's tidiness.
--   Their one-per-day uniqueness is NOT inherited from the unique index below —
--   a Postgres unique index treats NULLs as distinct, so that index constrains
--   nothing here. It is enforced by a separate PARTIAL unique index on
--   (date, subject_id) WHERE session_id IS NULL, added below for exactly that
--   reason.
--
-- REVERSE (manual recovery only — this runner has no automated rollback):
-- drop the index and FK below, drop the column, and re-add
-- `UNIQUE (date, subject_id)` — which will fail if any subject has more than
-- one brief for a day by then, and that failure is the honest signal that rows
-- would have to be discarded to go back.

ALTER TABLE swarm_briefs ADD COLUMN IF NOT EXISTS session_id uuid;

-- Newest session of the brief's own (subject_id, date) THAT ACTUALLY PUBLISHED A
-- BRIEF. swarm_sessions.date is the STORED generated column 0022 derived from
-- convened_at, so this join is against the day the server recorded, never a
-- client-supplied one.
--
-- `state <> 'scheduled'` is load-bearing, not defensive. openSession() inserts
-- every session as 'scheduled' (src/swarm/domain.ts) and the brief is published
-- later by a separate cron, so "the newest session of today has not been briefed
-- yet" is the ORDINARY STEADY STATE for most of every day. Without this filter
-- the day's surviving brief attaches to that unbriefed session — which then
-- advertises a windowClosesAt it never promised, and destroys the real body on
-- its own ON CONFLICT (session_id) DO UPDATE when it finally publishes. That is
-- precisely the harm this migration exists to prevent.
--
-- publishBrief() is the ONLY writer of state='collecting' (domain.ts), and the
-- admin lifecycle only ever advances scheduled -> collecting -> window_closed ->
-- aggregated -> published (swarm/admin.ts), so any state other than 'scheduled'
-- PROVES a brief was published. `window_closes_at IS NOT NULL` would NOT prove
-- it: admin.ts pre-sets that column on sessions it inserts as 'scheduled'.
--
-- RESIDUAL, accepted deliberately: 'cancelled' is reachable from 'scheduled'
-- (never briefed) and from 'collecting'/'window_closed' (briefed), so it alone
-- does not discriminate. It is included here because a cancelled session that
-- reached 'collecting' IS the rightful owner of the surviving body, and
-- cancellation is a rare admin escape hatch that the worker/demo path never
-- takes — whereas 'scheduled' is the common case and had to go. A brief whose
-- day's newest session was cancelled-before-briefing is the one shape this can
-- still misattribute.
--
-- The NOT EXISTS guard makes a RE-RUN safe: a day that had no qualifying session
-- on the first pass (so its brief stayed NULL) may have gained one since, and
-- that session may already carry its own brief. Without the guard the re-resolve
-- would collide on swarm_briefs_session_key and abort the whole migration. On
-- the first pass no session has a brief yet, so the guard is a no-op.
UPDATE swarm_briefs b
   SET session_id = (
     SELECT s.id FROM swarm_sessions s
      WHERE s.subject_id = b.subject_id
        AND s.date = b.date
        AND s.state <> 'scheduled'
        AND NOT EXISTS (SELECT 1 FROM swarm_briefs b2 WHERE b2.session_id = s.id)
      ORDER BY s.convened_at DESC
      LIMIT 1
   )
 WHERE b.session_id IS NULL;

ALTER TABLE swarm_briefs DROP CONSTRAINT IF EXISTS swarm_briefs_date_subject_id_key;

-- Identity. NULLs are distinct in a Postgres unique index, so this constrains
-- session-bound rows to one brief per session and leaves the sessionless
-- legacy rows described above alone.
CREATE UNIQUE INDEX IF NOT EXISTS swarm_briefs_session_key
  ON swarm_briefs (session_id);

-- …and because those NULLs are distinct, this index alone would let the
-- sessionless rows multiply per day — the very thing the dropped
-- UNIQUE (date, subject_id) prevented. A partial unique index keeps the old
-- guarantee for exactly the rows that still live under the old key, so
-- "sessionless briefs stay one-per-day" is ENFORCED rather than merely
-- inherited. Safe to create here: pre-migration the dropped constraint made
-- (date, subject_id) unique across ALL briefs, so no duplicate sessionless pair
-- can exist at this point, and the only writer that still produces such a row
-- (scripts/v0-seed-bootstrap.ts) emits at most one per (subject_id, date).
CREATE UNIQUE INDEX IF NOT EXISTS swarm_briefs_sessionless_day_key
  ON swarm_briefs (date, subject_id) WHERE session_id IS NULL;

-- The dropped UNIQUE was also the index serving the day-scoped read. Replace it
-- (non-unique now) so `WHERE subject_id = ? AND date = ?` keeps an index.
CREATE INDEX IF NOT EXISTS swarm_briefs_subject_date_idx
  ON swarm_briefs (subject_id, date);

ALTER TABLE swarm_briefs DROP CONSTRAINT IF EXISTS swarm_briefs_session_fk;
ALTER TABLE swarm_briefs ADD CONSTRAINT swarm_briefs_session_fk
  FOREIGN KEY (session_id) REFERENCES swarm_sessions (id) ON DELETE CASCADE;
