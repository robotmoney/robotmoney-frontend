-- Project Fusion, issue #767 — make the shadow soak READABLE.
--
-- `swarm_session_judgements` (migration 0039) records what the judge said. It
-- does not record two things an operator running a soak has to know before
-- moving `swarm_judge_config.mode` to `enforce`, and both of them are silences
-- rather than errors:
--
--  1. WHETHER THE OPINION REACHED THE SESSION. In `enforce`, `applyOpinion()`
--     is CONDITIONAL — it refuses to write onto a terminal session, because the
--     window between forming an opinion and storing it is a model call and a
--     `swarm.publish` job runs in another process. That refusal was reported on
--     the HTTP response and then lost. A row saying `mode = 'enforce'` was
--     therefore not evidence that the session carries the judge's prose.
--  2. WHETHER THE RESPONSE WAS PARTIALLY DROPPED. #773 made a `positions[]`
--     entry naming a member with no take body a DROP rather than a
--     whole-response fallback — the right trade, since `view` is filled from
--     the frozen take set and a bodyless member has nothing quotable. But the
--     drop left no trace: the row still said `source = 'model'` with
--     `fallback_reason` NULL, so a model that named few disagreements and a
--     model whose output was trimmed were indistinguishable without re-reading
--     the take set by hand.
--
-- Counts, not a reason string. `fallback_reason` means "the model's answer was
-- not used at all" and `source = 'model'` must keep meaning what it says; a
-- partial drop is neither. So these are separate, non-blocking columns.
--
-- Defaults make this a pure ALTER against the existing append-only rows: no
-- historical row is rewritten and none is deleted, and `applied = false` is the
-- honest reading of a pre-#767 row — nothing recorded that it landed.

ALTER TABLE swarm_session_judgements
  ADD COLUMN IF NOT EXISTS applied               boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS applied_skipped_reason text,
  ADD COLUMN IF NOT EXISTS dropped_positions      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dropped_disagreements  integer NOT NULL DEFAULT 0;

-- `shadow` reaches no session BY DEFINITION — that is the whole point of the
-- mode — so a shadow row that claims to have applied, or that names a reason it
-- failed to, is a bug in the writer and the schema refuses it.
ALTER TABLE swarm_session_judgements
  DROP CONSTRAINT IF EXISTS swarm_session_judgements_applied_mode_check;
ALTER TABLE swarm_session_judgements
  ADD CONSTRAINT swarm_session_judgements_applied_mode_check
  CHECK (mode = 'enforce' OR (applied = false AND applied_skipped_reason IS NULL));

-- Applied and "here is why it did not apply" are mutually exclusive.
ALTER TABLE swarm_session_judgements
  DROP CONSTRAINT IF EXISTS swarm_session_judgements_applied_reason_check;
ALTER TABLE swarm_session_judgements
  ADD CONSTRAINT swarm_session_judgements_applied_reason_check
  CHECK (NOT (applied AND applied_skipped_reason IS NOT NULL));

ALTER TABLE swarm_session_judgements
  DROP CONSTRAINT IF EXISTS swarm_session_judgements_drop_counts_check;
ALTER TABLE swarm_session_judgements
  ADD CONSTRAINT swarm_session_judgements_drop_counts_check
  CHECK (dropped_positions >= 0 AND dropped_disagreements >= 0);

COMMENT ON COLUMN swarm_session_judgements.applied IS
  'enforce only: the opinion actually reached swarm_sessions.swarm_recommendation (issue #767).';
COMMENT ON COLUMN swarm_session_judgements.applied_skipped_reason IS
  'enforce only: why a recorded opinion did NOT reach the session (e.g. it published first).';
COMMENT ON COLUMN swarm_session_judgements.dropped_positions IS
  'positions[] entries dropped for having no member-authored body to quote (issues #773/#767).';
COMMENT ON COLUMN swarm_session_judgements.dropped_disagreements IS
  'disagreements dropped because every one of their positions was (issues #773/#767).';
