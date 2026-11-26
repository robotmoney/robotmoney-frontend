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
//   (2) a TypeScript check of an artifact kind (artifact_kind, artifactKind)
//       against the literal "regime_snapshots", in any file outside
//       packages/analyst-sdk/src. A caller compares with REGIME_ARTIFACT_KIND or
//       regimeArtifactKindOf, the SDK's line lookup in
//       src/analyze/regime-versions.ts. The shapes:
//         - a comparison (=== !== == !=) in either operand order;
//         - the literal written in quotes or as a template literal with no
//           substitution (`regime_snapshots`);
//         - the kind operand wrapped in a cast or a call:
//           (o.artifact_kind as string), String(o.artifact_kind), <string>o.artifact_kind;
//         - `case "regime_snapshots":` in a switch whose discriminant names
//           an artifact kind (a switch on a table name is not one);
//         - a literal list holding the literal tested with .includes, .has
//           or .indexOf on an artifact kind: ["regime_snapshots"].includes(o.artifact_kind).
//   (3) a declaration of COMPARED_FIELDS anywhere but exactly once, under
//       packages/analyst-sdk/src/replay. An import, a re-export or a use is not one.
//
// Scope: TypeScript checks only. SQL text that filters on
// artifact_kind = 'regime_snapshots' (backend/src/swarm/domain.ts, the cutover
// parity queries in backend/src/analytics/cutover/parity.ts, and tests) is a
// query over the table, not a replay tool's kind check, and is out of scope:
// check (2) runs over the code with every string and template literal's text
// blanked, so SQL inside a literal (even `artifact_kind != 'regime_snapshots'`
// or `CASE artifact_kind WHEN ...`) cannot match. Only a literal whose whole
// text is the kind, or an artifact kind property name (o["artifact_kind"]), is
// kept, and a template's ${...} code is kept. This implements
// the success test of the issue's proposal, .agents/ultracode-1765/proposal.md
// lines 506-507 (section 10): `rg "Number\(s.toFixed\(6\)\)"` finds one site,
// and `rg 'artifact_kind === "regime_snapshots"'` finds none outside the SDK's
// line lookup.
//
// Comments and regex literals are blanked before matching, with newlines kept
// so a line number names its line: prose that names a pattern is not a site.
// A template's ${...} is scanned as code, so a regex or a nested template in it
// (`${s.replace(/"/g, '""')}`, `${a ? `https://x/${p}` : ""}`) cannot open a
// string or a comment that blanks the rest of the file. Two checks keep a lost
// scanner from passing for a clean file: both scanners must end clean on every
// walked file (each literal, comment and ${...} closed, each brace matched,
// each line kept), and a backstop runs the strict === and !== comparisons over
// each line scanned on its own.
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
// (2) An artifact kind checked against the literal. These run over kindCode()
// text, where the literal is always written "regime_snapshots" (its quotes or
// backticks normalized) and every other literal's text is blank.
const KIND = String.raw`artifact_?[kK]ind\b`;
const LIT = String.raw`"regime_snapshots"`;
// After the kind on the left of a comparison: a closing quote, bracket or paren, a non-null `!`, a template's `}` and backtick, or a cast.
const KIND_TAIL = String.raw`(?:["'\]!)}\x60]|\s+(?:as|satisfies)\s+[\w$.<>\[\]|"']+)*`;
// Before the kind on the right: open parens, a <T> cast, a call such as String(, or a template's backtick and ${; then a member chain.
const KIND_HEAD = String.raw`(?:\(\s*|<[\w$.\[\]|\s]+>\s*|[\w$]+\s*\(\s*|\x60\$\{\s*)*[\w$.?!\[\]"']*`;
const KIND_CHECKS: RegExp[] = [
  // o.artifact_kind === "regime_snapshots", (o.artifact_kind as string) !== ..., String(o.artifactKind) == ...
  new RegExp(String.raw`${KIND}${KIND_TAIL}\s*[!=]==?\s*\(*\s*${LIT}`, "g"),
  // "regime_snapshots" === o.artifact_kind, ... !== String(o.artifact_kind), ... === (o.artifactKind as K)
  new RegExp(String.raw`${LIT}\s*[!=]==?\s*${KIND_HEAD}${KIND}`, "g"),
  // ["regime_snapshots", ...].includes(o.artifact_kind), (... as const).includes, new Set([...]).has, [...].indexOf(...)
  new RegExp(String.raw`\[[^\[\]]*${LIT}[^\[\]]*\](?:\s+as\s+const)?\s*\)?\s*\??\.\s*(?:includes|has|indexOf)\s*\(\s*${KIND_HEAD}${KIND}`, "g"),
];
// The backstop: the strict comparisons (=== and !==, which SQL never writes)
// over each codeOnly() line run through kindCode() on its own. A scanner that
// loses its place on one line cannot carry that into a later line here, so it
// can never hide a plain `o.artifact_kind === "regime_snapshots"`.
const STRICT_KIND_CHECKS: RegExp[] = [new RegExp(String.raw`${KIND}${KIND_TAIL}\s*[!=]==\s*\(*\s*${LIT}`), new RegExp(String.raw`${LIT}\s*[!=]==\s*${KIND_HEAD}${KIND}`)];
// A `case "regime_snapshots":` label; it is a site only inside a switch on an artifact kind.
const KIND_CASE = new RegExp(String.raw`\bcase\s*\(?\s*${LIT}\s*\)?\s*:`, "g");
// A literal whose whole text is one of these is kept in kindCode(); every other literal's text is blanked.
const KEPT_LITERAL = /^(?:regime_snapshots|artifact_?[kK]ind)$/;
// (3) A declaration (`COMPARED_FIELDS =`, `COMPARED_FIELDS: T =`), not a comparison or a `typeof COMPARED_FIELDS` annotation.
const COMPARED_FIELDS_DECL = /(?<!\btypeof\s+)\bCOMPARED_FIELDS\s*(:[^=]+)?=(?!=)/;
// A file without one of these cannot hold a site, so it is not tokenized.
const NEEDLES = ["toFixed(6)", "regime_snapshots", "COMPARED_FIELDS"];

// True when a `/` here starts a regex literal rather than dividing: the last
// significant character before it cannot end an operand. Derived from the
// scanner in scripts/tests/unit/analyst-sdk-purity.test.ts, plus one case: a
// TypeScript non-null assertion (`a[i]! / b`) ends an operand, so the `/`
// after it divides.
function startsRegex(before: string): boolean {
  const t = before.trimEnd();
  if (t === "") return true;
  if (/[\w$)\]]!$/.test(t)) return false;
  if (/[(,=:[!&|?{};+\-*%<>~^]$/.test(t)) return true;
  return /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/.test(t);
}

/** A scanner's output: its text, with every newline kept, and what kept the scan from ending clean. */
export interface Scan {
  text: string;
  /** Each is `line N: what`. Empty when every literal, comment and ${...} closed (and, for kindCode, every brace matched). */
  problems: string[];
}

const lineOf = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

/**
 * The text with comments and regex literals blanked; strings and template
 * literals are kept, and so is every newline. A template's ${...} is scanned
 * as code, so a regex literal or a comment inside it is blanked and a template
 * nested in it is read as one: `${name.replace(/"/g, '""')}` and
 * `${base ? `https://x/${p}` : ""}` neither open a string nor start a comment.
 * A string literal ends at its line's end, so one stray quote cannot swallow
 * the lines after it.
 */
export function codeOnly(text: string): Scan {
  let out = "";
  let i = 0;
  const problems: string[] = [];
  const problem = (at: number, what: string) => problems.push(`line ${lineOf(text, at)}: ${what}`);
  // A shebang line is not code.
  if (text.startsWith("#!")) while (i < text.length && text[i] !== "\n") i++;
  // Code up to the `}` that closes the ${...} opened at `open`, or to the end of the text when `open` is undefined.
  const code = (open?: number): void => {
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      const n = text[i + 1];
      if (c === "/" && n === "/") {
        while (i < text.length && text[i] !== "\n") i++;
      } else if (c === "/" && n === "*") {
        const start = i;
        i += 2;
        while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) out += text[i++] === "\n" ? "\n" : "";
        if (i >= text.length) problem(start, "a block comment is not closed");
        i += 2;
        out += " ";
      } else if (c === "/" && startsRegex(out)) {
        // Regex literal: skip to the closing unescaped `/` (a `/` inside [...] does not close it), then the flags.
        const start = i++;
        let inClass = false;
        while (i < text.length && text[i] !== "\n" && (inClass || text[i] !== "/")) {
          if (text[i] === "\\") i++;
          else if (text[i] === "[") inClass = true;
          else if (text[i] === "]") inClass = false;
          i++;
        }
        if (text[i] === "/") {
          i++;
          while (i < text.length && /[a-z]/i.test(text[i]!)) i++;
        } else problem(start, "a regex literal is not closed on its line");
        out += "/_/";
      } else if (c === '"' || c === "'") {
        const start = i;
        out += text[i++];
        while (i < text.length && text[i] !== c && text[i] !== "\n") {
          if (text[i] === "\\") out += text[i++];
          out += text[i++] ?? "";
        }
        if (text[i] === c) out += text[i++];
        else problem(start, "a string literal is not closed on its line");
      } else if (c === "`") {
        template();
      } else if (c === "}" && depth === 0 && open !== undefined) {
        return;
      } else {
        if (c === "{") depth++;
        else if (c === "}" && depth > 0) depth--;
        out += c;
        i++;
      }
    }
    if (open !== undefined) problem(open, "a template's ${...} is not closed");
  };
  // A template literal from its opening backtick; each ${...} in it is code.
  const template = (): void => {
    const start = i;
    out += text[i++];
    while (i < text.length && text[i] !== "`") {
      if (text[i] === "\\") {
        out += text.slice(i, i + 2);
        i += 2;
      } else if (text[i] === "$" && text[i + 1] === "{") {
        const open = i;
        out += "${";
        i += 2;
        code(open);
        if (i < text.length) out += text[i++];
      } else {
        out += text[i++];
      }
    }
    if (i < text.length) out += text[i++];
    else problem(start, "a template literal is not closed");
  };
  code();
  return { text: out, problems };
}

/**
 * codeOnly() text with every string and template literal's text blanked, so
 * SQL or prose inside a literal cannot match a kind check. A literal whose whole
 * text is the kind or an artifact kind property name is kept, written in double
 * quotes, so `regime_snapshots` (a template with no substitution) reads like
 * "regime_snapshots". A template's ${...} code is kept and scanned. Every
 * newline is kept, so an offset still names its line. A `}` with no `{` is a
 * problem, not the end of the scan: the text after it is still scanned.
 */
export function kindCode(code: string): Scan {
  let i = 0;
  const problems: string[] = [];
  const problem = (at: number, what: string) => problems.push(`line ${lineOf(code, at)}: ${what}`);
  const blank = (t: string) => t.replace(/[^\n]/g, "");
  const literal = (body: string, raw: string) => (KEPT_LITERAL.test(body) ? `"${body}"` : `""${blank(raw)}`);
  // Code up to the `}` that closes the ${...} opened at `open`, or to the end of the text when `open` is undefined.
  const codeRun = (open?: number): string => {
    let out = "";
    let depth = 0;
    while (i < code.length) {
      const c = code[i]!;
      if (c === '"' || c === "'") {
        const start = i++;
        while (i < code.length && code[i] !== c && code[i] !== "\n") i += code[i] === "\\" ? 2 : 1;
        const closed = code[i] === c;
        if (closed) i++;
        else problem(start, "a string literal is not closed on its line");
        const raw = code.slice(start, i);
        out += closed ? literal(raw.slice(1, -1), raw) : `""${blank(raw)}`;
      } else if (c === "`") {
        out += template();
      } else if (c === "}" && depth === 0) {
        if (open !== undefined) return out;
        problem(i, "a `}` with no `{`");
        out += c;
        i++;
      } else {
        if (c === "{") depth++;
        if (c === "}") depth--;
        out += c;
        i++;
      }
    }
    if (open !== undefined) problem(open, "a template's ${...} is not closed");
    else if (depth > 0) problem(code.length, `${depth} \`{\` not closed at the end of the text`);
    return out;
  };
  // A template literal from its opening backtick.
  const template = (): string => {
    const start = i++;
    let text = "";
    let out = "";
    let substitutions = 0;
    while (i < code.length && code[i] !== "`") {
      if (code[i] === "\\") {
        text += code.slice(i, i + 2);
        i += 2;
      } else if (code[i] === "$" && code[i + 1] === "{") {
        const open = i;
        i += 2;
        out += `${blank(text)}\${${codeRun(open)}}`;
        i++;
        text = "";
        substitutions++;
      } else {
        text += code[i++];
      }
    }
    if (i < code.length) i++;
    else problem(start, "a template literal is not closed");
    return substitutions === 0 ? literal(text, `\`${text}\``) : `\`${out}${blank(text)}\``;
  };
  const text = codeRun();
  return { text, problems };
}

/** The offset just past the bracket that closes the one at `open` (`(` or `{`) in kindCode() text, or the text's length. */
function closeOf(text: string, open: number): number {
  const [o, c] = text[open] === "(" ? ["(", ")"] : ["{", "}"];
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === o) depth++;
    else if (text[j] === c && --depth === 0) return j + 1;
  }
  return text.length;
}

/** The 1-based lines of `code` (kindCode() text) that check an artifact kind against the literal, each once, in order. */
export function kindCheckLines(code: string): number[] {
  const lineAt = (offset: number) => code.slice(0, offset).split("\n").length;
  const lines = new Set<number>();
  for (const re of KIND_CHECKS) for (const m of code.matchAll(re)) lines.add(lineAt(m.index!));
  // Each switch's body, and whether its discriminant names an artifact kind.
  const switches: Array<{ start: number; end: number; onKind: boolean }> = [];
  for (const m of code.matchAll(/\bswitch\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = closeOf(code, open);
    const brace = code.indexOf("{", close);
    if (brace < 0 || code.slice(close, brace).trim() !== "") continue;
    switches.push({ start: brace, end: closeOf(code, brace), onKind: new RegExp(KIND).test(code.slice(open, close)) });
  }
  // A case label belongs to the innermost switch whose body holds it.
  for (const m of code.matchAll(KIND_CASE)) {
    const owner = switches.filter((s) => s.start < m.index! && m.index! < s.end).sort((a, b) => b.start - a.start)[0];
    if (owner?.onKind) lines.add(lineAt(m.index!));
  }
  return [...lines].sort((a, b) => a - b);
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
    const code = codeOnly(text).text;
    const lines = code.split("\n");
    lines.forEach((line, i) => {
      const site = { file, line: i + 1, text: line.trim() };
      if (ROW_BUILDER.test(line)) rows.push(site);
      if (COMPARED_FIELDS_DECL.test(line)) decls.push(site);
    });
    if (!text.includes("regime_snapshots")) continue;
    const found = new Set(kindCheckLines(kindCode(code).text));
    lines.forEach((line, i) => {
      if (line.includes("regime_snapshots") && STRICT_KIND_CHECKS.some((re) => re.test(kindCode(line).text))) found.add(i + 1);
    });
    for (const n of [...found].sort((a, b) => a - b)) kinds.push({ file, line: n, text: lines[n - 1]?.trim() ?? "" });
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

  test("the real tree: both scanners end clean on every walked file, with every literal, comment and ${...} closed, every brace matched and every line kept", () => {
    const unclean: string[] = [];
    for (const [file, text] of files) {
      const c = codeOnly(text);
      const k = kindCode(c.text);
      for (const p of [...c.problems, ...k.problems]) unclean.push(`${file}: ${p}`);
      const n = text.split("\n").length;
      if (c.text.split("\n").length !== n || k.text.split("\n").length !== n) unclean.push(`${file}: a scanner lost a line`);
    }
    expect(unclean).toEqual([]);
  });

  test("the real tree: a loose comparison appended to any walked file is a site at its last line, so no file hides its tail from the scanner", () => {
    // `==`, not `===`: the per-line backstop takes only === and !==, so this proves the whole-file scanner reaches the end.
    const missed: string[] = [];
    for (const [file, text] of files) {
      const planted = `${text}${text.endsWith("\n") ? "" : "\n"}if (o.artifact_kind == "regime_snapshots") planted();\n`;
      const last = planted.split("\n").length - 1;
      if (!sitesOf(new Map([[file, planted]])).kinds.some((s) => s.line === last)) missed.push(file);
    }
    expect(missed).toEqual([]);
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

    test("a `case \"regime_snapshots\":` in a switch on an artifact kind is named by file and line; a switch on a table name is not", () => {
      const v = scan(
        plant(
          [
            "scripts/release/switch.ts",
            [
              "export function kindOf(o: { artifact_kind: string }) {",
              "  switch (o.artifact_kind) {",
              '    case "regime_beside_snapshots":',
              "      return 1;",
              '    case "regime_snapshots":',
              "      return 0;",
              "  }",
              "}",
              "",
            ].join("\n"),
          ],
          ["backend/src/analytics/switch-cast.ts", "switch (String(row.artifactKind)) {\n  case 'regime_snapshots': break;\n}\n"],
          // A switch on a table name, with a nested switch on the kind inside one of its cases: only the inner label is a site.
          [
            "backend/src/analytics/cutover/domain.ts",
            [
              "switch (domain) {",
              '  case "regime_snapshots":',
              "    switch (o.artifact_kind) {",
              "      case `regime_snapshots`: return 0;",
              "    }",
              "    break;",
              '  case "research_signals": {',
              "    switch (o.artifact_kind) { default: break; }",
              "  }",
              '  case "swarm_briefs": break;',
              "}",
              "",
            ].join("\n"),
          ],
          // The inverse nesting: a switch on the table name inside a switch on the kind owns its own labels.
          ["backend/tests/support/inner.ts", 'switch (o.artifact_kind) {\n  default:\n    switch (table) {\n      case "regime_snapshots": break;\n    }\n}\n'],
        ),
      );
      expect(at(v)).toEqual(["backend/src/analytics/cutover/domain.ts:4", "backend/src/analytics/switch-cast.ts:2", "scripts/release/switch.ts:5"]);
      expect(v.every((x) => x.rule.includes("REGIME_ARTIFACT_KIND"))).toBe(true);
    });

    test("a template-literal operand is named, on either side and in either form", () => {
      const v = scan(
        plant(
          ["scripts/release/tpl.ts", "if (o.artifact_kind === `regime_snapshots`) console.log(o.id);\n"],
          ["packages/csvb/src/audit/tpl.ts", "\nconst own = rows.filter((r) => `regime_snapshots` !== `${r.artifactKind}`);\n"],
          ["backend/scripts/tpl.ts", 'const isMain = `${o.artifact_kind}` == "regime_snapshots";\n'],
        ),
      );
      expect(at(v)).toEqual(["backend/scripts/tpl.ts:1", "packages/csvb/src/audit/tpl.ts:2", "scripts/release/tpl.ts:1"]);
    });

    test("a cast or String() wrapped kind operand is named, on either side", () => {
      const v = scan(
        plant(
          [
            "scripts/release/cast.ts",
            [
              'if ((o.artifact_kind as string) === "regime_snapshots") a();',
              "if (String(o.artifact_kind) !== 'regime_snapshots') b();",
              'if ("regime_snapshots" == String(r.artifactKind)) c();',
              'if ("regime_snapshots" === (o.artifact_kind as unknown as ArtifactKind)) d();',
              'if ((<string>o["artifact_kind"]) != "regime_snapshots") e();',
              'if (o.artifact_kind! === ("regime_snapshots")) f();',
              "",
            ].join("\n"),
          ],
        ),
      );
      expect(at(v)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `scripts/release/cast.ts:${n}`));
    });

    test("a literal list holding the kind, tested with .includes, .has or .indexOf on an artifact kind, is named", () => {
      const v = scan(
        plant(
          [
            "backend/src/analytics/lists.ts",
            [
              'if (["regime_snapshots", "regime_beside_snapshots"].includes(o.artifact_kind)) a();',
              "const own = rows.filter((r) => (['regime_snapshots'] as const).includes(String(r.artifactKind) as never));",
              'if (new Set(["regime_snapshots"]).has(o.artifact_kind)) b();',
              'if (["x", `regime_snapshots`].indexOf(o["artifact_kind"]) >= 0) c();',
              "const multi = [",
              '  "regime_beside_snapshots",',
              '  "regime_snapshots",',
              "].includes(o.artifact_kind);",
              "",
            ].join("\n"),
          ],
        ),
      );
      expect(at(v)).toEqual([1, 2, 3, 4, 5].map((n) => `backend/src/analytics/lists.ts:${n}`));
    });

    test("SQL text stays out of scope: a kind filter inside a string or template literal is not a site, whatever its operator", () => {
      const sqlOnly = plant([
        "backend/src/analytics/cutover/sql.ts",
        [
          "const a = await sql`SELECT id FROM analytics_output_snapshots WHERE artifact_kind != 'regime_snapshots'`;",
          'const b = "SELECT CASE artifact_kind WHEN \'regime_snapshots\' THEN 1 END FROM t WHERE artifact_kind <> \'x\'";',
          "const c = await sql`SELECT id FROM t WHERE artifact_kind = ${\"regime_snapshots\"} AND kind IN ('regime_snapshots', 'x')`;",
          "const d = await sql`",
          "  SELECT id FROM t",
          "   WHERE artifact_kind == 'regime_snapshots' -- not TypeScript",
          "     AND ${sql.unsafe(\"1 = 1\")}`;",
          "const e = await db`SELECT 1 WHERE ['regime_snapshots'].includes(o.artifact_kind)`;",
          // Prose in a literal that spells a TypeScript check is still text, not a check.
          "const f = 'never write o.artifact_kind === \"regime_snapshots\" here';",
          'const g = `compare with REGIME_ARTIFACT_KIND, never String(o.artifactKind) !== "regime_snapshots"`;',
          "",
        ].join("\n"),
      ]);
      expect(scan(sqlOnly)).toEqual([]);
      // The same file with a real comparison in a template's ${...} code is named at that line.
      const inCode = plant(["backend/src/analytics/cutover/sql.ts", "const a = await sql`SELECT 1`;\nconst label = `${o.artifact_kind === \"regime_snapshots\" ? \"main\" : \"beside\"}`;\n"]);
      expect(at(scan(inCode))).toEqual(["backend/src/analytics/cutover/sql.ts:2"]);
    });

    test("a regex literal or a nested template inside a template's ${...} does not hide the lines after it", () => {
      // scripts/ops/analytics-storage-baseline.ts line 202: a regex holding a quote, inside ${...}.
      const quote = "const quote = (name: string) => `\"${name.replace(/\"/g, '\"\"')}\"`;\n";
      // A template nested in ${...}, holding a URL's `//`.
      const url = 'const u = `${base ? `https://x/${p}` : ""}/y`;\n';
      // Line 2 is a strict comparison; line 3 is a shape only the whole-file scanner names.
      const after = 'if (o.artifact_kind === "regime_snapshots") a();\nif (["regime_snapshots"].includes(o.artifactKind)) b();\n';
      const v = scan(plant(["scripts/ops/q.ts", quote + after], ["backend/src/u.ts", url + after]));
      expect(at(v)).toEqual(["backend/src/u.ts:2", "backend/src/u.ts:3", "scripts/ops/q.ts:2", "scripts/ops/q.ts:3"]);
      // Both end clean, and the regex and the nested template's `//` are blanked inside ${...}, not read as a quote or a comment.
      for (const text of [quote + after, url + after]) {
        const c = codeOnly(text);
        expect(c.problems).toEqual([]);
        expect(kindCode(c.text).problems).toEqual([]);
      }
      expect(codeOnly(quote).text).toBe("const quote = (name: string) => `\"${name.replace(/_/, '\"\"')}\"`;\n");
      expect(codeOnly(url).text).toBe(url);
    });

    test("a non-null assertion before a `/` divides: a[i]! / b neither opens a regex nor drops a line", () => {
      const text = 'const g = w.map((wi, i) => Sw[i]! - b[i]! / wi);\nif (["regime_snapshots"].includes(o.artifact_kind)) a();\n';
      expect(codeOnly(text)).toEqual({ text, problems: [] });
      expect(at(scan(plant(["backend/src/analytics/div.ts", text])))).toEqual(["backend/src/analytics/div.ts:2"]);
    });

    test("the scanners report a text they cannot end clean on, and a stray `}` does not end the scan", () => {
      expect(codeOnly("const a = `open\n").problems).toEqual(["line 1: a template literal is not closed"]);
      expect(codeOnly("const t = `${a\n").problems).toEqual(["line 1: a template's ${...} is not closed", "line 1: a template literal is not closed"]);
      expect(codeOnly('const b = "open\nconst c = 1;\n')).toEqual({ text: 'const b = "open\nconst c = 1;\n', problems: ["line 1: a string literal is not closed on its line"] });
      expect(codeOnly("\n/* open\n").problems).toEqual(["line 2: a block comment is not closed"]);
      expect(kindCode("}\nconst d = 1;\n")).toEqual({ text: "}\nconst d = 1;\n", problems: ["line 1: a `}` with no `{`"] });
      expect(kindCode("function f() {\n").problems).toEqual(["line 2: 1 `{` not closed at the end of the text"]);
      // The loose comparison after the stray `}` is still named (the per-line backstop takes only === and !==).
      expect(at(scan(plant(["scripts/release/stray.ts", '}\nif (o.artifact_kind == "regime_snapshots") a();\n'])))).toEqual(["scripts/release/stray.ts:2"]);
    });

    test("the per-line backstop names a strict comparison after a line the whole-file scanner loses its place on", () => {
      // A regex after `)` reads as division, so its backtick opens a template that never closes and blanks the rest of the file.
      const text = 'if (ok) /`/.test(s);\nif (o.artifact_kind === "regime_snapshots") a();\nif (o.artifact_kind == "regime_snapshots") b();\n';
      expect(codeOnly(text).problems).toEqual(["line 1: a template literal is not closed"]);
      // Line 2 (===) is named by the backstop alone. Line 3 (==) is out of the backstop's reach: the clean-state check on the real tree keeps a real file from ever getting here.
      expect(at(scan(plant(["scripts/release/lost.ts", text])))).toEqual(["scripts/release/lost.ts:2"]);
    });

    test("the same shapes inside packages/analyst-sdk/src are the SDK's own line lookup, not a violation", () => {
      const v = scan(plant(["packages/analyst-sdk/src/analyze/kinds.ts", 'switch (o.artifact_kind) { case "regime_snapshots": break; }\nexport const k = ["regime_snapshots"].includes(String(o.artifact_kind));\n']));
      expect(v).toEqual([]);
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
