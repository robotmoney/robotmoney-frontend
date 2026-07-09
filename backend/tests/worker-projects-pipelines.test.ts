// PROJECTS PIPELINE WORKER CONTRACT (issue #87). Runs against the ephemeral
// Postgres the preload provisions (real DB, never mocked). Asserts: every new
// projects.* kind resolves in the handler registry and is seeded idempotently in
// job_schedules; the pipeline upserts fixture-derived rows into the 0013(+)
// tables; discovery is idempotent (stable row counts); and a forced extractor
// failure leaves the last-persisted rows intact while the handler reports a
// non-success status (degrade-to-persisted, nothing fabricated).
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import { getHandler } from "../src/worker/handlers/index.ts";
import {
  discover,
  fetchVaults,
  recomputeCoverage,
  refreshCoins,
  refreshWallets,
  snapshotDaily,
  syncRevenue,
} from "../src/worker/handlers/projects.ts";
import { failingSource, uniqueSlugSource } from "./support/projects-fixture-source.ts";

const KINDS = [
  "projects.discover",
  "projects.refresh_coins",
  "projects.refresh_wallets",
  "projects.sync_revenue",
  "projects.snapshot_daily",
  "projects.fetch_vaults",
  "projects.recompute_coverage",
];

async function projectIds(prefix: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`SELECT id FROM projects WHERE slug LIKE ${prefix + "-%"}`;
  return rows.map((r) => r.id);
}

async function counts(ids: string[]) {
  if (!ids.length) return { agents: 0, coins: 0, wallets: 0, vaults: 0 };
  const [[a], [c], [w], [v]] = await Promise.all([
    sql`SELECT count(*)::int n FROM openclaw_agents WHERE project_id IN ${sql(ids)}`,
    sql`SELECT count(*)::int n FROM lobster_coins WHERE project_id IN ${sql(ids)}`,
    sql`SELECT count(*)::int n FROM tracked_wallets WHERE project_id IN ${sql(ids)}`,
    sql`SELECT count(*)::int n FROM agent_vaults WHERE project_id IN ${sql(ids)}`,
  ]);
  return { agents: a.n as number, coins: c.n as number, wallets: w.n as number, vaults: v.n as number };
}

test("every projects.* kind resolves in the handler registry", () => {
  for (const k of KINDS) expect(typeof getHandler(k)).toBe("function");
});

test("every projects.* kind is seeded exactly once in job_schedules (idempotent)", async () => {
  // Re-seed first so this assertion is independent of test ordering (queue.test.ts
  // truncates job_schedules in its beforeEach). seed() is idempotent.
  const { seed } = await import("../src/db/seed.ts");
  await seed();
  for (const k of KINDS) {
    const rows = await sql<{ enabled: boolean }[]>`SELECT enabled FROM job_schedules WHERE kind = ${k}`;
    expect(rows.length).toBe(1);
    expect(rows[0].enabled).toBe(true);
  }
  // Re-running the seed must not duplicate schedule rows.
  await seed();
  for (const k of KINDS) {
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int n FROM job_schedules WHERE kind = ${k}`;
    expect(n).toBe(1);
  }
});

test("the full pipeline upserts fixture-derived rows; discovery is idempotent", async () => {
  const prefix = `wk_${crypto.randomUUID().slice(0, 8)}`;
  const src = uniqueSlugSource(prefix);

  const d = await discover({}, src);
  expect(d.ok).toBe(true);
  const ids = await projectIds(prefix);
  expect(ids.length).toBe(3);

  await refreshCoins({}, src);
  await refreshWallets({}, src);
  await fetchVaults({}, src);
  await snapshotDaily({ project_ids: ids });
  await syncRevenue({}, src);
  await recomputeCoverage({ project_ids: ids });

  // Rows landed with pipeline-derived values.
  const [{ mc }] = await sql<{ mc: number }[]>`
    SELECT market_cap::float8 AS mc FROM lobster_coins c JOIN projects p ON p.id = c.project_id
    WHERE p.slug = ${prefix + "-virtuals-protocol"} AND c.ticker = 'VIRTUAL'`;
  expect(mc).toBe(1_500_000_000);

  const [{ rev }] = await sql<{ rev: number }[]>`
    SELECT COALESCE(sum(revenue_usd),0)::float8 AS rev FROM agent_revenue_daily r
    JOIN openclaw_agents a ON a.id = r.agent_id WHERE a.project_id IN ${sql(ids)}`;
  expect(rev).toBeGreaterThan(0);

  const [{ snaps }] = await sql<{ snaps: number }[]>`
    SELECT count(*)::int AS snaps FROM daily_coin_snapshots s
    JOIN lobster_coins c ON c.id = s.coin_id WHERE c.project_id IN ${sql(ids)}`;
  expect(snaps).toBeGreaterThan(0);

  const [{ scored }] = await sql<{ scored: number }[]>`
    SELECT count(*)::int AS scored FROM projects WHERE id IN ${sql(ids)} AND data_coverage_score IS NOT NULL`;
  expect(scored).toBe(3);

  // Idempotent discovery: re-run leaves facet row counts unchanged (upsert, not
  // duplicate) so FK-linked snapshot/revenue rows survive.
  const before = await counts(ids);
  await discover({}, src);
  const after = await counts(ids);
  expect(after).toEqual(before);
});

test("a forced extractor failure leaves last-persisted rows intact and reports non-success", async () => {
  const prefix = `wkfail_${crypto.randomUUID().slice(0, 8)}`;
  const src = uniqueSlugSource(prefix);

  await discover({}, src);
  await refreshCoins({}, src); // persist real market caps

  const [{ before }] = await sql<{ before: number }[]>`
    SELECT market_cap::float8 AS before FROM lobster_coins c JOIN projects p ON p.id = c.project_id
    WHERE p.slug = ${prefix + "-virtuals-protocol"} AND c.ticker = 'VIRTUAL'`;
  expect(before).toBe(1_500_000_000);

  // Extractor throws → handler must NOT write and must report non-success.
  const res = await refreshCoins({}, failingSource(prefix));
  expect(res.ok).toBe(false);
  expect(res.status).toBe("degraded");

  const [{ after }] = await sql<{ after: number }[]>`
    SELECT market_cap::float8 AS after FROM lobster_coins c JOIN projects p ON p.id = c.project_id
    WHERE p.slug = ${prefix + "-virtuals-protocol"} AND c.ticker = 'VIRTUAL'`;
  expect(after).toBe(before); // last-persisted value untouched
});
