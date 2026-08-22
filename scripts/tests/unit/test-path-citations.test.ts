// PURE citation gate for executable-file references (docs/architecture.md §3,
// docs/decisions.md D23).
//
// Docs, workflow YAML, and source comments in this repo carry dozens of
// citations of the form `scripts/tests/<file>.test.ts`,
// `scripts/checks/<file>.sh`, or `backend/tests/<file>.test.ts` — the
// load-bearing kind that tells a reader (or an agent) WHERE the assertion behind
// a claim lives. Nothing gated them, so the D23 cost-class split moved 32 files
// and would have left every one of those citations pointing at a path that no
// longer exists, with a green CI.
//
// This test makes a stale citation RED. It is deliberately dumb: extract every
// citation, assert the file exists. No network, no subprocess, no Docker.
//
// The planted-violation controls at the bottom are the load-bearing half. A
// citation gate that only ever runs against a clean tree is indistinguishable
// from one whose regex matches nothing, so every declared scan root gets a
// fixture carrying a stale flat path and must be seen to go red.
//
// docs/code-review/** is excluded on purpose: those are dated review artifacts
// that describe the tree as it was on the day they were written, and rewriting
// history to keep a grep happy would destroy their evidentiary value.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

// Runtime, docs, and CI trees that carry citations. `evals/` is deliberately
// absent: it does not exist in this repo yet, and a scan root that is missing
// throws below rather than silently contributing zero files.
const SCANNED_ROOTS = ["docs", ".github/workflows", "scripts", "backend/tests", "contract", "frontend/public/assets/js"];
const SCANNED_EXTENSIONS = [".md", ".yml", ".yaml", ".ts", ".js", ".sh"];
const EXCLUDED_DIRS = new Set(["node_modules", "code-review", ".git"]);
const LOOSE_FILES = ["CONTRIBUTING.md", "README.md"];

// A citation is a path to an executable file, captured up to the extension so a
// trailing `:12-30` line reference or closing bracket is not swallowed.
const CITATION =
  /(?:scripts\/tests\/[A-Za-z0-9._/-]*?\.test\.ts|contract\/tests\/[A-Za-z0-9._/-]*?\.test\.ts|backend\/tests\/[A-Za-z0-9._/-]*?\.test\.ts|scripts\/checks\/[A-Za-z0-9._-]*?\.sh)/g;

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCANNED_EXTENSIONS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

function scannedFiles(root: string, requireRoots: boolean): string[] {
  const files: string[] = [];
  for (const rel of SCANNED_ROOTS) {
    const full = join(root, rel);
    if (!existsSync(full)) {
      // The REAL tree must have every declared root: a renamed tree has to be
      // red here, never a silently empty scan. A fixture root holds only the
      // one directory its planted violation lives in.
      if (requireRoots) throw new Error(`scanned root ${rel} is missing — a renamed tree must be red here, not a silently empty scan`);
      continue;
    }
    walk(full, files);
  }
  for (const loose of LOOSE_FILES) {
    const full = join(root, loose);
    if (existsSync(full)) files.push(full);
  }
  return files;
}

interface Citation {
  path: string;
  citedIn: string;
  line: number;
}

function collectCitations(root: string, requireRoots = true): Citation[] {
  const found: Citation[] = [];
  for (const file of scannedFiles(root, requireRoots)) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((text, i) => {
        for (const m of text.matchAll(CITATION)) found.push({ path: m[0], citedIn: relative(root, file), line: i + 1 });
      });
  }
  return found;
}

/** Citations naming a file that is not on disk. */
function dangling(citations: Citation[], root: string): string[] {
  return citations.filter((c) => !existsSync(join(root, c.path))).map((c) => `${c.citedIn}:${c.line} cites missing ${c.path}`);
}

/**
 * Citations still pointing at the pre-split flat `scripts/tests/` root. Every
 * test now declares its cost class by path, so a citation without a `unit/`,
 * `integration/`, or `fixtures/` segment is either stale or a new loose file.
 */
function flat(citations: Citation[]): string[] {
  return citations
    .filter((c) => c.path.startsWith("scripts/tests/") && !/^scripts\/tests\/(unit|integration|fixtures)\//.test(c.path))
    .map((c) => `${c.citedIn}:${c.line} → ${c.path}`);
}

describe("executable-file path citations resolve", () => {
  const citations = collectCitations(repoRoot);

  test("the scan actually found citations — an empty scan would make this file vacuous", () => {
    // Guards against a regex or walker regression silently turning this whole
    // gate green. The tree carries dozens; a floor of 20 is well below that and
    // well above zero.
    expect(citations.length).toBeGreaterThan(20);
  });

  test("every declared scan root exists — a renamed tree is red, not a quiet no-op", () => {
    for (const rel of SCANNED_ROOTS) expect(existsSync(join(repoRoot, rel))).toBe(true);
  });

  test("every cited scripts/tests, contract/tests, backend/tests, and scripts/checks path exists", () => {
    expect(dangling(citations, repoRoot)).toEqual([]);
  });

  test("no citation points at the pre-split flat scripts/tests/ root (D23 §3 L1)", () => {
    expect(flat(citations)).toEqual([]);
  });
});

// ── negative controls: this gate must be able to FAIL ────────────────────────
describe("the citation gate goes red on a planted stale citation", () => {
  // Assembled from segments, never written as one literal. A literal here would
  // be a citation in its own right — the real-tree scan above reads THIS file —
  // so the suite would either flag itself or be "fixed" by the next path sweep.
  const STALE = ["scripts", "tests", "goldens-drift.test.ts"].join("/"); // pre-split path
  const MISSING = ["scripts", "tests", "unit", "no-such-suite.test.ts"].join("/"); // well-shaped, absent
  const REAL = ["scripts", "tests", "unit", "goldens-drift.test.ts"].join("/"); // post-split, exists

  function plant(rel: string, fileName: string, body: string): string {
    const root = mkdtempSync(join(tmpdir(), "test-path-citations-"));
    mkdirSync(join(root, rel), { recursive: true });
    writeFileSync(join(root, rel, fileName), body);
    return root;
  }

  // One planted violation per declared root: without these, dropping any entry
  // from SCANNED_ROOTS would leave this suite green while that tree went
  // unscanned forever.
  for (const rel of SCANNED_ROOTS) {
    test(`a stale flat citation planted in ${rel}/ is caught — that root is really scanned`, () => {
      const root = plant(rel, "planted.md", `see \`${STALE}\` for the assertion\n`);
      try {
        const found = collectCitations(root, false);
        expect(found.map((c) => c.path)).toContain(STALE);
        expect(flat(found).join("\n")).toContain(STALE);
        // ...and it is dangling too, since the fixture tree has no such file.
        expect(dangling(found, root).join("\n")).toContain(STALE);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  for (const loose of LOOSE_FILES) {
    test(`a stale flat citation planted in ${loose} is caught`, () => {
      const root = mkdtempSync(join(tmpdir(), "test-path-citations-loose-"));
      try {
        writeFileSync(join(root, loose), `drift gate: \`${STALE}\`\n`);
        expect(flat(collectCitations(root, false)).join("\n")).toContain(STALE);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("a citation of a file that does not exist is caught even when it IS cost-classed", () => {
    const root = plant("docs", "planted.md", `see \`${MISSING}\`\n`);
    try {
      const found = collectCitations(root, false);
      expect(flat(found)).toEqual([]); // correctly shaped...
      expect(dangling(found, root).join("\n")).toContain(MISSING); // ...but still missing
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a scan root that vanished is loud, not silently empty", () => {
    const empty = mkdtempSync(join(tmpdir(), "test-path-citations-empty-"));
    try {
      expect(() => collectCitations(empty, true)).toThrow(/must be red here/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("a correctly cost-classed citation of a real file is NOT flagged — the gate does not cry wolf", () => {
    const root = plant("docs", "clean.md", `the drift gate is \`${REAL}\`\n`);
    try {
      const found = collectCitations(root, false);
      expect(found.map((c) => c.path)).toContain(REAL);
      expect(flat(found)).toEqual([]);
      // Resolve it against the REAL repo, where that file exists post-split.
      expect(dangling(found, repoRoot)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
