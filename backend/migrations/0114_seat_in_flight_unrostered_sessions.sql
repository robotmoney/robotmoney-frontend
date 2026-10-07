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
-- active member with the `member` role, `expected`, name and lens frozen now —
-- plus any member who already filed a take there, so every take v0.5.x
-- accepted still counts. Judges hold no seat (scheduler spec §4.4). A closed
-- window or a finished session is not touched: nothing more can be filed
-- into it, and seating it would only add absences v0.5.x never recorded.
--
-- ADDITIVE (spec §8.4): it inserts rows into an append-only table and changes
-- no shape; v0.5.x code beside it reads a seated session as rostered and
-- admits exactly the seated members. IDEMPOTENT: a session that already has a
-- roster is skipped, and ON CONFLICT covers a rerun.

DO $$
BEGIN
  -- A replay onto an older baseline (the v0.3.0 preflight test) can arrive
  -- without the roster table or the columns this reads; such a database has no
  -- v0.5.x epoch to seat.
  IF to_regclass('public.swarm_session_members') IS NULL
     OR (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public'
            AND (table_name, column_name) IN (('swarm_sessions', 'brief_opens_at'),
                                              ('swarm_members', 'role'),
                                              ('swarm_members', 'lens'))) < 3 THEN
    RAISE NOTICE 'roster table or columns absent; no in-flight session to seat';
    RETURN;
  END IF;

  INSERT INTO swarm_session_members (session_id, member_id, member_name, member_lens, status)
  SELECT s.id, m.id, m.name, m.lens, 'expected'
    FROM swarm_sessions s
    JOIN swarm_members m
      ON m.role = 'member'
     AND (m.status = 'active'
          OR EXISTS (SELECT 1 FROM swarm_recommendations r
                      WHERE r.session_id = s.id AND r.member_id = m.id))
   WHERE s.state = 'collecting'
     AND s.brief_opens_at IS NULL
     AND (s.window_closes_at IS NULL OR s.window_closes_at > now())
     AND NOT EXISTS (SELECT 1 FROM swarm_session_members x WHERE x.session_id = s.id)
  ON CONFLICT DO NOTHING;
END
$$;
