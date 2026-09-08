-- Issue #780: ensureSmokeSubjectFixtures (backend/src/swarm/domain.ts) upserted
-- swarm_subjects with `ON CONFLICT ... DO UPDATE SET recommendation_type =
-- EXCLUDED.recommendation_type` — always 'position_actions', clobbering any
-- existing value on every smoke-session start. DEMO_SUBJECTS
-- (scripts/lib/smoke-mode.ts) reuses the live portfolio's own subject id
-- ("woon"), and the simulation initializer (scripts/lib/swarm/session.ts)
-- called the admin action that runs this upsert before every smoke session —
-- reachable against a real deployment, not only a scratch database. Every live
-- subject, including robotmoney-vault and robotmoney-allocation (whose
-- manifests declare bucket_weights), got silently rewritten to
-- 'position_actions'. That is why the vault's target weights stopped
-- appearing: sessionWeights() (frontend/public/assets/js/app/alpine/views/
-- swarm.js) returns null for position_actions and renders "No weight change"
-- rather than inventing a number.
--
-- The upsert itself is fixed in the same PR (COALESCE, matching the
-- protection thesis_blurb already had). This migration self-heals the two
-- known-affected subjects on deploy rather than requiring a manual prod SQL
-- edit — restricted to exactly the subjects the swarm PRD names as
-- bucket_weights, and only touching a row still showing the clobbered value,
-- so a subject legitimately running position_actions is left alone.
--
-- Idempotent and safe to run again: once both subjects already read
-- bucket_weights, the WHERE clause matches nothing.
UPDATE swarm_subjects
   SET recommendation_type = 'bucket_weights'
 WHERE id IN ('robotmoney-vault', 'robotmoney-allocation')
   AND recommendation_type = 'position_actions';
