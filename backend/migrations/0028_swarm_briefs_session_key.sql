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
--   Briefs with no session at all for their (subject_id, date) are KEPT with
--   `session_id IS NULL`, not deleted. 19 of the 73 briefs in the committed v0
--   archive (seed-data/v0-committee-archive.json.gz) are exactly this shape —
--   v0 archived a brief for days whose session it did not archive. That is why
--   `session_id` is NULLABLE rather than NOT NULL: a Postgres unique index
--   treats NULLs as distinct, so these pre-existing day-keyed rows keep the
--   one-per-day uniqueness they were born under while every session-bound row
--   is one-per-session. Dropping them to buy a NOT NULL would delete real
--   archived content to satisfy a constraint's tidiness.
--
-- REVERSE (manual recovery only — this runner has no automated rollback):
-- drop the index and FK below, drop the column, and re-add
-- `UNIQUE (date, subject_id)` — which will fail if any subject has more than
-- one brief for a day by then, and that failure is the honest signal that rows
-- would have to be discarded to go back.

ALTER TABLE swarm_briefs ADD COLUMN IF NOT EXISTS session_id uuid;

-- Newest session of the brief's own (subject_id, date). swarm_sessions.date is
-- the STORED generated column 0022 derived from convened_at, so this join is
-- against the day the server recorded, never a client-supplied one.
UPDATE swarm_briefs b
   SET session_id = (
     SELECT s.id FROM swarm_sessions s
      WHERE s.subject_id = b.subject_id AND s.date = b.date
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

-- The dropped UNIQUE was also the index serving the day-scoped read. Replace it
-- (non-unique now) so `WHERE subject_id = ? AND date = ?` keeps an index.
CREATE INDEX IF NOT EXISTS swarm_briefs_subject_date_idx
  ON swarm_briefs (subject_id, date);

ALTER TABLE swarm_briefs DROP CONSTRAINT IF EXISTS swarm_briefs_session_fk;
ALTER TABLE swarm_briefs ADD CONSTRAINT swarm_briefs_session_fk
  FOREIGN KEY (session_id) REFERENCES swarm_sessions (id) ON DELETE CASCADE;
