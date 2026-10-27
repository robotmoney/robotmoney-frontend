// packages/analyst-sdk is pure compute (issue #1095): no filesystem, no
// database, no environment, no reach into the backend. Mechanical, not
// conventional: this file scans every .ts under packages/analyst-sdk/src and
// fails on the first forbidden import or environment/filesystem reference.
//
// Forbidden under packages/analyst-sdk/src:
//   - an import of node:fs (or fs, node:fs/promises), postgres, bun:sqlite
//   - an import path containing /db/, /chain/, /store/ or /cutover/
//   - an import of the backend-only extract modules (fetch-cache, source-ledger,
//     geckoterminal, edgar-seed, floor-seed): the extractors reach the network
//     and the ledger only through the injectable seam in extract/http.ts
//   - node:child_process, worker_threads, net, http(s), os and similar modules
//   - any reference to process.env, process["env"], Bun.env, Bun.file,
//     import.meta.env, or destructuring of process/Bun
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
  const re = /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|^\s*import\s+["']([^"']+)["']|\bimport\s*\(\s*`([^`]*)`/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) out.push((m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5])!);
  return out;
}

// True when a `/` here starts a regex literal rather than dividing: the last
// significant character before it cannot end an operand.
function startsRegex(before: string): boolean {
  const t = before.trimEnd();
  if (t === "") return true;
  if (/[(,=:[!&|?{};+\-*%<>~^]$/.test(t)) return true;
  return /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/.test(t);
}

/**
 * Blank out comments and regex literals with a small scanner that tracks string
 * and template literals, so prose naming a forbidden thing does not trip the
 * scan, a leading block comment cannot hide code on the same line, and a quote
 * inside a regex literal (`/["']/`, `/https?:\/\//`) cannot open a phantom string
 * that swallows the code after it. Newlines are kept.
 */
function codeOnly(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) out += text[i++] === "\n" ? "\n" : "";
      i += 2;
      out += " ";
    } else if (c === "/" && startsRegex(out)) {
      // Regex literal: skip to the closing unescaped `/` (a `/` inside [...] does not close it), then the flags.
      i++;
      let inClass = false;
      while (i < text.length && text[i] !== "\n" && (inClass || text[i] !== "/")) {
        if (text[i] === "\\") i++;
        else if (text[i] === "[") inClass = true;
        else if (text[i] === "]") inClass = false;
        i++;
      }
      i++;
      while (i < text.length && /[a-z]/i.test(text[i]!)) i++;
      out += "/_/";
    } else if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\") out += text[i++];
        out += text[i++] ?? "";
      }
      out += text[i++] ?? "";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Anything that reaches the filesystem, a process, the network stack or a
// database. The SDK's own network access goes through the injected fetch.
const FORBIDDEN_MODULES = new Set([
  "node:fs", "fs", "node:fs/promises", "fs/promises", "postgres", "bun:sqlite",
  "node:child_process", "child_process", "node:worker_threads", "worker_threads",
  "node:cluster", "cluster", "node:net", "net", "node:http", "http", "node:https", "https",
  "node:os", "os", "node:process", "process", "bun",
]);
// Environment and filesystem reach that needs no import.
const FORBIDDEN_CODE: Array<[RegExp, string]> = [
  [/\bprocess\s*(\.\s*env\b|\[\s*["'`]env["'`]\s*\])/, "references process.env"],
  [/\bconst\s*\{[^}]*\}\s*=\s*(process|Bun|import\.meta)\b/, "destructures process, Bun or import.meta"],
  [/\bBun\s*(\.\s*(env|file|write|spawn|spawnSync|\$)\b|\[)/, "uses Bun.env or Bun file/process access"],
  [/\bimport\.meta\.env\b/, "references import.meta.env"],
  [/\bDeno\s*\./, "uses Deno"],
  [/\bimport\s*\(\s*`[^`]*\$\{/, "dynamic import with a computed template specifier"],
  [/\bimport\s*\(\s*(?!["'`])[^\s)]/, "dynamic import with a non-literal specifier"],
];
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
  for (const [re, what] of FORBIDDEN_CODE) if (re.test(code)) found.push(`${file}: ${what}`);
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
      ['process["env"]', 'const k = process["env"].X;'],
      ["destructured process", "const { env } = process;"],
      ["Bun.env", "const k = Bun.env.X;"],
      ["Bun.file", 'const f = Bun.file("x");'],
      ["import.meta.env", "const k = import.meta.env.X;"],
      ["node:child_process import", 'import a from "node:child_process";'],
      ["process.env after a regex literal holding a quote and slashes", "const re = /https?:\\/\\//;\nconst k = process.env.X;"],
      ["process.env after a regex literal with a quote class", "const re = /[\"']/g;\nconst k = process.env.X;"],
      ["backtick dynamic import of a forbidden path", "const m = await import(`../db/client.ts`);"],
      ["backtick dynamic import of node:fs", "const m = await import(`node:fs`);"],
      ["backtick dynamic import with a computed specifier", "const m = await import(`node:${name}`);"],
      ["dynamic import of a variable", "const m = await import(spec);"],
      ["import after a leading block comment", '/* c */ import fs from "node:fs";'],
      ["import after a multi-line block comment", '/* a\n b */ import fs from "node:fs";'],
    ];
    for (const [name, code] of planted) {
      test(`flags ${name}`, () => {
        expect(purityViolations("planted.ts", code), name).not.toEqual([]);
      });
    }
    test("regex literals and division are told apart, and a clean regex is not flagged", () => {
      expect(purityViolations("ok.ts", 'const re = /https?:\\/\\//; const half = a / b / c; const s = "x";')).toEqual([]);
      expect(purityViolations("ok.ts", "const a = 4 / 2; const r = x.replace(/[\"']/g, ''); const q = `${a}`;")).toEqual([]);
    });
    test("a comment that merely names a forbidden thing is not flagged", () => {
      expect(purityViolations("ok.ts", '// never import node:fs or read process.env here\nimport type { Point } from "../types.ts";')).toEqual([]);
    });
  });
});

// ── issue 1421: extract is the only stage that reaches acquisition ──────────
// After extract, every downstream stage runs from supplied data. Mechanically:
//   - no SDK file imports csvb (the SDK consumes prepared inputs, it never
//     downloads archives) or a third-party HTTP client;
//   - provider HTTP exists only in packages/analyst-sdk/src/extract/http.ts:
//     no other SDK file calls fetch or names XMLHttpRequest, WebSocket,
//     EventSource or navigator.sendBeacon;
//   - no downstream module (SDK files outside src/extract/; backend analytics
//     analyze/, transform/, report/, prepare.ts and coverage.ts) reaches an
//     acquisition client DIRECTLY OR TRANSITIVELY through its relative imports
//     (backend shims are followed into the SDK), and none calls fetch itself.
// The graph check runs over planted positive and negative fixtures too, so a
// resolver that follows nothing cannot pass for a clean tree.
const CSVB_IMPORT = /(^|\/)(csvb|csv-backups)(\/|$|\.ts$)|^@robotmoney\/csvb/;
const HTTP_CLIENT_PACKAGES = new Set(["axios", "node-fetch", "undici", "got", "ky", "superagent", "cross-fetch", "isomorphic-fetch", "ws", "needle", "request"]);
const DIRECT_HTTP: Array<[RegExp, string]> = [
  [/(?<![\w$.])fetch\s*\(/, "calls fetch"],
  [/\bglobalThis\s*\.\s*fetch\b/, "uses globalThis.fetch"],
  [/\b(XMLHttpRequest|WebSocket|EventSource)\b/, "names a browser HTTP client"],
  [/\bnavigator\s*\.\s*sendBeacon\b/, "uses navigator.sendBeacon"],
];

/** codeOnly() with string and template literal contents blanked, for checks on code alone. */
function codeWithoutStrings(text: string): string {
  return codeOnly(text).replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
}

function resolveRelative(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const p = parts.join("/");
  return p.endsWith(".ts") ? p : `${p}.ts`;
}

export interface ImportGraphRules {
  /** Files whose import graph must never reach `forbidden`. */
  downstream: (path: string) => boolean;
  /** Acquisition modules (extract clients, data sources, ledgers, HTTP clients). */
  forbidden: (path: string) => boolean;
  /** The one module allowed to perform provider HTTP. */
  httpModule: string;
  /** Files the direct-HTTP and csvb rules apply to. */
  sdkFile: (path: string) => boolean;
}

/** Violations over a set of files keyed by repo-relative path. */
export function importGraphViolations(files: ReadonlyMap<string, string>, rules: ImportGraphRules): string[] {
  const found: string[] = [];
  const edges = new Map<string, string[]>();
  for (const [path, text] of files) {
    const specs = specifiers(codeOnly(text));
    edges.set(path, specs.map((s) => resolveRelative(path, s)).filter((p): p is string => p !== null));
    if (rules.sdkFile(path)) {
      for (const s of specs) {
        if (CSVB_IMPORT.test(s)) found.push(`${path}: imports ${s} (the SDK never imports csvb)`);
        if (HTTP_CLIENT_PACKAGES.has(s)) found.push(`${path}: imports the HTTP client ${s}`);
      }
      if (path !== rules.httpModule) {
        const code = codeWithoutStrings(text);
        for (const [re, what] of DIRECT_HTTP) if (re.test(code)) found.push(`${path}: ${what} (provider HTTP lives only in ${rules.httpModule})`);
      }
    } else if (rules.downstream(path)) {
      const code = codeWithoutStrings(text);
      for (const [re, what] of DIRECT_HTTP) if (re.test(code)) found.push(`${path}: ${what} (a downstream module never performs HTTP)`);
    }
  }
  for (const start of files.keys()) {
    if (!rules.downstream(start)) continue;
    const seen = new Set<string>([start]);
    const queue: string[][] = [[start]];
    while (queue.length) {
      const chain = queue.shift()!;
      for (const next of edges.get(chain[chain.length - 1]!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        if (rules.forbidden(next)) {
          found.push(`${start}: reaches acquisition module ${next} via ${[...chain, next].join(" -> ")}`);
          continue;
        }
        queue.push([...chain, next]);
      }
    }
  }
  return found;
}

const SDK_REL = "packages/analyst-sdk/src";
const BA = "backend/src/analytics";
const REPO_RULES: ImportGraphRules = {
  sdkFile: (p) => p.startsWith(`${SDK_REL}/`),
  httpModule: `${SDK_REL}/extract/http.ts`,
  downstream: (p) =>
    (p.startsWith(`${SDK_REL}/`) && !p.startsWith(`${SDK_REL}/extract/`)) ||
    /^backend\/src\/analytics\/(analyze|transform|report)\//.test(p) ||
    p === `${BA}/prepare.ts` ||
    p === `${BA}/coverage.ts`,
  forbidden: (p) =>
    p.startsWith(`${SDK_REL}/extract/`) ||
    p.startsWith(`${BA}/extract/`) ||
    [`${BA}/access/data-source.ts`, `${BA}/access/hermetic-source.ts`, `${BA}/source-ledger.ts`, `${BA}/api-client.ts`, `${BA}/telemetry-client.ts`, `${BA}/edgar-incremental-refresh.ts`].includes(p),
};

describe("issue 1421: no downstream acquisition", () => {
  const repoFiles = new Map<string, string>();
  for (const dir of [SDK_SRC, join(root, "backend/src")]) {
    for (const f of tsFiles(dir)) repoFiles.set(relative(root, f), readFileSync(f, "utf8"));
  }

  test("the graph is non-vacuous: downstream files exist and their imports resolve to real files", () => {
    const downstream = [...repoFiles.keys()].filter(REPO_RULES.downstream);
    expect(downstream.length).toBeGreaterThan(30);
    // run.ts really does import prepare.ts: the resolver follows relative imports.
    const runImports = specifiers(codeOnly(repoFiles.get(`${SDK_REL}/run.ts`)!)).map((s) => resolveRelative(`${SDK_REL}/run.ts`, s));
    expect(runImports).toContain(`${SDK_REL}/prepare.ts`);
    for (const p of runImports) if (p) expect(repoFiles.has(p), p).toBe(true);
  });

  test("the real tree: no csvb, no HTTP client, provider HTTP only in extract/http.ts, no downstream path to acquisition", () => {
    expect(importGraphViolations(repoFiles, REPO_RULES)).toEqual([]);
  });

  test("extract/http.ts really is where the SDK's provider HTTP lives", () => {
    const code = codeWithoutStrings(repoFiles.get(REPO_RULES.httpModule)!);
    expect(/globalThis\s*\.\s*fetch\b/.test(code)).toBe(true);
  });

  describe("planted import-graph fixtures", () => {
    const S = SDK_REL;
    const clean = new Map([
      [`${S}/run.ts`, 'import { prepare } from "./prepare.ts";\nexport const run = () => prepare();'],
      [`${S}/prepare.ts`, 'import { mean } from "./transform/math.ts";\nexport const prepare = () => mean([1]);'],
      [`${S}/transform/math.ts`, "export const mean = (xs: number[]) => xs[0];"],
      [`${S}/extract/http.ts`, "export const get = (u: string) => globalThis.fetch(u);"],
      [`${S}/extract/yahoo.ts`, 'import { get } from "./http.ts";\nexport const fetchYahoo = (s: string) => get(s);\nconsole.log("fetch (yahoo) done");'],
    ]);
    const plant = (path: string, code: string) => new Map([...clean, [path, code]]);

    test("positive: a clean downstream graph and an extractor using http.ts pass", () => {
      expect(importGraphViolations(clean, REPO_RULES)).toEqual([]);
    });

    const negatives: Array<[string, Map<string, string>, RegExp]> = [
      ["a downstream file importing an extractor directly", plant(`${S}/analyze/x.ts`, 'import { fetchYahoo } from "../extract/yahoo.ts";'), /reaches acquisition module .*extract\/yahoo\.ts/],
      ["a downstream file reaching an extractor transitively", plant(`${S}/transform/math.ts`, 'import { fetchYahoo } from "../extract/yahoo.ts";\nexport const mean = () => 1;'), /run\.ts: reaches acquisition module .*run\.ts -> .*prepare\.ts -> .*math\.ts -> .*yahoo\.ts/],
      ["a downstream file calling fetch", plant(`${S}/analyze/y.ts`, 'export const y = () => fetch("https://x");'), /calls fetch/],
      ["a downstream file using globalThis.fetch", plant(`${S}/analyze/y.ts`, "export const y = globalThis.fetch;"), /globalThis\.fetch/],
      ["a WebSocket in the SDK", plant(`${S}/analyze/y.ts`, 'export const y = () => new WebSocket("wss://x");'), /browser HTTP client/],
      ["an XMLHttpRequest in the SDK", plant(`${S}/analyze/y.ts`, "export const y = () => new XMLHttpRequest();"), /browser HTTP client/],
      ["an extractor other than http.ts calling fetch (provider HTTP outside http.ts)", plant(`${S}/extract/yahoo.ts`, 'export const fetchYahoo = (s: string) => fetch(s);'), /extract\/yahoo\.ts: calls fetch \(provider HTTP lives only in/],
      ["an SDK import of csvb", plant(`${S}/input/archive.ts`, 'import { download } from "csvb";'), /never imports csvb/],
      ["an SDK import of csvb by relative path", plant(`${S}/input/archive.ts`, 'import { download } from "../../../csv-backups/src/cli.ts";'), /never imports csvb/],
      ["an SDK import of a third-party HTTP client", plant(`${S}/analyze/y.ts`, 'import axios from "axios";'), /HTTP client axios/],
      ["a backend analyze module importing the live data source", plant(`${BA}/analyze/z.ts`, 'import { liveDataSource } from "../access/data-source.ts";'), /reaches acquisition module backend\/src\/analytics\/access\/data-source\.ts/],
      ["a backend report module reaching the source ledger through a helper", new Map([...clean, [`${BA}/report/r.ts`, 'import { h } from "./h.ts";'], [`${BA}/report/h.ts`, 'import { captureSourceAcquisition } from "../source-ledger.ts";\nexport const h = 1;']]), /report\/r\.ts: reaches acquisition module .*source-ledger\.ts/],
      ["a backend shim leading into an SDK extractor", new Map([...clean, [`${BA}/transform/s.ts`, 'export * from "../../../../packages/analyst-sdk/src/extract/yahoo.ts";']]), /transform\/s\.ts: reaches acquisition module packages\/analyst-sdk\/src\/extract\/yahoo\.ts/],
    ];
    for (const [name, files, expected] of negatives) {
      test(`negative: flags ${name}`, () => {
        const v = importGraphViolations(files, REPO_RULES);
        expect(v.some((m) => expected.test(m)), v.join("\n") || "(no violations)").toBe(true);
      });
    }

    test("a log message or comment naming fetch is not a fetch call", () => {
      const files = plant(`${S}/analyze/y.ts`, '// we never fetch( here\nexport const y = () => console.log(`fetch (${1}) skipped`, "fetch(x)");\nexport const viaClient = (o: { get: () => void; fetch: () => void }) => o.fetch();');
      expect(importGraphViolations(files, REPO_RULES).join("\n")).toBe("");
    });
  });
});
