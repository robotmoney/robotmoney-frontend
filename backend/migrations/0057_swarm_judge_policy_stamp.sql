-- A SEPARATE STAMP FOR THE TWO COLUMNS THAT DECIDE ELIGIBILITY (T04, AC-FE-10).
--
-- `swarm_judge_config.updated_at` moves on EVERY patch — a model rotation, the
-- third-party flag, anything. `swarm/receipt-gap.ts` uses it for one purpose
-- only: deciding whether today's judge config is entitled to speak for a
-- session that published BEFORE it ("config_predates"). That question is about
-- `mode` and `min_takes` and nothing else, so reading a column every patch
-- bumps made an unrelated operator action silently retract a missing-receipt
-- alert for a permanently receiptless session — the exact class of silent
-- retraction the module's own header says it exists to prevent.
--
-- `policy_updated_at` records the last change to the POLICY: the moment `mode`
-- or `min_takes` actually changed VALUE. judge-session.ts's setJudgeConfig
-- advances it inside the same UPDATE, evaluated against the row as it stands,
-- so it cannot be moved by a patch that leaves the policy where it was.
--
-- BACKFILLED FROM `updated_at`, not from now(): the last known moment the
-- config could have changed is the honest upper bound for a database that has
-- never carried this column, and it preserves today's behaviour for every
-- existing row rather than silently re-qualifying old sessions.
DO $$
BEGIN
  IF to_regclass('public.swarm_judge_config') IS NULL THEN
    RAISE NOTICE 'swarm_judge_config absent — 0039 has not run on this database; nothing to stamp';
    RETURN;
  END IF;

  ALTER TABLE swarm_judge_config ADD COLUMN IF NOT EXISTS policy_updated_at timestamptz;
  UPDATE swarm_judge_config SET policy_updated_at = updated_at WHERE policy_updated_at IS NULL;
  ALTER TABLE swarm_judge_config ALTER COLUMN policy_updated_at SET DEFAULT now();
  ALTER TABLE swarm_judge_config ALTER COLUMN policy_updated_at SET NOT NULL;
END $$;
