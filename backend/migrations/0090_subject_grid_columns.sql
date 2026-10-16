-- compat: additive
-- metadata_version: 1
--
-- The subject's two other scheduling columns — issue #1026 W4,
-- docs/technical/system-scheduler-spec.md §2.2/§2.3/§2.4 and §4.4, and D53
-- decision 7 (docs/decisions.md).
--
-- WHAT §2.2 ASKS FOR. Three columns on the subject, not one:
--
--   epoch_duration    the spacing of the grid, and the length of every full window
--   epoch_anchor      one instant on the grid; every close is
--                     epoch_anchor + k × epoch_duration for some integer k
--   judging_duration  how long judging waits for a consensus after it is
--                     requested (§4.4); not part of the grid
--
-- Migration 0085 built the first as `epoch_duration_seconds`. This migration
-- adds the other two. D53 decision 7 keeps the unit suffix on the durations,
-- so the new duration is `judging_duration_seconds`; the anchor is an instant
-- and has no unit.
--
-- WHY THE ANCHOR DEFAULTS TO THE UNIX EPOCH. §2.3 sets all three columns from
-- the schema declaration on a blank database, so every subject needs a usable
-- anchor from its first instant without an operator doing anything — exactly
-- the reasoning 0085 gives for its default. A FIXED instant, never now(): an
-- anchor that depended on when the row was inserted would give two subjects
-- with the same duration two different grids for no reason anyone chose.
-- 1970-01-01T00:00:00Z puts an hourly grid on the hour and a daily grid on UTC
-- midnight, which is the grid an operator would pick if asked. §2.2's first
-- epoch rule (close at least half a duration after now) makes any anchor
-- safe, so the choice is legibility, not correctness.
--
-- WHY THE BACKFILL CONTINUES PRODUCTION'S GRID. v0.5.4 ran each subject on a
-- six-hour cycle (see 0085): a session opened, its window closed six hours
-- later, and the next session opened at the next slot. "Same schedule" means
-- the same open and close INSTANTS, not just the same length, so the anchor is
-- taken from the data production left behind:
--
--   * a subject with a `collecting` session takes that window's close. Its
--     close is on the grid by construction (k = 0), so the open window stays
--     exactly where it is (§2.2's duration-change rule does the same).
--   * a subject with no open window takes the close of its most recent session
--     that recorded one (never a `scheduled` or `cancelled` row, whose close
--     was never a slot the driver walked). Every close production wrote is one slot after an
--     open, so `last_close + k * epoch_duration` is the slot sequence the
--     driver was walking, and the next epoch opens on it.
--   * a subject that never had a session keeps the unix-epoch default: there
--     is no production grid to continue.
--
-- Closes sit within seconds of their slot rather than exactly on it (a session
-- opens when the driver reaches the slot, not before), so the continued grid
-- matches production's to that latency, not to the millisecond. At most one
-- `collecting` session exists per subject (0086's
-- `swarm_sessions_one_collecting_per_subject`), and a collecting session is
-- always the newest, so one rule, "latest recorded close", covers both cases.
--
-- WHY 900 FOR THE JUDGING DURATION. It is the deadline applied to a judging
-- that has been requested, and it is deliberately looser than the only wait
-- v0.5.4 had: the host driver stopped waiting for a judge after
-- judgeWaitCeilingMs() = max(120 s, 2 x 180 s + 60 s) = 420 s
-- (scripts/lib/swarm/session.ts). Production had no stored judging duration at
-- all, and judging never moved a session's open or close, so 900 changes no
-- schedule; it only lets a slow judge land that the driver would have given up
-- on. (An earlier draft cited a `JUDGING_DURATION_SECONDS = 900` constant in
-- backend/src/swarm/domain.ts. No such constant exists.) Moving the deadline
-- onto this column (and capturing it on the session at turnover, migration
-- 0091) is later work that reads what this file writes.
--
-- NOT NULL WITH A POSITIVE CHECK, for 0085's reason: §2.4 says "There is no
-- on/off state for scheduling", and a NULL or zero judging duration would be a
-- disabled judging wait by another name. The anchor is NOT NULL for the same
-- reason — a subject with no anchor has no grid.
--
-- ADDITIVE. Both columns carry defaults, so every existing INSERT into
-- swarm_subjects (createSubjectAdmin in backend/src/swarm/admin.ts names only
-- the columns it knows) keeps working unchanged, and no existing read selects
-- `*` into a fixed shape. `swarm_subjects` is append-only for DELETE and
-- TRUNCATE only (0032); its guard triggers do not fire on the UPDATE below.

ALTER TABLE swarm_subjects
  ADD COLUMN IF NOT EXISTS epoch_anchor timestamptz NOT NULL
    DEFAULT '1970-01-01 00:00:00+00'::timestamptz,
  ADD COLUMN IF NOT EXISTS judging_duration_seconds integer NOT NULL DEFAULT 900;

ALTER TABLE swarm_subjects
  DROP CONSTRAINT IF EXISTS swarm_subjects_judging_duration_seconds_check;
ALTER TABLE swarm_subjects
  ADD CONSTRAINT swarm_subjects_judging_duration_seconds_check
  CHECK (judging_duration_seconds > 0);

UPDATE swarm_subjects s
   SET epoch_anchor = last.window_closes_at
  FROM (
    SELECT DISTINCT ON (subject_id) subject_id, window_closes_at
      FROM swarm_sessions
     WHERE window_closes_at IS NOT NULL
       AND subject_id IS NOT NULL
       AND state NOT IN ('scheduled', 'cancelled')
     ORDER BY subject_id, window_closes_at DESC
  ) last
 WHERE last.subject_id = s.id;

COMMENT ON COLUMN swarm_subjects.epoch_anchor IS
  'One instant on this subject''s grid: every epoch close is epoch_anchor + k * epoch_duration_seconds (scheduler spec §2.2). Set by the schema declaration on a blank database, changed afterwards only through the admin subject route; a duration change re-anchors at the current window''s close.';
COMMENT ON COLUMN swarm_subjects.judging_duration_seconds IS
  'How long judging waits for a consensus after it is requested, in seconds (scheduler spec §2.2, §4.4). Not part of the grid. Captured onto the session at turnover. Never zero and never null: there is no disabled state (§2.4).';
