// Demo projects seed (issue #70 deferred ingestion). Runs against the ephemeral
// Postgres the preload provisions + migrates (tests/preload.ts) — a real DB, never
// a mock. Asserts seedDemoProjects() populates the 0013 tables so fetchProjects()
// returns a full, gated, faceted directory, and that the seed is idempotent (row
// counts stable across repeated runs).
import { test, expect } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { seedDemoProjects } from "../../src/projects/demo-seed.ts";
import { fetchProjects } from "../../src/projects/projections.ts";

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

test("seedDemoProjects populates a gated, faceted, sparkline-bearing directory", async () => {
  await seedDemoProjects();
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

  // At least one project draws a 30d sparkline and one earns non-zero 30d revenue.
  const withSpark = projects.filter((p) => p.sparkline.length > 0);
  expect(withSpark.length).toBeGreaterThan(0);
  expect(withSpark[0].sparkline.length).toBe(30);
  expect(projects.some((p) => p.revenue30d > 0)).toBe(true);

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

test("seedDemoProjects is idempotent — a second run does not duplicate rows", async () => {
  await seedDemoProjects();
  const before = await rowCounts();

  await seedDemoProjects();
  const after = await rowCounts();

  expect(after).toEqual(before);

  // And the DTO count is unchanged too.
  const first = (await fetchProjects()).projects.length;
  await seedDemoProjects();
  const second = (await fetchProjects()).projects.length;
  expect(second).toBe(first);
});
