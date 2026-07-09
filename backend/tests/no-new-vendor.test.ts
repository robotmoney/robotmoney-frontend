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
  "src/chain/wallet-history-seed.ts",
  "src/worker/handlers/wallet.ts",
  "src/api/routes/dashboards.ts",
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

test("the token-price fetcher reaches only GeckoTerminal + Yahoo hosts", () => {
  const src = readFileSync(join(process.cwd(), "src/chain/token-prices.ts"), "utf8");
  const hosts = [...src.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]!.toLowerCase());
  for (const host of hosts) {
    const ok = host.includes("geckoterminal.com") || host.includes("yahoo.com");
    expect(ok, `unexpected host ${host} in token-prices.ts`).toBe(true);
  }
  // Sanity: it does mention the two allowed vendors.
  expect(src.includes("geckoterminal.com")).toBe(true);
});
