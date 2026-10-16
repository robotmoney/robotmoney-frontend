// Demo projects seed (issue #70 deferred ingestion). Runs against the ephemeral
// Postgres the preload provisions + migrates (tests/preload.ts) — a real DB, never
// a mock. Asserts seedSmokeProjects() populates the 0013 tables so fetchProjects()
// returns a full, gated, faceted directory, and that the seed is idempotent (row
// counts stable across repeated runs).
import { test, expect } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { join } from "node:path";
import { harnessUrl } from "../support/cluster.ts";
import { fetchProjects } from "../../src/projects/projections.ts";

// seedSmokeProjects writes through its module's own pool, and the tables it fills
// are the owner's (rm_app holds no INSERT/DELETE on them). In production the seed
// runs as the schema owner, so this test runs it the same way: in a child process
// whose pool is the fixture owner login, on this file's database. The reads below
// stay on the runtime pool.
async function seedSmokeProjects(): Promise<void> {
  const database = new URL(process.env.DATABASE_URL!).pathname.replace(/^\//, "");
  const modulePath = join(import.meta.dir, "..", "..", "src", "projects", "smoke-seed.ts");
  const child = Bun.spawn(
    ["bun", "-e", `const m = await import(${JSON.stringify(modulePath)}); await m.seedSmokeProjects(); process.exit(0);`],
    {
      cwd: join(import.meta.dir, "..", ".."),
      env: { ...process.env, DATABASE_URL: harnessUrl(database) },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`owner-run seedSmokeProjects failed (${code}): ${err}`);
}

async function rowCounts() {
  const [[p], [a], [c], [w], [v], [r], [s]] = await Promise.all([
    sql`SELECT count(*)::int AS n FROM projects`,
    sql`SELECT count(*)::int AS n FROM openclaw_agents`,
    sql`SELECT count(*)::int AS n FROM lobster_coins`,
    sql`SELECT count(*)::int AS n FROM tracked_wallets`,
    sql`SELECT count(*)::int AS n FROM agent_vaults`,
    sql`SELECT count(*)::int AS n FROM agent_revenue_daily`,
    sql`SELECT count(*)::int AS n FROM daily_coin_snapshots`,
  ]);
  return { projects: p.n, agents: a.n, coins: c.n, wallets: w.n, vaults: v.n, revenue: r.n, snapshots: s.n };
}

test("seedSmokeProjects populates a gated, faceted, sparkline-bearing directory", async () => {
  await seedSmokeProjects();
  const { projects } = await fetchProjects();

  // ≥ 8 projects, all clearing the MIN_SCORE (55) gate.
  expect(projects.length).toBeGreaterThanOrEqual(8);
  for (const p of projects) {
    expect(p.dataCoverageScore).not.toBeNull();
    expect(p.dataCoverageScore ?? 0).toBeGreaterThanOrEqual(55);
    expect(typeof p.slug).toBe("string");
    expect(typeof p.displayName).toBe("string");
  }

  // Every facet flavor is represented across the directory.
  expect(projects.some((p) => p.facets.agent)).toBe(true);
  expect(projects.some((p) => p.facets.coin)).toBe(true);
  expect(projects.some((p) => p.facets.wallet)).toBe(true);
  expect(projects.some((p) => p.facets.vault)).toBe(true);
  expect(projects.some((p) => p.facets.x402)).toBe(true);

  // At least one project draws a 30d sparkline.
  const withSpark = projects.filter((p) => p.sparkline.length > 0);
  expect(withSpark.length).toBeGreaterThan(0);
  expect(withSpark[0].sparkline.length).toBe(30);

  // Revenue is no longer surfaced on the DTO (issue #346), but the smoke seed
  // still writes real agent_revenue_daily rows (feeding the sparkline
  // fallback for tokenless projects) — assert that directly against the table.
  const [{ n: revenueRows }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agent_revenue_daily WHERE revenue_usd > 0`;
  expect(revenueRows).toBeGreaterThan(0);

  // Tokenless x402 project has a sparkline length 30 from activity.
  const x402Coinless = projects.find((p) => p.slug === "coinbase-x402-facilitator");
  expect(x402Coinless).toBeDefined();
  expect(x402Coinless!.sparkline.length).toBe(30);

  // Coin-bearing projects carry numeric market cap; wallet totals sum > 0 somewhere.
  const withCoin = projects.find((p) => p.coins.length > 0);
  expect(withCoin).toBeDefined();
  expect(typeof withCoin!.maxMarketCap).toBe("number");
  expect(withCoin!.maxMarketCap).toBeGreaterThan(0);
  expect(projects.some((p) => p.walletTotalUsd > 0)).toBe(true);

  // Sticky pins lead the default sort.
  expect(projects[0].isSticky).toBe(true);
});

test("seedSmokeProjects is idempotent — a second run does not duplicate rows", async () => {
  await seedSmokeProjects();
  const before = await rowCounts();

  await seedSmokeProjects();
  const after = await rowCounts();

  expect(after).toEqual(before);

  // And the DTO count is unchanged too.
  const first = (await fetchProjects()).projects.length;
  await seedSmokeProjects();
  const second = (await fetchProjects()).projects.length;
  expect(second).toBe(first);
});
