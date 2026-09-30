-- Store the judge model as the BARE wire id (`deepseek-v4-flash`), not the
-- provider-qualified selector (`opencode/deepseek-v4-flash`).
--
-- WHY. Two branches met in the 0.5.x -> main merge with two spellings of one
-- model. Production (v0.5.x) seeded `opencode/deepseek-v4-flash` in 0063 and
-- stripped the prefix at the wire (judge.ts wireModelId()). Main normalises at
-- the WRITE boundary instead (judge-session.ts normalizeJudgeModel()), and its
-- model policy (judge-model-policy.ts, AC-MODEL-01) pins the bare id. Left
-- alone, the stored value and the value setJudgeConfig() would accept disagree,
-- and the config row, the judgement rows and the admin API would name one model
-- two ways. The transport still sends wireModelId(model) on every path, so this
-- is bookkeeping, not a behaviour change for the provider call.
--
-- 0063 is untouched: production recorded it, and its bytes are history (R2).
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
