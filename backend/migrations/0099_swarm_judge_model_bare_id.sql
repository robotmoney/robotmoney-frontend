-- compat: additive
-- metadata_version: 1
--
-- Store the judge model as the BARE wire id (`deepseek-v4-flash`), not the
-- provider-qualified selector (`opencode/deepseek-v4-flash`).
--
-- WHY. Production's 0063 (v0.5.1) seeded `opencode/deepseek-v4-flash`, the
-- provider-qualified selector. Main normalises the model at the write boundary
-- (judge-session.ts normalizeJudgeModel()) and its model policy
-- (judge-model-policy.ts, AC-MODEL-01) pins the bare id, which is also what
-- Zen's REST endpoint accepts (it answers the qualified form with a 401). Left
-- alone, the stored value and the value setJudgeConfig() accepts would
-- disagree, and a mode-only patch would keep sending the qualified id.
--
-- 0063 is untouched: production recorded it, and its bytes are history.
--
-- ONLY a leading `opencode/`, and only where something non-empty remains, so a
-- row can never be pushed into 0056's "a judge that is on must have a model"
-- CHECK. Any other model an operator chose is left exactly as it is. `mode` is
-- not touched. Idempotent: a second run matches no row.
--
-- Guarded like 0063 (and main's 0056/0057): a database replayed from an older
-- baseline may not have the table yet (0039 creates it).
DO $$
BEGIN
  IF to_regclass('public.swarm_judge_config') IS NULL THEN
    RAISE NOTICE 'swarm_judge_config absent — 0039 has not run on this database; nothing to normalise';
    RETURN;
  END IF;
  UPDATE swarm_judge_config
     SET model = btrim(substr(btrim(model), length('opencode/') + 1)),
         updated_at = now()
   WHERE model IS NOT NULL
     AND btrim(model) LIKE 'opencode/%'
     AND btrim(substr(btrim(model), length('opencode/') + 1)) <> '';
END $$;
