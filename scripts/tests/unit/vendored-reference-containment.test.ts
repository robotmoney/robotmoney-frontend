// The vendored original-JS regime reference
// (backend/scripts/vendor/regime-reference-js/, issue #447 / PR #464) carries a
// stated rule — "never imported by `src/`" — that nothing enforced (issue #504).
// Its README name-checked backend/tests/no-new-vendor.test.ts as the guard; that
// test is a hardcoded 6-file allowlist scanning backend/src/chain/* for forbidden
// HOST strings (issue #84) and has no opinion about this directory at all. AC2 of
// issue #500 was satisfied by a one-time human grep at merge time.
//
// This file makes both halves of the containment executable, per-PR, in the
// required `unit` workflow (no Docker, no network, no env gate):
//
//  1. **No backend/src/** file references the vendored tree.** Scanned over
//     comment-stripped code, so prose that merely names the directory is not a
//     false positive, and over STRING LITERALS rather than `import`/`require`
//     syntax alone — the real load path is `createRequire(...)(join(VENDOR_DIR,
//     "compute.js"))`, which no import-statement regex would ever see.
//
//  2. **The invariant that actually holds the line.** The vendored files are NOT
//     kept out of the compiled tree by living outside it: backend/tsconfig.json's
//     `include` covers `scripts/**/*.ts`, and the vendor directory sits under
//     backend/scripts/. They stay out purely because they are `.js` and `allowJs`
//     is off. So the real invariant is: `include` never gains a `.js` glob and
//     `allowJs` is never enabled — much easier to break by accident than "don't
//     import from the vendor dir", and undocumented before this issue.
//
// Every assertion below is paired with a RED CONTROL: the scanner is run against
// fixture trees carrying a planted violation, and the tsconfig predicate against
// tampered copies of the real config. A guard never proven capable of failing is
// not a guard.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const BACKEND = join(repoRoot, "backend");
// Path of THIS file, as the vendor README must cite it.
const GUARD_REL = "scripts/tests/unit/vendored-reference-containment.test.ts";
const VENDOR_README = join(BACKEND, "scripts", "vendor", "regime-reference-js", "README.md");
const BACKEND_TSCONFIG = join(BACKEND, "tsconfig.json");
const CODE_EXT = [".ts", ".tsx", ".js", ".cjs", ".mjs"];

// ── the scanner (shared by the real-tree check and the red controls) ─────────

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...walk(full));
    } else if (CODE_EXT.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

// Scan CODE, not prose: a source comment is allowed to name the vendored tree
// (this repo's convention — see backend/tests/no-new-vendor.test.ts). The
// `[^:]` guard keeps the `//` in `https://…` from reading as a line comment.
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function stringLiterals(code: string): string[] {
  return [...code.matchAll(/(['"`])([^'"`\n]*?)\1/g)].map((m) => m[2]!);
}

function pathSegments(literal: string): string[] {
  return literal.split(/[\\/]+/).filter((s) => s.length > 0);
}

// Directories vendored under backend/scripts/vendor/ — read from the tree, so a
// second vendored package arrives already guarded instead of needing a new test.
function vendoredPackageNames(backendRoot: string): string[] {
  const root = join(backendRoot, "scripts", "vendor");
  if (!existsSync(root)) throw new Error(`no vendor root to scan: ${root}`);
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

// Every reference from <backendRoot>/src/** into <backendRoot>/scripts/vendor/**,
// as "<file>: <literal>" strings. Throws — never returns a vacuous empty list —
// if there is nothing to scan on either side.
function vendorReferencesFromSrc(backendRoot: string): string[] {
  const srcRoot = join(backendRoot, "src");
  if (!existsSync(srcRoot)) throw new Error(`no src tree to scan: ${srcRoot}`);
  const vendorRoot = resolve(join(backendRoot, "scripts", "vendor"));
  const packages = vendoredPackageNames(backendRoot);
  const files = walk(srcRoot);
  if (files.length === 0) throw new Error(`no source files under ${srcRoot}`);

  const hits: string[] = [];
  for (const file of files) {
    for (const literal of stringLiterals(codeOnly(readFileSync(file, "utf8")))) {
      const namesPackage = pathSegments(literal).some((s) => packages.includes(s));
      const resolvesInside =
        literal.startsWith(".") && `${resolve(dirname(file), literal)}${sep}`.startsWith(`${vendorRoot}${sep}`);
      if (namesPackage || resolvesInside) hits.push(`${relative(backendRoot, file)}: ${literal}`);
    }
  }
  return hits;
}

// ── the tsconfig containment predicate (shared with its red controls) ────────

interface BackendTsconfig {
  compilerOptions: Record<string, unknown>;
  include: string[];
}

function readBackendTsconfig(): BackendTsconfig {
  return JSON.parse(readFileSync(BACKEND_TSCONFIG, "utf8")) as BackendTsconfig;
}

// Reasons backend/tsconfig.json would start pulling the vendored `.js` into the
// compiled tree. Empty list == the containment invariant holds.
function tsconfigJsExposure(cfg: BackendTsconfig): string[] {
  const reasons: string[] = [];
  for (const glob of cfg.include ?? []) {
    // `*.js` / `*.mjs` / `*.cjs` / `*.jsx` as an extension, or inside a
    // brace list such as `**/*.{ts,js}`.
    if (/\.(c|m)?jsx?(\b|$)/i.test(glob) || /\{[^}]*\b(c|m)?jsx?\b[^}]*\}/i.test(glob)) {
      reasons.push(`include glob pulls in JavaScript: ${glob}`);
    }
  }
  if (cfg.compilerOptions?.allowJs) reasons.push("compilerOptions.allowJs is enabled");
  return reasons;
}

// ── fixture backend trees for the red controls ──────────────────────────────

// <root>/src/chain/<name> plus a real <root>/scripts/vendor/regime-reference-js/
// tree, so relative specifiers resolve exactly as they would in the repo.
function fixtureBackend(name: string, contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "vendored-reference-containment-"));
  mkdirSync(join(root, "src", "chain"), { recursive: true });
  mkdirSync(join(root, "scripts", "vendor", "regime-reference-js", "lib"), { recursive: true });
  writeFileSync(join(root, "scripts", "vendor", "regime-reference-js", "compute.js"), "module.exports = {};\n");
  writeFileSync(join(root, "scripts", "vendor", "loose-helper.js"), "module.exports = {};\n");
  writeFileSync(join(root, "src", "chain", name), contents);
  return root;
}

function withFixture(name: string, contents: string, assert: (hits: string[]) => void): void {
  const root = fixtureBackend(name, contents);
  try {
    assert(vendorReferencesFromSrc(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the vendored regime reference is never reachable from backend/src (issue #504)", () => {
  test("the vendored tree it guards actually exists — a guard over nothing is a green that means nothing", () => {
    expect(vendoredPackageNames(BACKEND)).toContain("regime-reference-js");
    const vendored = walk(join(BACKEND, "scripts", "vendor", "regime-reference-js"));
    expect(vendored.length).toBeGreaterThan(0);
    expect(vendored.every((f) => f.endsWith(".js"))).toBe(true);
  });

  test("the REAL tree passes: no backend/src/** file imports, requires, or path-builds into backend/scripts/vendor/**", () => {
    const hits = vendorReferencesFromSrc(BACKEND);
    expect(hits, `backend/src must never reach the vendored reference:\n${hits.join("\n")}`).toEqual([]);
  });

  // ── red controls ──────────────────────────────────────────────────────────
  test("FAILS on a plain ESM import of the vendored package", () => {
    withFixture("regime.ts", 'import { computeRegime } from "../../scripts/vendor/regime-reference-js/compute.js";\n', (hits) => {
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.join("\n")).toContain("regime-reference-js");
    });
  });

  test("FAILS on the createRequire + join() load path — the one the regenerate script actually uses", () => {
    withFixture(
      "regime.ts",
      [
        'const require = createRequire(import.meta.url);',
        'const VENDOR = join(import.meta.dir, "..", "..", "scripts", "vendor", "regime-reference-js");',
        'const { computeRegime } = require(join(VENDOR, "compute.js"));',
        "",
      ].join("\n"),
      (hits) => {
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.join("\n")).toContain("regime-reference-js");
      },
    );
  });

  test("FAILS on a file directly under scripts/vendor/ that names no vendored package — path resolution, not just name matching", () => {
    withFixture("regime.ts", 'import { helper } from "../../scripts/vendor/loose-helper.js";\n', (hits) => {
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.join("\n")).toContain("loose-helper.js");
    });
  });

  test("FAILS on a dynamic import of the vendored package", () => {
    withFixture("regime.ts", 'export const load = () => import("../../scripts/vendor/regime-reference-js/lib/utils.js");\n', (hits) => {
      expect(hits.length).toBeGreaterThan(0);
    });
  });

  test("PASSES on a clean file that merely NAMES the vendored tree in a comment — the guard must not cry wolf", () => {
    withFixture(
      "regime.ts",
      [
        "// The independent reference lives in scripts/vendor/regime-reference-js/",
        "// and is never loaded from here.",
        '/* see scripts/vendor/regime-reference-js/README.md */',
        'import { join } from "node:path";',
        'export const P = join("a", "b");',
        "",
      ].join("\n"),
      (hits) => expect(hits).toEqual([]),
    );
  });

  test("a backend tree with no src/ or no vendor/ is LOUD, not vacuously green", () => {
    const empty = mkdtempSync(join(tmpdir(), "vendored-reference-containment-empty-"));
    try {
      expect(() => vendorReferencesFromSrc(empty)).toThrow(/no src tree to scan/);
      mkdirSync(join(empty, "src"), { recursive: true });
      expect(() => vendorReferencesFromSrc(empty)).toThrow(/no vendor root to scan/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("backend/tsconfig.json keeps the vendored .js out of the compiled tree (issue #504)", () => {
  test("the REAL config passes: no .js include glob, no allowJs", () => {
    const cfg = readBackendTsconfig();
    // Sanity: the vendored tree really does sit inside an included path, so the
    // extension is the only thing holding the line.
    expect(cfg.include).toContain("scripts/**/*.ts");
    const reasons = tsconfigJsExposure(cfg);
    expect(reasons, reasons.join("\n")).toEqual([]);
  });

  // ── red controls ──────────────────────────────────────────────────────────
  const jsGlobs = ["scripts/**/*.js", "src/**/*.mjs", "scripts/**/*.cjs", "scripts/**/*.{ts,js}"];
  for (const glob of jsGlobs) {
    test(`FAILS when include gains ${glob}`, () => {
      const cfg = readBackendTsconfig();
      const reasons = tsconfigJsExposure({ ...cfg, include: [...cfg.include, glob] });
      expect(reasons.length).toBeGreaterThan(0);
      expect(reasons.join("\n")).toContain(glob);
    });
  }

  test("FAILS when allowJs is enabled", () => {
    const cfg = readBackendTsconfig();
    const reasons = tsconfigJsExposure({ ...cfg, compilerOptions: { ...cfg.compilerOptions, allowJs: true } });
    expect(reasons).toContain("compilerOptions.allowJs is enabled");
  });
});

describe("the vendor README names the guard that really enforces its rules (issue #504)", () => {
  const readme = readFileSync(VENDOR_README, "utf8");

  test("it no longer cites no-new-vendor.test.ts, which never read this directory", () => {
    expect(readme).not.toContain("no-new-vendor.test.ts");
  });

  test("it names THIS guard, and the file it names exists", () => {
    expect(readme).toContain(GUARD_REL);
    expect(existsSync(join(repoRoot, GUARD_REL))).toBe(true);
  });

  test("it still states both containment rules, including the tsconfig one", () => {
    expect(readme).toContain("Never imported by `src/`");
    expect(readme).toContain("allowJs");
  });
});
