-- Give the judge a model where it has none: the same model CI and the smoke
-- driver run every agent on (scripts/lib/model-registry.ts DEFAULT_AGENT_MODEL,
-- `opencode/deepseek-v4-flash`).
--
-- WHY. Production on 2026-09-25 had swarm_judge_config = mode 'enforce',
-- model NULL. Since a42d6c5a ("no fallback") a judge with no model refuses with
-- `model_unconfigured` and writes nothing, so every swarm.judge job died and
-- sessions could not publish a judged opinion (3 dead judge jobs in 24 h; one
-- session published in 48 h). The twin never saw it: the smoke driver sets its
-- own judge model at boot (scripts/lib/swarm/session.ts enableTwinJudge).
--
-- ONLY WHERE THE MODEL IS MISSING. An operator who has chosen a model keeps it;
-- the admin judge-config route stays the way to change it. `mode` is left
-- exactly as it is: this migration does not turn the judge on anywhere it is
-- off. Idempotent: a second run matches no row.
--
-- The id is the wire-prefixed form the driver writes; judge.ts's wireModelId()
-- strips the `opencode/` prefix before calling the provider.
-- Guarded like main's own judge migrations (0056/0057): a database replayed
-- from an older baseline may not have the table yet (0039 creates it).
DO $$
BEGIN
  IF to_regclass('public.swarm_judge_config') IS NULL THEN
    RAISE NOTICE 'swarm_judge_config absent — 0039 has not run on this database; nothing to set';
    RETURN;
  END IF;
  UPDATE swarm_judge_config
     SET model = 'opencode/deepseek-v4-flash',
         updated_at = now()
   WHERE id = 1
     AND (model IS NULL OR btrim(model) = '');
END $$;
