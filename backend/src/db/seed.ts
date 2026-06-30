// Idempotent seed of job_schedules so the worker runs the analytics suite on its
// own — no manual admin trigger needed. UPSERTs on the natural key (kind, cron)
// from migration 0005, so repeated runs (every boot / migrate) never duplicate
// rows. Runs as part of `bun run migrate` (migrate.ts calls seed() after DDL).
//
// Dev-safe: the only seeded schedule is analytics.run, whose handler upserts on
// natural keys, so an extra firing is harmless. We DO NOT touch next_run_at /
// enabled on an existing row — that lets the scheduler own slot bookkeeping and
// lets an operator disable a schedule without the seed re-enabling it.
import { sql, closeDb } from "./client.ts";

interface SeedSchedule {
  kind: string;
  cron: string;
  payload: Record<string, unknown>;
  timezone: string;
  enabled: boolean;
}

// Keep this list small and harmless. Each kind MUST have a handler registered in
// backend/src/worker/handlers/index.ts and be idempotent on natural keys.
//
// Follow-up (intentionally NOT seeded here): the committee session lifecycle
// (open/brief/close/aggregate/publish) needs dedicated job handlers that do not
// yet exist; seeding it now would enqueue jobs with "no handler registered".
// Add those handlers, then add their schedules to this list.
const SCHEDULES: SeedSchedule[] = [
  // Daily 06:00 UTC: refresh the analytics suite (regime + research signals).
  { kind: "analytics.run", cron: "0 6 * * *", payload: {}, timezone: "UTC", enabled: true },
];

export async function seed(): Promise<void> {
  for (const s of SCHEDULES) {
    // ON CONFLICT DO NOTHING keeps this purely additive/idempotent: the row is
    // inserted once and never overwritten, so the scheduler-managed columns
    // (next_run_at, last_enqueued_at, enabled) survive untouched.
    await sql`
      INSERT INTO job_schedules (kind, cron, payload, timezone, enabled)
      VALUES (${s.kind}, ${s.cron}, ${sql.json(s.payload)}, ${s.timezone}, ${s.enabled})
      ON CONFLICT (kind, cron) DO NOTHING
    `;
  }
  console.log(`seeded job_schedules (${SCHEDULES.length} definition(s), idempotent)`);
}

// Run directly: `bun run src/db/seed.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then(closeDb)
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
      return closeDb();
    });
}
