-- compat: additive
-- metadata_version: 1
--
-- The epoch lifecycle on swarm_sessions — issue #1026 W4.2/W4.3,
-- docs/technical/system-scheduler-spec.md §2.1, §4.3, §4.4 and §9.
--
-- Five facts the spec requires a session to CARRY, because every guard in §5
-- and every outcome in §4.4 is decided from stored data rather than from what
-- a caller says or when an event happened:
--
--   judge_mode             §4.4: "Judge mode is captured at turnover ... An
--                          admin changing the mode afterwards affects later
--                          sessions, never one already settling."
--   judging_requested_at   §4.4: the API "records the request instant".
--   judging_deadline_at    §4.4/§9: "A judging deadline is stored by the API
--                          when judging is requested and is never restarted by
--                          a rebuild." An ABSOLUTE instant, so a scheduler
--                          restart reconstructs the original timer rather than
--                          starting a fresh one.
--   consensus_recorded_at  §4.4: the acceptance instant finalize compares
--                          against the deadline. "An event's arrival time never
--                          decides an outcome."
--   judging_outcome        §4.4: decided ONCE by finalize, one of `judged`,
--                          `no_consensus`, `not_judged`. Stored so a repeated
--                          finalize "returns the outcome already decided; it
--                          never re-decides."
--
-- plus one more that makes turnover epoch-bound:
--
--   successor_session_id   §4.3: "the API returns the original turnover's
--                          result if it has one". The successor IS that result.
--                          Without it, a retry aimed at N cannot be
--                          distinguished from a fresh boundary, and the only
--                          remaining way to answer would be "whatever is open"
--                          — which is precisely what §4.3 forbids, and which
--                          would close N+1.
--
-- ── THE UNIQUENESS CONSTRAINT ───────────────────────────────────────────────
--
-- §2.1 states the invariant and says who enforces it: "an active subject has at
-- most one session in `collecting`. The database enforces it with a uniqueness
-- constraint." A partial unique index is that constraint. It is what makes
-- §4.1's "two concurrent first-openings for one subject yield one session"
-- true under real concurrency rather than under a read-then-write that two
-- callers can interleave.
--
-- It is NOT filtered on the subject's status. A subject deactivated while its
-- window was open still has at most one collecting session, and the index has
-- no way to see `swarm_subjects.status` anyway. Deactivation closes the window
-- (§4.5), so the two agree.
--
-- PRE-EXISTING DUPLICATES. The pre-epoch lifecycle allowed a second session to
-- be opened for a subject whose predecessor was still collecting, so a
-- long-lived database can hold duplicates this index would refuse. They are
-- closed here, oldest first, keeping the NEWEST — the one whose brief was
-- advertised last and the only one a participant could still be submitting
-- into. `window_closed` is the honest state for the others: their window is
-- over and their settlement may proceed. This is an UPDATE, so migration
-- 0032's append-only guard (DELETE and TRUNCATE only) does not apply.
--
-- ── THE STATE CHECK ─────────────────────────────────────────────────────────
--
-- `judging` is added because §4.4 makes it a real lifecycle state: the session
-- sits there between the judging request and consensus being recorded, and §3
-- step 3 recovers it by name after a scheduler restart.
--
-- `scheduled` and `cancelled` are KEPT although the spec's target lifecycle has
-- neither. docs/architecture/admin-surface.md §5.3 records this compromise as
-- agreed: historical rows must stay readable, and a CHECK constraint is
-- validated against every existing row, so dropping the values would either
-- fail the migration or force a rewrite of history. New sessions never take
-- them — the epoch path in backend/src/swarm/domain.ts writes `collecting` on
-- INSERT and no code path writes `cancelled` for an epoch — so the constraint
-- is wider than the behaviour on purpose, and the behaviour is what the tests
-- pin.

ALTER TABLE swarm_sessions
  ADD COLUMN IF NOT EXISTS judge_mode text,
  ADD COLUMN IF NOT EXISTS judging_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS judging_deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS consensus_recorded_at timestamptz,
  ADD COLUMN IF NOT EXISTS judging_outcome text,
  ADD COLUMN IF NOT EXISTS successor_session_id uuid;

ALTER TABLE swarm_sessions
  DROP CONSTRAINT IF EXISTS swarm_sessions_judge_mode_check;
ALTER TABLE swarm_sessions
  ADD CONSTRAINT swarm_sessions_judge_mode_check
  CHECK (judge_mode IS NULL OR judge_mode IN ('off', 'enforce'));

-- D48: `shadow` is not a go-forward mode, so it is not admissible here even
-- though swarm_judge_config still accepts it for the historical rows in
-- swarm_session_judgements. A session closing while the operator's config says
-- `shadow` captures `off` (see domain.ts's epoch section) rather than creating a new shadow
-- judgement, which D48 forbids in those words.

ALTER TABLE swarm_sessions
  DROP CONSTRAINT IF EXISTS swarm_sessions_judging_outcome_check;
ALTER TABLE swarm_sessions
  ADD CONSTRAINT swarm_sessions_judging_outcome_check
  CHECK (judging_outcome IS NULL OR judging_outcome IN ('judged', 'no_consensus', 'not_judged'));

-- The deadline exists if and only if judging was requested. Two columns that
-- can disagree are two columns a recovery read has to arbitrate between.
ALTER TABLE swarm_sessions
  DROP CONSTRAINT IF EXISTS swarm_sessions_judging_request_pair_check;
ALTER TABLE swarm_sessions
  ADD CONSTRAINT swarm_sessions_judging_request_pair_check
  CHECK ((judging_requested_at IS NULL) = (judging_deadline_at IS NULL));

ALTER TABLE swarm_sessions
  DROP CONSTRAINT IF EXISTS swarm_sessions_successor_fk;
ALTER TABLE swarm_sessions
  ADD CONSTRAINT swarm_sessions_successor_fk
  FOREIGN KEY (successor_session_id) REFERENCES swarm_sessions (id);

-- A session is never its own successor.
ALTER TABLE swarm_sessions
  DROP CONSTRAINT IF EXISTS swarm_sessions_successor_not_self_check;
ALTER TABLE swarm_sessions
  ADD CONSTRAINT swarm_sessions_successor_not_self_check
  CHECK (successor_session_id IS NULL OR successor_session_id <> id);

ALTER TABLE swarm_sessions DROP CONSTRAINT IF EXISTS swarm_sessions_state_check;
ALTER TABLE swarm_sessions ADD CONSTRAINT swarm_sessions_state_check
  CHECK (state = ANY (ARRAY[
    -- the target lifecycle (spec §4)
    'collecting', 'window_closed', 'aggregated', 'judging', 'judged', 'published',
    -- legacy, readable, never written by the epoch path (admin-surface.md §5.3)
    'scheduled', 'cancelled'
  ]));

-- Close pre-existing duplicate collecting sessions, keeping the newest.
UPDATE swarm_sessions s
   SET state = 'window_closed'
  FROM (
    SELECT id,
           row_number() OVER (PARTITION BY subject_id ORDER BY convened_at DESC, id DESC) AS rn
      FROM swarm_sessions
     WHERE state = 'collecting'
  ) ranked
 WHERE ranked.id = s.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS swarm_sessions_one_collecting_per_subject
  ON swarm_sessions (subject_id) WHERE state = 'collecting';

CREATE INDEX IF NOT EXISTS swarm_sessions_unsettled_idx
  ON swarm_sessions (state)
  WHERE state IN ('window_closed', 'aggregated', 'judging', 'judged');

-- ── THE EVENT LOG ───────────────────────────────────────────────────────────
--
-- §9, verbatim: "Every change to what the clock waits on is an event on the
-- stream, sequenced in the transaction that made the change." The table lives
-- in the lifecycle migration rather than one of its own because the sequence
-- number and the transition that caused it are ONE fact — a schema that lets
-- them land separately is a schema in which a crash between commit and publish
-- silently loses an event, and the clock cannot tell a lost event from a quiet
-- period.
--
-- WHY `seq` IS NOT AN IDENTITY COLUMN. An identity sequence is monotonic but
-- neither gapless nor commit-ordered: two concurrent transactions take 5 and 6
-- and may commit in the other order, so a subscriber reading 6 and then 5 sees
-- both an out-of-order delivery and, until the other commits, a hole. §6.3
-- builds the clock's whole correctness rule on the opposite: "a gap — a
-- sequence number that is not the last applied plus one — means the copy is no
-- longer provably current". So the number is assigned under an advisory
-- transaction lock and is MAX + 1, exactly the shape migration 0028's
-- `swarm_brief_revisions` uses for the same reason. Event-writing transactions
-- therefore serialise against each other, which is the cost of a stream a
-- subscriber can reason about, and is paid once per transition.
--
-- THREE KINDS, matching §6.2's table and nothing else. An unconstrained `kind`
-- would let a typo publish an event no scheduler subscribes to, which is
-- indistinguishable from no event at all.
CREATE TABLE IF NOT EXISTS swarm_stream_events (
  seq          bigint PRIMARY KEY,
  kind         text NOT NULL,
  subject_id   text,
  session_id   uuid REFERENCES swarm_sessions (id),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  committed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT swarm_stream_events_kind_check
    CHECK (kind = ANY (ARRAY['subject.changed', 'epoch.turned_over', 'session.judged'])),
  CONSTRAINT swarm_stream_events_seq_positive_check CHECK (seq > 0)
);

CREATE INDEX IF NOT EXISTS swarm_stream_events_subject_idx
  ON swarm_stream_events (subject_id, seq);

-- The API writes the log; nothing else does, and nobody deletes from it.
REVOKE ALL ON swarm_stream_events FROM PUBLIC;
GRANT SELECT, INSERT ON swarm_stream_events TO rm_app;
GRANT SELECT ON swarm_stream_events TO rm_worker, rm_readonly;

COMMENT ON TABLE swarm_stream_events IS
  'The scheduler event stream (spec §6). One row per change to what the clock waits on, written in the same transaction as that change, numbered gaplessly in commit order.';
COMMENT ON COLUMN swarm_stream_events.seq IS
  'Global monotonic sequence, gapless and in commit order: assigned as MAX + 1 under an advisory transaction lock, never from a sequence (see this migration''s header).';

COMMENT ON COLUMN swarm_sessions.judge_mode IS
  'The judge mode in force when this epoch CLOSED (scheduler spec §4.4), captured in the turnover transaction. NULL while the epoch is still collecting.';
COMMENT ON COLUMN swarm_sessions.judging_deadline_at IS
  'The absolute instant judging must have produced a consensus by. Stored once when judging is requested and never restarted by a scheduler rebuild (spec §9).';
COMMENT ON COLUMN swarm_sessions.consensus_recorded_at IS
  'When the judges'' consensus was ACCEPTED by the API. Compared against judging_deadline_at by finalize; an event''s arrival time is never compared to anything (spec §4.4).';
COMMENT ON COLUMN swarm_sessions.judging_outcome IS
  'Decided once, by finalize, from stored instants: judged | no_consensus | not_judged (spec §4.4). A repeated finalize returns this value rather than re-deciding.';
COMMENT ON COLUMN swarm_sessions.successor_session_id IS
  'The epoch this one turned over into. It is the turnover''s recorded result, which is what lets a retry bound to THIS epoch replay instead of closing the successor (spec §4.3).';
