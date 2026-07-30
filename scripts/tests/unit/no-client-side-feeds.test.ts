// Executed guard (issue #294): asserts no file under frontend/public/ issues a
// chain-RPC or third-party data-feed request (eth_call/eth_getBalance/jsonrpc/
// window.ethereum and known feed hosts like geckoterminal, mainnet.base.org, alchemy).
// Block explorer links (basescan.org) are explicitly permitted.
// Also includes a planted-violation control proving the guard is not vacuous.
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
      const violations = findFeedViolations(text, relPath);
      allViolations.push(...violations);
    }

    expect(allViolations).toEqual([]);
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
