-- Committee admin surface (issue #152): versioned topic/member mutations,
-- frozen session rosters, guarded lifecycle transitions, and auditable admin
-- actions. Builds on 0004/0006's session/member/subject tables and reuses the
-- generic audit_log (0004) rather than growing a parallel table.
--
-- Idempotent throughout (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT
-- EXISTS / ON CONFLICT DO NOTHING) so it is safe to apply to a database that
-- already has committee_sessions/committee_subjects/committee_members rows —
-- it never drops or narrows anything, only adds.

-- Optimistic concurrency: every admin-mutable row carries a version an admin
-- must present back (expectedVersion) so a stale read never silently clobbers
-- a concurrent edit (409 stale_version).
ALTER TABLE committee_subjects ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
ALTER TABLE committee_subjects ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE committee_subjects ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE committee_members ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
ALTER TABLE committee_members ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE committee_members ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;
ALTER TABLE committee_members ADD COLUMN IF NOT EXISTS rejected_at timestamptz;

ALTER TABLE committee_sessions ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
ALTER TABLE committee_sessions ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

-- Frozen expected roster: the set of members considered "expected" for a
-- session, snapshotted at admin session-creation time (committee/admin.ts
-- createSession) so LATER member activation/deactivation can never rewrite a
-- session's history. `status` distinguishes an excused member (roster/
-- add-excuse-restore, allowed only before collecting) from a normal expected
-- attendee; the row itself is never deleted (append-only membership record).
CREATE TABLE IF NOT EXISTS committee_session_roster (
  id             bigserial PRIMARY KEY,
  session_id     uuid NOT NULL REFERENCES committee_sessions(id) ON DELETE CASCADE,
  member_id      text NOT NULL REFERENCES committee_members(id),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'excused')),
  snapshotted_at timestamptz NOT NULL DEFAULT now(),
  excused_at     timestamptz,
  restored_at    timestamptz,
  UNIQUE (session_id, member_id)
);
CREATE INDEX IF NOT EXISTS committee_session_roster_session_idx ON committee_session_roster (session_id);

-- One row per guarded lifecycle state transition (committee/admin.ts
-- guardedTransition), written in the SAME transaction as the session's state
-- UPDATE and its audit_log row — so committee_sessions.state history is
-- reconstructable and every admin-driven write is doubly attributable.
CREATE TABLE IF NOT EXISTS committee_session_events (
  id         bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES committee_sessions(id) ON DELETE CASCADE,
  from_state text,
  to_state   text NOT NULL,
  actor      text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  detail     jsonb
);
CREATE INDEX IF NOT EXISTS committee_session_events_session_idx ON committee_session_events (session_id);

-- Roster backfill: sessions created before this migration have no snapshot
-- row. Best-effort reconstruct one from the members who are active RIGHT NOW
-- so historical sessions stay queryable through the same roster-aware read
-- paths (e.g. aggregate denominators) instead of silently reading as
-- zero-member sessions. This is necessarily an approximation for old data —
-- new sessions get a REAL point-in-time snapshot going forward — so
-- aggregateSession() only prefers roster rows when the roster is non-empty
-- and otherwise falls back to live committee_members, keeping this backfill
-- purely additive (see committee/domain.ts).
INSERT INTO committee_session_roster (session_id, member_id, status, snapshotted_at)
SELECT s.id, m.id, 'active', s.generated_at
FROM committee_sessions s
CROSS JOIN committee_members m
WHERE m.status = 'active'
ON CONFLICT (session_id, member_id) DO NOTHING;

-- Supports the admin audit-log filter endpoint (actor/action/time range).
CREATE INDEX IF NOT EXISTS audit_log_action_at_idx ON audit_log (action, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_at_idx ON audit_log (actor, at DESC);
