-- compat: additive
-- metadata_version: 1
--
-- The vault subject's take carries no weight vector (owner decision,
-- 2026-10-09; docs/post-mortems/2026-10-09T1704Z-0.6.0-upgrade.md).
--
-- WHY. `robotmoney-vault` reviews how the vault's ACTUAL holdings drift from
-- the targets; `robotmoney-allocation` reviews whether the targets themselves
-- should change. A weight vector answers the allocation question, so it has no
-- place in a vault take. v0.6.0 made the vector mandatory on every
-- `bucket_weights` subject (domain.ts submitRecommendation), and the vault was
-- typed `bucket_weights`, so every external member that followed the published
-- docs (weights only "when the brief names allocation buckets"; the vault brief
-- names none) was refused with 400 `weights_required_for_bucket_weights_subject`.
-- Woon and ShodAI filed weightless vault takes for two months before the
-- cutover and every one was accepted.
--
-- WHAT IT DOES. Types the vault subject `position_actions`, as `robotmoney-treasury`
-- and `woon` are. The four-weight rule then never fires for it and its brief
-- marks `takeSchema.weights.optional = true`. `robotmoney-allocation` stays
-- `bucket_weights`.
--
-- WHAT IT REVERSES. Migration 0051 (issue 780) set the vault to `bucket_weights`
-- because a smoke upsert had clobbered it and the swarm page then rendered "No
-- weight change" for the vault. That repair restored the previous production
-- type. This migration changes that type on purpose; the swarm page stops
-- drawing target weights for NEW vault sessions. Sessions already published keep
-- the rollup type they were published with (the receipt reads the stored
-- rollup, not the subject row), so no past receipt changes.
--
-- IDEMPOTENT. Matches only a vault still typed `bucket_weights`. `version` and
-- `updated_at` move as an admin edit moves them, so a stale admin write
-- (409 stale_version) cannot overwrite this. No `subject.changed` event is
-- written: no scheduling column changes, and the type is read at submit and at
-- aggregation, never cached by the scheduler.
UPDATE swarm_subjects
   SET recommendation_type = 'position_actions',
       version = version + 1,
       updated_at = now()
 WHERE id = 'robotmoney-vault'
   AND recommendation_type = 'bucket_weights';
