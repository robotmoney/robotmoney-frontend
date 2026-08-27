-- Project Fusion, issue #752 — the consensus judge that EXPLAINS but does not
-- DECIDE.
--
-- Three structures, one rule between them: math decides, the judge explains.
--
--  1. `judged` joins the session state machine between `aggregated` and
--     `published` — the judged-but-unsigned state. It is deliberately NOT on
--     the required path: `aggregated -> published` stays legal, so a session
--     whose judge is turned off publishes exactly as it does today.
--
--  2. `swarm_judge_config` is a ONE-ROW operator switch. It exists as a table
--     rather than an env var because the swarm is LIVE: an operator must be
--     able to stop the judge reaching published sessions without restarting
--     the api and the swarm lane. `off` (the default this migration installs)
--     is today's behaviour to the byte; `shadow` computes and stores the
--     judge's opinion without it reaching a session; `enforce` lets the prose
--     through.
--
--  3. `swarm_session_judgements` is the append-only record of every judge run,
--     shadow runs included. `prompt_hash` pins the instructions the model was
--     given and `inputs_digest` pins the exact frozen take set + brief it read,
--     so a stored opinion is attributable to precisely what produced it.
--
-- The `opinion` CHECK is the load-bearing half of "the judge authors no
-- number": even a future code path that merged a weight-like field out of a
-- model response could not persist it here. The signed allocation vector stays
-- reproducible from the take set by anyone holding it.

ALTER TABLE swarm_sessions DROP CONSTRAINT IF EXISTS swarm_sessions_state_check;
ALTER TABLE swarm_sessions ADD CONSTRAINT swarm_sessions_state_check
  CHECK (state IN ('scheduled', 'collecting', 'window_closed', 'aggregated', 'judged', 'published', 'cancelled'));

CREATE TABLE IF NOT EXISTS swarm_judge_config (
  id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- off: the judge never runs. shadow: it runs and is recorded, and nothing it
  -- says reaches a session. enforce: its prose replaces the template prose on
  -- the session it judged.
  mode        text NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'shadow', 'enforce')),
  -- Below this many takes a session is THINLY SUPPORTED and the release-safety
  -- opinion says so. Recorded on every judgement so a historical opinion can be
  -- read against the threshold that was actually in force when it was made.
  min_takes   integer NOT NULL DEFAULT 3 CHECK (min_takes >= 1),
  -- WHICH MODEL, AS A ROW RATHER THAN AN ENVIRONMENT VARIABLE. D22 rule 1 says
  -- there is exactly ONE model-selection signal and it is `resolveAgentModel()`
  -- over AGENT_MODEL; a second `SWARM_JUDGE_MODEL` env var would be precisely
  -- the ambient, unreviewable selection that rule exists to prevent (and
  -- scripts/tests/unit/model-selection-single-signal.test.ts enforces it). An
  -- operator setting this column instead is an audited, reversible act on a
  -- live system. NULL — the shipped default — means the judge has no model and
  -- every session it judges falls back to template prose with
  -- `model_unconfigured` recorded against it.
  model       text CHECK (model IS NULL OR btrim(model) <> ''),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO swarm_judge_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS swarm_session_judgements (
  id              bigserial PRIMARY KEY,
  session_id      uuid NOT NULL REFERENCES swarm_sessions(id),
  mode            text NOT NULL CHECK (mode IN ('shadow', 'enforce')),
  source          text NOT NULL CHECK (source IN ('model', 'fallback')),
  -- Exactly one of these two facts is true of any row: a model authored it, or
  -- the templates did and this column says why.
  fallback_reason text,
  model           text,
  prompt_hash     text NOT NULL,
  inputs_digest   text NOT NULL,
  take_count      integer NOT NULL CHECK (take_count >= 0),
  min_takes       integer NOT NULL CHECK (min_takes >= 1),
  opinion         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT swarm_session_judgements_fallback_reason_check
    CHECK ((source = 'fallback') = (fallback_reason IS NOT NULL)),
  -- The judge authors no number. Enforced in the schema, not only in the code
  -- that writes it.
  CONSTRAINT swarm_session_judgements_no_weights_check
    CHECK (NOT (opinion ?| ARRAY['weights', 'weight', 'allocation', 'allocations', 'vector', 'bucket_weights']))
);

CREATE INDEX IF NOT EXISTS swarm_session_judgements_session_idx
  ON swarm_session_judgements (session_id, created_at DESC);
