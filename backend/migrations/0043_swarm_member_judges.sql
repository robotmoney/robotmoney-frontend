-- Issue #812 — a consensus judge is an existing swarm identity with a role,
-- never a second credential or onboarding system. `judge` members retain their
-- member id, Ed25519 key history and bearer-token rotation path.
ALTER TABLE swarm_members
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member'
  CHECK (role IN ('member', 'judge'));

-- A judgement always names its author. Historical rows predate graduated
-- judges and were produced by the built-in worker, so the default records that
-- fact. Member-authored rows name the immutable member id in both fields.
ALTER TABLE swarm_session_judgements
  ADD COLUMN IF NOT EXISTS judged_by text NOT NULL DEFAULT 'robotmoney-in-house',
  ADD COLUMN IF NOT EXISTS judged_by_member_id text REFERENCES swarm_members(id),
  ADD CONSTRAINT swarm_session_judgements_judged_by_check
    CHECK (
      (judged_by = 'robotmoney-in-house' AND judged_by_member_id IS NULL)
      OR (judged_by = judged_by_member_id AND judged_by_member_id IS NOT NULL)
    );

COMMENT ON COLUMN swarm_members.role IS
  'member submits signed takes; judge authors consensus judgements and is excluded from takes/rosters (issue #812).';
COMMENT ON COLUMN swarm_session_judgements.judged_by IS
  'Named judging party: robotmoney-in-house or the immutable swarm member id (issue #812).';
