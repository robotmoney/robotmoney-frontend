// PROJECTS PIPELINE FIDELITY (issue #87). Two layers, both loud-fail (never
// skip) — the preload (tests/preload.ts) provisions the ephemeral Postgres this
// suite imports `sql` from, so a missing DB/fixtures fails the run red:
//
//   1. Pure transforms replay the VENDORED provider payloads (fixtures/dataset.ts)
//      and must exactly equal the VENDORED legacy ground truth (fixtures/
//      ground-truth.ts, hand-derived from the legacy formulas) — the PR #9
//      methodology, asserting the port reproduces the deprecated edge functions.
//   2. The full pipeline runs those same fixtures through the worker handlers into
//      real Postgres, then asserts the projection's aggregates (market-cap/FDV,
//      trailing-30d revenue, snapshot series, facet flags, data_coverage_score)
//      match the hand-derived ground truth end to end.
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import { fetchProjects } from "../src/projects/projections.ts";
import {
  coinGeckoFields,
  computeCoverage,
  coinSnapshotRow,
  dexScreenerBest,
  sumTrailing30d,
  vaultTvlErc4626,
  virtualsRevenueRow,
  x402RevenueRows,
} from "../src/projects/transforms.ts";
import { COINGECKO_MARKETS, DEXSCREENER_TOKENS, VAULT_READS } from "../src/projects/fixtures/dataset.ts";
import {
  COINGECKO_GROUND_TRUTH,
  COVERAGE_FULL,
  COVERAGE_SPARSE,
  DEX_GAME_GROUND_TRUTH,
  TRAILING_ASOF,
  TRAILING_ROWS,
  TRAILING_SUM_GROUND_TRUTH,
  VAULT_TVL_18DEC,
  VAULT_TVL_GROUND_TRUTH,
  VIRTUALS_REVENUE_GROUND_TRUTH,
  X402_ROWS_GROUND_TRUTH,
  X402_SNAPSHOTS,
} from "../src/projects/fixtures/ground-truth.ts";
import {
  discover,
  fetchVaults,
  recomputeCoverage,
  refreshCoins,
  refreshWallets,
  snapshotDaily,
  syncRevenue,
} from "../src/worker/handlers/projects.ts";
import { uniqueSlugSource } from "./support/projects-fixture-source.ts";

const GAME = "0xgame00000000000000000000000000000000coin";
const VAULT_A = "0xvault0000000000000000000000000000000aaa";

// ── Layer 1: pure transform parity vs vendored legacy ground truth ───────────
test("market: coinGeckoFields reproduces the legacy CoinGecko mapping (fdv fallback)", () => {
  for (const id of Object.keys(COINGECKO_GROUND_TRUTH)) {
    expect(coinGeckoFields(COINGECKO_MARKETS[id])).toEqual(COINGECKO_GROUND_TRUTH[id]);
  }
});

test("market: dexScreenerBest picks the base-token, base-chain, top-liquidity pair", () => {
  const res = dexScreenerBest(DEXSCREENER_TOKENS[GAME], { contract_address: GAME, chain: "base" });
  expect(res.status).toBe("ok");
  if (res.status === "ok") expect(res.values).toEqual(DEX_GAME_GROUND_TRUTH);
});

test("revenue: virtualsRevenueRow = top-liquidity base 24h volume × 0.006", () => {
  for (const [token, expected] of Object.entries(VIRTUALS_REVENUE_GROUND_TRUTH)) {
    const row = virtualsRevenueRow(DEXSCREENER_TOKENS[token], { agent_id: "a", date: "2026-07-09" });
    expect(row).not.toBeNull();
    expect(row!.revenue_usd).toBe(expected);
  }
});

test("revenue: x402RevenueRows rolls up positive-volume days only", () => {
  expect(x402RevenueRows(X402_SNAPSHOTS)).toEqual(X402_ROWS_GROUND_TRUTH);
});

test("revenue: sumTrailing30d windows on/after asof-30d", () => {
  expect(sumTrailing30d(TRAILING_ROWS, TRAILING_ASOF)).toBe(TRAILING_SUM_GROUND_TRUTH);
});

test("vault: vaultTvlErc4626 scales totalAssets by decimals × price", () => {
  expect(vaultTvlErc4626(VAULT_READS[VAULT_A])).toBe(VAULT_TVL_GROUND_TRUTH[VAULT_A]);
  expect(vaultTvlErc4626(VAULT_TVL_18DEC.input)).toBe(VAULT_TVL_18DEC.expected);
});

test("coverage: computeCoverage reproduces compute_project_coverage() exactly", () => {
  expect(computeCoverage(COVERAGE_FULL.input)).toEqual(COVERAGE_FULL.expected);
  expect(computeCoverage(COVERAGE_SPARSE.input)).toEqual(COVERAGE_SPARSE.expected);
});

test("snapshot: coinSnapshotRow freezes the current market row as one dated point", () => {
  expect(coinSnapshotRow({ id: "c1", price_usd: "1.5", market_cap: 100, volume_24h: null }, "2026-07-09")).toEqual({
    coin_id: "c1",
    snapshot_date: "2026-07-09",
    price_usd: 1.5,
    market_cap: 100,
    volume_24h: 0,
  });
});

// ── Layer 2: end-to-end pipeline → projection parity in real Postgres ────────
test("full pipeline reproduces the ground-truth directory aggregates end to end", async () => {
  const prefix = `fid_${crypto.randomUUID().slice(0, 8)}`;
  const src = uniqueSlugSource(prefix);

  await discover({}, src);
  const projRows = await sql<{ id: string; slug: string }[]>`SELECT id, slug FROM projects WHERE slug LIKE ${prefix + "-%"}`;
  const ids = projRows.map((r) => r.id);
  expect(ids.length).toBe(3);

  await refreshCoins({}, src);
  await refreshWallets({}, src);
  await fetchVaults({}, src);
  await snapshotDaily({ project_ids: ids });
  await syncRevenue({}, src);
  await recomputeCoverage({ project_ids: ids });

  const { projects } = await fetchProjects();
  const bySlug = (s: string) => projects.find((p) => p.slug === `${prefix}-${s}`);

  const virtuals = bySlug("virtuals-protocol");
  expect(virtuals).toBeDefined();
  expect(virtuals!.maxMarketCap).toBe(1_500_000_000); // VIRTUAL beats GAME (90M)
  expect(virtuals!.maxFdv).toBe(2_000_000_000);
  expect(virtuals!.volume24h).toBe(50_000_000); // max coin 24h volume
  expect(virtuals!.tvlUsd).toBe(1_000_000); // ERC-4626 vault TVL
  expect(virtuals!.revenue30d).toBe(60_000); // 10,000,000 × 0.006
  expect(virtuals!.facets).toEqual({ agent: true, x402: false, coin: true, wallet: true, vault: true });
  expect(virtuals!.dataCoverageScore).toBe(86);
  expect(virtuals!.sparkline).toEqual([1.5]); // primary coin VIRTUAL, one snapshot @ 1.5

  const aixbt = bySlug("aixbt");
  expect(aixbt!.maxMarketCap).toBe(320_000_000);
  expect(aixbt!.maxFdv).toBe(320_000_000); // fdv fell back to market_cap
  expect(aixbt!.revenue30d).toBe(30_000); // 5,000,000 × 0.006
  expect(aixbt!.facets).toEqual({ agent: true, x402: false, coin: true, wallet: true, vault: false });
  expect(aixbt!.dataCoverageScore).toBe(79);

  const x402 = bySlug("coinbase-x402-facilitator");
  expect(x402!.revenue30d).toBe(15_000); // x402 volume rollup
  expect(x402!.facets).toEqual({ agent: true, x402: true, coin: false, wallet: true, vault: false });
  expect(x402!.dataCoverageScore).toBe(78);
});
