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
const E2E_WORKFLOWS = ["e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"];
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

// dorny/paths-filter matches each pattern with picomatch(pattern, {dot: true}):
// a pattern is matched against the FULL repo-relative path, so a bare
// `package.json` selects only the root file, never `backend/package.json`, and
// `**` crosses dot-directories. Bun.Glob has the same semantics, so the table
// below is evaluated with it rather than with a hand-rolled glob translation.
function globMatches(glob: string, path: string): boolean {
  return new Bun.Glob(glob).match(path);
}

function pathMatches(path: string, patterns: string[], quantifier: "some" | "every" = "some"): boolean {
  if (quantifier === "some") return patterns.some((p) => globMatches(p, path));
  // `every` (dorny's predicate-quantifier): ALL patterns must hold, and a
  // leading `!` inverts one, so `['**', '!docs/**']` reads "any path not in docs".
  return patterns.every((p) => (p.startsWith("!") ? !globMatches(p.slice(1), path) : globMatches(p, path)));
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
  //
  // The four e2e-*.yml domains each carry an ALLOW LIST: the shared boot (every
  // domain) plus the paths that domain exercises. Lifecycle, swarm and web take
  // the whole backend (web's specs read live data any backend module can
  // break), onboarding takes only the swarm and api code, and a frontend file
  // runs e2e-web alone.
  const CASES: Array<[string, string[]]> = [
    ["backend/src/api/routes.ts", ["backend.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    // Issue #602: a compose file must ALSO select integration.yml. That job
    // owns scripts/tests/integration/smoke-compose-config.test.ts, the only
    // suite that renders `docker compose config` and asserts what the api
    // service is handed — so a PR touching nothing but a compose file has to
    // run it, or the assertions covering that very file are skipped pre-merge.
    ["docker-compose.yml", ["backend.yml", "integration.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    // The stage overlay is appended only by `bun run smoke -- --static-port`,
    // which no e2e boot passes, so it selects no e2e domain.
    ["docker-compose.stage.yml", ["backend.yml", "integration.yml"]],
    // Backend internals the boot does not import: the domains that take the
    // whole backend (lifecycle, swarm, web), never onboarding unless it is
    // swarm or api code.
    ["backend/src/analytics/extract/geckoterminal.ts", ["backend.yml", "research-pipeline.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml"]],
    ["backend/src/analytics/x.ts", ["backend.yml", "research-pipeline.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml"]],
    ["backend/src/chain/token-prices.ts", ["backend.yml", "research-pipeline.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml"]],
    ["backend/src/swarm/apply.ts", ["backend.yml", "onboarding-eval-rails.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["backend/src/swarm/x.ts", ["backend.yml", "onboarding-eval-rails.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    // Backend files the boot itself imports or runs select every domain.
    ["backend/src/db/target-lock.ts", ["backend.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["backend/migrations/0001_backends.sql", ["backend.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["backend/scripts/smoke-prepare.ts", ["backend.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    // The backend image copies contract/ and the checks import it.
    ["contract/src/index.ts", ["contract.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    // Issue #1095: the SDK is its own gated workflow AND the backend's, because
    // the backend re-exports it and copies it into its image. The domains that
    // take the whole backend take it too.
    ["packages/analyst-sdk/src/run.ts", ["analyst-sdk.yml", "backend.yml", "research-pipeline.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml"]],
    // A unit test cannot change what the integration suite or the live stack
    // sees, so a PR touching only unit tests selects neither (unit.yml, which
    // is not path-gated, still runs it).
    ["scripts/tests/unit/smoke-env.test.ts", []],
    // Integration-suite files do not change what a live stack does.
    ["scripts/tests/integration/smoke-compose-config.test.ts", ["integration.yml"]],
    ["scripts/tests/support/dead-docker.ts", ["integration.yml"]],
    // The shared boot.
    ["scripts/smoke.ts", ["integration.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["scripts/stack/naming.ts", ["integration.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    [".github/actions/e2e-setup/action.yml", ["integration.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["test-fixtures/smoke/empty-roster.credentials.json", ["e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["scripts/lib/swarm/inference.ts", ["integration.yml", "onboarding-eval-rails.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["scripts/lib/member-agent/Dockerfile", ["integration.yml", "onboarding-eval-rails.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["scripts/lib/rmpc-fetch.ts", ["integration.yml", "onboarding-eval-rails.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["scripts/lib/onboarding-eval.ts", ["integration.yml", "onboarding-eval-rails.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["scripts/agent/member-agent.ts", ["integration.yml", "onboarding-eval-rails.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["package.json", ["integration.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["bun.lock", ["integration.yml", "e2e-lifecycle.yml", "e2e-swarm.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    // Each domain's own entry points and its own workflow file.
    ["scripts/system-scheduler.ts", ["integration.yml", "e2e-lifecycle.yml"]],
    ["scripts/starter-swarm-agent.ts", ["integration.yml", "e2e-swarm.yml"]],
    ["scripts/verify-live.ts", ["integration.yml", "e2e-swarm.yml"]],
    ["evals/onboarding/isolated.ts", ["integration.yml", "onboarding-eval-rails.yml", "e2e-onboarding.yml"]],
    [".github/workflows/e2e-web.yml", ["integration.yml", "e2e-web.yml"]],
    [".github/workflows/e2e-swarm.yml", ["integration.yml", "e2e-swarm.yml"]],
    [".github/workflows/unit.yml", ["integration.yml"]],
    ["tsconfig.json", ["integration.yml"]],
    // The web client's own scripts: web-client runs them, integration keeps
    // them because static-assembly.sh (exercised there) imports version.ts,
    // and e2e-web serves what they assemble.
    ["scripts/web-client/browser.ts", ["integration.yml", "web-client.yml", "e2e-web.yml"]],
    ["scripts/static-assembly.sh", ["integration.yml", "web-client.yml", "e2e-web.yml"]],
    // The website-server origin: web serves the client through it, and swarm's
    // verify-live reads /api through it.
    ["website-server/nginx.conf", ["web-client.yml", "e2e-swarm.yml", "e2e-web.yml"]],
    // Every frontend file runs e2e-web and no other e2e domain: a web-only
    // change boots one stack.
    ["frontend/public/assets/js/app.js", ["web-client.yml", "e2e-web.yml"]],
    ["frontend/public/assets/css/x.css", ["web-client.yml", "e2e-web.yml"]],
    ["playwright.config.ts", ["web-client.yml", "e2e-web.yml"]],
    ["frontend/public/views/home.html", ["web-client.yml", "e2e-web.yml"]],
    ["frontend/public/data/deposit/vaults.json", ["web-client.yml", "e2e-web.yml"]],
    ["frontend/public/skills/deposit/SKILL.md", ["web-client.yml", "e2e-web.yml"]],
    ["frontend/public/assets/img/hero.png", ["web-client.yml", "e2e-web.yml"]],
    // The specs themselves were skipped by the old shared deny list, so a spec
    // edit never reached the live stack it needs.
    ["frontend/test/browser/x.spec.ts", ["web-client.yml", "e2e-web.yml"]],
    // The specs answer /api from the committed goldens.
    ["goldens/api-goldens.json", ["web-client.yml", "e2e-web.yml"]],
    // The skill the onboarding member agent reads.
    ["frontend/public/skills/swarm-onboarding/SKILL.md", ["web-client.yml", "e2e-web.yml", "e2e-onboarding.yml"]],
    ["docs/x.md", []],
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

  // The e2e filters are ALLOW lists under dorny's default `some` quantifier. An
  // `every` quantifier would turn each list into "a path matching ALL of these
  // globs", which no path does, so the job would never run on a PR.
  test("each e2e filter is a plain allow list (default `some`, no `!` entries)", () => {
    for (const file of E2E_WORKFLOWS) {
      expect(quantifierFor(file), file).toBe("some");
      const patterns = extractFilters(file)["e2e"]!;
      expect(patterns.length, file).toBeGreaterThan(0);
      expect(patterns.filter((p) => p.startsWith("!")), `${file} has a deny entry`).toEqual([]);
      expect(patterns, `${file} lists its own workflow file`).toContain(`.github/workflows/${file}`);
    }
  });

  // Red control: the table must be able to tell a domain's list apart from a
  // broken one. Dropping `frontend/**` from e2e-web's real list must turn a
  // frontend change from a run into a skip.
  test("removing an allow entry makes that path skip — red control", () => {
    const real = extractFilters("e2e-web.yml")["e2e"]!;
    expect(real).toContain("frontend/**");
    const without = real.filter((p) => p !== "frontend/**");
    const path = "frontend/public/assets/css/x.css";
    expect(pathMatches(path, real)).toBe(true);
    expect(pathMatches(path, without)).toBe(false);
  });

  // An allow-list entry that matches no tracked file is a typo or a dead path:
  // it silently selects nothing. Every e2e pattern must match a real file.
  test("every e2e allow-list pattern matches at least one file in the repo", () => {
    for (const file of E2E_WORKFLOWS) {
      for (const pattern of extractFilters(file)["e2e"]!) {
        const scan = new Bun.Glob(pattern).scanSync({ cwd: repoRoot, dot: true, onlyFiles: true });
        const first = scan[Symbol.iterator]().next();
        expect(first.done, `${file}: '${pattern}' matches no file`).toBe(false);
      }
    }
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
