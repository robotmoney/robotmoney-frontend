// Live GeckoTerminal token_price smoke test (SEPARATE from the mocked-fetch
// offline coverage in tests/api/wallet-balances.test.ts, which is the
// CI-gating, fully-offline coverage for the prop-wallet USD valuation path).
// This file HITS THE REAL GeckoTerminal `simple/networks/base/token_price`
// endpoint (src/chain/token-prices.ts: fetchGeckoTokenPriceUsd) and fails
// LOUDLY (non-zero exit) if the endpoint is unreachable or its response shape
// has drifted — it never skips silently.
//
// Gating: it runs ONLY when RUN_LIVE_FETCHERS=1 — the nightly job
// (.github/workflows/nightly-fetchers.yml), NOT plain CI, mirroring
// tests/vault-rpc-live.test.ts and tests/fetchers-live.test.ts. This is a
// documented environment gate, not a silent per-assertion skip: when enabled
// it must reach the network and pass (or fail loudly); when disabled it
// announces why and still executes an assertion (test-coverage policy: exit 0
// must never mean "0 tests ran").
import { test, expect } from "bun:test";
import { fetchGeckoTokenPriceUsd } from "../src/chain/token-prices.ts";

const LIVE = process.env.RUN_LIVE_FETCHERS === "1";
const t = LIVE ? test : test.skip;

// Base WETH — a priceKind: 'gecko' asset in resolveTrackedAssets
// (src/config.ts) with a real, non-placeholder default address. WETH is the
// chosen drift-check asset because it tracks ETH within a stable, wide price
// band, so a loose sanity bound catches response-shape/decoding drift without
// flaking on ordinary price movement. ROBOTMONEY now also carries a real gecko
// default address (0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3), so it is a
// live-priced asset too; only BNKR still defaults to a non-functional
// repeating-digit placeholder (0x7777…7777, isPlaceholderAddress→true) that
// would correctly fail against the real endpoint and is unsuitable for a drift
// check. WETH stays the single asset asserted here to keep the smoke test
// robust.
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";

if (!LIVE) {
  // eslint-disable-next-line no-console
  console.warn(
    "[token-price-live] SKIPPED the real GeckoTerminal token_price check (RUN_LIVE_FETCHERS != 1). " +
      "Mocked-fetch coverage in tests/api/wallet-balances.test.ts still gates every PR. The nightly " +
      "workflow (nightly-fetchers.yml) sets RUN_LIVE_FETCHERS=1 to validate against the real endpoint " +
      "daily. Set RUN_LIVE_FETCHERS=1 to run locally.",
  );
  test("token-price-live gate is documented (mocked-fetch tests remain the gate)", () => {
    expect(LIVE).toBe(false);
  });
}

t("the real GeckoTerminal token_price endpoint answers a sane USD price for Base WETH", async () => {
  const price = await fetchGeckoTokenPriceUsd(WETH_ADDRESS);
  // Loose sanity bound (WETH tracks ETH): catches response-shape drift or a
  // decoding regression, not day-to-day price movement.
  expect(Number.isFinite(price)).toBe(true);
  expect(price).toBeGreaterThan(100);
  expect(price).toBeLessThan(100_000);
});
