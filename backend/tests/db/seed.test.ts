// Seed invariants for the wallet-balance sampling schedule (issue #118): chain
// reads happen ONLY on the schedule, so the baseline sampler must run every
// minute and a cold-start job must fill the table within seconds of boot. Under
// DEMO_MODE the cadence is deliberately HOURLY instead (per-IP quota
// protection — the standing demo and the self-hosted CI runner share one host
// IP, and per-minute GeckoTerminal/Base-RPC sampling exhausts both quotas),
// which is also proven here — as is the same treatment for the demo's
// regime.classify / research.refresh analytics rows (issue #287). Runs against the ephemeral Postgres from
// tests/preload.ts (already migrated + seeded once); seed()/seedJobSchedules()
// are idempotent, so re-invoking them here is safe and self-contained.
import { afterEach, expect, test } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { SCHEDULES, seed, seedJobSchedules } from "../../src/db/seed.ts";
import { resolveSwarmSchedules } from "../../src/config.ts";
import { tickScheduler } from "../../src/worker/scheduler.ts";

// Every test in this file must leave the shared ephemeral Postgres on the
// PRODUCTION baseline (later test files, e.g. tests/api/admin-surface.test.ts,
// assert against it): clear the demo flag, drop any demo-only rows, and re-arm
// the per-minute baseline the DEMO_MODE path disables.
afterEach(async () => {
  delete process.env.DEMO_MODE;
  await sql`DELETE FROM job_schedules WHERE kind = 'wallet.sample_balances' AND cron <> '* * * * *'`;
  await sql`UPDATE job_schedules SET enabled = true WHERE kind = 'wallet.sample_balances' AND cron = '* * * * *'`;
  // Demo-cadence + pre-#287 analytics rows: the production baseline keeps only
  // the two daily rows for these kinds.
  await sql`
    DELETE FROM job_schedules
     WHERE kind IN ('regime.classify', 'research.refresh')
       AND cron NOT IN ('30 22 * * *', '0 23 * * *')`;
  // Issue #399: DEMO_MODE disables projects.recompute_coverage in place (no
  // second demo-cadence row, unlike wallet.sample_balances above) — re-arm it
  // so later test files sharing this ephemeral Postgres see the production
  // baseline enabled.
  await sql`UPDATE job_schedules SET enabled = true WHERE kind = 'projects.recompute_coverage' AND cron = '0 3 * * *'`;
});

test("cadence (#118): seed registers wallet.sample_balances at the every-minute cron '* * * * *'", async () => {
  delete process.env.DEMO_MODE; // prod-shaped seed
  await seed(); // idempotent (ON CONFLICT DO NOTHING throughout)
  const rows = await sql<{ cron: string; enabled: boolean }[]>`
    SELECT cron, enabled FROM job_schedules WHERE kind = 'wallet.sample_balances'
  `;
  // On a fresh prod/CI DB only the every-minute schedule exists — and it is
  // ENABLED. (The hourly row + per-minute disable are demo-gated below; the
  // prod seed stays byte-for-byte unchanged with DEMO_MODE unset.)
  expect(rows).toHaveLength(1);
  expect(rows[0]!.cron).toBe("* * * * *");
  expect(rows[0]!.enabled).toBe(true);
});

test("demo cadence (quota protection): DEMO_MODE seeds an ENABLED hourly sampler and DISABLES the per-minute baseline", async () => {
  delete process.env.DEMO_MODE;
  await seed(); // establish the production baseline first (fresh-boot shape)
  process.env.DEMO_MODE = "1";
  await seedJobSchedules(); // the demo migrate/seed one-shot re-runs this with the flag set
  await seedJobSchedules(); // idempotent: a re-run (every boot) must not change the outcome
  const rows = await sql<{ cron: string; enabled: boolean }[]>`
    SELECT cron, enabled FROM job_schedules WHERE kind = 'wallet.sample_balances' ORDER BY cron
  `;
  const byCron = Object.fromEntries(rows.map((r) => [r.cron, r.enabled]));
  // The conflict key is (kind, cron): the hourly row COEXISTS with the
  // per-minute baseline, so disabling the baseline is what switches the demo
  // to hourly sampling. Minute 3 staggers it off vault.sample_share_price
  // ("0 * * * *") — cron is minute-granularity.
  expect(rows).toHaveLength(2);
  expect(byCron["3 * * * *"]).toBe(true);
  expect(byCron["* * * * *"]).toBe(false);
});

test("demo cadence never re-enables an operator-disabled hourly row (seed stays ON CONFLICT DO NOTHING)", async () => {
  process.env.DEMO_MODE = "1";
  await seedJobSchedules();
  await sql`UPDATE job_schedules SET enabled = false WHERE kind = 'wallet.sample_balances' AND cron = '3 * * * *'`;
  await seedJobSchedules(); // re-boot: must not flip the operator's disable back on
  const rows = await sql<{ enabled: boolean }[]>`
    SELECT enabled FROM job_schedules WHERE kind = 'wallet.sample_balances' AND cron = '3 * * * *'
  `;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.enabled).toBe(false);
});

test("without DEMO_MODE a later seed re-run leaves the baseline untouched (no hourly row, per-minute stays enabled)", async () => {
  delete process.env.DEMO_MODE;
  await seedJobSchedules();
  const rows = await sql<{ cron: string; enabled: boolean }[]>`
    SELECT cron, enabled FROM job_schedules WHERE kind = 'wallet.sample_balances'
  `;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.cron).toBe("* * * * *");
  expect(rows[0]!.enabled).toBe(true);
});

test("cold start (#118): seed enqueues exactly ONE immediate wallet.sample_balances job (idempotent on dedupe_key)", async () => {
  await seed();
  const jobs = await sql<{ kind: string; status: string }[]>`
    SELECT kind, status FROM jobs WHERE dedupe_key = 'wallet.sample_balances:coldstart'
  `;
  expect(jobs).toHaveLength(1); // one immediate sample so the endpoint has fresh data at boot
  expect(jobs[0]!.kind).toBe("wallet.sample_balances");

  // Re-running seed must NOT enqueue a duplicate (constant dedupe_key + partial
  // unique index) — the scheduled cron owns steady-state sampling thereafter.
  await seed();
  const again = await sql<{ c: number }[]>`
    SELECT count(*)::int AS c FROM jobs WHERE dedupe_key = 'wallet.sample_balances:coldstart'
  `;
  expect(again[0]!.c).toBe(1);
});

test("cold start survives DEMO_MODE: the immediate enqueue is NOT demo-gated (the live-smoke gate needs live provenance within seconds)", async () => {
  await sql`DELETE FROM jobs WHERE dedupe_key = 'wallet.sample_balances:coldstart'`;
  process.env.DEMO_MODE = "1";
  await seed();
  const jobs = await sql<{ c: number }[]>`
    SELECT count(*)::int AS c FROM jobs WHERE dedupe_key = 'wallet.sample_balances:coldstart'
  `;
  expect(jobs[0]!.c).toBe(1);
});

// ---------------------------------------------------------------------------
// Demo analytics cadence (issue #287). The pre-#287 pair (`*/2` regime +
// `1-59/2` research) fired one analytics action EVERY minute against the public
// Base RPC; the standing demo shares a host IP with the self-hosted CI runner,
// so it exhausted the per-IP quota and starved CI's own demo-readiness gate
// (blocker #285). Both are HOURLY now, on distinct minutes, and the superseded
// rows are disabled on any database that already holds them.
// ---------------------------------------------------------------------------

interface ScheduleRow {
  kind: string;
  cron: string;
  enabled: boolean;
}
const plain = (rows: ScheduleRow[]): ScheduleRow[] =>
  rows
    .map((r) => ({ kind: r.kind, cron: r.cron, enabled: r.enabled }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.cron.localeCompare(b.cron));

const analyticsRows = async (): Promise<ScheduleRow[]> =>
  plain(
    await sql<ScheduleRow[]>`
      SELECT kind, cron, enabled FROM job_schedules
       WHERE kind IN ('regime.classify', 'research.refresh')`,
  );

test("demo analytics cadence (#287): legacy consumer schedules remain disabled for the independent producer", async () => {
  process.env.DEMO_MODE = "1";
  await seedJobSchedules();
  const byKey = Object.fromEntries((await analyticsRows()).map((r) => [`${r.kind}|${r.cron}`, r.enabled]));
  // Rows remain for migration compatibility, but the independent producer
  // owns the cadence and shared consumers must never claim these jobs.
  expect(byKey["regime.classify|7 * * * *"]).toBe(false);
  expect(byKey["research.refresh|37 * * * *"]).toBe(false);
  // The daily production rows are untouched by the demo path.
  expect(byKey["regime.classify|30 22 * * *"]).toBe(false);
});

test("demo analytics cadence (#287): seeding over pre-existing */2 rows leaves them DISABLED, and a re-run is a no-op", async () => {
  delete process.env.DEMO_MODE;
  await seedJobSchedules(); // production baseline first
  // An already-deployed demo, seeded before #287: both ~2-minute rows present
  // and ENABLED (edgar-seed-bootstrap flips research.refresh on in practice).
  await sql`
    INSERT INTO job_schedules (kind, cron, enabled)
    VALUES ('regime.classify', '*/2 * * * *', true),
           ('research.refresh', '1-59/2 * * * *', true)`;

  process.env.DEMO_MODE = "1";
  await seedJobSchedules(); // the demo's migrate/seed one-shot re-runs with the flag set
  const after = await analyticsRows();
  const byKey = Object.fromEntries(after.map((r) => [`${r.kind}|${r.cron}`, r.enabled]));
  // The conflict key is (kind, cron), so the hourly rows only COEXIST with the
  // superseded ones — disabling those is what actually switches the cadence.
  expect(byKey["regime.classify|*/2 * * * *"]).toBe(false);
  expect(byKey["research.refresh|1-59/2 * * * *"]).toBe(false);
  expect(byKey["regime.classify|7 * * * *"]).toBe(false);
  expect(byKey["research.refresh|37 * * * *"]).toBe(false);

  await seedJobSchedules(); // every boot re-runs it: idempotent (`AND enabled` guard)
  expect(await analyticsRows()).toEqual(after);
});

test("demo analytics cadence (#287): the disable is one-directional — an operator-disabled hourly row is never re-enabled", async () => {
  process.env.DEMO_MODE = "1";
  await seedJobSchedules();
  await sql`UPDATE job_schedules SET enabled = false WHERE kind = 'regime.classify' AND cron = '7 * * * *'`;
  await seedJobSchedules(); // re-boot must not flip the operator's disable back on
  const rows = await sql<{ enabled: boolean }[]>`
    SELECT enabled FROM job_schedules WHERE kind = 'regime.classify' AND cron = '7 * * * *'`;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.enabled).toBe(false);
});

// ---------------------------------------------------------------------------
// projects.recompute_coverage demo guard (issue #399). The handler recomputes
// data_coverage_score from live inputs, which would collapse
// seedDemoProjects()'s deliberately incomplete demo rows back below the
// /projects directory's MIN_SCORE gate (projects/projections.ts) — hiding
// them and defeating the point of seeding curated demo data. Guarded the same
// way as the wallet-sampler baseline above: a one-directional, idempotent
// UPDATE, not a second schedule row.
// ---------------------------------------------------------------------------

const recomputeCoverageRow = async (): Promise<{ enabled: boolean } | undefined> =>
  (
    await sql<{ enabled: boolean }[]>`
      SELECT enabled FROM job_schedules WHERE kind = 'projects.recompute_coverage' AND cron = '0 3 * * *'
    `
  )[0];

test("demo guard (#399): DEMO_MODE disables the canonical projects.recompute_coverage schedule on a fresh seed", async () => {
  delete process.env.DEMO_MODE;
  await sql`DELETE FROM job_schedules WHERE kind = 'projects.recompute_coverage'`;
  process.env.DEMO_MODE = "1";
  await seedJobSchedules(); // fresh insert (ON CONFLICT DO NOTHING) then the demo-gated disable
  const row = await recomputeCoverageRow();
  expect(row?.enabled).toBe(false);
});

test("demo guard (#399): re-seeding an EXISTING demo database disables a row left enabled by an older deployment (upgrade case)", async () => {
  delete process.env.DEMO_MODE;
  await seedJobSchedules(); // production baseline: row exists and enabled
  const before = await recomputeCoverageRow();
  expect(before?.enabled).toBe(true);

  process.env.DEMO_MODE = "1";
  await seedJobSchedules(); // simulates re-running seed against a pre-existing demo DB
  const after = await recomputeCoverageRow();
  expect(after?.enabled).toBe(false);

  await seedJobSchedules(); // idempotent: a later boot must not change the outcome
  expect((await recomputeCoverageRow())?.enabled).toBe(false);
});

test("demo guard (#399): idempotent — an operator-disabled row stays disabled across repeated seed runs", async () => {
  process.env.DEMO_MODE = "1";
  await seedJobSchedules();
  expect((await recomputeCoverageRow())?.enabled).toBe(false);
  await seedJobSchedules(); // every boot re-runs this; the `AND enabled` guard makes it a no-op
  await seedJobSchedules();
  expect((await recomputeCoverageRow())?.enabled).toBe(false);
});

test("demo guard (#399): with DEMO_MODE unset the production schedule remains enabled and unchanged", async () => {
  delete process.env.DEMO_MODE;
  await seedJobSchedules();
  const row = await recomputeCoverageRow();
  expect(row?.enabled).toBe(true);
});

test("demo guard (#399): a disabled schedule is never picked up by the scheduler (tickScheduler filters WHERE enabled)", async () => {
  process.env.DEMO_MODE = "1";
  await seedJobSchedules();
  expect((await recomputeCoverageRow())?.enabled).toBe(false);
  await sql`UPDATE job_schedules SET next_run_at = now() - interval '1 day' WHERE kind = 'projects.recompute_coverage'`;
  await tickScheduler();
  const jobs = await sql<{ c: number }[]>`
    SELECT count(*)::int AS c FROM jobs WHERE kind = 'projects.recompute_coverage'
  `;
  expect(jobs[0]!.c).toBe(0); // disabled row is never enqueued, so the handler never fires and demo scores stay untouched
});

test("without DEMO_MODE the seeded row set is byte-for-byte SCHEDULES (+ the env-configured swarm rows) — no demo cadence leaks into prod/CI", async () => {
  delete process.env.DEMO_MODE;
  await sql`DELETE FROM job_schedules`; // re-seeded immediately below (fresh-boot shape)
  await seedJobSchedules();
  const rows = plain(await sql<ScheduleRow[]>`SELECT kind, cron, enabled FROM job_schedules`);
  const expected = plain([
    ...SCHEDULES.map((s) => ({ kind: s.kind, cron: s.cron, enabled: s.enabled })),
    ...resolveSwarmSchedules().map((s) => ({ kind: s.kind, cron: s.cron, enabled: s.enabled })),
  ]);
  expect(rows).toEqual(expected);
});
