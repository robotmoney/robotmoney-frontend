-- R19 — retain the completion cost/token fields OpenCode Zen returns, so a run
-- can report what it SPENT.
--
-- Zen's /chat/completions answer carries a `usage` object (prompt_tokens,
-- completion_tokens, total_tokens) and, on the Zen endpoint, a cost figure.
-- The judge threw all of it away: the judgement row recorded which model
-- answered but nothing about what the answer cost, so "what did this rollout
-- spend on judging" could only be answered from the vendor's dashboard, out of
-- band and unattributable to a session.
--
-- NULLABLE, and nullable FOREVER: rows written before this migration spent
-- something nobody recorded, and a fallback judgement whose model never
-- answered spent nothing at all. NULL means "not recorded", never "zero".
-- `swarm_session_judgements` is append-only (migration 0040); adding nullable
-- columns adds no way to rewrite history.
-- GUARDED ON THE TABLE'S EXISTENCE, for the same reason 0056 is: the v0.2.2
-- preflight harness (tests/preflight-0-3-0-append-only-safety.test.ts) builds
-- its baseline as "every migration EXCEPT the 0.2.2->0.3.0 release's", which
-- hands a database that has never run 0040 to every migration numbered after
-- it. That fiction is the harness's, not a state any real upgrade path reaches
-- — and a migration that hard-fails inside it would block a release for a
-- reason that has nothing to do with the release.
DO $$
BEGIN
  IF to_regclass('public.swarm_session_judgements') IS NULL THEN
    RAISE NOTICE 'swarm_session_judgements absent — 0040 has not run on this database; no spend columns to add';
    RETURN;
  END IF;

  ALTER TABLE swarm_session_judgements
    ADD COLUMN IF NOT EXISTS usage_input_tokens  integer CHECK (usage_input_tokens IS NULL OR usage_input_tokens >= 0),
    ADD COLUMN IF NOT EXISTS usage_output_tokens integer CHECK (usage_output_tokens IS NULL OR usage_output_tokens >= 0),
    ADD COLUMN IF NOT EXISTS usage_total_tokens  integer CHECK (usage_total_tokens IS NULL OR usage_total_tokens >= 0),
    ADD COLUMN IF NOT EXISTS usage_cost_usd      numeric(18, 8) CHECK (usage_cost_usd IS NULL OR usage_cost_usd >= 0);

  COMMENT ON COLUMN swarm_session_judgements.usage_cost_usd IS
  'Completion cost in USD as reported by the provider for THIS judging, or NULL when the provider reported none (and on every fallback row, where no model answered). NULL is "not recorded", never "free" (R19).';
END $$;
