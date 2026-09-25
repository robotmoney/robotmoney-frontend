-- compat: additive
-- metadata_version: 1
--
-- The judge switch holds two modes, `off` and `enforce` — issue #1026,
-- decision D53 (1), which waives D48's judge-replay prerequisite and removes
-- `shadow` from every write path. docs/technical/system-scheduler-spec.md §4.4:
-- "The session records the judge mode in force (`off` or `enforce`, per D48)".
--
-- 0039 created `swarm_judge_config.mode` with CHECK (mode IN ('off', 'shadow',
-- 'enforce')). The writers stopped accepting `shadow` before this file
-- (src/swarm/judge-config.ts refuses it by name, and the admin route refuses
-- it like any unknown value). This migration makes the column say the same,
-- so no writer that bypasses the module can put the retired mode back.
--
-- SELF-HEALING. A database whose row still says `shadow` is moved to `off`
-- first — the mode `currentJudgeMode()` already reads a legacy `shadow` as, so
-- nothing a session sees changes — with both stamps moved and an audit_log row
-- naming this migration, because a policy change nobody can trace is the
-- thing `policy_updated_at` (0057) and the audit trail exist to prevent. On a
-- database with no `shadow` row the UPDATE and the INSERT touch nothing.
--
-- WHAT IS NOT TOUCHED. `swarm_session_judgements.mode` keeps its CHECK
-- ('shadow', 'enforce'): those rows are append-only history (0040), and a
-- published receipt that says a judgement ran in `shadow` must stay readable.
--
-- WHY `additive`. §8.4: every query the older registry declares still
-- succeeds with the same semantics. Code built for 0081 already writes only
-- `off` or `enforce` and reads `shadow` as `off`, so the tighter CHECK refuses
-- nothing it does, and the healed row reads the same to it as before.
--
-- A database 0039 never reached has no switch to tighten, and skips — the same
-- guard 0056 and 0057 use for the same table.

DO $$
BEGIN
  IF to_regclass('public.swarm_judge_config') IS NULL THEN
    RAISE NOTICE 'swarm_judge_config absent — 0039 has not run on this database; nothing to tighten';
    RETURN;
  END IF;

  WITH healed AS (
    UPDATE swarm_judge_config
       SET mode = 'off', updated_at = now(), policy_updated_at = now()
     WHERE mode = 'shadow'
    RETURNING id
  )
  INSERT INTO audit_log (actor, action, scope, target_type, target_id, reason, before_state, after_state)
  SELECT 'migration 0082', 'judge_config', jsonb_build_object('mode', 'off'), 'swarm_judge_config', id::text,
         'D53 (1): shadow retired; the column now admits off | enforce',
         jsonb_build_object('mode', 'shadow'), jsonb_build_object('mode', 'off')
    FROM healed;

  ALTER TABLE swarm_judge_config DROP CONSTRAINT IF EXISTS swarm_judge_config_mode_check;
  ALTER TABLE swarm_judge_config ADD CONSTRAINT swarm_judge_config_mode_check
    CHECK (mode IN ('off', 'enforce'));
END $$;
