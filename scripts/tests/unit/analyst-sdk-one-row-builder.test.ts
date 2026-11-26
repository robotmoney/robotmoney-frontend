// Issue 1765 (acceptance box 5): one published-row builder, no artifact kind
// compared with a literal outside the SDK, one COMPARED_FIELDS. It replaces
// release-replay-row-parity.test.ts (deleted by issue 1765), which held the
// copies of the as-of row builder equal to each other. The copies are gone
// (the backend's buildSnapshotRows, the release tool's replayRow and the backend
// test support's builder), so this asserts that none comes back.
//
// Mechanical, not conventional: this file scans every .ts file git lists
// (tracked, plus untracked files git does not ignore), except node_modules and
// this file, and fails on:
//   (1) the row-building rounding, `Number(<name>.toFixed(6))`, anywhere but
//       exactly once, in a file under packages/analyst-sdk/src. Other toFixed(6)
//       uses (a goldens CSV's fixed text, a log line, a test's expression in
//       parentheses) do not have this shape and are not matched.
//   (2) a TypeScript comparison (=== !== == !=) of an artifact kind
//       (artifact_kind, artifactKind) with the literal "regime_snapshots", in
//       either operand order, in any file outside packages/analyst-sdk/src. A
//       caller compares with REGIME_ARTIFACT_KIND or regimeArtifactKindOf, the
//       SDK's line lookup in src/analyze/regime-versions.ts.
//   (3) a declaration of COMPARED_FIELDS anywhere but exactly once, under
//       packages/analyst-sdk/src/replay. An import, a re-export or a use is not one.
//
// Scope: TypeScript comparisons only. SQL text that filters on
// artifact_kind = 'regime_snapshots' (backend/src/swarm/domain.ts, the cutover
// parity queries in backend/src/analytics/cutover/parity.ts, and tests) is a
// query over the table, not a replay tool's kind check, and is out of scope:
// check (2) matches only the TypeScript comparison operators. This implements
// the success test of the issue's proposal, .agents/ultracode-1765/proposal.md
// lines 506-507 (section 10): `rg "Number\(s.toFixed\(6\)\)"` finds one site,
// and `rg 'artifact_kind === "regime_snapshots"'` finds none outside the SDK's
// line lookup.
//
// Comments and regex literals are blanked before matching, with newlines kept
// so a line number names its line: prose that names a pattern is not a site.
//
// RED CONTROLS: scan() runs over planted maps built from scratch and must name
// each planted site by file and line, and the git walk runs over a planted
// temporary repository on disk, so a scanner or a walk that finds nothing
// cannot pass for a clean tree. An empty walk fails the walk check.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "../../..");
const SELF = "scripts/tests/unit/analyst-sdk-one-row-builder.test.ts";
const SDK_SRC = "packages/analyst-sdk/src/";
const SDK_REPLAY = "packages/analyst-sdk/src/replay/";
// The walk must reach each place a copy lived or a replay tool lives.
const WALK_ROOTS = ["packages/analyst-sdk/src", "backend/src", "backend/scripts", "backend/tests", "scripts/release", "packages/csvb/src"];
const MIN_FILES = 1000;

// (1) The published row's percentile rounding, the shape every copy had.
const ROW_BUILDER = /Number\(\s*[\w.\[\]!]+\.toFixed\(6\)\s*\)/;
// (2) An artifact kind compared with the literal, in either operand order.
const KIND_LITERAL = /artifact_?[kK]ind[!"'\]]*\s*[!=]==?\s*["']regime_snapshots["']|["']regime_snapshots["']\s*[!=]==?\s*[\w$.?!\[\]"']*artifact_?[kK]ind\b/;
// (3) A declaration (`COMPARED_FIELDS =`, `COMPARED_FIELDS: T =`), not a comparison or a `typeof COMPARED_FIELDS` annotation.
const COMPARED_FIELDS_DECL = /(?<!\btypeof\s+)\bCOMPARED_FIELDS\s*(:[^=]+)?=(?!=)/;
// A file without one of these cannot hold a site, so it is not tokenized.
const NEEDLES = ["toFixed(6)", "regime_snapshots", "COMPARED_FIELDS"];

// True when a `/` here starts a regex literal rather than dividing: the last
// significant character before it cannot end an operand. The same scanner as
// scripts/tests/unit/analyst-sdk-purity.test.ts.
function startsRegex(before: string): boolean {
  const t = before.trimEnd();
  if (t === "") return true;
  if (/[(,=:[!&|?{};+\-*%<>~^]$/.test(t)) return true;
  return /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/.test(t);
}

/** The text with comments and regex literals blanked; strings and template literals are kept, and so is every newline. */
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

export interface Violation {
  file: string;
  /** 1-based; 0 when the violation is a missing site. */
  line: number;
  rule: string;
  text: string;
}

type Site = Omit<Violation, "rule">;

// A site that must appear exactly once, under `home`: each site outside `home`
// is a violation, each of two or more under it is one, and none at all is one.
function exactlyOnce(sites: Site[], home: string, what: string): Violation[] {
  const inside = sites.filter((s) => s.file.startsWith(home));
  const out: Violation[] = sites.filter((s) => !s.file.startsWith(home)).map((s) => ({ ...s, rule: `${what} outside ${home}` }));
  if (inside.length > 1) out.push(...inside.map((s) => ({ ...s, rule: `${what}: ${inside.length} under ${home}, one expected` })));
  if (inside.length === 0) out.push({ file: home, line: 0, text: "", rule: `${what}: none under ${home}, one expected` });
  return out;
}

/** Every site of each rule in `files` (repo-relative path to text), in file order. */
export function sitesOf(files: ReadonlyMap<string, string>): { rows: Site[]; kinds: Site[]; decls: Site[] } {
  const rows: Site[] = [];
  const kinds: Site[] = [];
  const decls: Site[] = [];
  for (const [file, text] of files) {
    if (!NEEDLES.some((n) => text.includes(n))) continue;
    codeOnly(text)
      .split("\n")
      .forEach((code, i) => {
        const site = { file, line: i + 1, text: code.trim() };
        if (ROW_BUILDER.test(code)) rows.push(site);
        if (KIND_LITERAL.test(code)) kinds.push(site);
        if (COMPARED_FIELDS_DECL.test(code)) decls.push(site);
      });
  }
  return { rows, kinds, decls };
}

/** Every violation of the three rules in `files` (repo-relative path to text), sorted by file and line. */
export function scan(files: ReadonlyMap<string, string>): Violation[] {
  const { rows, kinds, decls } = sitesOf(files);
  return [
    ...exactlyOnce(rows, SDK_SRC, "the published row's Number(x.toFixed(6)) rounding"),
    ...kinds.filter((s) => !s.file.startsWith(SDK_SRC)).map((s) => ({ ...s, rule: `an artifact kind compared with the literal "regime_snapshots" outside ${SDK_SRC} (compare with REGIME_ARTIFACT_KIND)` })),
    ...exactlyOnce(decls, SDK_REPLAY, "a COMPARED_FIELDS declaration"),
  ].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

const at = (v: readonly Violation[]): string[] => v.map((x) => `${x.file}:${x.line}`);

/** Every .ts file git lists under `base` (tracked, and untracked files it does not ignore), except node_modules and this file. */
export function gitTsFiles(base: string): string[] {
  // A hook's GIT_DIR or GIT_INDEX_FILE would point git at another repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const r = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.ts"], { cwd: base, env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ls-files failed in ${base}: ${r.stderr.toString()}`);
  const out = new Set<string>();
  for (const p of r.stdout.toString().split("\0")) {
    if (p === "" || p === SELF || p.split("/").includes("node_modules")) continue;
    try {
      if (statSync(join(base, p)).isFile()) out.add(p);
    } catch {
      // Deleted in the working tree and not yet staged: there is nothing to read.
    }
  }
  return [...out].sort();
}

function tree(base: string): Map<string, string> {
  return new Map(gitTsFiles(base).map((p) => [p, readFileSync(join(base, p), "utf8")]));
}

/** Why a walk is too thin to trust: a root it found nothing under, or fewer than `min` files. */
export function walkProblems(paths: readonly string[], min: number): string[] {
  const problems = WALK_ROOTS.filter((r) => !paths.some((p) => p.startsWith(`${r}/`))).map((r) => `the walk found no .ts file under ${r}`);
  if (paths.length < min) problems.push(`the walk found ${paths.length} .ts files, fewer than ${min}`);
  return problems;
}

describe("one row builder, no literal artifact kind outside the SDK, one COMPARED_FIELDS (issue 1765)", () => {
  const files = tree(root);

  test("the walk is non-vacuous: every root is reached, over a thousand files in all; an empty walk fails", () => {
    expect(walkProblems([...files.keys()], MIN_FILES)).toEqual([]);
    expect(files.has(SELF)).toBe(false);
    expect([...files.keys()].some((p) => p.includes("node_modules"))).toBe(false);
    expect(walkProblems([], MIN_FILES)).toEqual([...WALK_ROOTS.map((r) => `the walk found no .ts file under ${r}`), `the walk found 0 .ts files, fewer than ${MIN_FILES}`]);
  });

  test("the real tree: the one row builder and the one COMPARED_FIELDS are in the SDK, and nothing else matches", () => {
    expect(scan(files).map((v) => `${v.file}:${v.line}: ${v.rule}: ${v.text}`)).toEqual([]);
  });

  test("the real tree: each single site is where the rule says", () => {
    const { rows, decls } = sitesOf(files);
    expect(rows.length).toBe(1);
    expect(rows[0]!.file.startsWith(SDK_SRC)).toBe(true);
    expect(decls.length).toBe(1);
    expect(decls[0]!.file.startsWith(SDK_REPLAY)).toBe(true);
    // The SDK's line lookup names the literal; callers use it.
    expect(files.get("packages/analyst-sdk/src/analyze/regime-versions.ts")).toMatch(/export const REGIME_ARTIFACT_KIND\b/);
  });

  describe("red control: planted maps", () => {
    // Built from scratch, never from the real tree, so these keep biting when the real tree is clean.
    const CLEAN = new Map<string, string>([
      ["packages/analyst-sdk/src/replay/rows.ts", "export const pct = (s: number) => Number(s.toFixed(6));\n"],
      ["packages/analyst-sdk/src/replay/compare.ts", 'export const COMPARED_FIELDS = ["regime", "composite"] as const;\nexport type F = (typeof COMPARED_FIELDS)[number];\n'],
      ["packages/analyst-sdk/src/analyze/regime-versions.ts", 'export const REGIME_ARTIFACT_KIND = { main: "regime_snapshots" } as const;\nexport const isMain = (artifactKind: string) => artifactKind === "regime_snapshots";\n'],
      [
        "backend/scripts/replay-sample.ts",
        'import { COMPARED_FIELDS } from "../../packages/analyst-sdk/src/replay/index.ts";\nexport { COMPARED_FIELDS } from "../../packages/analyst-sdk/src/replay/index.ts";\nconst fields: typeof COMPARED_FIELDS = COMPARED_FIELDS;\nif (fields === COMPARED_FIELDS) console.log(COMPARED_FIELDS.length);\n',
      ],
      [
        "backend/src/analytics/report/clean.ts",
        [
          "// Number(s.toFixed(6)) in a comment is prose",
          '/* o.artifact_kind !== "regime_snapshots" and COMPARED_FIELDS = [] in a block comment */',
          "const label = v.toFixed(6);",
          "const shifted = Number((p > 0.5 ? p - 0.25 : p).toFixed(6));",
          "const rows = await sql`SELECT id FROM analytics_output_snapshots WHERE artifact_kind = 'regime_snapshots'`;",
          "const re = /artifact_kind === \"regime_snapshots\"/;",
          "if (o.artifact_kind === REGIME_ARTIFACT_KIND.main) console.log(o.id);",
          'const view = { artifact_kind: "regime_snapshots" };',
          "",
        ].join("\n"),
      ],
    ]);
    const plant = (...extra: Array<[string, string]>) => new Map([...CLEAN, ...extra]);

    test("positive: the clean map has no violation", () => {
      expect(scan(CLEAN)).toEqual([]);
    });

    test("a second Number(x.toFixed(6)) in backend/src/foo.ts is named by file and line", () => {
      const v = scan(plant(["backend/src/foo.ts", "import type { Row } from './row.ts';\nexport const pct = (x: { s: number }) => Number(x.s.toFixed(6));\n"]));
      expect(at(v)).toEqual(["backend/src/foo.ts:2"]);
      expect(v[0]!.rule).toContain("outside packages/analyst-sdk/src/");
    });

    test("a second row builder inside the SDK names both sites", () => {
      const v = scan(plant(["packages/analyst-sdk/src/engine/history.ts", "\n\nconst p = Number(row.percentiles![id].toFixed(6));\n"]));
      expect(at(v)).toEqual(["packages/analyst-sdk/src/engine/history.ts:3", "packages/analyst-sdk/src/replay/rows.ts:1"]);
      expect(v[0]!.rule).toContain("2 under packages/analyst-sdk/src/, one expected");
    });

    test("no row builder at all is a violation", () => {
      const none = new Map(CLEAN);
      none.delete("packages/analyst-sdk/src/replay/rows.ts");
      expect(scan(none).map((x) => x.rule)).toEqual(["the published row's Number(x.toFixed(6)) rounding: none under packages/analyst-sdk/src/, one expected"]);
    });

    test('an `o.artifact_kind !== "regime_snapshots"` in scripts/release/bar.ts is named by file and line, in either operand order', () => {
      const v = scan(
        plant(
          ["scripts/release/bar.ts", 'for (const o of outputs) {\n  if (o.artifact_kind !== "regime_snapshots") continue;\n}\n'],
          ["packages/csvb/src/audit/baz.ts", "const own = rows.filter((r) => 'regime_snapshots' === r.artifactKind);\n"],
          ["backend/tests/support/qux.ts", 'expect(rows.find((r) => r["artifact_kind"] == "regime_snapshots")).toBeDefined();\n'],
        ),
      );
      expect(at(v)).toEqual(["backend/tests/support/qux.ts:1", "packages/csvb/src/audit/baz.ts:1", "scripts/release/bar.ts:2"]);
      expect(v.every((x) => x.rule.includes("REGIME_ARTIFACT_KIND"))).toBe(true);
    });

    test("a second COMPARED_FIELDS declaration is named by file and line, outside the replay folder or inside it", () => {
      expect(at(scan(plant(["scripts/release/replay-fields.ts", '\nexport const COMPARED_FIELDS: readonly string[] = ["regime"];\n'])))).toEqual(["scripts/release/replay-fields.ts:2"]);
      expect(at(scan(plant(["packages/analyst-sdk/src/replay/fields.ts", 'let COMPARED_FIELDS = ["regime"];\n'])))).toEqual([
        "packages/analyst-sdk/src/replay/compare.ts:1",
        "packages/analyst-sdk/src/replay/fields.ts:1",
      ]);
      // Under the SDK but outside src/replay is still outside its home.
      expect(at(scan(plant(["packages/analyst-sdk/src/engine/fields.ts", "export const COMPARED_FIELDS = [] as const;\n"])))).toEqual(["packages/analyst-sdk/src/engine/fields.ts:1"]);
    });
  });

  test("red control: the git walk over a planted temporary repository finds a planted site in a real file, skipping node_modules, ignored files and this file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "one-row-builder-"));
    try {
      const write = (p: string, text: string) => {
        mkdirSync(dirname(join(tmp, p)), { recursive: true });
        writeFileSync(join(tmp, p), text);
      };
      const copyOfRow = "export const pct = (r: { s: number }) => Number(r.s.toFixed(6));\n";
      write("packages/analyst-sdk/src/replay/rows.ts", "export const pct = (s: number) => Number(s.toFixed(6));\n");
      write("packages/analyst-sdk/src/replay/compare.ts", 'export const COMPARED_FIELDS = ["regime"] as const;\n');
      write("backend/src/analytics/planted.ts", `// a planted copy of the row builder, on line 3\nexport const a = 1;\n${copyOfRow}`);
      write("backend/scripts/not-yet-added.ts", '\nif (o.artifact_kind === "regime_snapshots") console.log(o.id);\n');
      write("node_modules/dep/index.ts", copyOfRow);
      write("packages/csvb/node_modules/dep/index.ts", copyOfRow);
      write(SELF, copyOfRow);
      write("ignored/x.ts", copyOfRow);
      write(".gitignore", "ignored/\n");
      write("README.md", copyOfRow);
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
      const git = (...args: string[]) => {
        const r = Bun.spawnSync(["git", ...args], { cwd: tmp, env, stdout: "pipe", stderr: "pipe" });
        if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
      };
      git("init", "-q");
      git("add", "-f", "packages", "backend/src", "node_modules", SELF, ".gitignore", "README.md");
      // Tracked node_modules and this file are skipped; the untracked file is walked; the ignored one is not.
      expect(gitTsFiles(tmp)).toEqual([
        "backend/scripts/not-yet-added.ts",
        "backend/src/analytics/planted.ts",
        "packages/analyst-sdk/src/replay/compare.ts",
        "packages/analyst-sdk/src/replay/rows.ts",
      ]);
      expect(at(scan(tree(tmp)))).toEqual(["backend/scripts/not-yet-added.ts:2", "backend/src/analytics/planted.ts:3"]);
      // A tree this small fails the walk check.
      expect(walkProblems(gitTsFiles(tmp), MIN_FILES)).toContain(`the walk found 4 .ts files, fewer than ${MIN_FILES}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
