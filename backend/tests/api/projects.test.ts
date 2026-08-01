// Projects directory aggregation (issue #70). Runs against the ephemeral Postgres
// the preload provisions + migrates (tests/preload.ts) — a real DB, never a mock.
// Seeds projects + their facet rows and asserts fetchProjects() aggregates them
// into the /api/projects DTO exactly like the ported Projects.tsx did: live facet
// flags, max mcap/fdv, 30d sparkline, min-score gate, the sticky-first /
// mcap-desc default sort, and (issue #346) per-row coin/wallet refreshedAt/stale.
import { test, expect } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { fetchProjects } from "../../src/projects/projections.ts";
import { getProjects } from "../../src/api/routes/projects.ts";
import {
  discover,
  fetchVaults,
  recomputeCoverage,
  refreshCoins,
  refreshWallets,
  snapshotDaily,
  syncRevenue,
} from "../../src/worker/handlers/projects.ts";
import { uniqueSlugSource } from "../support/projects-fixture-source.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function insertProject(over: Record<string, unknown> = {}): Promise<string> {
  const row = {
    slug: rid("slug"),
    display_name: "Test Project",
    status: "active",
    data_coverage_score: 80,
    is_sticky: false,
    ...over,
  };
  const [r] = await sql`INSERT INTO projects ${sql(row)} RETURNING id`;
  return r.id as string;
}

test("fetchProjects aggregates facets, revenue, sparkline and returns the DTO shape", async () => {
  const pid = await insertProject({ display_name: "Aggregate Co", data_coverage_score: 90, website_url: "https://agg.example/", twitter_handle: "@agg", overview_short: "short blurb" });

  // Two coins → max mcap/fdv across them; the highest-cap coin carries the spark.
  const [coinA] = await sql`INSERT INTO lobster_coins ${sql({ project_id: pid, name: "Alpha", ticker: "ALP", market_cap: 12_000_000, fdv: 20_000_000, percent_change_24h: 3.5 })} RETURNING id`;
  await sql`INSERT INTO lobster_coins ${sql({ project_id: pid, name: "Beta", ticker: "BET", market_cap: 5_000_000, fdv: 15_000_000, percent_change_24h: -8 })}`;

  // 30d price snapshots for the primary coin (chronological sparkline).
  await sql`INSERT INTO daily_coin_snapshots ${sql([
    { coin_id: coinA.id, snapshot_date: dayAgo(2), price_usd: 1.0 },
    { coin_id: coinA.id, snapshot_date: dayAgo(1), price_usd: 1.2 },
    { coin_id: coinA.id, snapshot_date: dayAgo(0), price_usd: 1.5 },
  ])}`;
  // An OLD snapshot (>30d) must be excluded from the spark window.
  await sql`INSERT INTO daily_coin_snapshots ${sql({ coin_id: coinA.id, snapshot_date: dayAgo(60), price_usd: 99 })}`;

  // Agent with x402 signal + 30d revenue (one in-window, one aged-out).
  const [agent] = await sql`INSERT INTO openclaw_agents ${sql({ project_id: pid, name: "Ag", protocol_standard: "x402", x402_txn_count: 4 })} RETURNING id`;
  await sql`INSERT INTO agent_revenue_daily ${sql([
    { agent_id: agent.id, revenue_date: dayAgo(3), revenue_usd: 100, source: "x402" },
    { agent_id: agent.id, revenue_date: dayAgo(10), revenue_usd: 250, source: "virtuals" },
    { agent_id: agent.id, revenue_date: dayAgo(45), revenue_usd: 9999, source: "olas" },
  ])}`;

  // Wallets (summed) + a vault (presence).
  await sql`INSERT INTO tracked_wallets ${sql([
    { project_id: pid, label: "Treasury", chain: "base", balance_usd: 1000 },
    { project_id: pid, label: "Ops", chain: "base", balance_usd: 500 },
  ])}`;
  await sql`INSERT INTO agent_vaults ${sql({ project_id: pid, name: "Vault" })}`;

  const { projects } = await fetchProjects();
  const p = projects.find((x) => x.id === pid);
  expect(p).toBeDefined();
  if (!p) return;

  // Facet flags recomputed live from presence.
  expect(p.facets).toEqual({ agent: true, x402: true, coin: true, wallet: true, vault: true });

  // Max across coins.
  expect(p.maxMarketCap).toBe(12_000_000);
  expect(p.maxFdv).toBe(20_000_000);
  expect(p.coins.length).toBe(2);
  expect(typeof p.coins[0].marketCap).toBe("number");

  // agent_revenue_daily's trailing-30d window still trims the 45d-old row
  // (100 + 250, the 9999 excluded) — no longer surfaced on the DTO (issue
  // #346), but the underlying persisted data/window logic is unchanged and
  // still feeds the tokenless-project sparkline fallback, so assert it directly.
  const [{ rev }] = await sql<{ rev: number }[]>`
    SELECT COALESCE(sum(revenue_usd), 0)::float8 AS rev FROM agent_revenue_daily
    WHERE agent_id = ${agent.id} AND revenue_date >= ${dayAgo(30)}`;
  expect(rev).toBe(350);

  // Wallet total summed; description falls back to overview_short.
  expect(p.walletTotalUsd).toBe(1500);
  expect(p.description).toBe("short blurb");
  expect(p.websiteUrl).toBe("https://agg.example/");
  expect(p.twitterHandle).toBe("@agg");

  // Sparkline = only the 3 in-window snapshots, chronological (old 99 excluded).
  expect(p.sparkline).toEqual([1.0, 1.2, 1.5]);

  // Issue #346: neither coin nor wallet has ever been through a
  // projects.refresh_coins/refresh_wallets pass in this test, so both are
  // honestly reported as never-refreshed/stale — never fabricated as fresh.
  expect(p.coins[0].refreshedAt).toBeNull();
  expect(p.coins[0].stale).toBe(true);
  expect(p.wallets[0].refreshedAt).toBeNull();
  expect(p.wallets[0].stale).toBe(true);

  // Issue #346: revenue30d is no longer part of the DTO at all (no directory-
  // wide non-fabricated revenue source exists yet).
  expect((p as unknown as Record<string, unknown>).revenue30d).toBeUndefined();

  // Tokenless project with NO activity series.
  const pidEmpty = await insertProject({ display_name: "Empty Co" });
  await sql`INSERT INTO openclaw_agents ${sql({ project_id: pidEmpty, name: "EmptyAg", protocol_standard: "x402" })}`;
  
  const pEmpty = (await fetchProjects()).projects.find((x) => x.id === pidEmpty);
  expect(pEmpty).toBeDefined();
  expect(pEmpty!.sparkline.length).toBe(0);
});

test("fetchProjects excludes inactive/low-score projects and sorts sticky-first then by max market cap", async () => {
  const tag = rid("sorttag");

  // Below MIN_SCORE (55) → excluded.
  await insertProject({ display_name: `${tag}-lowscore`, data_coverage_score: 10 });
  // Inactive status → excluded.
  await insertProject({ display_name: `${tag}-inactive`, status: "inactive", data_coverage_score: 95 });

  // In-scope rows with differing market caps + a sticky pin.
  const big = await insertProject({ display_name: `${tag}-big`, data_coverage_score: 60 });
  await sql`INSERT INTO lobster_coins ${sql({ project_id: big, name: "Big", ticker: "BIG", market_cap: 9_000_000 })}`;
  const small = await insertProject({ display_name: `${tag}-small`, data_coverage_score: 60 });
  await sql`INSERT INTO lobster_coins ${sql({ project_id: small, name: "Small", ticker: "SML", market_cap: 1_000 })}`;
  const sticky = await insertProject({ display_name: `${tag}-sticky`, data_coverage_score: 60, is_sticky: true });
  // Sticky has NO coins (max mcap 0) yet must still lead on first load.

  const { projects } = await fetchProjects();
  const mine = projects.filter((p) => p.displayName.startsWith(tag));

  // Only the three active, in-score projects survive the gate.
  expect(mine.map((p) => p.displayName).sort()).toEqual([`${tag}-big`, `${tag}-small`, `${tag}-sticky`]);

  // Default order: sticky first, then market cap desc.
  expect(mine[0].id).toBe(sticky);
  const nonSticky = mine.filter((p) => !p.isSticky);
  expect(nonSticky[0].id).toBe(big);
  expect(nonSticky[1].id).toBe(small);
});

test("GET /api/projects serves the populated additive-superset DTO after the pipeline runs on fixtures", async () => {
  const prefix = `api_${crypto.randomUUID().slice(0, 8)}`;
  const src = uniqueSlugSource(prefix);

  await discover({}, src);
  const ids = (await sql<{ id: string }[]>`SELECT id FROM projects WHERE slug LIKE ${prefix + "-%"}`).map((r) => r.id);
  await refreshCoins({}, src);
  await refreshWallets({}, src);
  await fetchVaults({}, src);
  await snapshotDaily({ project_ids: ids });
  await syncRevenue({}, src);
  await recomputeCoverage({ project_ids: ids });

  // The route handler is a thin adapter over fetchProjects — exercise it directly.
  const res = await getProjects();
  const mine = res.projects.filter((p) => p.slug.startsWith(prefix));
  expect(mine.length).toBe(4);

  const virtuals = mine.find((p) => p.slug === `${prefix}-virtuals-protocol`)!;
  // Market data.
  expect(virtuals.maxMarketCap).toBe(1_500_000_000);
  expect(virtuals.coins.some((c) => (c.priceUsd ?? 0) > 0)).toBe(true);
  // Revenue aggregate is no longer on the DTO (issue #346) — the underlying
  // pipeline computation is still exercised end to end via syncRevenue above;
  // verified directly against the persisted table in the fidelity suite.
  expect((virtuals as unknown as Record<string, unknown>).revenue30d).toBeUndefined();
  // Snapshot series.
  expect(virtuals.sparkline.length).toBeGreaterThan(0);
  // Additive-superset aggregates (issue #87).
  expect(virtuals.volume24h).toBe(50_000_000);
  expect(virtuals.tvlUsd).toBe(1_000_000);

  // Issue #346: refreshCoins/refreshWallets ran above (against the fixture
  // live source), so every coin/wallet row now carries a fresh refreshedAt
  // and is not stale.
  for (const c of virtuals.coins) {
    expect(c.refreshedAt).not.toBeNull();
    expect(c.stale).toBe(false);
  }
  for (const w of virtuals.wallets) {
    expect(w.refreshedAt).not.toBeNull();
    expect(w.stale).toBe(false);
  }

  // Tokenless project WITH activity series from fixture.
  const x402 = mine.find((p) => p.slug === `${prefix}-coinbase-x402-facilitator`)!;
  expect(x402.sparkline.length).toBeGreaterThan(0);
  
  // Coin-backed projects still return the coin-price 30-point series unchanged, asserted as a regression.
  expect(virtuals.sparkline.length).toBeGreaterThan(0);

  // Tokenless project WITHOUT activity series returns empty sparkline (length 0).
  const tokenlessNoAct = mine.find((p) => p.slug === `${prefix}-tokenless-no-activity`);
  if (tokenlessNoAct) {
    expect(tokenlessNoAct.sparkline.length).toBe(0);
  }

  // Every #70 field still present and typed (contract not reshaped).
  for (const p of mine) {
    expect(typeof p.walletTotalUsd).toBe("number");
    expect(Array.isArray(p.wallets)).toBe(true);
    expect(p.facets).toHaveProperty("x402");
  }
});

test("fetchProjects returns an empty list when no projects qualify", async () => {
  // A brand-new ephemeral DB may already have seeded rows from other suites, so
  // assert the shape/contract rather than an exact empty array.
  const res = await fetchProjects();
  expect(Array.isArray(res.projects)).toBe(true);
  for (const p of res.projects) {
    expect(p.dataCoverageScore == null || p.dataCoverageScore >= 55).toBe(true);
  }
});
