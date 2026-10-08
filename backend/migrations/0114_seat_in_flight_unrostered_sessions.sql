-- compat: additive
-- metadata_version: 1
--
-- Seat a roster on every session v0.5.x convened and left open — runbook
-- blocker B20 (v0-6-0-rollout.md section 0).
--
-- WHY. v0.5.x convened epochs with no `swarm_session_members` rows and no
-- `brief_opens_at`, and its submit path let any member file into a session
-- with no roster rows (v0.5.4 domain.ts: "this check is a no-op for them").
-- 0.6 keys the roster bypass on `brief_opens_at` instead (domain.ts
-- submitRecommendation, pendingTakesFor), so such a session offers itself to
-- nobody and refuses every take: on the stage-2 twin of 2026-10-07 the vault
-- session convened by v0.5.x at 00:38Z published with only the 2 takes filed
-- before the capture, under min_takes, with no consensus receipt. The release
-- rule (owner, 2026-10-03) is that production's behavior wins and an upgrade
-- does not change usual schedules, so a session open at the cutover must
-- still collect takes from the members production would have taken them from.
--
-- WHAT IT SEATS. For each `collecting` session with no roster rows, no
-- `brief_opens_at` (the legacy fixture path keeps its own bypass) and a window
-- still open, the same set insertEpoch seats when it opens an epoch — every
-- active member with the `member` role, name and lens frozen now — plus any
-- member who already filed a take there, so a take v0.5.x accepted is never
-- orphaned by a missing seat. Judges hold no seat (scheduler spec §4.4). A
-- closed window or a finished session is not touched: nothing more can be filed
-- into it, and seating it would only add absences v0.5.x never recorded.
--
-- THE STATUS EACH SEAT GETS. Every seat is `expected`, with one exception: in a
-- session whose subject's `recommendation_type` is `bucket_weights`, a member
-- whose FINAL take there (`swarm_recommendations.final`, 0092) carries no
-- canonical-four weight vector is seated `excused`. Their stance is dropped
-- from that one session and from nothing else. A member with a weighted final
-- take, a member with no take, and every member of a `position_actions` (or any
-- other non-`bucket_weights`) session are seated `expected` as before.
--
-- WHY THAT EXCEPTION (owner decision, 2026-10-08). v0.5.4 accepted takes with
-- no weight vector into `bucket_weights` sessions. 0.6's receipt refuses such a
-- session (consensus-receipt.ts gate 5b, `weights_not_authored_by_every_take`;
-- gate 5 when no take has a vector), and `swarm_recommendations` is append-only,
-- so the take cannot be repaired. On the production-shaped stage run of
-- 2026-10-08 the in-flight `robotmoney-vault` session published with no receipt
-- for exactly this reason (two v0.5.4 takes, members Woon 46bed5c1… and ShodAI
-- 029a0f13…). The documented remedy for a weightless take is the excuse
-- (docs/technical/committee-to-chain.md, admin.ts rosterExcuseAdmin):
-- loadFrozenTakeSet reads only non-excused seats, so the take leaves the
-- rollup, the judge digest and the receipt together. This migration applies
-- that remedy at seating time instead of leaving it to an operator after the
-- refusal. An excused member is also refused a new take in that session
-- (submitRecommendation), as with any excuse.
--
-- "Carries a canonical-four weight vector" is the predicate gate 5b applies to
-- a take, `isCanonicalFourVector(normalizedTakeWeights(payload.weights))`,
-- written in SQL: `payload.weights` is an array of exactly four objects, each
-- with a string `bucket` among agent_tokens, conservative_defi_yield,
-- protocol_tokens and real_world_assets (all four named, none twice) and a
-- numeric `weight` >= 0, with a positive total.
--
-- AN EXCUSE IS RECORDED AS THE EXCUSE PATH RECORDS IT. The seat gets
-- `status = 'excused'`, `excused_at = now()` and a `reason`, the columns
-- rosterExcuseAdmin and the judge-role excuse write. It also gets the audit row
-- the forced excuse writes after collection has begun — action
-- `roster_excuse_forced`, scope {sessionId, memberId, state, reason} — with
-- actor `migration 0114` (as 0101 names itself), plus a NOTICE.
--
-- ADDITIVE (spec §8.4): it inserts rows into append-only tables and changes no
-- shape; v0.5.x code beside it reads a seated session as rostered and admits
-- exactly the seated, non-excused members. IDEMPOTENT: a session that already
-- has a roster is skipped, and ON CONFLICT covers a rerun, so a rerun neither
-- reseats nor re-audits.

DO $$
DECLARE
  seat record;
  excuse_reason constant text :=
    'final v0.5.x take in a bucket_weights session carries no canonical-four weight vector (migration 0114, owner decision 2026-10-08)';
BEGIN
  -- A replay onto an older baseline (the v0.3.0 preflight test) can arrive
  -- without the roster table or the columns this reads; such a database has no
  -- v0.5.x epoch to seat.
  IF to_regclass('public.swarm_session_members') IS NULL
     OR (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public'
            AND (table_name, column_name) IN (('swarm_sessions', 'brief_opens_at'),
                                              ('swarm_members', 'role'),
                                              ('swarm_members', 'lens'),
                                              ('swarm_recommendations', 'final'),
                                              ('swarm_subjects', 'recommendation_type'))) < 5 THEN
    RAISE NOTICE 'roster table or columns absent; no in-flight session to seat';
    RETURN;
  END IF;

  FOR seat IN
    INSERT INTO swarm_session_members (session_id, member_id, member_name, member_lens, status, excused_at, reason)
    SELECT s.id, m.id, m.name, m.lens,
           CASE WHEN w.weightless THEN 'excused' ELSE 'expected' END,
           CASE WHEN w.weightless THEN now() END,
           CASE WHEN w.weightless THEN excuse_reason END
      FROM swarm_sessions s
      JOIN swarm_members m
        ON m.role = 'member'
       AND (m.status = 'active'
            OR EXISTS (SELECT 1 FROM swarm_recommendations r
                        WHERE r.session_id = s.id AND r.member_id = m.id))
      LEFT JOIN swarm_subjects subj ON subj.id = s.subject_id
      -- The member's final take here, judged by gate 5b's predicate. No take,
      -- or a non-bucket_weights subject, is never weightless.
      CROSS JOIN LATERAL (
        SELECT COALESCE(subj.recommendation_type = 'bucket_weights', false)
               AND EXISTS (
                 SELECT 1 FROM swarm_recommendations r
                  WHERE r.session_id = s.id AND r.member_id = m.id AND r.final
                    AND NOT COALESCE((
                      SELECT count(*) = 4
                             AND count(DISTINCT e->>'bucket') = 4
                             AND bool_and(COALESCE(
                                   jsonb_typeof(e) = 'object'
                                   AND jsonb_typeof(e->'bucket') = 'string'
                                   AND (e->>'bucket') IN ('agent_tokens', 'conservative_defi_yield',
                                                          'protocol_tokens', 'real_world_assets')
                                   AND jsonb_typeof(e->'weight') = 'number'
                                   AND CASE WHEN jsonb_typeof(e->'weight') = 'number'
                                            THEN (e->>'weight')::numeric >= 0 END,
                                   false))
                             AND COALESCE(sum(CASE WHEN jsonb_typeof(e->'weight') = 'number'
                                                   THEN (e->>'weight')::numeric END), 0) > 0
                        FROM jsonb_array_elements(
                               CASE WHEN jsonb_typeof(r.payload->'weights') = 'array'
                                    THEN r.payload->'weights' ELSE '[]'::jsonb END) AS e
                    ), false)
               ) AS weightless
      ) w
     WHERE s.state = 'collecting'
       AND s.brief_opens_at IS NULL
       AND (s.window_closes_at IS NULL OR s.window_closes_at > now())
       AND NOT EXISTS (SELECT 1 FROM swarm_session_members x WHERE x.session_id = s.id)
    ON CONFLICT DO NOTHING
    RETURNING session_id, member_id, status, reason
  LOOP
    IF seat.status = 'excused' THEN
      INSERT INTO audit_log (actor, action, scope, target_type, target_id, reason)
      VALUES ('migration 0114', 'roster_excuse_forced',
              jsonb_build_object('sessionId', seat.session_id, 'memberId', seat.member_id,
                                 'state', 'collecting', 'reason', seat.reason),
              'swarm_session', seat.session_id::text, seat.reason);
      RAISE NOTICE 'migration 0114: seated member % excused on bucket_weights session %: final v0.5.x take carries no canonical-four weight vector',
        seat.member_id, seat.session_id;
    END IF;
  END LOOP;
END
$$;
