-- compat: additive
-- metadata_version: 1
--
-- Clear every member `operator` the member wrote for itself — issue #1026,
-- decision D55 (2).
--
-- D55: "A self-healing forward migration clears `operator` on every member row
-- where the member set it through the self-write path that issue #925 closed.
-- It runs on every deploy and changes nothing once no forged row remains."
-- Why: the judge's third-party gate is keyed on `operator` (`submitJudgement`,
-- smoke-production-spec.md §6.2), so a value a member wrote for itself is a
-- standing forgery, not old data. #925 stopped new forgeries of the in-house
-- value; the rows already written stay forged until something clears them.
--
-- PROVENANCE, FROM THE RECORD THAT EXISTS. `swarm_members.operator` has four
-- writers, and the append-only audit_log (0032) tells three of them apart:
--
--   * the member itself, through `updateMemberProfile` (POST
--     /api/swarm/members/:id/profile). Every call has logged an
--     `update_profile` row since the route was added (ce2c4427, the same commit
--     as the self-write). Before #925 the row held only {memberId}, so it
--     cannot say which field changed: such a row counts as a possible operator
--     write. From #925 on it names `fields`, and counts only when `operator` is
--     among them.
--   * an admin, through `updateMemberAdmin`, whose `member_update` row names
--     `fields` — provenance only when `operator` is among them.
--   * the in-house roster seed (src/swarm/roster-seed.ts, LIVE_ROSTER), which
--     writes `operator = 'robotmoney'` for athena, robot-money and themis on
--     every run and logs nothing. The judge of record, themis, is one of them:
--     clearing its operator would fail D52's third-party gate for the real
--     judge. A roster member holding exactly the manifest's value is kept.
--   * the one-time v0 archive backfill (scripts/v0-seed-bootstrap.ts), which
--     also logs nothing. It is recognised by what it leaves: a member with no
--     self-write row at all never wrote its own operator, so it is not touched.
--
-- THE RULE. A member's operator is cleared when it is non-NULL, the member has
-- a self-write row that could have set it, no admin row naming `operator` came
-- after the newest such self-write (audit_log.id order), and it is not a
-- roster member holding the manifest's value. Everything else — admin-written,
-- roster-seeded, archive-seeded, or never written — is left exactly as it is.
--
-- RECORDED. Each cleared member gets an audit_log row (actor `migration 0083`,
-- action `member_operator_cleared`) naming the id and the value removed, and a
-- NOTICE naming the id. The row is also what keeps the rerun a no-op: a
-- cleared operator is NULL and no longer matches.
--
-- WHY `additive`. §8.4: every query the older registry declares still
-- succeeds with the same semantics. Nothing here changes a column, a
-- constraint or a grant; it moves forged values to NULL, which every reader
-- already handles (a member with no operator is third-party to the gate).

DO $$
DECLARE
  -- The in-house roster: handle -> the operator its manifest sets. Kept in step
  -- with LIVE_ROSTER in src/swarm/roster-seed.ts by
  -- backend/tests/member-operator-provenance.test.ts.
  roster_handles text[] := ARRAY['athena', 'robot-money', 'themis'];
  roster_operator text := 'robotmoney';
  forged record;
BEGIN
  FOR forged IN
    WITH self_writes AS (
      SELECT a.scope->>'memberId' AS member_id, max(a.id) AS last_id
        FROM audit_log a
       WHERE a.action = 'update_profile'
         AND a.scope ? 'memberId'
         AND (NOT (a.scope ? 'fields') OR (a.scope->'fields') ? 'operator')
       GROUP BY a.scope->>'memberId'
    ),
    admin_writes AS (
      SELECT a.scope->>'memberId' AS member_id, max(a.id) AS last_id
        FROM audit_log a
       WHERE a.action = 'member_update'
         AND a.scope ? 'memberId'
         AND jsonb_typeof(a.scope->'fields') = 'array'
         AND (a.scope->'fields') ? 'operator'
       GROUP BY a.scope->>'memberId'
    )
    SELECT m.id, m.operator
      FROM swarm_members m
      JOIN self_writes s ON s.member_id = m.id
      LEFT JOIN admin_writes w ON w.member_id = m.id
     WHERE m.operator IS NOT NULL
       AND (w.last_id IS NULL OR w.last_id < s.last_id)
       AND NOT (m.handle = ANY (roster_handles) AND m.operator = roster_operator)
     ORDER BY m.id
  LOOP
    UPDATE swarm_members
       SET operator = NULL, version = version + 1, updated_at = now()
     WHERE id = forged.id;
    INSERT INTO audit_log (actor, action, scope, target_type, target_id, reason, before_state, after_state)
    VALUES ('migration 0083', 'member_operator_cleared',
            jsonb_build_object('memberId', forged.id, 'fields', jsonb_build_array('operator')),
            'swarm_member', forged.id,
            'D55 (2): operator set through the member self-write path with no later admin write',
            jsonb_build_object('operator', forged.operator), jsonb_build_object('operator', NULL));
    RAISE NOTICE 'migration 0083: cleared self-written operator on member %', forged.id;
  END LOOP;
END
$$;
