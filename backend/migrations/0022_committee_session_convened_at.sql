-- Committee sessions are identified by WHEN POSTGRES CONVENED THEM.
--
-- Before this migration a session's identity was `(date, subject_id)`, and that
-- `date` was chosen by the CLIENT. The demo exploited that: it passed
-- `today + N days`, walking synthetic dates forward so repeat runs would not
-- collide on the unique constraint, and wiped all session history at boot when
-- it wanted to reuse today. Both are the same mistake — a date invented away
-- from the database, then defended with a TRUNCATE.
--
-- After this migration:
--   * `convened_at timestamptz NOT NULL DEFAULT now()` is the real identity, set
--     by the SERVER on insert. No caller supplies it.
--   * `date` is DERIVED from it (a STORED generated column), so it can never
--     again disagree with when the session actually happened, and every existing
--     query that reads `date` keeps working unchanged.
--   * UNIQUE(date, subject_id) is dropped, so a subject may convene as often as
--     its cadence says — every session is its own row rather than an upsert over
--     yesterday's.
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE: the member-facing signing payload
-- (contract/src/signing.js) still carries `date`. Submissions no longer resolve
-- a session BY that date — they resolve to the subject's currently-collecting
-- session and then assert the signed date agrees — so no member, no rmpc build
-- and no onboarding doc has to change. Only one session per subject collects at
-- a time, which the session driver already serialises.
--
-- BACKFILL: convened_at is seeded from the old `date` at midnight UTC, so the
-- regenerated `date` is byte-identical to the value each row already had. No
-- existing session changes the day it is filed under.

ALTER TABLE committee_sessions ADD COLUMN IF NOT EXISTS convened_at timestamptz;

UPDATE committee_sessions SET convened_at = date::timestamptz WHERE convened_at IS NULL;

ALTER TABLE committee_sessions ALTER COLUMN convened_at SET DEFAULT now();
ALTER TABLE committee_sessions ALTER COLUMN convened_at SET NOT NULL;

-- The client-chosen identity goes away.
ALTER TABLE committee_sessions DROP CONSTRAINT IF EXISTS committee_sessions_date_subject_id_key;

-- `date` is rebuilt as a derived column. Dropping and re-adding is the only way
-- to convert a plain column into a generated one; the backfill above is what
-- makes that lossless, and nothing (no view, no index beyond the constraint just
-- dropped) depended on the old column.
ALTER TABLE committee_sessions DROP COLUMN IF EXISTS date;
ALTER TABLE committee_sessions
  ADD COLUMN date date GENERATED ALWAYS AS (((convened_at AT TIME ZONE 'UTC')::date)) STORED;

-- Identity + the read pattern that replaces "find this subject's session for
-- date D": newest session for a subject.
CREATE UNIQUE INDEX IF NOT EXISTS committee_sessions_subject_convened_key
  ON committee_sessions (subject_id, convened_at);
CREATE INDEX IF NOT EXISTS committee_sessions_subject_convened_desc_idx
  ON committee_sessions (subject_id, convened_at DESC);
