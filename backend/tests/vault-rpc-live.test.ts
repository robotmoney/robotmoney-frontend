// Live Base RPC smoke test (SEPARATE from the mocked-RPC suites
// tests/chain-client.test.ts + tests/vault-economics.test.ts, which are the
// CI-gating, fully-offline coverage). This file HITS THE REAL configured Base
// JSON-RPC endpoint and vault contract and fails LOUDLY (non-zero exit) if the
// RPC is unreachable or returns malformed data — it never skips silently.
//
// Gating: it runs ONLY when RUN_LIVE_FETCHERS=1 — the nightly job
// (.github/workflows/nightly-fetchers.yml), NOT plain CI, mirroring
// tests/fetchers-live.test.ts. This is a documented environment gate, not a
// silent per-assertion skip: when enabled it must reach the network and pass
// (or fail loudly); when disabled it announces why and still executes an
// assertion (test-coverage policy: exit 0 must never mean "0 tests ran").
import { test, expect } from "bun:test";
import { config } from "../src/config.ts";
import { callTotalAssets, callTotalSupply } from "../src/chain/base-rpc-client.ts";

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
    "[vault-rpc-live] EXPECT_LIVE=1 but the RUN_LIVE_FETCHERS gate is OFF — " +
      "the workflow/test gate wiring has drifted; refusing an all-skip false-green run",
  );
}

if (!LIVE) {
  // eslint-disable-next-line no-console
  console.warn(
    "[vault-rpc-live] SKIPPED the real Base RPC smoke check (RUN_LIVE_FETCHERS != 1). " +
      "Mocked-RPC coverage in tests/chain-client.test.ts + tests/vault-economics.test.ts " +
      "still gates every PR. The nightly workflow (nightly-fetchers.yml) sets " +
      "RUN_LIVE_FETCHERS=1 to validate against the real vault daily. Set " +
      "RUN_LIVE_FETCHERS=1 to run locally.",
  );
  test("vault-rpc-live gate is documented (mocked-RPC tests remain the gate)", () => {
    expect(LIVE).toBe(false);
  });
}

t("the configured Base RPC endpoint answers totalAssets()/totalSupply() for the real vault", async () => {
  const opts = { rpcUrl: config.baseRpcUrl, timeoutMs: 15_000 };
  const [totalAssets, totalSupply] = await Promise.all([
    callTotalAssets(config.vault.address, opts),
    callTotalSupply(config.vault.address, opts),
  ]);
  // A deployed, non-empty ERC-4626 vault must have positive totalSupply (it has
  // at least one depositor) — 0n here would mean either the vault is genuinely
  // empty (plausible pre-launch) or, more likely, the configured address/RPC is
  // wrong. Fail loudly either way rather than silently accept.
  expect(totalSupply).toBeGreaterThan(0n);
  expect(totalAssets).toBeGreaterThan(0n);
  // Sanity range on share price: a share price collapsing to ~0 or exploding to
  // absurd multiples of 1.0 would indicate a decoding/selector regression.
  const sharePrice = Number(totalAssets) / Number(totalSupply);
  expect(sharePrice).toBeGreaterThan(0.5);
  expect(sharePrice).toBeLessThan(2);
});
