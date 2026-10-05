-- compat: additive
-- metadata_version: 1
--
-- Move the judge model from `deepseek-v4-flash` to `deepseek-v4.1-flash`.
--
-- WHY. 2026-10-05: OpenCode Zen renamed the model. The old id now answers
-- `AI_APICallError: Not Found`, so a judge row still holding it would fail
-- every call. The code pin (judge-model-policy.ts PINNED_JUDGE_MODEL) moves in
-- the same change.
--
-- 0063 and 0081 are untouched: production recorded them, and their bytes are
-- history. This is a new forward file.
--
-- Matches the BARE id (what 0081 left) and the provider-qualified form
-- (`opencode/deepseek-v4-flash`), and writes the bare new id. Any other model
-- an operator chose is left exactly as it is. `mode` is not touched, and the
-- new value is never empty, so 0056's "a judge that is on must have a model"
-- CHECK holds. Idempotent: a second run matches no row.
--
-- Guarded like 0063 and 0081: a database replayed from an older baseline may
-- not have the table yet (0039 creates it).
DO $$
BEGIN
  IF to_regclass('public.swarm_judge_config') IS NULL THEN
    RAISE NOTICE 'swarm_judge_config absent — 0039 has not run on this database; nothing to rename';
    RETURN;
  END IF;
  UPDATE swarm_judge_config
     SET model = 'deepseek-v4.1-flash',
         updated_at = now()
   WHERE btrim(model) IN ('deepseek-v4-flash', 'opencode/deepseek-v4-flash');
END $$;
