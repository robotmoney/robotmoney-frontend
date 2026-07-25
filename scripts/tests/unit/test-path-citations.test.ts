// PURE citation gate for executable-file references (docs/architecture.md §3).
//
// Docs, workflow YAML, and source comments in this repo carry ~60 citations of
// the form `scripts/tests/<file>.test.ts`, `scripts/checks/<file>.sh`, or
// `contract/tests/<class>/<file>.test.ts` — the load-bearing kind that tells a
// reader (or an agent) WHERE the assertion behind a claim lives. Nothing gated
// them, so the D23 cost-class split moved ~35 files and left every one of those
// citations pointing at a path that no longer existed, with a green CI.
//
// This test makes a stale citation RED. It is deliberately dumb: extract every
// citation, assert the file exists. No network, no subprocess, no Docker.
//
// docs/code-review/** is excluded on purpose: those are dated review artifacts
// that describe the tree as it was on the day they were written, and rewriting
// history to keep a grep happy would destroy their evidentiary value.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

const SCANNED_ROOTS = ["docs", ".github/workflows", "scripts", "evals", "backend/tests", "contract", "frontend/public/assets/js"];
const SCANNED_EXTENSIONS = [".md", ".yml", ".yaml", ".ts", ".js", ".sh"];
const EXCLUDED_DIRS = new Set(["node_modules", "code-review", "recyclebin", ".git"]);

// A citation is a path to an executable file, captured up to the extension so a
// trailing `:12-30` line reference or closing bracket is not swallowed.
const CITATION = /(?:scripts\/tests\/[A-Za-z0-9._/-]*?\.test\.ts|contract\/tests\/[A-Za-z0-9._/-]*?\.test\.ts|backend\/tests\/[A-Za-z0-9._/-]*?\.test\.ts|scripts\/checks\/[A-Za-z0-9._-]*?\.sh|evals\/onboarding\/[A-Za-z0-9._/-]*?\.ts)/g;

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCANNED_EXTENSIONS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

function scannedFiles(): string[] {
  const files: string[] = [];
  for (const root of SCANNED_ROOTS) {
    const full = join(repoRoot, root);
    if (!existsSync(full)) throw new Error(`scanned root ${root} is missing — a renamed tree must be red here, not a silently empty scan`);
    walk(full, files);
  }
  for (const loose of ["CONTRIBUTING.md", "README.md"]) {
    const full = join(repoRoot, loose);
    if (existsSync(full)) files.push(full);
  }
  return files;
}

interface Citation {
  path: string;
  citedIn: string;
  line: number;
}

function collectCitations(): Citation[] {
  const found: Citation[] = [];
  for (const file of scannedFiles()) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      for (const m of text.matchAll(CITATION)) found.push({ path: m[0], citedIn: relative(repoRoot, file), line: i + 1 });
    });
  }
  return found;
}

describe("executable-file path citations resolve", () => {
  const citations = collectCitations();

  test("the scan actually found citations — an empty scan would make this file vacuous", () => {
    // Guards against a regex or walker regression silently turning this whole
    // gate green. The tree carries dozens; a floor of 20 is well below that and
    // well above zero.
    expect(citations.length).toBeGreaterThan(20);
  });

  test("every cited scripts/tests, contract/tests, backend/tests, scripts/checks, and evals path exists", () => {
    const dangling = citations
      .filter((c) => !existsSync(join(repoRoot, c.path)))
      .map((c) => `${c.citedIn}:${c.line} cites missing ${c.path}`);
    expect(dangling).toEqual([]);
  });

  test("no citation points at the pre-split flat scripts/tests/ root (D23 §3 L1)", () => {
    // Every test now declares its cost class by path. A citation without a
    // unit/ or integration/ segment is either stale or a new loose test file.
    const flat = citations
      .filter((c) => c.path.startsWith("scripts/tests/") && !/^scripts\/tests\/(unit|integration|fixtures)\//.test(c.path))
      .map((c) => `${c.citedIn}:${c.line} → ${c.path}`);
    expect(flat).toEqual([]);
  });
});
