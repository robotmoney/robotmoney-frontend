// AC (#84 — no new vendor/key): the new prop-wallet valuation files must reach
// ONLY the Base RPC, GeckoTerminal, and Yahoo hosts — no Alchemy / DexScreener /
// CoinGecko / Dune / Supabase host or import. Grep-based, so a future edit that
// pulls in a forbidden vendor fails loudly. New GeckoTerminal-endpoint code is
// allowed (same vendor already in the repo).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const NEW_FILES = [
  "src/chain/token-prices.ts",
  "src/chain/wallet-balances.ts",
  "src/chain/wallet-valuation.ts", // shared balances/sleeves valuation (finding 007)
  "src/chain/wallet-history-seed.ts",
  "src/worker/handlers/wallet.ts",
  "src/api/routes/dashboards.ts",
  // The #709 backfill path. It reaches a NEW GeckoTerminal endpoint (daily
  // OHLCV) and a historical block tag on the SAME Base RPC — same vendors,
  // which is exactly the boundary this file exists to keep honest. Repairing
  // history must not become the excuse that quietly adds a data vendor.
  "src/chain/historical-prices.ts",
  "src/chain/block-resolver.ts",
  "src/ops/wallet-backfill.ts",
  "src/worker/handlers/repair.ts",
].map((p) => join(process.cwd(), p));

const FORBIDDEN = ["alchemy", "dexscreener", "coingecko", "dune", "supabase"];

// Scan CODE, not prose: strip block + line comments first (docs legitimately
// name the forbidden vendors to say they are excluded). The `[^:]` guard keeps
// the `//` inside `https://…` URLs from being treated as a line comment.
function codeOnly(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .toLowerCase();
}

test("new #84 valuation files reach no forbidden vendor host or import", () => {
  for (const file of NEW_FILES) {
    const src = codeOnly(file);
    for (const bad of FORBIDDEN) {
      expect(src.includes(bad), `${file} must not reference "${bad}"`).toBe(false);
    }
  }
});

// GeckoTerminal is CoinGecko's, and we pay for a CoinGecko plan (issue #1062). The same on-chain data is served from the
// paid host under the same key, so that ONE host is allowed, in ONE module (chain/gecko-endpoint.ts). The price fetchers
// no longer name a GeckoTerminal host themselves: they get their URLs from that module, so the host policy is one place
// to read and one test to hold. Nothing else about the #84 boundary changes: still no Alchemy, DexScreener, Dune or
// Supabase, and still no CoinGecko host anywhere else in these files (FORBIDDEN above checks "coingecko" in code).
const GECKO_ENDPOINT_HOSTS = ["api.geckoterminal.com", "pro-api.coingecko.com"];

test("GeckoTerminal's hosts are named in exactly one module, and are exactly the free host and CoinGecko's paid host for it", () => {
  const src = readFileSync(join(process.cwd(), "src/chain/gecko-endpoint.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const hosts = [...new Set([...code.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]!.toLowerCase()))].sort();
  expect(hosts).toEqual([...GECKO_ENDPOINT_HOSTS].sort());
});

test("the token-price fetcher reaches only Yahoo by name, and GeckoTerminal only through gecko-endpoint", () => {
  const src = readFileSync(join(process.cwd(), "src/chain/token-prices.ts"), "utf8");
  const hosts = [...src.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]!.toLowerCase());
  for (const host of hosts) {
    expect(host.includes("yahoo.com"), `unexpected host ${host} in token-prices.ts`).toBe(true);
  }
  // Sanity: it reaches GeckoTerminal, and does so through the one module that names the hosts.
  expect(src.includes('from "./gecko-endpoint.ts"')).toBe(true);
});

test("the historical-price fetcher (#709) reaches GeckoTerminal only through gecko-endpoint, and names no host", () => {
  const src = readFileSync(join(process.cwd(), "src/chain/historical-prices.ts"), "utf8");
  const hosts = [...src.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]!.toLowerCase());
  expect(hosts, "historical-prices.ts must not name a host; chain/gecko-endpoint.ts does").toEqual([]);
  expect(src.includes('from "./gecko-endpoint.ts"')).toBe(true);
});

test("the new_pools extractor names no GeckoTerminal host either", () => {
  const src = readFileSync(join(process.cwd(), "src/analytics/extract/geckoterminal.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  expect([...code.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1])).toEqual([]);
  expect(src.includes("gecko-endpoint.ts")).toBe(true);
});
