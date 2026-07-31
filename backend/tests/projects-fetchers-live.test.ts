// Live provider drift test for the projects pipelines (issue #87). Hits the two
// NEW keyless HTTP providers the ported pipelines added — CoinGecko
// /coins/markets (refresh-lobster-coins) and DexScreener /tokens
// (refresh-lobster-coins + sync-agent-revenue-virtuals) — and asserts the shape
// the transforms depend on is still present, FAILING LOUDLY on real drift.
//
// Gating: runs ONLY when RUN_LIVE_FETCHERS=1 (nightly-fetchers.yml), NOT plain
// CI, so a transient upstream hiccup can never flake an unrelated PR. Per-PR
// coverage is the deterministic fixture replay in tests/projects-pipelines-
// fidelity.test.ts (always runs). The Base RPC provider used by fetch-vaults is
// already swept by tests/vault-rpc-live.test.ts, so it needs no new entry here.
import { test, expect } from "bun:test";
import { liveProjectsDataSource } from "../src/projects/access/live-source.ts";
import { coinGeckoFields, dexScreenerBest } from "../src/projects/transforms.ts";

const LIVE = process.env.RUN_LIVE_FETCHERS === "1";
const t = LIVE ? test : test.skip;

// Execution-evidence guard (test-coverage policy invariant 2): the nightly
// workflow sets EXPECT_LIVE=1 alongside the gate. If the gate name ever drifts
// (in the workflow or here), LIVE resolves false while EXPECT_LIVE=1 — every
// live test would silently become a skip and the run would stay green while
// validating nothing. Refuse loudly instead: a module-load throw fails
// `bun test` non-zero.
if (process.env.EXPECT_LIVE === "1" && !LIVE) {
  throw new Error(
    "[projects-fetchers-live] EXPECT_LIVE=1 but the RUN_LIVE_FETCHERS gate is OFF — " +
      "the workflow/test gate wiring has drifted; refusing an all-skip false-green run",
  );
}

if (!LIVE) {
  // Not a silent skip of behavior: mirrors the sibling live suites
  // (fetchers-live / vault-rpc-live / token-price-live). Announce why, and
  // still execute an assertion so exit 0 is backed by >0 executed tests
  // (test-coverage policy: exit 0 must never mean "0 tests ran").
  console.warn(
    "[projects-fetchers-live] SKIPPED live drift checks (RUN_LIVE_FETCHERS != 1). " +
      "Per-PR coverage is the deterministic fixture replay in projects-pipelines-fidelity.test.ts; " +
      "this only defers the CoinGecko/DexScreener drift guard to the nightly job.",
  );
  test("projects-fetchers-live gate is documented (fixture replay tests remain the gate)", () => {
    expect(LIVE).toBe(false);
  });
}

// USDC on Base — a permanent, high-liquidity token that will always have pairs.
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

t("CoinGecko /coins/markets returns the fields refresh-lobster-coins reads", async () => {
  const rows = await liveProjectsDataSource.coinGeckoMarkets(["ethereum"]);
  expect(rows.length).toBeGreaterThan(0);
  const f = coinGeckoFields(rows[0]);
  expect(f.market_cap).toBeGreaterThan(0);
  expect(f.price_usd).toBeGreaterThan(0);
}, 30_000);

t("DexScreener /tokens returns base-token pairs dexScreenerBest can select", async () => {
  const payload = await liveProjectsDataSource.dexScreenerToken(USDC_BASE);
  expect((payload.pairs ?? []).length).toBeGreaterThan(0);
  const res = dexScreenerBest(payload, { contract_address: USDC_BASE, chain: "base" });
  // USDC is deep-liquidity on Base, so a base-token pair must clear the floor.
  expect(res.status).toBe("ok");
}, 30_000);
