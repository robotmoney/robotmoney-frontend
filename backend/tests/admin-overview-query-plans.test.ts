// GET /api/admin/overview's per-kind reads plan on the kind indexes at
// production size (issue 1690, migration 0134).
//
// On production (2026-11-18) the overview hit the 5 s statement timeout
// (57014). For each monitored kind it reads the newest job and the newest run
// (src/admin/overview.ts). No index led with kind outside the live-only
// partial index, so the two kinds with no rows (regime.classify and
// research.refresh, which the analytics producer runs outside the queue)
// planned parallel sequential scans of jobs and job_runs: four full scans per
// request. Migration 0134 adds jobs_kind_id_idx (kind, id DESC) and
// job_runs_kind_started_idx (kind, started_at DESC).
//
// The tables are loaded to production's shape (350k rows each, 85% the two
// wallet samplers, no row of regime.classify or research.refresh), then
// VACUUMed and ANALYZEd. Then:
//   * EXPLAIN of the registered lastJob and lastRun probes, for every
//     MONITORED_KINDS entry, shows no Seq Scan on jobs or job_runs and uses the
//     new index, both in the generic plan Postgres keeps for a prepared
//     statement after five runs (what the api runs: the 2026-11-18 timeout was
//     a generic plan walking the primary key) and in each kind's own plan;
//   * getOverviewProjection runs under 500 ms (best of three after a warm-up);
//   * red control: with the two indexes dropped (in a transaction rolled
//     back), the same judge fails.
import { beforeAll, describe, expect, test } from "bun:test";
import { registeredSites } from "../src/db/registry.ts";
import { MONITORED_KINDS, getOverviewProjection } from "../src/admin/overview.ts";
import { explainText, flatten, type ExplainResult } from "../../scripts/release/jobs-query-plans.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { vacuumAnalyzeAsOwner } from "./support/vacuum-as-owner.ts";

useCleanDatabase(import.meta.file);

const ROWS = 350_000;
const READS = [
  { site: "src/admin/overview:getOverviewProjection.lastJob", table: "jobs", index: "jobs_kind_id_idx" },
  { site: "src/admin/overview:getOverviewProjection.lastRun", table: "job_runs", index: "job_runs_kind_started_idx" },
] as const;

class Rollback extends Error {}

function probeOf(site: string): string {
  const declaration = registeredSites().find((d) => d.site === site);
  if (!declaration?.probe) throw new Error(`no registered probe for ${site}`);
  return declaration.probe.statement;
}

/**
 * EXPLAIN (ANALYZE, BUFFERS) of `statement` run with `kind`, after `before`, in
 * a transaction that never commits. `generic`: the plan Postgres keeps for a
 * prepared statement after five runs, which is what the api's postgres.js
 * statements run on; otherwise the plan for this one kind.
 */
async function explain(statement: string, kind: string, generic: boolean, before = ""): Promise<ExplainResult> {
  let result: ExplainResult | undefined;
  await fixtureDb
    .begin(async (tx) => {
      if (before) await tx.unsafe(before);
      await tx.unsafe(`SET LOCAL plan_cache_mode = ${generic ? "force_generic_plan" : "force_custom_plan"}`);
      await tx.unsafe(`PREPARE overview_probe (text) AS ${statement}`);
      const rows = (await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE overview_probe('${kind.replace(/'/g, "''")}')`)) as unknown as {
        "QUERY PLAN": ExplainResult[];
      }[];
      result = rows[0]!["QUERY PLAN"][0]!;
      // A prepared statement outlives the rollback.
      await tx.unsafe("DEALLOCATE overview_probe");
      throw new Rollback();
    })
    .catch((error) => {
      if (!(error instanceof Rollback)) throw error;
    });
  return result!;
}

/** What is wrong with one read's plan: a Seq Scan on its table, or its table read through anything but `index`. */
function judge(table: string, index: string, result: ExplainResult): string[] {
  const nodes = flatten(result.Plan);
  const problems: string[] = [];
  if (nodes.some((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === table)) problems.push(`Seq Scan on ${table}`);
  if (!nodes.some((n) => n["Index Name"] === index)) problems.push(`does not use ${index}`);
  return problems;
}

beforeAll(async () => {
  // Production's shape: the two wallet samplers are 85% of the rows, the
  // project kinds share the rest; no row of regime.classify or research.refresh.
  const kindOf = `CASE WHEN g % 100 < 43 THEN 'wallet.sample_balances'
                       WHEN g % 100 < 85 THEN 'wallet.sample_sleeves'
                       ELSE (ARRAY['projects.discover','projects.refresh_coins','projects.refresh_wallets','projects.sync_revenue',
                                   'projects.snapshot_daily','projects.fetch_vaults','projects.recompute_coverage','kind.other'])[g % 8 + 1] END`;
  await fixtureDb.unsafe(`
    INSERT INTO jobs (kind, payload, status, attempts, created_at, updated_at, run_after)
    SELECT ${kindOf}, jsonb_build_object('note', repeat('x', 200)), 'succeeded', 1,
           now() - make_interval(mins => g), now() - make_interval(mins => g), now() - make_interval(mins => g)
      FROM generate_series(1, ${ROWS}) g`);
  await fixtureDb.unsafe(`
    INSERT INTO job_runs (kind, started_at, finished_at, status, output)
    SELECT ${kindOf}, now() - make_interval(mins => g), now() - make_interval(mins => g) + interval '2 seconds', 'succeeded',
           jsonb_build_object('note', repeat('y', 200))
      FROM generate_series(1, ${ROWS}) g`);
  await vacuumAnalyzeAsOwner("jobs", "job_runs");
  const [counts] = await fixtureDb<{ jobs: number; runs: number; none: number }[]>`
    SELECT (SELECT count(*) FROM jobs)::int AS jobs, (SELECT count(*) FROM job_runs)::int AS runs,
           (SELECT count(*) FROM jobs WHERE kind IN ('regime.classify', 'research.refresh'))::int
         + (SELECT count(*) FROM job_runs WHERE kind IN ('regime.classify', 'research.refresh'))::int AS none`;
  expect(counts!.jobs).toBeGreaterThanOrEqual(ROWS);
  expect(counts!.runs).toBeGreaterThanOrEqual(ROWS);
  expect(counts!.none).toBe(0);
}, 300_000);

describe("the overview's per-kind reads at 350k rows (issue 1690)", () => {
  for (const read of READS) {
    for (const generic of [true, false]) {
      const form = generic ? "the generic plan" : "each kind's own plan";
      test(`${read.site}, ${form}: every monitored kind plans on ${read.index}, no Seq Scan on ${read.table}`, async () => {
        expect(MONITORED_KINDS).toContain("regime.classify");
        for (const kind of MONITORED_KINDS) {
          const result = await explain(probeOf(read.site), kind, generic);
          expect({ kind, problems: judge(read.table, read.index, result) }).toEqual({ kind, problems: [] });
        }
      });

      test(`RED CONTROL, ${form}: without ${read.index} the same judge fails for a kind with no rows`, async () => {
        const result = await explain(probeOf(read.site), "regime.classify", generic, `DROP INDEX ${read.index}`);
        expect(judge(read.table, read.index, result).length).toBeGreaterThan(0);
      });
    }
  }

  test("getOverviewProjection completes under 500 ms (best of three after a warm-up)", async () => {
    await getOverviewProjection();
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      await getOverviewProjection();
      best = Math.min(best, performance.now() - started);
    }
    expect(best).toBeLessThan(500);
  });
});
