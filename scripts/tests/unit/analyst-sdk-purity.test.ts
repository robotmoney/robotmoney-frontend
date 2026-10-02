// packages/analyst-sdk is pure compute (issue #1095): no filesystem, no
// database, no environment, no reach into the backend. Mechanical, not
// conventional: this file scans every .ts under packages/analyst-sdk/src and
// fails on the first forbidden import or `process.env` reference.
//
// Forbidden under packages/analyst-sdk/src:
//   - an import of node:fs (or fs, node:fs/promises), postgres, bun:sqlite
//   - an import path containing /db/, /chain/, /store/ or /cutover/
//   - an import of the backend-only extract modules (fetch-cache, source-ledger,
//     geckoterminal, edgar-seed, floor-seed): the extractors reach the network
//     and the ledger only through the injectable seam in extract/http.ts
//   - any reference to process.env
//
// Also asserted here: the SDK imports nothing from backend/src, and
// backend/src/api imports nothing from packages/ (the API reaches the SDK only
// through the analytics/ shims).
//
// RED CONTROL: the scanner is also run against planted violations and must
// flag every one, so a scanner that matches nothing cannot pass for a clean
// tree.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "../../..");
const SDK_SRC = join(root, "packages/analyst-sdk/src");
const API_SRC = join(root, "backend/src/api");

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) tsFiles(full, out);
    else if (e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Module specifiers named by `from "x"`, `import("x")`, `require("x")` and bare `import "x"`. */
function specifiers(code: string): string[] {
  const out: string[] = [];
  const re = /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) out.push((m[1] ?? m[2] ?? m[3] ?? m[4])!);
  return out;
}

/** Drop comment-only lines so prose that names a forbidden thing does not trip the scan. */
function codeOnly(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
}

const FORBIDDEN_MODULES = new Set(["node:fs", "fs", "node:fs/promises", "fs/promises", "postgres", "bun:sqlite"]);
const FORBIDDEN_PATH_PARTS = ["/db/", "/chain/", "/store/", "/cutover/"];
// Extract-stage modules that stay in the backend (issue #1095 part B).
const BACKEND_ONLY_EXTRACT = /(^|\/)(fetch-cache|source-ledger|geckoterminal|edgar-seed|floor-seed)(-generator)?(\.ts)?$/;

export function purityViolations(file: string, text: string): string[] {
  const code = codeOnly(text);
  const found: string[] = [];
  for (const spec of specifiers(code)) {
    if (FORBIDDEN_MODULES.has(spec)) found.push(`${file}: imports ${spec}`);
    // Trailing slash so a specifier ending in the directory (../db) counts too.
    if (FORBIDDEN_PATH_PARTS.some((p) => `${spec}/`.includes(p))) found.push(`${file}: imports ${spec} (forbidden path)`);
    if (BACKEND_ONLY_EXTRACT.test(spec)) found.push(`${file}: imports ${spec} (backend-only extract module)`);
  }
  if (/\bprocess\.env\b/.test(code)) found.push(`${file}: references process.env`);
  return found;
}

describe("analyst-sdk purity", () => {
  const files = tsFiles(SDK_SRC);

  test("the scan is non-vacuous", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test("no file under packages/analyst-sdk/src has a forbidden import or process.env reference", () => {
    const violations = files.flatMap((f) => purityViolations(relative(root, f), readFileSync(f, "utf8")));
    expect(violations).toEqual([]);
  });

  test("the scan covers the extractor files and none of the backend-only ones", () => {
    const extract = files.filter((f) => f.includes("/src/extract/")).map((f) => relative(SDK_SRC, f)).sort();
    for (const name of ["blockchain-com", "coinmetrics", "defillama", "edgar", "floor-seed-calendar", "fred", "http", "shiller", "sources", "yahoo"]) {
      expect(extract, name).toContain(`extract/${name}.ts`);
    }
    expect(extract.filter((f) => BACKEND_ONLY_EXTRACT.test(f))).toEqual([]);
  });

  test("the SDK imports nothing from backend/src", () => {
    const bad = files.flatMap((f) =>
      specifiers(codeOnly(readFileSync(f, "utf8")))
        .filter((s) => /backend\/|@robotmoney\/backend/.test(s))
        .map((s) => `${relative(root, f)}: ${s}`),
    );
    expect(bad).toEqual([]);
  });

  test("the SDK declares no @robotmoney/contract dependency (it must install standalone)", () => {
    const pkg = JSON.parse(readFileSync(join(root, "packages/analyst-sdk/package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.values(deps).filter((v) => v.startsWith("file:") || v.startsWith("link:"))).toEqual([]);
    for (const f of files) expect(readFileSync(f, "utf8"), relative(root, f)).not.toContain("@robotmoney/contract");
  });

  test("backend/src/api imports nothing from packages/ (it reaches the SDK only through the analytics shims)", () => {
    const apiFiles = tsFiles(API_SRC);
    expect(apiFiles.length).toBeGreaterThan(10);
    const bad = apiFiles.flatMap((f) =>
      specifiers(codeOnly(readFileSync(f, "utf8")))
        .filter((s) => /(^|\/)packages\/|analyst-sdk/.test(s))
        .map((s) => `${relative(root, f)}: ${s}`),
    );
    expect(bad).toEqual([]);
  });

  test("backend analytics shims are one-line re-exports into the SDK", () => {
    const shim = (p: string) => readFileSync(join(root, "backend/src/analytics", p), "utf8").trim();
    expect(shim("types.ts")).toBe('export * from "../../../packages/analyst-sdk/src/types.ts";');
    expect(shim("analyze/compute.ts")).toBe('export * from "../../../../packages/analyst-sdk/src/analyze/compute.ts";');
  });

  // ── red control ───────────────────────────────────────────────────────────
  // Planted input, built from scratch (never derived from the real tree), so
  // this keeps biting even when the real tree is already clean.
  describe("red control: planted violations are all caught", () => {
    const planted: Array<[string, string]> = [
      ["node:fs import", 'import { readFileSync } from "node:fs";'],
      ["fs/promises import", 'import { readFile } from "node:fs/promises";'],
      ["postgres import", 'import postgres from "postgres";'],
      ["bun:sqlite import", 'import { Database } from "bun:sqlite";'],
      ["/db/ path", 'import { sql } from "../../db/client.ts";'],
      ["/chain/ path", 'import { x } from "../chain/gecko-endpoint.ts";'],
      ["/store/ path", 'export * from "../store/raw.ts";'],
      ["/cutover/ path", 'const m = await import("../cutover/parity.ts");'],
      ["fetch-cache import in an extractor", 'import { withFetchCache } from "./fetch-cache.ts";'],
      ["source-ledger import in an extractor", 'import { recordSourceFetch } from "../source-ledger.ts";'],
      ["geckoterminal import in an extractor", 'import { fetchGeckoTerminalNewPools } from "./geckoterminal.ts";'],
      ["edgar-seed import in an extractor", 'import { loadEdgarSeed } from "./edgar-seed.ts";'],
      ["floor-seed import in an extractor", 'import { loadRawFloorSeed } from "./floor-seed.ts";'],
      ["process.env", "const k = process.env.API_KEY;"],
    ];
    for (const [name, code] of planted) {
      test(`flags ${name}`, () => {
        expect(purityViolations("planted.ts", code), name).not.toEqual([]);
      });
    }
    test("a comment that merely names a forbidden thing is not flagged", () => {
      expect(purityViolations("ok.ts", '// never import node:fs or read process.env here\nimport type { Point } from "../types.ts";')).toEqual([]);
    });
  });
});
