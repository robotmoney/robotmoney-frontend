-- compat: additive
-- metadata_version: 1
--
-- One session per subject per day (owner decision, 2026-10-09).
--
-- WHY. Before the v0.6.0 cutover production met each subject once a day: four
-- subjects took turns on a 6 h window each, vault about 00:xx, woon 06:xx,
-- allocation 12:xx, treasury 18:xx, one open at a time. v0.6.0 (runbook blocker
-- B3) read "6 h" as the per-subject cadence and ran every subject back to back,
-- 16 sessions a day instead of 4. The 6 h figure was the window length.
--
-- WHAT IT DOES. Sets `epoch_duration_seconds = 86400` and the grid anchor for the
-- four production subjects, to the values production already holds. An operator
-- applied these by hand through the admin route at 16:55 UTC on 2026-10-09 (a
-- production edit outside a migration, against the owner's rule that production
-- is changed only by migration). This file records them so every other database
-- converges on the same grid and a rebuilt production keeps it.
--
--   robotmoney-vault       anchor 2026-10-10 00:52:19.990+00
--   woon                   anchor 2026-10-10 06:58:21.970+00
--   robotmoney-allocation  anchor 2026-10-10 13:00:42.491+00
--   robotmoney-treasury    anchor 2026-10-09 19:03:59.504+00
--
-- ON PRODUCTION THIS IS A NO-OP: the WHERE clause matches only a row whose
-- duration or anchor differs, so an applied-by-hand row is untouched, its
-- `version` does not move, and no open window's `window_closes_at` is read or
-- written. An open window keeps the close it was opened with either way (§2.2).
--
-- A SUBJECT THAT IS NOT THERE IS SKIPPED. A blank database holds no such row
-- before bootstrap and the demo seed uses other ids, so nothing is created.
--
-- NO `subject.changed` EVENT. Scheduler spec §2.3 says scheduling columns change
-- only through the admin route, which publishes the event the running clock
-- re-reads. A migration cannot publish it from here (stream events are written
-- by the API). It does not need to: the migrate step runs before the stack is
-- rebuilt, and a scheduler that starts reads every subject. This is a
-- deliberate, documented exception to §2.3 for a change the owner ordered.
UPDATE swarm_subjects AS s
   SET epoch_duration_seconds = 86400,
       epoch_anchor = v.anchor,
       version = s.version + 1,
       updated_at = now()
  FROM (VALUES
    ('robotmoney-vault',      '2026-10-10 00:52:19.990+00'::timestamptz),
    ('woon',                  '2026-10-10 06:58:21.970+00'::timestamptz),
    ('robotmoney-allocation', '2026-10-10 13:00:42.491+00'::timestamptz),
    ('robotmoney-treasury',   '2026-10-09 19:03:59.504+00'::timestamptz)
  ) AS v(id, anchor)
 WHERE s.id = v.id
   AND (s.epoch_duration_seconds IS DISTINCT FROM 86400
        OR s.epoch_anchor IS DISTINCT FROM v.anchor);
