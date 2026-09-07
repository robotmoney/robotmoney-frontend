-- Issue #796 — the admin-flippable, no-redeploy gate that decides whether ANY
-- third-party (graduated-member) judgement is permitted at all, layered on top
-- of #812's identity/role model. Global rather than per-party: see the
-- "Amendment (issue #796)" in docs/decisions.md for the granularity decision
-- and its reasoning.
--
-- Shipped default is `false` — the same "off by default, opt-in on a live
-- swarm" posture `mode` already has (migration 0039). A `judgeMemberId`
-- judgement is refused fail-closed until an admin flips this; the built-in
-- worker's judgements (no `judgeMemberId`) are unaffected either way.
ALTER TABLE swarm_judge_config
  ADD COLUMN IF NOT EXISTS third_party_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN swarm_judge_config.third_party_enabled IS
  'Global switch: may a graduated judge member (identified by judgeMemberId) author a judgement at all. Off by default; independent of mode. A false value refuses a third-party judgement with third_party_judging_disabled and writes nothing; the built-in worker judgement path is unaffected either way (issue #796).';
