-- rm_readonly must be able to read sequence state, because it is the role the
-- BACKUP runs as (issue #699; docs/runbooks/rollout-procedure.md §5.1).
--
-- WHAT WENT WRONG. `pg_dump` reads every sequence's `last_value` to reproduce
-- it in the dump. Running as rm_readonly against production it failed:
--
--   pg_dump: error: failed to get data for sequence "analytics_data_vintages_id_seq";
--            user may lack SELECT privilege on the sequence
--
-- Twelve of forty sequences in `public` denied rm_readonly a read. They are
-- exactly the twelve created by 0056-0060, each of which ends with a hardening
-- block of the shape:
--
--   REVOKE ALL ON SEQUENCE <new sequences> FROM PUBLIC, rm_worker, rm_readonly;
--   GRANT  SELECT ON <new tables> TO rm_readonly;
--
-- So each of those migrations granted rm_readonly SELECT on the TABLE and, in
-- the same breath, took away its ability to read that table's sequence.
--
-- WHY THAT IS OVER-HARDENING RATHER THAN POLICY. A role that can already
-- SELECT every row of `analytics_data_vintages` learns nothing from
-- `analytics_data_vintages_id_seq.last_value` that the rows do not already
-- tell it -- the counter is strictly less information than the table. It is
-- not a privilege boundary; it is the same boundary spelled twice, once
-- correctly and once as a denial. What the denial DOES do is break the backup,
-- silently: nothing at runtime reads those sequences as rm_readonly, so the
-- only consumer is pg_dump, and the only symptom is the P3.backup gate of the
-- NEXT release failing. That is where this was found.
--
-- 0053 CONTRIBUTES A SECOND, SMALLER GAP, fixed here too. It revokes the
-- default privilege on both tables and sequences (lines 103-104) and restores
-- it for tables only (line 118) -- there is no SEQUENCES counterpart. So even
-- a migration that does NOT revoke explicitly would leave its sequence
-- unreadable. Restoring the default is what makes the normal case correct
-- without every future migration having to remember.
--
-- IDEMPOTENT. Both statements are absolute assignments over a set; re-running
-- reaches the same state. Runs as rm_owner (migrate.ts SET LOCAL ROLE, 0054+),
-- which owns every sequence here and may therefore grant on it.

-- 1. REPAIR: every sequence that exists right now, including the twelve.
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO rm_readonly;

-- 2. PREVENT: the default 0053 revoked and never restored, so a sequence
--    created later is readable without anyone remembering to say so.
ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO rm_readonly;
