// Executed guard (issue #294): asserts no file under frontend/public/ issues a
// chain-RPC or third-party data-feed request (eth_call/eth_getBalance/jsonrpc/
// window.ethereum and known feed hosts like geckoterminal, mainnet.base.org, alchemy).
// Block explorer links (basescan.org) are explicitly permitted.
// Also includes a planted-violation control proving the guard is not vacuous.
//
// D97 (issue 1615): the deposit page's wallet layer is out of this guard's
// scope. A holder's wallet session reads their own balance and signs their own
// transactions, which no server can do for them. The exemption is two paths:
// the vendored wallet kit and lib/deposit/. Dashboards and every other file
// stay held to the rule.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const publicDir = join(repoRoot, "frontend", "public");

const FORBIDDEN_PATTERNS = [
  "eth_call",
  "eth_getBalance",
  "jsonrpc",
  "window.ethereum",
  "api.geckoterminal.com",
  "mainnet.base.org",
  ".g.alchemy.com",
];

/** The deposit page's wallet layer (D97): the vendored kit and lib/deposit/. Nothing else. */
const WALLET_LAYER = [
  /^frontend\/public\/assets\/js\/vendor\/rm-appkit-\d+\.\d+\.\d+\.min\.js$/,
  /^frontend\/public\/assets\/js\/app\/lib\/deposit\/[^/]+\.js$/,
];

export function isWalletLayer(relPath: string): boolean {
  return WALLET_LAYER.some((re) => re.test(relPath));
}

function isBinaryExtension(filename: string): boolean {
  return /\.(png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|svg|webmanifest)$/i.test(filename);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...walk(p));
    } else if (!isBinaryExtension(name)) {
      out.push(p);
    }
  }
  return out;
}

export function findFeedViolations(content: string, filename = "test-file"): string[] {
  const violations: string[] = [];
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (content.includes(pattern)) {
      violations.push(`${filename}: contains forbidden feed pattern "${pattern}"`);
    }
  }
  return violations;
}

describe("no client-side chain-RPC or third-party feed requests in frontend/public", () => {
  test("frontend/public carries zero chain-RPC or feed requests", () => {
    const files = walk(publicDir);
    const allViolations: string[] = [];

    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const relPath = f.replace(repoRoot + "/", "");
      if (isWalletLayer(relPath)) continue;
      const violations = findFeedViolations(text, relPath);
      allViolations.push(...violations);
    }

    expect(allViolations).toEqual([]);
  });

  test("the wallet layer exemption names the deposit wallet files and nothing else (D97)", () => {
    expect(isWalletLayer("frontend/public/assets/js/vendor/rm-appkit-1.8.24.min.js")).toBe(true);
    expect(isWalletLayer("frontend/public/assets/js/app/lib/deposit/manifest.js")).toBe(true);
    // A dashboard, a view, another vendor file, a nested or look-alike path: all still held.
    for (const p of [
      "frontend/public/assets/js/app/alpine/views/allocation.js",
      "frontend/public/assets/js/app/alpine/views/deposit.js",
      "frontend/public/assets/js/vendor/chart-4.5.1.umd.min.js",
      "frontend/public/assets/js/vendor/rm-appkit-latest.min.js",
      "frontend/public/assets/js/app/lib/deposit/feeds/prices.js",
      "frontend/public/assets/js/app/lib/deposit-feeds/prices.js",
      "frontend/public/views/deposit.html",
    ]) expect(isWalletLayer(p), p).toBe(false);
  });

  test("planted-violation control flags planted feed requests", () => {
    const plantedContent = `
      function fetchChainData() {
        return fetch("https://mainnet.base.org", {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call" })
        });
      }
    `;

    const violations = findFeedViolations(plantedContent, "temp/planted-fixture.js");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes("mainnet.base.org"))).toBe(true);
    expect(violations.some((v) => v.includes("eth_call"))).toBe(true);
    expect(violations.some((v) => v.includes("jsonrpc"))).toBe(true);
  });
});
