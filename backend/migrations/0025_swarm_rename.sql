-- Committee → swarm rename, pass 2 (issue #263; supersedes pass 1's #262/D-series
-- backend-copy-only rename). Renames every live committee_* table, the one
-- committee_-prefixed column, and every explicitly-named or auto-generated
-- constraint/index derived from those table names, so the schema no longer
-- says "committee" anywhere. Forward-only and idempotent-safe: every
-- statement targets an object that either already has its final name (a
-- second run is then a no-op via the RENAME-to-self guard implied by
-- `DO $$ ... EXCEPTION WHEN duplicate_table/undefined_table THEN NULL END $$`
-- is unnecessary here because Postgres's `ALTER ... RENAME` on an
-- already-renamed object simply errors "does not exist" on a second run,
-- which the migration runner (backend/src/db/migrate.ts) tolerates by never
-- re-applying a migration once recorded in schema_migrations — this file
-- only ever executes once per database.
--
-- Two tables from 0001_backends.sql (committee_takes, committee_submissions)
-- were already dropped as vestigial prototype remnants by
-- 0006_committee_reconcile.sql — they do not exist and are NOT touched here.
--
-- REVERSE (manual recovery only — this runner has no automated rollback):
-- run every RENAME below with old/new swapped, in the reverse order they
-- appear in this file (undo the column rename first, then each table's
-- constraint/index renames, then the table renames themselves).

-- ── committee_members → swarm_members ──────────────────────────────────────
ALTER TABLE committee_members RENAME TO swarm_members;
ALTER TABLE swarm_members RENAME CONSTRAINT committee_members_pkey TO swarm_members_pkey;
ALTER TABLE swarm_members RENAME CONSTRAINT committee_members_status_check TO swarm_members_status_check;

-- ── committee_subjects → swarm_subjects ─────────────────────────────────────
ALTER TABLE committee_subjects RENAME TO swarm_subjects;
ALTER TABLE swarm_subjects RENAME CONSTRAINT committee_subjects_pkey TO swarm_subjects_pkey;
ALTER TABLE swarm_subjects RENAME CONSTRAINT committee_subjects_status_check TO swarm_subjects_status_check;

-- ── committee_sessions → swarm_sessions ─────────────────────────────────────
-- (0022_committee_session_convened_at.sql already dropped the auto-named
-- UNIQUE(date, subject_id) constraint and the plain `date` column it backed,
-- so neither is renamed here — they no longer exist.)
ALTER TABLE committee_sessions RENAME TO swarm_sessions;
ALTER TABLE swarm_sessions RENAME COLUMN committee_recommendation TO swarm_recommendation;
ALTER TABLE swarm_sessions RENAME CONSTRAINT committee_sessions_pkey TO swarm_sessions_pkey;
ALTER TABLE swarm_sessions RENAME CONSTRAINT committee_sessions_state_check TO swarm_sessions_state_check;
ALTER TABLE swarm_sessions RENAME CONSTRAINT committee_sessions_subject_fk TO swarm_sessions_subject_fk;
ALTER INDEX committee_sessions_subject_convened_key RENAME TO swarm_sessions_subject_convened_key;
ALTER INDEX committee_sessions_subject_convened_desc_idx RENAME TO swarm_sessions_subject_convened_desc_idx;

-- ── committee_briefs → swarm_briefs ─────────────────────────────────────────
ALTER TABLE committee_briefs RENAME TO swarm_briefs;
ALTER TABLE swarm_briefs RENAME CONSTRAINT committee_briefs_pkey TO swarm_briefs_pkey;
ALTER TABLE swarm_briefs RENAME CONSTRAINT committee_briefs_date_subject_id_key TO swarm_briefs_date_subject_id_key;
ALTER TABLE swarm_briefs RENAME CONSTRAINT committee_briefs_subject_fk TO swarm_briefs_subject_fk;

-- ── committee_subject_snapshots → swarm_subject_snapshots ───────────────────
ALTER TABLE committee_subject_snapshots RENAME TO swarm_subject_snapshots;
ALTER TABLE swarm_subject_snapshots RENAME CONSTRAINT committee_subject_snapshots_pkey TO swarm_subject_snapshots_pkey;
ALTER TABLE swarm_subject_snapshots RENAME CONSTRAINT committee_subject_snapshots_subject_id_date_key TO swarm_subject_snapshots_subject_id_date_key;
ALTER TABLE swarm_subject_snapshots RENAME CONSTRAINT committee_subject_snapshots_subject_fk TO swarm_subject_snapshots_subject_fk;

-- ── committee_applications → swarm_applications ─────────────────────────────
ALTER TABLE committee_applications RENAME TO swarm_applications;
ALTER TABLE swarm_applications RENAME CONSTRAINT committee_applications_pkey TO swarm_applications_pkey;
ALTER TABLE swarm_applications RENAME CONSTRAINT committee_applications_status_check TO swarm_applications_status_check;

-- ── committee_member_keys → swarm_member_keys ───────────────────────────────
ALTER TABLE committee_member_keys RENAME TO swarm_member_keys;
ALTER TABLE swarm_member_keys RENAME CONSTRAINT committee_member_keys_pkey TO swarm_member_keys_pkey;
ALTER INDEX committee_member_keys_member_idx RENAME TO swarm_member_keys_member_idx;
ALTER INDEX committee_member_keys_token_idx RENAME TO swarm_member_keys_token_idx;

-- ── committee_recommendations → swarm_recommendations ───────────────────────
ALTER TABLE committee_recommendations RENAME TO swarm_recommendations;
ALTER TABLE swarm_recommendations RENAME CONSTRAINT committee_recommendations_pkey TO swarm_recommendations_pkey;
ALTER TABLE swarm_recommendations RENAME CONSTRAINT committee_recommendations_session_id_member_id_key TO swarm_recommendations_session_id_member_id_key;
ALTER TABLE swarm_recommendations RENAME CONSTRAINT committee_recommendations_member_id_nonce_key TO swarm_recommendations_member_id_nonce_key;
ALTER TABLE swarm_recommendations RENAME CONSTRAINT committee_recommendations_subject_fk TO swarm_recommendations_subject_fk;
ALTER INDEX committee_recommendations_session_idx RENAME TO swarm_recommendations_session_idx;

-- ── committee_memos → swarm_memos ───────────────────────────────────────────
ALTER TABLE committee_memos RENAME TO swarm_memos;
ALTER TABLE swarm_memos RENAME CONSTRAINT committee_memos_pkey TO swarm_memos_pkey;

-- ── committee_session_members → swarm_session_members ───────────────────────
ALTER TABLE committee_session_members RENAME TO swarm_session_members;
ALTER TABLE swarm_session_members RENAME CONSTRAINT committee_session_members_pkey TO swarm_session_members_pkey;
ALTER TABLE swarm_session_members RENAME CONSTRAINT committee_session_members_status_check TO swarm_session_members_status_check;

-- ── committee_session_events → swarm_session_events ─────────────────────────
ALTER TABLE committee_session_events RENAME TO swarm_session_events;
ALTER TABLE swarm_session_events RENAME CONSTRAINT committee_session_events_pkey TO swarm_session_events_pkey;
ALTER INDEX committee_session_events_session_idx RENAME TO swarm_session_events_session_idx;

-- ── committee_claim_challenges → swarm_claim_challenges ─────────────────────
ALTER TABLE committee_claim_challenges RENAME TO swarm_claim_challenges;
ALTER TABLE swarm_claim_challenges RENAME CONSTRAINT committee_claim_challenges_pkey TO swarm_claim_challenges_pkey;
ALTER TABLE swarm_claim_challenges RENAME CONSTRAINT committee_claim_challenges_challenge_key TO swarm_claim_challenges_challenge_key;
ALTER TABLE swarm_claim_challenges RENAME CONSTRAINT committee_claim_challenges_expiry_check TO swarm_claim_challenges_expiry_check;
ALTER INDEX committee_claim_challenges_expiry_idx RENAME TO swarm_claim_challenges_expiry_idx;

-- ── committee_notification_outbox → swarm_notification_outbox ───────────────
ALTER TABLE committee_notification_outbox RENAME TO swarm_notification_outbox;
ALTER TABLE swarm_notification_outbox RENAME CONSTRAINT committee_notification_outbox_pkey TO swarm_notification_outbox_pkey;
ALTER TABLE swarm_notification_outbox RENAME CONSTRAINT committee_notification_outbox_kind_member_id_key TO swarm_notification_outbox_kind_member_id_key;
ALTER TABLE swarm_notification_outbox RENAME CONSTRAINT committee_notification_outbox_kind_check TO swarm_notification_outbox_kind_check;
ALTER INDEX committee_notification_outbox_pending_idx RENAME TO swarm_notification_outbox_pending_idx;

-- ── committee_agent_health_events → swarm_agent_health_events ───────────────
ALTER TABLE committee_agent_health_events RENAME TO swarm_agent_health_events;
ALTER TABLE swarm_agent_health_events RENAME CONSTRAINT committee_agent_health_events_pkey TO swarm_agent_health_events_pkey;
ALTER TABLE swarm_agent_health_events RENAME CONSTRAINT committee_agent_health_events_event_type_check TO swarm_agent_health_events_event_type_check;
ALTER INDEX committee_agent_health_events_session_idx RENAME TO swarm_agent_health_events_session_idx;
ALTER INDEX committee_agent_health_events_member_idx RENAME TO swarm_agent_health_events_member_idx;
ALTER INDEX committee_agent_health_events_type_idx RENAME TO swarm_agent_health_events_type_idx;
ALTER INDEX committee_agent_health_events_absent_once_idx RENAME TO swarm_agent_health_events_absent_once_idx;

-- ── committee_waitlist → swarm_waitlist ──────────────────────────────────────
ALTER TABLE committee_waitlist RENAME TO swarm_waitlist;
ALTER TABLE swarm_waitlist RENAME CONSTRAINT committee_waitlist_pkey TO swarm_waitlist_pkey;
ALTER INDEX committee_waitlist_email_norm_uq RENAME TO swarm_waitlist_email_norm_uq;
