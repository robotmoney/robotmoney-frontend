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
//   - an import of the package's edges, node/ or bin/, by relative path or as
//     `@robotmoney/analyst-sdk/node` (issue 1765), reported with file and line
//
// Issue 1765: node/ is the package's only fs edge. It lives outside src/, so
// the scan above does not cover it; a client imports it as
// `@robotmoney/analyst-sdk/node`. Every other entry of the package's exports
// map reaches only src/ code, and './node' really does reach node:fs.
//
// node/ may import node:fs, but it imports no csvb and no HTTP client and never
// calls fetch (issue 1765, its own scan below, with a planted red control).
//
// Also asserted here: the SDK imports nothing from backend/src, and
// backend/src/api imports nothing from packages/ (the API reaches the SDK only
// through the analytics/ shims).
//
// RED CONTROL: the scanner is also run against planted violations and must
// flag every one, so a scanner that matches nothing cannot pass for a clean
// tree.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "../../..");
const SDK_PKG = "packages/analyst-sdk";
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

/** Module specifiers named by `from "x"`, `import("x")`, `require("x")` and bare `import "x"`, each with its 1-based line. */
function specifierLines(code: string): Array<{ spec: string; line: number }> {
  const out: Array<{ spec: string; line: number }> = [];
  const re = /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|^\s*import\s+["']([^"']+)["']|\bimport\s*\(\s*`([^`]*)`/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const spec = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5])!;
    out.push({ spec, line: code.slice(0, m.index + m[0].lastIndexOf(spec)).split("\n").length });
  }
  return out;
}

/** Module specifiers named by `from "x"`, `import("x")`, `require("x")` and bare `import "x"`. */
function specifiers(code: string): string[] {
  return specifierLines(code).map((s) => s.spec);
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
// The package's edges (issue 1765): node/ (the node:fs edge, `@robotmoney/analyst-sdk/node`) and bin/ (the commands).
const EDGE_SUBPATH = /^@robotmoney\/analyst-sdk\/(node|bin)(\/|$)/;
const EDGE_PATH = new RegExp(`^${SDK_PKG}/(node|bin)(/|\\.ts$)`);

/** True when `spec`, imported from the repo-relative `file`, names the package's node/ or bin/ edge. */
function importsEdge(file: string, spec: string): boolean {
  if (EDGE_SUBPATH.test(spec)) return true;
  const to = resolveRelative(file, spec);
  return to !== null && EDGE_PATH.test(to);
}

export function purityViolations(file: string, text: string): string[] {
  const code = codeOnly(text);
  const found: string[] = [];
  for (const { spec, line } of specifierLines(code)) {
    if (FORBIDDEN_MODULES.has(spec)) found.push(`${file}: imports ${spec}`);
    // Trailing slash so a specifier ending in the directory (../db) counts too.
    if (FORBIDDEN_PATH_PARTS.some((p) => `${spec}/`.includes(p))) found.push(`${file}: imports ${spec} (forbidden path)`);
    if (BACKEND_ONLY_EXTRACT.test(spec)) found.push(`${file}: imports ${spec} (backend-only extract module)`);
    if (importsEdge(file, spec)) found.push(`${file}:${line}: imports ${spec} (src/ never imports node/ or bin/; node/ is the only fs edge)`);
  }
  for (const [re, what] of FORBIDDEN_CODE) if (re.test(code)) found.push(`${file}: ${what}`);
  return found;
}

/** Every violation under `<base>/packages/analyst-sdk/src`, each file named relative to `base`. */
function scanSrc(base: string): string[] {
  return tsFiles(join(base, SDK_PKG, "src")).flatMap((f) => purityViolations(relative(base, f), readFileSync(f, "utf8")));
}

describe("analyst-sdk purity", () => {
  const files = tsFiles(SDK_SRC);

  test("the scan is non-vacuous", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test("no file under packages/analyst-sdk/src has a forbidden import or process.env reference", () => {
    expect(scanSrc(root)).toEqual([]);
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

// ── issue 1765: node/ is the package's only fs edge ─────────────────────────
// The exports map has one entry outside src/, './node'. Every other entry's
// code reaches only src/ files (data imports such as the shipped universe JSON
// are not code), and none of them is impure; './node' reaches node:fs. src/
// never imports node/ or bin/ (purityViolations above). The red controls plant
// violations in real temporary files and expect each named with its line.
/** Resolve a relative import of a repo-relative file on disk: as written, then with .ts, then as a folder's index.ts. */
function resolveOnDisk(base: string, from: string, spec: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const p = parts.join("/");
  for (const c of [p, `${p}.ts`, `${p}/index.ts`]) if (existsSync(join(base, c)) && /\.(ts|json)$/.test(c)) return c;
  throw new Error(`${from}: cannot resolve ${spec}`);
}

/** Every file a repo-relative module reaches through its relative imports, itself included. */
function reachedFiles(base: string, start: string): string[] {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const file = queue.shift()!;
    if (!file.endsWith(".ts")) continue;
    for (const spec of specifiers(codeOnly(readFileSync(join(base, file), "utf8")))) {
      if (!spec.startsWith(".")) continue;
      const next = resolveOnDisk(base, file, spec);
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen].sort();
}

describe("issue 1765: node/ is the package's only fs edge", () => {
  const pkg = JSON.parse(readFileSync(join(root, SDK_PKG, "package.json"), "utf8")) as { exports: Record<string, string> };
  const read = (f: string) => readFileSync(join(root, f), "utf8");
  const importsFs = (f: string) => specifiers(codeOnly(read(f))).some((s) => s === "node:fs" || s === "fs");

  test("the exports map has './node' as its one code entry outside src/", () => {
    const outside = Object.entries(pkg.exports).filter(([k, t]) => k !== "./package.json" && !t.startsWith("./src/"));
    expect(outside).toEqual([["./node", "./node/index.ts"]]);
    for (const entry of [".", "./replay", "./archive", "./src/*"]) expect(pkg.exports[entry], entry).toStartWith("./src/");
  });

  test("'.', './replay' and './archive' reach only src/ code, all of it pure", () => {
    for (const entry of [".", "./replay", "./archive"]) {
      const reached = reachedFiles(root, `${SDK_PKG}/${pkg.exports[entry]!.slice(2)}`);
      const code = reached.filter((f) => f.endsWith(".ts"));
      expect(code.length, entry).toBeGreaterThan(entry === "." ? 40 : 3);
      expect(code.filter((f) => !f.startsWith(`${SDK_PKG}/src/`)), entry).toEqual([]);
      expect(code.flatMap((f) => purityViolations(f, read(f))), entry).toEqual([]);
      expect(reached.filter((f) => /\/(node|bin)\//.test(f)), entry).toEqual([]);
    }
  });

  test("'./node' is the edge: it reaches node:fs from node/ files and never imports bin/", () => {
    const reached = reachedFiles(root, `${SDK_PKG}/${pkg.exports["./node"]!.slice(2)}`);
    const edge = reached.filter((f) => f.startsWith(`${SDK_PKG}/node/`));
    expect(edge).toContain(`${SDK_PKG}/node/backups-dir.ts`);
    expect(edge.filter(importsFs)).toEqual([`${SDK_PKG}/node/backups-dir.ts`, `${SDK_PKG}/node/supplementary-dir.ts`]);
    expect(reached.filter((f) => f.startsWith(`${SDK_PKG}/bin/`))).toEqual([]);
    // Every reached file outside node/ is src/ code or data, so the fs reach is node/'s alone.
    expect(reached.filter((f) => !f.startsWith(`${SDK_PKG}/node/`) && f.endsWith(".ts") && importsFs(f))).toEqual([]);
  });

  test("red control: planted src files on disk that import node/ or './node' are flagged with file and line; node/ itself is allowed", () => {
    const tmp = mkdtempSync(join(tmpdir(), "analyst-sdk-edge-"));
    try {
      const analyze = join(tmp, SDK_PKG, "src", "analyze");
      mkdirSync(analyze, { recursive: true });
      mkdirSync(join(tmp, SDK_PKG, "node"), { recursive: true });
      writeFileSync(join(analyze, "planted-path.ts"), '// a planted edge import on line 3\nimport type { Point } from "../types.ts";\nimport { openBackupsDir } from "../../node/backups-dir.ts";\nexport const x: Point[] = [];\n');
      writeFileSync(join(analyze, "planted-subpath.ts"), 'import { sha256 } from "@robotmoney/analyst-sdk/node";\nexport const h = sha256;\n');
      writeFileSync(join(analyze, "planted-bin.ts"), '\n\nexport { openBackupsDir } from "../../bin/backups-dir.ts";\n');
      writeFileSync(join(analyze, "planted-fs.ts"), 'import { readFileSync } from "node:fs";\nexport const r = readFileSync;\n');
      writeFileSync(join(analyze, "clean.ts"), '// never import ../../node/backups-dir.ts here\nimport { openArchive } from "../archive/reader.ts";\nexport const o = openArchive;\n');
      writeFileSync(join(tmp, SDK_PKG, "node", "edge.ts"), 'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n');
      const why = "(src/ never imports node/ or bin/; node/ is the only fs edge)";
      expect(scanSrc(tmp).sort()).toEqual([
        `${SDK_PKG}/src/analyze/planted-bin.ts:3: imports ../../bin/backups-dir.ts ${why}`,
        `${SDK_PKG}/src/analyze/planted-fs.ts: imports node:fs`,
        `${SDK_PKG}/src/analyze/planted-path.ts:3: imports ../../node/backups-dir.ts ${why}`,
        `${SDK_PKG}/src/analyze/planted-subpath.ts:1: imports @robotmoney/analyst-sdk/node ${why}`,
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("red control: an in-memory src file importing the node/ folder itself, or by a dynamic import, is flagged", () => {
    const f = `${SDK_PKG}/src/input/x.ts`;
    expect(purityViolations(f, 'export * from "../../node";')).toEqual([`${f}:1: imports ../../node (src/ never imports node/ or bin/; node/ is the only fs edge)`]);
    expect(purityViolations(f, '\nconst m = await import("@robotmoney/analyst-sdk/node/index.ts");')).toEqual([
      `${f}:2: imports @robotmoney/analyst-sdk/node/index.ts (src/ never imports node/ or bin/; node/ is the only fs edge)`,
    ]);
    expect(purityViolations(f, 'import { openArchive } from "../archive/reader.ts";\nimport { x } from "./node-helpers.ts";')).toEqual([]);
  });

  test("red control: the reach walk follows a planted chain into node:fs", () => {
    const tmp = mkdtempSync(join(tmpdir(), "analyst-sdk-reach-"));
    try {
      mkdirSync(join(tmp, SDK_PKG, "src", "a"), { recursive: true });
      writeFileSync(join(tmp, SDK_PKG, "src", "index.ts"), 'export * from "./a/b.ts";\n');
      writeFileSync(join(tmp, SDK_PKG, "src", "a", "b.ts"), 'import { c } from "../c.ts";\nexport const b = c;\n');
      writeFileSync(join(tmp, SDK_PKG, "src", "c.ts"), 'import { readFileSync } from "node:fs";\nexport const c = readFileSync;\n');
      const reached = reachedFiles(tmp, `${SDK_PKG}/src/index.ts`);
      expect(reached).toEqual([`${SDK_PKG}/src/a/b.ts`, `${SDK_PKG}/src/c.ts`, `${SDK_PKG}/src/index.ts`]);
      expect(reached.flatMap((f) => purityViolations(f, readFileSync(join(tmp, f), "utf8")))).toEqual([`${SDK_PKG}/src/c.ts: imports node:fs`]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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

/** codeOnly() with string and template literal contents blanked, for checks on code alone. Newlines are kept, so a line number still names its line. */
function codeWithoutStrings(text: string): string {
  return codeOnly(text).replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (m) => '""' + m.replace(/[^\n]/g, ""));
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

// ── issue 1765: node/ reads and writes files, and reaches nothing else ─────
// node/ is the package's fs edge, so it may import node:fs. It must not import
// csvb (the SDK never downloads an archive: a client hands it a folder csvb
// filled), a third-party HTTP client or node's http modules, or call fetch:
// the SDK's one provider HTTP path is src/extract/http.ts, reached through the
// injected fetch. The issue 1421 scan above covers src/ only; this covers node/.
// The red control plants each violation in a real temporary node/ tree and
// expects it named with its file and line.
const NODE_HTTP_MODULES = new Set(["node:http", "http", "node:https", "https", "node:http2", "http2"]);

/** Violations of the node/ edge rule in one file, each with its 1-based line. */
export function nodeEdgeViolations(file: string, text: string): string[] {
  const found: string[] = [];
  for (const { spec, line } of specifierLines(codeOnly(text))) {
    if (CSVB_IMPORT.test(spec)) found.push(`${file}:${line}: imports ${spec} (the SDK never imports csvb)`);
    if (HTTP_CLIENT_PACKAGES.has(spec) || NODE_HTTP_MODULES.has(spec)) found.push(`${file}:${line}: imports the HTTP client ${spec}`);
  }
  codeWithoutStrings(text).split("\n").forEach((code, i) => {
    for (const [re, what] of DIRECT_HTTP) if (re.test(code)) found.push(`${file}:${i + 1}: ${what} (node/ reads and writes local files only)`);
  });
  return found;
}

/** Every node/ edge violation under `<base>/packages/analyst-sdk/node`, each file named relative to `base`. */
function scanNodeEdge(base: string): string[] {
  return tsFiles(join(base, SDK_PKG, "node")).flatMap((f) => nodeEdgeViolations(relative(base, f), readFileSync(f, "utf8")));
}

describe("issue 1765: node/ imports no csvb and no HTTP client, and never calls fetch", () => {
  test("the scan is non-vacuous: it reads every node/ file, the fs edge among them", () => {
    const names = tsFiles(join(root, SDK_PKG, "node")).map((f) => relative(join(root, SDK_PKG, "node"), f)).sort();
    expect(names).toContain("backups-dir.ts");
    expect(names).toContain("supplementary-dir.ts");
    expect(names.length).toBeGreaterThanOrEqual(4);
  });

  test("the real node/ tree has no violation", () => {
    expect(scanNodeEdge(root)).toEqual([]);
  });

  test("red control: planted node/ files on disk are flagged with file and line; node:fs, a comment and a string are not", () => {
    const tmp = mkdtempSync(join(tmpdir(), "analyst-sdk-node-edge-"));
    try {
      const node = join(tmp, SDK_PKG, "node");
      mkdirSync(node, { recursive: true });
      writeFileSync(join(node, "planted-csvb.ts"), '// the csvb client\nimport { fill } from "@robotmoney/csvb";\nexport const f = fill;\n');
      writeFileSync(join(node, "planted-csvb-path.ts"), 'export { fill } from "../../csvb/src/cli.ts";\n');
      writeFileSync(join(node, "planted-axios.ts"), 'import { readFileSync } from "node:fs";\nimport axios from "axios";\nexport const a = [axios, readFileSync];\n');
      writeFileSync(join(node, "planted-https.ts"), 'import { request } from "node:https";\nexport const r = request;\n');
      writeFileSync(join(node, "planted-fetch.ts"), 'const note = `a template\nover two lines`;\n\nexport const get = (u: string) => fetch(u);\n');
      writeFileSync(join(node, "planted-global-fetch.ts"), "export const g = globalThis.fetch;\n");
      writeFileSync(join(node, "clean.ts"), '// never fetch( here, and never import "@robotmoney/csvb"\nimport { readFileSync } from "node:fs";\nexport const msg = "fetch(x) is the extractors\' job";\nexport const read = readFileSync;\n');
      expect(scanNodeEdge(tmp).sort()).toEqual([
        `${SDK_PKG}/node/planted-axios.ts:2: imports the HTTP client axios`,
        `${SDK_PKG}/node/planted-csvb-path.ts:1: imports ../../csvb/src/cli.ts (the SDK never imports csvb)`,
        `${SDK_PKG}/node/planted-csvb.ts:2: imports @robotmoney/csvb (the SDK never imports csvb)`,
        `${SDK_PKG}/node/planted-fetch.ts:4: calls fetch (node/ reads and writes local files only)`,
        `${SDK_PKG}/node/planted-global-fetch.ts:1: uses globalThis.fetch (node/ reads and writes local files only)`,
        `${SDK_PKG}/node/planted-https.ts:1: imports the HTTP client node:https`,
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── issue 1742 (R2): forward statistics are display only ────────────────────
// Forward correlations look forward by design. No decision module (the SDK's
// allocate/ and the backend's swarm/) may import analyze/correlations.ts,
// either the SDK file or the backend shim, or read RunResult.correlations.
const CORRELATIONS_IMPORT = /(^|\/)analyze\/correlations(\.ts)?$/;

/** Violations of the decision-module rule in one file. */
export function correlationReadViolations(file: string, text: string): string[] {
  const code = codeOnly(text);
  const found: string[] = [];
  for (const spec of specifiers(code)) {
    if (CORRELATIONS_IMPORT.test(spec)) found.push(`${file}: imports ${spec} (forward statistics are display only)`);
  }
  if (/\.\s*correlations\b/.test(code)) found.push(`${file}: reads a .correlations value (forward statistics are display only)`);
  return found;
}

describe("issue 1742: no decision module reads forward correlations", () => {
  const ALLOCATE = join(root, "packages/analyst-sdk/src/allocate");
  const SWARM = join(root, "backend/src/swarm");
  const allocateFiles = tsFiles(ALLOCATE);
  const swarmFiles = tsFiles(SWARM);

  test("the scan is non-vacuous", () => {
    expect(allocateFiles.length).toBeGreaterThanOrEqual(9);
    expect(swarmFiles.length).toBeGreaterThanOrEqual(18);
  });

  test("the real tree: no allocate/ or backend/src/swarm/ file imports analyze/correlations.ts or reads .correlations", () => {
    const violations = [...allocateFiles, ...swarmFiles].flatMap((f) => correlationReadViolations(relative(root, f), readFileSync(f, "utf8")));
    expect(violations).toEqual([]);
  });

  describe("red control: planted files", () => {
    test("flags an allocate/ file importing the SDK correlations module", () => {
      expect(correlationReadViolations("packages/analyst-sdk/src/allocate/x.ts", 'import { computeCorrelations } from "../analyze/correlations.ts";')).not.toEqual([]);
    });
    test("flags a swarm/ file importing it through the backend shim path", () => {
      expect(correlationReadViolations("backend/src/swarm/x.ts", 'import { CorrelationCell } from "../analytics/analyze/correlations.ts";')).not.toEqual([]);
    });
    test("flags a file reading RunResult.correlations", () => {
      expect(correlationReadViolations("packages/analyst-sdk/src/allocate/y.ts", "const c = run.correlations.forward;")).not.toEqual([]);
    });
    test("passes a clean file and a comment that names the module", () => {
      expect(correlationReadViolations("backend/src/swarm/ok.ts", '// never import analyze/correlations.ts here\nimport { x } from "./domain.ts";')).toEqual([]);
    });
  });
});
