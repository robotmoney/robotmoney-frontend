-- R13 (AC-E2E-06, malformed-judge-output clause) — the TEST-ONLY judge
-- fault-injection lever.
--
-- AC-E2E-06 requires an executed demonstration that a MALFORMED judge response
-- yields deterministic fallback prose with its provenance recorded and the
-- weight vector untouched. Until now the only way to produce one was to point
-- the judge at a model and hope it misbehaved, or to edit source — neither of
-- which is a repeatable acceptance step, and the second of which is not the
-- shipped artifact.
--
-- WHY A DATABASE ROW AND NOT AN ENV VAR. The same reason
-- `swarm_judge_config` is a row (issue #752): the lever must be settable and
-- CLEARABLE on a live stack without a restart, and — more importantly — every
-- transition must be attributable. Setting it goes through
-- swarm/admin.ts, which writes an `audit_log` row in the SAME transaction.
--
-- THE ROW ALONE DOES NOTHING. Honouring it additionally requires the process
-- env flag SWARM_JUDGE_FAULT_INJECTION, and on an acceptance path
-- (RM_ENV=prod — staging and production both) a SECOND explicit opt-in,
-- SWARM_JUDGE_FAULT_INJECTION_ACCEPTANCE_OPT_IN. See
-- backend/src/swarm/judge-fault-injection.ts. Enabling it on staging is a
-- RECORDED ACCEPTANCE MUTATION: the stack is no longer judging the way the
-- rehearsal describes, and the audit_log row is the record of that.
CREATE TABLE IF NOT EXISTS swarm_judge_fault_injection (
  id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled       boolean NOT NULL DEFAULT false,
  -- The body the transport returns INSTEAD of calling the model. Bounded:
  -- it is operator-supplied text that travels into a judge transcript.
  body          text NOT NULL DEFAULT '' CHECK (length(body) <= 20000),
  -- How many further judge calls this body answers. Decremented on use;
  -- 0 means the lever is spent and honours nothing.
  remaining     integer NOT NULL DEFAULT 0 CHECK (remaining >= 0 AND remaining <= 100),
  -- When set, ONLY this session's judging is faulted. NULL = the next
  -- `remaining` calls, whichever sessions they are.
  session_id    uuid,
  -- Free-text operator note ("AC-E2E-06 rehearsal 2026-09-14"), bounded.
  note          text CHECK (note IS NULL OR length(note) <= 500),
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- An enabled lever with nothing to return is a trap: it would consume a
  -- judging and produce an empty-string "malformed" body nobody chose.
  CHECK (NOT enabled OR (length(btrim(body)) > 0 AND remaining > 0))
);

INSERT INTO swarm_judge_fault_injection (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE swarm_judge_fault_injection IS
  'TEST-ONLY judge fault-injection lever (R13/AC-E2E-06). Inert unless SWARM_JUDGE_FAULT_INJECTION is set in the judging process, and refused on an acceptance path (RM_ENV=prod) unless SWARM_JUDGE_FAULT_INJECTION_ACCEPTANCE_OPT_IN is also set. Every transition writes an audit_log row; enabling it on staging is a recorded acceptance mutation.';
