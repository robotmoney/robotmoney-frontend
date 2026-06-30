-- Natural key for job_schedules so the seed (backend/src/db/seed.ts) can UPSERT
-- idempotently. (kind, cron) uniquely identifies a recurring slot definition;
-- re-running the seed must never duplicate rows. This is the ON CONFLICT target.
CREATE UNIQUE INDEX IF NOT EXISTS job_schedules_kind_cron_idx
  ON job_schedules (kind, cron);
