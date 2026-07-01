// Idempotent seed of job_schedules so the worker runs the analytics suite on its
// own — no manual admin trigger needed. UPSERTs on the natural key (kind, cron)
// from migration 0005, so repeated runs (every boot / migrate) never duplicate
// rows. Runs as part of `bun run migrate` (migrate.ts calls seed() after DDL).
//
// Dev-safe: the only seeded schedule is analytics.run, whose handler upserts on
// natural keys, so an extra firing is harmless. We DO NOT touch next_run_at /
// enabled on an existing row — that lets the scheduler own slot bookkeeping and
// lets an operator disable a schedule without the seed re-enabling it.
import { sql, closeDb, jsonValue } from "./client.ts";

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
// Committee schedules are intentionally no-cron (never auto-enqueued by the
// scheduler). The demo script enqueues lifecycle jobs explicitly via the
// admin enqueue-job endpoint, which lets the demo control the pace while still
// exercising the real worker claim loop + handler path. Scheduled cron
// triggering (e.g. daily open_session) is a future addition.
const SCHEDULES: SeedSchedule[] = [
  // Daily 22:30 UTC: refresh the analytics suite (regime + research signals).
  // After the US equity close (21:00 UTC) + FRED's daily refresh, mirroring the
  // original scripts/regime cron so the fetched raw is the settled end-of-day data.
  { kind: "analytics.run", cron: "30 22 * * *", payload: {}, timezone: "UTC", enabled: true },
  // Committee lifecycle — disabled by default; the demo enqueues these explicitly
  // via the admin enqueue-job endpoint, exercising the real worker claim loop +
  // handler path. Enable manually or change to a real cron for auto-scheduling.
  { kind: "committee.open_session", cron: "0 6 * * *", payload: {}, timezone: "UTC", enabled: false },
  { kind: "committee.publish_brief", cron: "0 7 * * *", payload: {}, timezone: "UTC", enabled: false },
  { kind: "committee.close_window", cron: "0 8 * * *", payload: {}, timezone: "UTC", enabled: false },
  { kind: "committee.aggregate", cron: "0 9 * * *", payload: {}, timezone: "UTC", enabled: false },
  { kind: "committee.publish", cron: "0 10 * * *", payload: {}, timezone: "UTC", enabled: false },
];

// Fast demo schedules — ONLY added when DEMO_FAST_SCHEDULES is set (the demo
// script sets it on the migrate/seed run). Prod/CI leave the flag unset, so the
// default seed above is byte-for-byte unchanged there.
//
// These drive the worker's scheduler at a ~2-minute cadence and are STAGGERED by
// different cron minute offsets (cron is minute-granularity) so the two analytics
// action types never fire in the same minute:
//   - regime.classify (regime-only)      → even minutes  (*/2)
//   - analytics.run    (regime+research) → odd minutes   (1-59/2, offset by 1)
// New (kind, cron) combos, so ON CONFLICT DO NOTHING inserts them once and lets
// the scheduler own next_run_at/enabled bookkeeping thereafter.
const FAST_DEMO_SCHEDULES: SeedSchedule[] = [
  { kind: "regime.classify", cron: "*/2 * * * *", payload: {}, timezone: "UTC", enabled: true },
  { kind: "analytics.run", cron: "1-59/2 * * * *", payload: {}, timezone: "UTC", enabled: true },
];

export async function seed(): Promise<void> {
  const schedules = process.env.DEMO_FAST_SCHEDULES
    ? [...SCHEDULES, ...FAST_DEMO_SCHEDULES]
    : SCHEDULES;
  for (const s of schedules) {
    // ON CONFLICT DO NOTHING keeps this purely additive/idempotent: the row is
    // inserted once and never overwritten, so the scheduler-managed columns
    // (next_run_at, last_enqueued_at, enabled) survive untouched.
    await sql`
      INSERT INTO job_schedules (kind, cron, payload, timezone, enabled)
      VALUES (${s.kind}, ${s.cron}, ${sql.json(jsonValue(s.payload))}, ${s.timezone}, ${s.enabled})
      ON CONFLICT (kind, cron) DO NOTHING
    `;
  }
  console.log(`seeded job_schedules (${schedules.length} definition(s), idempotent)`);
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
