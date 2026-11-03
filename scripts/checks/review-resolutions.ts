// Review resolution check (issue 1459): every finding in a review file is
// resolved, never left open.
//
//   bun scripts/checks/review-resolutions.ts <review file> [--fixed|--filed]
//
// Only tables whose header row has both an `Id` and a `Resolution` column are
// parsed; every other table is ignored. A Resolution cell is exactly one of:
//
//   fixed: <repo path>             the same PR corrects that file
//   filed: #N                      issue N holds the finding
//   recorded: issue <N> comment    a comment on issue N holds the finding
//
// `open`, an empty cell or any other text is malformed. Any malformed cell
// exits 1 in every mode, before git or gh is called. `--fixed` then checks that
// each fixed path appears in `git diff --name-only origin/main`. `--filed`
// checks that `gh issue view N` exits 0 for each distinct filed N. With no mode
// flag both are checked. A `recorded:` cell is checked for its form only. Each
// failure prints the finding's Id and the cell text. On success it prints the
// number of cells it checked.

import { readFileSync } from "node:fs";

export type Resolution =
  | { kind: "fixed"; path: string }
  | { kind: "filed"; issue: number }
  | { kind: "recorded"; issue: number };

export interface ResolutionCell {
  id: string;
  cell: string;
}

export type Mode = "fixed" | "filed" | "both";

export interface Deps {
  /** Paths in `git diff --name-only origin/main`. */
  changedFiles: () => string[];
  /** True when `gh issue view N` exits 0. */
  issueExists: (n: number) => boolean;
}

export interface CheckResult {
  failures: string[];
  checked: number;
}

/** Cells of one Markdown table row, without the outer pipes, trimmed. */
function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((c) => c.trim());
}

/** Every (Id, Resolution) pair in tables whose header has both columns. */
export function resolutionCells(markdown: string): ResolutionCell[] {
  const out: ResolutionCell[] = [];
  const lines = markdown.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]!.trim().startsWith("|")) {
      i++;
      continue;
    }
    const table: string[] = [];
    while (i < lines.length && lines[i]!.trim().startsWith("|")) table.push(lines[i++]!);
    const header = cells(table[0]!);
    const idCol = header.indexOf("Id");
    const resCol = header.indexOf("Resolution");
    if (idCol < 0 || resCol < 0) continue;
    for (const row of table.slice(1)) {
      const c = cells(row);
      if (c.every((x) => /^:?-+:?$/.test(x))) continue; // the separator row
      out.push({ id: c[idCol] ?? "", cell: c[resCol] ?? "" });
    }
  }
  return out;
}

/** The resolution a cell names, or null when the cell is malformed. */
export function parseResolution(cell: string): Resolution | null {
  let m = /^fixed: (\S+)$/.exec(cell);
  if (m) return { kind: "fixed", path: m[1]! };
  m = /^filed: #([1-9]\d*)$/.exec(cell);
  if (m) return { kind: "filed", issue: Number(m[1]) };
  m = /^recorded: issue ([1-9]\d*) comment$/.exec(cell);
  if (m) return { kind: "recorded", issue: Number(m[1]) };
  return null;
}

/** Check a review file's resolutions in one mode. Pure apart from `deps`. */
export function checkResolutions(markdown: string, mode: Mode, deps: Deps): CheckResult {
  const parsed = resolutionCells(markdown).map((r) => ({ ...r, res: parseResolution(r.cell) }));
  const malformed = parsed.filter((r) => r.res === null).map((r) => `${r.id}: malformed resolution "${r.cell}"`);
  if (malformed.length > 0) return { failures: malformed, checked: 0 };
  const rows = parsed as (ResolutionCell & { res: Resolution })[];

  const failures: string[] = [];
  let checked = 0;
  if (mode !== "filed") {
    const changed = new Set(deps.changedFiles());
    for (const r of rows) {
      if (r.res.kind !== "fixed") continue;
      checked++;
      const path = r.res.path;
      if (!changed.has(path)) failures.push(`${r.id}: "${r.cell}" names a path not in git diff --name-only origin/main`);
    }
  }
  if (mode !== "fixed") {
    const seen = new Map<number, boolean>();
    for (const r of rows) {
      if (r.res.kind !== "filed") continue;
      checked++;
      const n: number = r.res.issue;
      if (!seen.has(n)) seen.set(n, deps.issueExists(n));
      if (!seen.get(n)) failures.push(`${r.id}: "${r.cell}" names an issue gh issue view cannot read`);
    }
  }
  if (mode === "both") checked += rows.filter((r) => r.res.kind === "recorded").length;
  return { failures, checked };
}

function main(argv: string[]): number {
  const usage = "usage: bun scripts/checks/review-resolutions.ts <review file> [--fixed|--filed]";
  const flags = argv.filter((a) => a.startsWith("--"));
  const files = argv.filter((a) => !a.startsWith("--"));
  if (files.length !== 1 || flags.length > 1 || (flags[0] && !["--fixed", "--filed"].includes(flags[0]))) {
    console.error(usage);
    return 2;
  }
  const mode: Mode = flags[0] === "--fixed" ? "fixed" : flags[0] === "--filed" ? "filed" : "both";
  const markdown = readFileSync(files[0]!, "utf8");
  const deps: Deps = {
    changedFiles: () => {
      const p = Bun.spawnSync(["git", "diff", "--name-only", "origin/main"]);
      if (p.exitCode !== 0) throw new Error(`git diff --name-only origin/main failed: ${p.stderr.toString()}`);
      return p.stdout.toString().split("\n").filter(Boolean);
    },
    issueExists: (n) => Bun.spawnSync(["gh", "issue", "view", String(n), "--json", "number"]).exitCode === 0,
  };
  const { failures, checked } = checkResolutions(markdown, mode, deps);
  for (const f of failures) console.error(f);
  if (failures.length > 0) return 1;
  console.log(`${checked} resolution cells checked`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
