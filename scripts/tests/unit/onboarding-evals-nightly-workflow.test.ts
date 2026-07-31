// Pins .github/workflows/onboarding-evals-nightly.yml's CI taxonomy class,
// triggers, and teardown scope (issue #279) — and, separately, that the
// claim-named vocabulary rename (layer0-3 -> runtime/skill-install/toolchain/
// keygen-signing) actually landed everywhere the issue named: the eval tree,
// the workflow, and the two canonical docs.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const WORKFLOW_PATH = join(repoRoot, ".github", "workflows", "onboarding-evals-nightly.yml");

describe("onboarding-evals-nightly.yml — CI taxonomy and triggers", () => {
  const text = readFileSync(WORKFLOW_PATH, "utf8");
  const parsed = Bun.YAML.parse(text) as {
    on?: unknown;
    true?: unknown;
    env?: Record<string, string>;
    jobs?: Record<string, { steps?: { run?: string; env?: Record<string, string> }[] }>;
  };

  test("declares CI_CLASS: heavy", () => {
    expect(parsed.env?.CI_CLASS).toBe("heavy");
  });

  // Issue #373 FOLDED this workflow into the merge-to-main set: the four
  // isolated claims bisect the onboarding funnel that e2e.yml's single
  // end-to-end admission reports as one opaque red, so nothing in the merge set
  // duplicates them and they belong in BOTH places. Nightly is a MIRROR of what
  // a merge runs (scripts/tests/unit/nightly-mirrors-merge-set.test.ts). The
  // property that has not moved: NO `pull_request` trigger — hours of real
  // model inference must never land on the per-PR graph (D22 rule 2).
  test("triggers are EXACTLY push-to-main, schedule and workflow_dispatch — no pull_request", () => {
    // YAML 1.1 folds the bare key `on` to boolean true; Bun.YAML keeps it a
    // string — accept either so this can never quietly observe zero triggers.
    const on = (parsed.on ?? parsed.true) as Record<string, unknown> | undefined;
    expect(on).toBeTruthy();
    expect(Object.keys(on!).sort()).toEqual(["push", "schedule", "workflow_dispatch"]);
    expect((on!.push as { branches: string[] }).branches).toEqual(["main"]);
  });

  test("runs the eval:onboarding:isolated package target", () => {
    const runs = Object.values(parsed.jobs ?? {}).flatMap((j) => (j.steps ?? []).map((s) => s.run ?? ""));
    expect(runs.some((r) => /bun run eval:onboarding:isolated\b/.test(r))).toBe(true);
  });

  test("the eval step is billed to the OPENCODE_API_KEY secret, not a bare literal", () => {
    const evalStep = Object.values(parsed.jobs ?? {})
      .flatMap((j) => j.steps ?? [])
      .find((s) => /bun run eval:onboarding:isolated\b/.test(s.run ?? ""));
    expect(evalStep?.env?.OPENCODE_API_KEY).toBe("${{ secrets.OPENCODE_API_KEY }}");
  });

  test("teardown removes rmeval_* containers, networks, AND volumes, but never images", () => {
    expect(text).toMatch(/docker ps -a --filter "name=rmeval_" -q \| xargs -r docker rm -f/);
    expect(text).toMatch(/docker network ls --filter "name=rmeval_" -q \| xargs -r docker network rm/);
    expect(text).toMatch(/docker volume ls --filter "name=rmeval_" -q \| xargs -r docker volume rm/);
    expect(text).not.toMatch(/docker (image )?rmi|docker system prune/);
  });

  test("the teardown step runs on `if: always()`, so a killed eval step still tears down", () => {
    const teardown = Object.values(parsed.jobs ?? {})
      .flatMap((j) => j.steps ?? [])
      .find((s) => /docker ps -a --filter "name=rmeval_"/.test(s.run ?? "")) as { if?: string } | undefined;
    expect(teardown?.if).toBe("always()");
  });
});

describe("claim-named vocabulary — no /layer[0-9]/ identifier or path survives the rename", () => {
  const LAYER_IDENTIFIER = /layer[0-9]/i;

  function assertClean(label: string, text: string): void {
    const match = text.match(LAYER_IDENTIFIER);
    expect(match, `${label} still contains a /layer[0-9]/ identifier: ${JSON.stringify(match?.[0])}`).toBeNull();
  }

  test("no file or directory under evals/onboarding/ is named layerN", () => {
    const evalsOnboarding = join(repoRoot, "evals", "onboarding");
    function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
    }
    const paths = walk(evalsOnboarding);
    expect(paths.length).toBeGreaterThan(0); // non-vacuous: the tree really exists
    for (const p of paths) assertClean(p, p.replace(repoRoot, ""));
  });

  test("no evals/onboarding/ file CONTAINS a /layer[0-9]/ identifier in its source", () => {
    const evalsOnboarding = join(repoRoot, "evals", "onboarding");
    function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
    }
    const files = walk(evalsOnboarding);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) assertClean(f, readFileSync(f, "utf8"));
  });

  test("onboarding-evals-nightly.yml carries no /layer[0-9]/ identifier", () => {
    assertClean(WORKFLOW_PATH, readFileSync(WORKFLOW_PATH, "utf8"));
  });

  test("docs/architecture.md §11.3 carries no /layer[0-9]/ identifier", () => {
    const doc = readFileSync(join(repoRoot, "docs", "architecture.md"), "utf8");
    const start = doc.indexOf("### 11.3 Onboarding eval");
    expect(start).toBeGreaterThan(-1);
    const end = doc.indexOf("\n### 11.4", start);
    const section = end > -1 ? doc.slice(start, end) : doc.slice(start);
    assertClean("docs/architecture.md §11.3", section);
  });

  test("evals/README.md carries no /layer[0-9]/ identifier", () => {
    assertClean("evals/README.md", readFileSync(join(repoRoot, "evals", "README.md"), "utf8"));
  });

  // ── negative control: the scan must be able to fire ─────────────────────
  test("the scan FIRES on a planted /layer[0-9]/ identifier — the assertion above isn't vacuous", () => {
    expect("evals/onboarding/isolated/layer0-runtime.eval.test.ts").toMatch(LAYER_IDENTIFIER);
  });
});
