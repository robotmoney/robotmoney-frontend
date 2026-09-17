-- Migration 0059 (issue #960): cleanup fabricated snapshots on framework subjects.
--
-- Framework subjects (source->>'type' = 'framework') have no portfolio to scrape:
-- the subject IS the allocation framework state rather than a book of holdings.
-- ensureSmokeSubjectFixtures previously wrote synthetic snapshots for any subject
-- not named woon or mav, producing fabricated holdings for framework subjects like
-- robotmoney-allocation.
--
-- swarm_subject_snapshots is append-only protected by rm_append_only_guard()
-- (migration 0032). In order to delete the fabricated snapshots, the statement
-- and row append-only triggers are temporarily disabled within this migration
-- transaction and re-enabled as ENABLE ALWAYS.
--
-- Safe and idempotent on rerun: once fabricated snapshots for framework subjects
-- are deleted, subsequent runs match 0 rows.

ALTER TABLE swarm_subject_snapshots DISABLE TRIGGER swarm_subject_snapshots_append_only;
ALTER TABLE swarm_subject_snapshots DISABLE TRIGGER swarm_subject_snapshots_append_only_row;

DELETE FROM swarm_subject_snapshots
 USING swarm_subjects
 WHERE swarm_subject_snapshots.subject_id = swarm_subjects.id
   AND swarm_subjects.source->>'type' = 'framework';

ALTER TABLE swarm_subject_snapshots ENABLE ALWAYS TRIGGER swarm_subject_snapshots_append_only;
ALTER TABLE swarm_subject_snapshots ENABLE ALWAYS TRIGGER swarm_subject_snapshots_append_only_row;
