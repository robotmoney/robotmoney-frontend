-- compat: additive
-- metadata_version: 1
--
-- The four subjects close exactly 6 h apart (owner request 2026-10-10, issue 1286).
--
-- WHY. 0117 gave each of the four production subjects a 24 h epoch, anchored
-- to the old 6 h rotation. Those anchors carried the rotation's drift: the
-- closes sat 6 h 06 m, 6 h 02 m, 6 h 03 m and 5 h 49 m apart. Members time
-- their agents to the closes, so the gaps should be exact.
--
-- WHAT IT DOES. Keeps `epoch_duration_seconds = 86400` and sets the four
-- anchors so their times of day are exactly 21600 s apart, in today's order:
-- vault, woon, allocation, treasury.
--
--   robotmoney-vault       anchor 2026-10-10 00:52:19.990+00   (unchanged)
--   woon                   anchor 2026-10-10 06:52:19.990+00   (was 06:58:21.970, 6 m 02 s earlier)
--   robotmoney-allocation  anchor 2026-10-10 12:52:19.990+00   (was 13:00:42.491, 8 m 23 s earlier)
--   robotmoney-treasury    anchor 2026-10-10 18:52:19.990+00   (was 19:03:59.504, 11 m 40 s earlier)
--
-- WHICH BASE TIME. Vault's close stays and the other three move onto its grid,
-- the smallest move of the two the owner offered (the other, rounding to the
-- hour, moves every close by up to 52 minutes). Vault's row keeps the anchor
-- 0117 wrote, so this file is a no-op for it.
--
-- WHY EVERY MOVE IS EARLIER, NEVER LATER. `swarm_sessions.window_closes_at`
-- is neither read nor written: an open window keeps the close it was opened
-- with (scheduler spec §2.2). At turnover the next window closes at the FIRST
-- grid instant strictly after that close (src/swarm/epoch.ts gridClose). A new
-- time of day a few minutes LATER than the old one would put that instant
-- minutes after the old close: a sliver window nobody can submit into. A new
-- time of day earlier than the old one puts it a day later, less the move: so
-- the one window between the old grid and the new lasts 24 h minus 6 to 12
-- minutes (woon 23 h 54 m, allocation 23 h 52 m, treasury 23 h 48 m), and every
-- window after it is 24 h. The grid cannot stretch that window instead: the
-- scheduler takes the first grid instant after the close, never the second.
--
-- IDEMPOTENT. The WHERE clause matches only a row whose duration or anchor
-- differs: a second run moves no `version`. A subject that is not there is
-- skipped, so a blank database and the demo seed stay untouched.
--
-- NO `subject.changed` EVENT, as in 0117: the migrate step runs before the
-- stack is rebuilt, and a scheduler that starts reads every subject (§3).
-- Members must be told the new close times before the release ships.
UPDATE swarm_subjects AS s
   SET epoch_duration_seconds = 86400,
       epoch_anchor = v.anchor,
       version = s.version + 1,
       updated_at = now()
  FROM (VALUES
    ('robotmoney-vault',      '2026-10-10 00:52:19.990+00'::timestamptz),
    ('woon',                  '2026-10-10 06:52:19.990+00'::timestamptz),
    ('robotmoney-allocation', '2026-10-10 12:52:19.990+00'::timestamptz),
    ('robotmoney-treasury',   '2026-10-10 18:52:19.990+00'::timestamptz)
  ) AS v(id, anchor)
 WHERE s.id = v.id
   AND (s.epoch_duration_seconds IS DISTINCT FROM 86400
        OR s.epoch_anchor IS DISTINCT FROM v.anchor);
