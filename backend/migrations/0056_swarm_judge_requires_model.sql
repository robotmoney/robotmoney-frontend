-- A JUDGE THAT IS ON MUST HAVE A MODEL (issue #969).
--
-- WHAT WENT WRONG. `swarm_judge_config` carries `mode` and `model` as two
-- independently settable columns. `mode` ships `off` and `model` ships NULL
-- (migration 0039), and nothing ever checked the pair. Production reached
-- `mode = 'enforce'` with `model = NULL`: the operator switch read ON,
-- resolveJudgeTransport() could never build a transport, and judge() absorbed
-- that into a `source = 'fallback'` row carrying template prose. Those rows
-- travelled the ordinary write path — same session, same `judged` state, same
-- SIGNED consensus receipt — so every enforce-mode opinion the system has
-- published was authored by a template and attributed to a judge.
--
-- SELF-HEALING, NOT JUST PREVENTIVE. The repair runs before the constraint,
-- because the constraint would otherwise refuse to attach to the very row that
-- motivated it. An operator who had the judge switched on without a model gets
-- it switched OFF by this migration and must set `{ mode, model }` together to
-- turn it back on. Failing safe is the point: `off` is the shipped default and
-- means "this system publishes no judge opinion", which is TRUE of what it was
-- doing anyway. Leaving it nominally on would keep the lie and merely stop
-- recording new instances of it.
-- GUARDED ON THE TABLE'S EXISTENCE. In every real deployment 0039 has created
-- `swarm_judge_config` long before this file runs, so the guard is dead code
-- there. It exists for the v0.2.2->v0.3.0 preflight rehearsal
-- (backend/tests/preflight-0-3-0-append-only-safety.test.ts), which builds its
-- baseline as "every migration EXCEPT this release's" and therefore hands a
-- database that has never run 0039 to every migration numbered after it. That
-- fiction is the harness's, not a state any upgrade path reaches — and a
-- migration that hard-fails inside it would block a release for a reason that
-- has nothing to do with the release.
DO $$
BEGIN
  IF to_regclass('public.swarm_judge_config') IS NULL THEN
    RAISE NOTICE 'swarm_judge_config absent — 0039 has not run on this database; nothing to constrain';
    RETURN;
  END IF;

  UPDATE swarm_judge_config
     SET mode = 'off', updated_at = now()
   WHERE mode <> 'off'
     AND (model IS NULL OR btrim(model) = '');

  ALTER TABLE swarm_judge_config
    DROP CONSTRAINT IF EXISTS swarm_judge_config_mode_requires_model_check;
  ALTER TABLE swarm_judge_config
    ADD CONSTRAINT swarm_judge_config_mode_requires_model_check
    CHECK (mode = 'off' OR (model IS NOT NULL AND btrim(model) <> ''));

  COMMENT ON CONSTRAINT swarm_judge_config_mode_requires_model_check ON swarm_judge_config IS
    'issue #969: shadow/enforce require a model. setJudgeConfig() validates the same pair against the resulting row; this is the backstop for any writer that does not come through it.';
END $$;

-- WHAT IS DELIBERATELY NOT DONE HERE.
--
-- `swarm_session_judgements.source` KEEPS `'fallback'` in its CHECK. The table
-- is append-only (migration 0040) and holds real fallback rows — including the
-- ones embedded in consensus receipts already published and signed. Narrowing
-- the domain to 'model' would make history unreadable to defend an invariant
-- that only governs the future. Nothing writes a new fallback row after #969
-- (judge() throws instead), so the column's remaining 'fallback' values are
-- exactly the historical set and stay legible as such.
--
-- Those published receipts are NOT retracted here either. They are
-- signature-valid attestations of template prose; whether they should remain
-- servable is a product decision, not a schema one.
