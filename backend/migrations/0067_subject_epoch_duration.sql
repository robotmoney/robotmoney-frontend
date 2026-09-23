-- compat: additive
-- metadata_version: 1
--
-- The subject's epoch duration — issue #1026 W4.1,
-- docs/technical/system-scheduler-spec.md §2.2/§2.3/§2.4.
--
-- WHAT THIS IS. §2.2: "Each subject has one scheduling parameter: its epoch
-- duration — how long its submission window stays open. That is the entire
-- schedule. Nothing else about a session's timing is configured." §2.3 puts it
-- on the subject, set once by the schema snapshot's declaration on a blank
-- database and afterwards only through the admin API. No environment variable,
-- no seed command, no boot overwrite.
--
-- WHY A DEFAULT AND NOT A BACKFILL TABLE. There is no bootstrap ROW for a
-- subject (backend/schema/bootstrap-data.sql seeds none), so the declaration's
-- default is what makes §2.1's liveness statement — "an active subject has
-- exactly one open window" — reachable at all on a fresh database: every
-- subject that has ever existed, and every subject created afterwards, carries
-- a usable duration from its first instant without an operator doing anything.
-- Existing rows take the same value, which is the honest choice: the system had
-- no per-subject duration before this migration, so there is nothing to
-- preserve and nothing to guess.
--
-- WHY 3600. It is the cadence the retired `SWARM_*_CRON` schedules already
-- ran at (a one-hour submission window, backend/src/swarm/domain.ts's
-- `publishBrief(sessionId, windowMinutes = 60)`), so a database migrated by
-- this file behaves as it did the day before. It is a starting value, not a
-- policy: §2.3 says an operator changes it through the admin API, and a
-- rehearsal that wants short epochs does exactly that.
--
-- WHY NOT NULL WITH A POSITIVE CHECK. §2.4: "There is no on/off state for
-- scheduling." A nullable column, or one admitting zero, would BE that state —
-- a subject whose duration is NULL or 0 is a subject whose scheduling is
-- disabled by another name, and the scheduler would need a rule for it. The
-- constraint removes the case rather than handling it. §4.5 is the only way to
-- stop a subject: deactivate it.
--
-- SECONDS, NOT AN INTERVAL. `interval` admits values a timer cannot honour
-- ('1 month' has no fixed length) and compares awkwardly against the stored
-- instants the scheduler reconstructs from. An integer count of seconds is
-- exactly as expressive as the spec needs and has one representation.

ALTER TABLE swarm_subjects
  ADD COLUMN IF NOT EXISTS epoch_duration_seconds integer NOT NULL DEFAULT 3600;

ALTER TABLE swarm_subjects
  DROP CONSTRAINT IF EXISTS swarm_subjects_epoch_duration_seconds_check;
ALTER TABLE swarm_subjects
  ADD CONSTRAINT swarm_subjects_epoch_duration_seconds_check
  CHECK (epoch_duration_seconds > 0);

COMMENT ON COLUMN swarm_subjects.epoch_duration_seconds IS
  'How long this subject''s submission window stays open, in seconds. The subject''s ONLY scheduling parameter (scheduler spec §2.2). Set by the schema snapshot on a blank database, changed afterwards only through the admin subject route. Never zero and never null: there is no disabled state (§2.4).';
