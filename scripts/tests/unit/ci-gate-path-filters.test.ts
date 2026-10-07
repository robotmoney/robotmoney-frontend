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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const wfDir = join(repoRoot, ".github", "workflows");
const read = (name: string) => readFileSync(join(wfDir, name), "utf8");

// Same list ci-workflows-structure.test.ts independently maintains as
// PATH_GATED_WORKFLOWS — duplicated rather than imported, per this repo's
// convention that sibling unit files stay independent of each other's
// internals (see that file's own header comment).
const PATH_GATED_WORKFLOWS = ["backend.yml", "contract.yml", "analyst-sdk.yml", "integration.yml", "web-client.yml", "research-pipeline.yml", "onboarding-eval-rails.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"];

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

function pathMatches(path: string, patterns: string[], quantifier: "some" | "every" = "some"): boolean {
  if (quantifier === "some") return patterns.some((p) => compilePattern(p).test(path));
  // `every` (dorny's predicate-quantifier): ALL patterns must hold, and a
  // leading `!` inverts one, so `['**', '!docs/**']` reads "any path not in docs".
  return patterns.every((p) => (p.startsWith("!") ? !compilePattern(p.slice(1)).test(path) : compilePattern(p).test(path)));
}

/** The `predicate-quantifier` a workflow's filter step declares (dorny default: some). */
function quantifierFor(file: string): "some" | "every" {
  const wf = Bun.YAML.parse(read(file)) as { jobs?: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, string> }> }> };
  const step = (wf.jobs?.changes?.steps ?? []).find((s) => (s.uses ?? "").startsWith("dorny/paths-filter@"));
  return step?.with?.["predicate-quantifier"] === "every" ? "every" : "some";
}

/** Every PATH_GATED_WORKFLOWS file whose real filter would trigger for `path`. */
function classify(path: string): string[] {
  return PATH_GATED_WORKFLOWS.filter((f) => pathMatches(path, patternsFor(f), quantifierFor(f)));
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
    ["backend/src/api/routes.ts", ["backend.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    // Issue #602: a compose file must ALSO select integration.yml. That job
    // owns scripts/tests/integration/smoke-compose-config.test.ts, the only
    // suite that renders `docker compose config` and asserts what the api
    // service is handed — so a PR touching nothing but a compose file has to
    // run it, or the assertions covering that very file are skipped pre-merge.
    ["docker-compose.yml", ["backend.yml", "integration.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["docker-compose.stage.yml", ["backend.yml", "integration.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["backend/src/analytics/extract/geckoterminal.ts", ["backend.yml", "research-pipeline.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["backend/src/chain/token-prices.ts", ["backend.yml", "research-pipeline.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["backend/src/swarm/apply.ts", ["backend.yml", "onboarding-eval-rails.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["contract/src/index.ts", ["contract.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    // Issue #1095: the SDK is its own gated workflow AND the backend's, because
    // the backend re-exports it and copies it into its image.
    ["packages/analyst-sdk/src/run.ts", ["analyst-sdk.yml", "backend.yml", "research-pipeline.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    // A unit test cannot change what the integration suite or the live stack
    // sees, so a PR touching only unit tests selects neither (unit.yml, which
    // is not path-gated, still runs it).
    ["scripts/tests/unit/smoke-env.test.ts", []],
    ["scripts/tests/integration/smoke-compose-config.test.ts", ["integration.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["scripts/tests/support/dead-docker.ts", ["integration.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["scripts/smoke.ts", ["integration.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["scripts/lib/swarm/inference.ts", ["integration.yml", "onboarding-eval-rails.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["scripts/lib/member-agent/Dockerfile", ["integration.yml", "onboarding-eval-rails.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["scripts/lib/rmpc-fetch.ts", ["integration.yml", "onboarding-eval-rails.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["scripts/lib/onboarding-eval.ts", ["integration.yml", "onboarding-eval-rails.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["evals/onboarding/isolated.ts", ["integration.yml", "onboarding-eval-rails.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    [".github/workflows/unit.yml", ["integration.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["tsconfig.json", ["integration.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["package.json", ["integration.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["bun.lock", ["integration.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    // The web client's own scripts: web-client runs them, integration keeps
    // them because static-assembly.sh (exercised there) imports version.ts.
    ["scripts/web-client/browser.ts", ["integration.yml", "web-client.yml"]],
    ["scripts/static-assembly.sh", ["integration.yml", "web-client.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["website-server/nginx.conf", ["web-client.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    // Client CODE selects the live stack: the specs that need a real api
    // (scripts/web-client/static-specs.ts NOT_STATIC) only run there.
    ["frontend/public/assets/js/app.js", ["web-client.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["frontend/public/assets/css/site.css", ["web-client.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["playwright.config.ts", ["web-client.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    // Copy and the specs that read it: web-client only. This is the point of
    // the e2e skip list — a marketing change never boots the live stack.
    ["frontend/public/views/home.html", ["web-client.yml"]],
    ["frontend/public/views/docs/investment-swarm/index.html", ["web-client.yml"]],
    ["frontend/public/data/deposit/vaults.json", ["web-client.yml"]],
    ["frontend/public/skills/deposit/SKILL.md", ["web-client.yml"]],
    ["frontend/public/blog/post.html", ["web-client.yml"]],
    ["frontend/public/assets/img/hero.png", ["web-client.yml"]],
    ["frontend/test/browser/about-view.spec.ts", ["web-client.yml"]],
    ["goldens/api-goldens.json", ["web-client.yml"]],
    ["docs/architecture.md", []],
    ["brand-assets/logo.svg", []],
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
    expect(realPatterns).toContain("scripts/lib/**");
    const typoedPatterns = realPatterns.map((p) => (p === "scripts/lib/**" ? "scropts/lib/**" : p));
    expect(typoedPatterns).not.toEqual(realPatterns);

    const path = "scripts/lib/swarm/inference.ts";
    expect(pathMatches(path, realPatterns)).toBe(true);
    expect(pathMatches(path, typoedPatterns)).toBe(false);
  });

  // Same idea for the e2e skip list, which is an `every` filter: dropping one
  // skip entry must turn a skipped path back into a run, and the matcher must
  // honour the quantifier (under `some`, `!docs/**` would match everything).
  test("e2e's filter is an `every` allowlist: removing a skip entry makes that path run — red control", () => {
    expect(quantifierFor("e2e-web.yml")).toBe("every");
    const real = extractFilters("e2e-web.yml")["e2e"]!;
    expect(real).toContain("**");
    expect(real).toContain("!frontend/public/views/**");
    const without = real.filter((p) => p !== "!frontend/public/views/**");
    const path = "frontend/public/views/home.html";
    expect(pathMatches(path, real, "every")).toBe(false);
    expect(pathMatches(path, without, "every")).toBe(true);
    expect(pathMatches(path, real, "some"), "the some-quantifier reading would run e2e for everything").toBe(true);
  });

  // ── unclassified-directory guard ───────────────────────────────────────────
  // integration.yml lists scripts/ subdirectories positively (a `some` filter
  // cannot subtract), so a NEW directory would silently skip the job. Every
  // directory under scripts/ and scripts/tests/ must either match a pattern in
  // integration's filter or be named here as deliberately skipped.
  test("every scripts/ and scripts/tests/ directory is selected by integration or deliberately skipped", () => {
    const SKIPPED_BY_INTEGRATION = new Set(["scripts/tests/unit"]);
    const patterns = patternsFor("integration.yml");
    const dirs = [
      ...readdirSync(join(repoRoot, "scripts"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `scripts/${d.name}`),
      ...readdirSync(join(repoRoot, "scripts", "tests"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `scripts/tests/${d.name}`),
    ].filter((d) => d !== "scripts/tests");
    const unclassified = dirs.filter((d) => !SKIPPED_BY_INTEGRATION.has(d) && !pathMatches(`${d}/x`, patterns));
    expect(unclassified, `add these directories to integration.yml's filter, or to SKIPPED_BY_INTEGRATION with a reason: ${unclassified.join(", ")}`).toEqual([]);
    for (const skipped of SKIPPED_BY_INTEGRATION) {
      expect(pathMatches(`${skipped}/x`, patterns), `${skipped} is listed as skipped but integration's filter selects it`).toBe(false);
    }
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
