-- compat: breaking
-- metadata_version: 1
--
-- rm_worker holds no privilege (issue 1034, decision D75).
--
-- WHY. Only the api holds a database credential. The pipeline worker claims,
-- renews and settles its jobs and writes its samples through /api/pipeline/**
-- with its pipeline-worker token (0126), and its compositions carry no database
-- URL. A role nothing logs in as must not keep the grants 0016, 0054, 0061,
-- 0062, 0109 and 0113 gave it: a leaked rm_worker password would otherwise
-- still read every table and write the job queue and the sample tables.
--
-- WHAT IT REVOKES. Every table and sequence privilege, the schema USAGE, and
-- rm_owner's default grants to rm_worker on future tables and sequences.
-- backend/schema/grants.sql re-asserts the same on every migrate run.
--
-- WHAT IT LEAVES. The role itself. Dropping it, or setting it NOLOGIN, needs
-- CREATEROLE, which rm_owner does not hold (smoke spec §3). That is a later
-- receipted operator step. A role with no USAGE on the schema can read nothing.
--
-- WHY `breaking` (spec §8.4: "no privilege it needs is revoked"). A pipeline
-- worker built before this release connects as rm_worker and needs these
-- grants. Code at this release never connects as rm_worker, so the label only
-- closes the rollback to a release whose worker still does.
--
-- IDEMPOTENT ON RE-APPLY: a REVOKE of a privilege not held is a no-op
-- (tests/rm-worker-retired.test.ts applies it twice).

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM rm_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM rm_worker;
REVOKE ALL ON SCHEMA public FROM rm_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public REVOKE ALL ON TABLES FROM rm_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM rm_worker;
