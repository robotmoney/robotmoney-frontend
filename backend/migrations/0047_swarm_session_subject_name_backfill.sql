-- One-time backfill: swarm_sessions.subject_name is denormalized off
-- swarm_subjects.name (migration 0001_backends.sql) and, until swarm/admin.ts's
-- updateSubjectAdmin started writing it in the same transaction (issue #779),
-- no admin route ever touched it. A subject rename fixed /swarm and
-- /swarm/subjects/:id and left every past session showing the old name on
-- member track records. #756 already renamed two subjects (`woon` to "Woon
-- Treasury", `robotmoney-treasury` to "RM Protocol Labs Treasury") before this
-- landed, so those subjects' sessions are exactly the rows this heals — but the
-- UPDATE is general, not name-specific: it re-syncs every session whose
-- subject_name has drifted from its subject's current name, whichever subject
-- that turns out to be.
--
-- Idempotent and safe to run again: once every session agrees with its
-- subject's current name, the WHERE clause matches nothing.
UPDATE swarm_sessions s
   SET subject_name = sub.name
  FROM swarm_subjects sub
 WHERE s.subject_id = sub.id
   AND s.subject_name IS DISTINCT FROM sub.name;
