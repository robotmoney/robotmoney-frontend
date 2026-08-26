// Unit-tests the ci-gate PATH-FILTER RULES (issue #276).
//
// There is no single `ci-gate.yml` in this repo any more: PR #316 shipped one,
// a production incident on that same PR got it removed (issue #275 addendum;
// see ci-workflows-structure.test.ts's PATHS_FILTER_SHA comment and issue
// #348, which tracks a structurally sounder fan-in replacement). What issue
// #276 calls "the ci-gate workflow's parsed path filters" is, on this repo's
// actual tree, the set of dorny/paths-filter `filters:` blocks distributed one
// per PATH_GATED_WORKFLOWS file, each in that file's own `changes` job. That
// distributed mechanism *is* the path-filter classification a changed file
// goes through today, so this suite extracts each workflow's real, live filter
// patterns (never a hand-copied duplicate) and asserts a fixture table of
// paths classifies against them exactly as CI would, plus a typoed-filter red
// control proving the table can actually catch a broken pattern.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const wfDir = join(repoRoot, ".github", "workflows");
const read = (name: string) => readFileSync(join(wfDir, name), "utf8");

// Same list ci-workflows-structure.test.ts independently maintains as
// PATH_GATED_WORKFLOWS — duplicated rather than imported, per this repo's
// convention that sibling unit files stay independent of each other's
// internals (see that file's own header comment).
const PATH_GATED_WORKFLOWS = ["backend.yml", "contract.yml", "integration.yml", "frontend.yml", "research-pipeline.yml", "onboarding-eval-rails.yml"];

interface FilterStep {
  uses?: string;
  with?: { filters?: string };
}
interface Job {
  steps?: FilterStep[];
}
interface Workflow {
  jobs?: Record<string, Job>;
}

/**
 * Extract the `{filterName: pattern[]}` map from a workflow's own `changes`
 * job. Takes raw YAML text (not a filename) so this core parser is directly
 * testable against planted fixture text, never only against the real tree —
 * `extractFilters` below is the thin wrapper that reads a real repo file.
 */
function filtersFromYamlText(text: string, label: string): Record<string, string[]> {
  const wf = Bun.YAML.parse(text) as Workflow;
  const changesJob = wf.jobs?.changes;
  if (!changesJob) throw new Error(`${label} has no "changes" job — expected one carrying a dorny/paths-filter step`);
  const step = (changesJob.steps ?? []).find((s) => (s.uses ?? "").startsWith("dorny/paths-filter@"));
  if (!step?.with?.filters) throw new Error(`${label}'s changes job has no dorny/paths-filter step with a filters: block`);
  const parsed = Bun.YAML.parse(step.with.filters) as Record<string, string[]>;
  if (Object.keys(parsed).length === 0) throw new Error(`${label}'s filters: block parsed to zero filter keys`);
  return parsed;
}

/** Extract the `{filterName: pattern[]}` map from a real repo workflow file — read out of the real YAML, never hand-copied. */
function extractFilters(file: string): Record<string, string[]> {
  return filtersFromYamlText(read(file), file);
}

/** All path patterns this workflow's filter(s) declare, flattened. */
function patternsFor(file: string): string[] {
  const filters = extractFilters(file);
  return Object.values(filters).flat();
}

// A gitignore-like glob → RegExp, matched against a repo-relative POSIX path.
// Mirrors dorny/paths-filter's (micromatch) semantics for the two pattern
// shapes this repo's filters actually use: an ANCHORED pattern containing a
// "/" (e.g. `backend/**`, matched against the full relative path from repo
// root) and an UNANCHORED bare pattern with no "/" (e.g. `tsconfig.json`,
// `docker-compose*.yml` — gitignore-style, matched at ANY depth).
function compilePattern(glob: string): RegExp {
  const anchored = glob.includes("/");
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 3;
      } else {
        out += ".*";
        i += 2;
      }
    } else if (c === "*") {
      out += "[^/]*";
      i += 1;
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if (".+^${}()|[]\\".includes(c)) {
      out += `\\${c}`;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return new RegExp(anchored ? `^${out}$` : `(^|/)${out}$`);
}

function pathMatches(path: string, patterns: string[]): boolean {
  return patterns.some((p) => compilePattern(p).test(path));
}

/** Every PATH_GATED_WORKFLOWS file whose real filter would trigger for `path`. */
function classify(path: string): string[] {
  return PATH_GATED_WORKFLOWS.filter((f) => pathMatches(path, patternsFor(f)));
}

describe("ci-gate path-filter classification (distributed dorny/paths-filter — no ci-gate.yml; see issue #348)", () => {
  test("every PATH_GATED_WORKFLOWS file declares exactly one filter key in its changes job", () => {
    for (const file of PATH_GATED_WORKFLOWS) {
      expect(Object.keys(extractFilters(file)).length, file).toBe(1);
    }
  });

  // Fixture table of changed-file path → the PATH_GATED_WORKFLOWS files whose
  // REAL, live filter should trigger for it. Compiled against filters
  // extracted from the actual workflow YAML (never a hand-duplicated pattern
  // list), so an edit to a workflow's filters: block that changes
  // classification for any path below is caught here.
  const CASES: Array<[string, string[]]> = [
    ["backend/src/api/routes.ts", ["backend.yml"]],
    // Issue #602: a compose file must ALSO select integration.yml. That job
    // owns scripts/tests/integration/smoke-compose-config.test.ts, the only
    // suite that renders `docker compose config` and asserts what the api
    // service is handed — so a PR touching nothing but a compose file has to
    // run it, or the assertions covering that very file are skipped pre-merge.
    ["docker-compose.yml", ["backend.yml", "integration.yml"]],
    ["docker-compose.smoke.yml", ["backend.yml", "integration.yml"]],
    ["docker-compose.stage.yml", ["backend.yml", "integration.yml"]],
    ["backend/src/analytics/extract/geckoterminal.ts", ["backend.yml", "research-pipeline.yml"]],
    ["backend/src/chain/token-prices.ts", ["backend.yml", "research-pipeline.yml"]],
    ["backend/src/swarm/apply.ts", ["backend.yml", "onboarding-eval-rails.yml"]],
    ["contract/src/index.ts", ["contract.yml"]],
    ["scripts/tests/unit/smoke-env.test.ts", ["integration.yml"]],
    ["scripts/lib/swarm/inference.ts", ["integration.yml", "onboarding-eval-rails.yml"]],
    ["scripts/lib/member-agent/Dockerfile", ["integration.yml", "onboarding-eval-rails.yml"]],
    ["scripts/lib/rmpc-fetch.ts", ["integration.yml", "onboarding-eval-rails.yml"]],
    ["scripts/lib/onboarding-eval.ts", ["integration.yml", "onboarding-eval-rails.yml"]],
    ["evals/onboarding/isolated.ts", ["integration.yml", "onboarding-eval-rails.yml"]],
    [".github/workflows/unit.yml", ["integration.yml"]],
    ["tsconfig.json", ["integration.yml"]],
    ["package.json", ["integration.yml"]],
    ["bun.lock", ["integration.yml"]],
    ["frontend/public/assets/js/app.js", ["frontend.yml"]],
    ["playwright.config.ts", ["frontend.yml"]],
    ["docs/architecture.md", []],
    ["README.md", []],
  ];

  for (const [path, expected] of CASES) {
    test(`${path} → [${expected.join(", ") || "none"}]`, () => {
      expect(classify(path).sort()).toEqual([...expected].sort());
    });
  }

  test("the fixture table is not vacuous — every PATH_GATED_WORKFLOWS file is triggered by at least one case, and at least one case triggers none", () => {
    for (const file of PATH_GATED_WORKFLOWS) {
      expect(CASES.some(([, expected]) => expected.includes(file)), `${file} should be triggered by at least one fixture path`).toBe(true);
    }
    expect(CASES.some(([, expected]) => expected.length === 0)).toBe(true);
  });

  // ── typoed-filter red control ──────────────────────────────────────────────
  // The table above is worthless if it cannot discriminate a broken filter
  // from a correct one. Mutate the REAL, extracted integration.yml filter with
  // a one-character typo and assert classification for a path that used to
  // match no longer does — the same class of bug a filter rename/typo in the
  // real workflow would produce, caught here in isolation from the real tree.
  test("a typoed filter pattern changes the classification — red control", () => {
    const real = extractFilters("integration.yml");
    const key = Object.keys(real)[0]!;
    const realPatterns = real[key]!;
    expect(realPatterns).toContain("scripts/**");
    const typoedPatterns = realPatterns.map((p) => (p === "scripts/**" ? "scropts/**" : p));
    expect(typoedPatterns).not.toEqual(realPatterns);

    const path = "scripts/tests/unit/smoke-env.test.ts";
    expect(pathMatches(path, realPatterns)).toBe(true);
    expect(pathMatches(path, typoedPatterns)).toBe(false);
  });

  // ── extractor negative controls: it must be able to FAIL loudly, never return silently empty ──
  test("throws on a workflow with no changes job at all", () => {
    const yaml = "name: x\non: push\njobs:\n  build:\n    steps:\n      - run: echo hi\n";
    expect(() => filtersFromYamlText(yaml, "x.yml")).toThrow(/no "changes" job/);
  });

  test("throws on a changes job with no dorny/paths-filter step", () => {
    const yaml = "name: x\non: push\njobs:\n  changes:\n    steps:\n      - uses: actions/checkout@v4\n";
    expect(() => filtersFromYamlText(yaml, "x.yml")).toThrow(/no dorny\/paths-filter step/);
  });

  test("throws on a dorny/paths-filter step whose filters: block parses to zero keys", () => {
    const yaml = "name: x\non: push\njobs:\n  changes:\n    steps:\n      - uses: dorny/paths-filter@abc\n        with:\n          filters: |\n            {}\n";
    expect(() => filtersFromYamlText(yaml, "x.yml")).toThrow(/zero filter keys/);
  });

  test("parses a clean planted changes job correctly, as a sanity control", () => {
    const yaml = "name: x\non: push\njobs:\n  changes:\n    steps:\n      - uses: dorny/paths-filter@abc\n        with:\n          filters: |\n            smoke:\n              - 'smoke/**'\n";
    expect(filtersFromYamlText(yaml, "x.yml")).toEqual({ smoke: ["smoke/**"] });
  });
});
