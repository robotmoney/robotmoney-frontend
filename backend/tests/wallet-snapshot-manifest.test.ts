import { expect, test } from "bun:test";
import type { TrackedAsset } from "../src/config.ts";
import {
  buildCanonicalWalletSnapshotManifest,
  canonicalJsonString,
  canonicalSha256,
  resolveAumProducerRevision,
  persistedSleeveManifestKey,
  validateExactSet,
  validateWalletSnapshotExactSets,
  type WalletSnapshotManifest,
} from "../src/ops/wallet-snapshot-manifest.ts";

const USDC: TrackedAsset = {
  symbol: "USDC",
  group: "Stable",
  color: "#0f0",
  valuationKind: "erc20",
  priceKind: "usdc",
  decimals: 6,
  address: "0xABCDEF",
  poolId: null,
};
const WETH: TrackedAsset = {
  symbol: "WETH",
  group: "Protocol",
  color: "#ff0",
  valuationKind: "erc20",
  priceKind: "gecko",
  decimals: 18,
  address: "0x123456",
  poolId: "base_pool",
};

function manifest(reverse = false): WalletSnapshotManifest {
  const balanceAssets = reverse ? [WETH, USDC] : [USDC, WETH];
  const sleeveKeys = [
    { walletIndex: 1, walletAddress: "0xBbB", asset: USDC },
    { walletIndex: 0, walletAddress: "0xAaA", asset: WETH },
  ];
  return { balanceAssets, sleeveKeys: reverse ? [...sleeveKeys].reverse() : sleeveKeys };
}

const OPTIONS = {
  manifestVersion: "wallet-aum-manifest/v1",
  valuationPolicyVersion: "wallet-aum-valuation/v1",
  configIdentity: "config-fixture-1",
};

test("canonical JSON recursively sorts object keys and hashes deterministically", () => {
  expect(canonicalJsonString({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
  expect(canonicalSha256({ b: 2, a: 1 })).toBe(canonicalSha256({ a: 1, b: 2 }));
});

test("canonical JSON refuses values JSON.stringify would silently corrupt", () => {
  expect(() => canonicalJsonString({ price: Number.NaN })).toThrow(/non-finite/);
  expect(() => canonicalJsonString({ missing: undefined })).toThrow(/undefined/);
  const sparse = new Array(1);
  expect(() => canonicalJsonString(sparse)).toThrow(/sparse array/);
  expect(() => canonicalJsonString({ [Symbol("hidden")]: "lost" })).toThrow(/symbol-keyed/);
});

test("manifest identity is invariant to input ordering and normalizes addresses", () => {
  const a = buildCanonicalWalletSnapshotManifest(manifest(), OPTIONS);
  const b = buildCanonicalWalletSnapshotManifest(manifest(true), OPTIONS);
  expect(a.manifestHash).toBe(b.manifestHash);
  expect(a.manifestJson).toBe(b.manifestJson);
  expect(a.manifest.balanceAssets.map((asset) => asset.symbol)).toEqual(["USDC", "WETH"]);
  expect(a.manifest.balanceAssets[0]!.address).toBe("0xabcdef");
  expect(a.manifest.expectedSleeveKeys).toEqual([
    persistedSleeveManifestKey("0xaaa", "WETH"),
    persistedSleeveManifestKey("0xbbb", "USDC"),
  ]);
});

test("manifest builder refuses duplicate natural keys", () => {
  expect(() => buildCanonicalWalletSnapshotManifest({ balanceAssets: [USDC, USDC], sleeveKeys: [] }, OPTIONS))
    .toThrow(/duplicate balance/);
});

test("manifest builder refuses structurally invalid domain values", () => {
  expect(() => buildCanonicalWalletSnapshotManifest({
    balanceAssets: [{ ...USDC, decimals: -1 }],
    sleeveKeys: [],
  }, OPTIONS)).toThrow(/non-negative integer decimals/);
  expect(() => buildCanonicalWalletSnapshotManifest({
    balanceAssets: [USDC],
    sleeveKeys: [{ walletIndex: -1, walletAddress: "0xaaa", asset: USDC }],
  }, OPTIONS)).toThrow(/non-negative integer walletIndex/);
});

test("exact-set validation reports missing, unexpected, and duplicate keys", () => {
  expect(validateExactSet(["USDC", "WETH"], ["USDC", "USDC", "BNKR"])).toEqual({
    expected: ["USDC", "WETH"],
    present: ["BNKR", "USDC"],
    missing: ["WETH"],
    unexpected: ["BNKR"],
    duplicateExpected: [],
    duplicatePresent: ["USDC"],
    exact: false,
  });
});

test("wallet exactness requires both balance and sleeve sets", () => {
  const built = buildCanonicalWalletSnapshotManifest(manifest(), OPTIONS).manifest;
  expect(validateWalletSnapshotExactSets(built, {
    balanceKeys: built.expectedBalanceKeys,
    sleeveKeys: built.expectedSleeveKeys,
  }).exact).toBe(true);
  expect(validateWalletSnapshotExactSets(built, {
    balanceKeys: built.expectedBalanceKeys,
    sleeveKeys: built.expectedSleeveKeys.slice(1),
  }).exact).toBe(false);
});

test("producer revision is explicit and absence stays unavailable", () => {
  expect(resolveAumProducerRevision({ AUM_PRODUCER_REVISION: "  abc123  " })).toEqual({
    status: "available",
    revision: "abc123",
    unavailableReason: null,
  });
  expect(resolveAumProducerRevision({})).toEqual({
    status: "unavailable",
    revision: null,
    unavailableReason: "AUM_PRODUCER_REVISION is unset or blank",
  });
});
