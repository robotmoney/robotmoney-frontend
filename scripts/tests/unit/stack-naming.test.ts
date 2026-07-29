// Pure unit tests for scripts/stack/naming.ts — the environment-scoped name and
// label scheme every container spawner in this repo now shares.
//
// The property under test is attribution: given a stray container on the shared
// host (which is simultaneously the stage demo box and the self-hosted Actions
// runner), can tooling tell WHICH environment created it — and can it tell
// safely, by label rather than by guessing at a name substring? Four families
// used to mint four private name shapes and the answer was no, which is why
// nothing could be reaped without risking the live site.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CI_IDENTITY_VARS,
  CI_PROJECT_PREFIX,
  dockerLabelFlags,
  ENV_CLASS_COMPOSE_VAR,
  ENV_CLASS_LABEL,
  ENV_HASH_COMPOSE_VAR,
  ENV_HASH_LABEL,
  isGithubActions,
  LOCAL_PROJECT_PREFIX,
  PROJECT_LABEL,
  projectPrefix,
  resolveStackEnvironment,
  shortHash,
  stackLabels,
  stackProjectName,
  type StackRole,
} from "../../stack/naming.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");

// A representative Actions environment. Every field matters to the hash, so
// each test below perturbs exactly one of them.
const ACTIONS_ENV = {
  GITHUB_ACTIONS: "true",
  GITHUB_WORKFLOW: "e2e",
  GITHUB_RUN_ID: "12345",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_JOB: "e2e",
};

const ROLES: StackRole[] = ["stack", "eval", "infra", "pgtest"];

describe("environment class", () => {
  test("GITHUB_ACTIONS === 'true' is CI; everything else is local", () => {
    expect(isGithubActions(ACTIONS_ENV)).toBe(true);
    expect(isGithubActions({})).toBe(false);
    // Exact comparison on purpose: a truthy-but-not-"true" value means
    // something is impersonating the runner and must not take the CI path.
    expect(isGithubActions({ GITHUB_ACTIONS: "1" })).toBe(false);
    expect(isGithubActions({ GITHUB_ACTIONS: "TRUE" })).toBe(false);
    expect(isGithubActions({ GITHUB_ACTIONS: "false" })).toBe(false);
  });

  test("the class picks the prefix: rm_ci under Actions, rm_demo otherwise", () => {
    expect(projectPrefix(resolveStackEnvironment(ACTIONS_ENV))).toBe(CI_PROJECT_PREFIX);
    expect(projectPrefix(resolveStackEnvironment({}))).toBe(LOCAL_PROJECT_PREFIX);
    expect(CI_PROJECT_PREFIX).toBe("rm_ci");
    expect(LOCAL_PROJECT_PREFIX).toBe("rm_demo");
  });
});

describe("the CI hash identifies one JOB EXECUTION", () => {
  test("stable: the same job resolves the same environment every time it is asked", () => {
    const a = resolveStackEnvironment(ACTIONS_ENV);
    const b = resolveStackEnvironment({ ...ACTIONS_ENV });
    expect(a).toEqual(b);
    expect(a.class).toBe("ci");
    // This is what lets the boot step and its `always()` teardown step name the
    // same project without passing anything between them.
    expect(stackProjectName("stack", a)).toBe(stackProjectName("stack", b));
  });

  test("distinct: changing ANY of the four identity vars changes the hash", () => {
    const base = resolveStackEnvironment(ACTIONS_ENV).hash;
    const seen = new Set([base]);
    for (const v of CI_IDENTITY_VARS) {
      const h = resolveStackEnvironment({ ...ACTIONS_ENV, [v]: "perturbed" }).hash;
      expect(h).not.toBe(base);
      seen.add(h);
    }
    // …and each perturbation is distinct from the others, so a re-attempt of
    // run 42 cannot collide with a different job of the same run.
    expect(seen.size).toBe(CI_IDENTITY_VARS.length + 1);
  });

  test("a seed can never override the CI identity", () => {
    const a = resolveStackEnvironment(ACTIONS_ENV, { seed: "one" });
    const b = resolveStackEnvironment(ACTIONS_ENV, { seed: "two" });
    expect(a.hash).toBe(b.hash);
  });

  test("the identity var list is exactly the documented quadruple, in order", () => {
    expect([...CI_IDENTITY_VARS]).toEqual([
      "GITHUB_WORKFLOW",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_JOB",
    ]);
  });
});

describe("the local hash is per-boot random", () => {
  test("two resolutions of the same local environment differ", () => {
    // There is no workflow identity outside Actions, so uniqueness has to come
    // from somewhere — and per-boot randomness is what stops two concurrent
    // `bun demo` runs from sharing a compose project.
    const hashes = new Set(Array.from({ length: 8 }, () => resolveStackEnvironment({}).hash));
    expect(hashes.size).toBe(8);
  });

  test("an explicit seed makes it deterministic (for tests only)", () => {
    expect(resolveStackEnvironment({}, { seed: "s" })).toEqual(resolveStackEnvironment({}, { seed: "s" }));
    expect(resolveStackEnvironment({}, { seed: "s" }).hash).not.toBe(resolveStackEnvironment({}, { seed: "t" }).hash);
  });

  test("the hash is short lowercase hex — readable in `docker ps`", () => {
    for (const env of [ACTIONS_ENV, {}]) {
      expect(resolveStackEnvironment(env).hash).toMatch(/^[0-9a-f]{10}$/);
    }
    expect(shortHash("x")).toMatch(/^[0-9a-f]{10}$/);
  });
});

describe("project names", () => {
  const ci = resolveStackEnvironment(ACTIONS_ENV);
  const local = resolveStackEnvironment({}, { seed: "fixed-local-seed" });

  test("concrete shape: <prefix>_<role>_<hash>", () => {
    expect(stackProjectName("stack", ci)).toBe(`rm_ci_stack_${ci.hash}`);
    expect(stackProjectName("pgtest", local)).toBe(`rm_demo_pgtest_${local.hash}`);
  });

  test("all four families are distinguishable inside ONE ci job, where the hash is identical", () => {
    const names = ROLES.map((r) => stackProjectName(r, ci));
    expect(new Set(names).size).toBe(ROLES.length);
    for (const n of names) expect(n.startsWith(`${CI_PROJECT_PREFIX}_`)).toBe(true);
  });

  test("every generated name is a VALID compose project name", () => {
    // docker compose rejects anything outside [a-z0-9][a-z0-9_-]*; an invalid
    // name would only surface at bring-up time, in CI, minutes in.
    for (const env of [ci, local]) {
      for (const role of ROLES) {
        expect(stackProjectName(role, env)).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
      }
    }
  });

  test("a ci name and a local name can never be confused for one another", () => {
    for (const role of ROLES) {
      expect(stackProjectName(role, ci).startsWith("rm_demo")).toBe(false);
      expect(stackProjectName(role, local).startsWith("rm_ci")).toBe(false);
    }
  });
});

describe("labels — the channel tooling selects on", () => {
  const ci = resolveStackEnvironment(ACTIONS_ENV);

  test("every container carries project + env class + env hash", () => {
    const project = stackProjectName("stack", ci);
    expect(stackLabels(ci, project)).toEqual({
      "robotmoney.demo.project": project,
      "robotmoney.env": "ci",
      "robotmoney.env.hash": ci.hash,
    });
  });

  test("the label keys are the documented constants (a rename would silently orphan a reaper)", () => {
    expect(PROJECT_LABEL).toBe("robotmoney.demo.project");
    expect(ENV_CLASS_LABEL).toBe("robotmoney.env");
    expect(ENV_HASH_LABEL).toBe("robotmoney.env.hash");
  });

  test("dockerLabelFlags emits --label pairs in a stable order (raw `docker run` spawners)", () => {
    const local = resolveStackEnvironment({}, { seed: "seed" });
    expect(dockerLabelFlags(stackLabels(local, "rm_demo_pgtest_x"))).toEqual([
      "--label", "robotmoney.demo.project=rm_demo_pgtest_x",
      "--label", "robotmoney.env=local",
      "--label", `robotmoney.env.hash=${local.hash}`,
    ]);
  });
});

// ── Wiring guards ───────────────────────────────────────────────────────────
// Executed assertions against the real on-disk compose files, workflows and
// spawners: these are the places the scheme has to be APPLIED, and none of them
// is reachable from a unit test any other way (each one needs Docker to run).
describe("the scheme is actually wired into every spawner", () => {
  test("docker-compose.demo.yml stamps both env labels on every service and on the pgdata volume", () => {
    const demo = readFileSync(join(repoRoot, "docker-compose.demo.yml"), "utf8");
    const classLines = demo.split("\n").filter((l) => l.includes(`${ENV_CLASS_LABEL}:`));
    const hashLines = demo.split("\n").filter((l) => l.includes(`${ENV_HASH_LABEL}:`));
    // postgres, api, the shared worker anchor, member-agent, and the volume.
    expect(classLines.length).toBe(5);
    expect(hashLines.length).toBe(5);
    for (const l of classLines) expect(l).toContain(`\${${ENV_CLASS_COMPOSE_VAR}}`);
    for (const l of hashLines) expect(l).toContain(`\${${ENV_HASH_COMPOSE_VAR}}`);
  });

  test("no spawner keeps a private ad-hoc name shape", () => {
    const files = [
      ["scripts", "lib", "demo-main.ts"],
      ["scripts", "onboarding-eval-local.ts"],
      ["scripts", "tests", "integration", "onboarding-eval-infra.test.ts"],
      ["backend", "tests", "preload.ts"],
    ];
    for (const parts of files) {
      const src = readFileSync(join(repoRoot, ...parts), "utf8");
      expect({ file: parts.join("/"), usesHelper: src.includes("stackProjectName(") }).toEqual({
        file: parts.join("/"),
        usesHelper: true,
      });
      // The four retired shapes.
      for (const legacy of ["rmdemo_", "rmeval_local_", "rm_onboarding_infra_", "rmtest_pg_"]) {
        expect({ file: parts.join("/"), legacy, found: src.includes(legacy) }).toEqual({
          file: parts.join("/"), legacy, found: false,
        });
      }
    }
  });

  test("backend/tests/preload.ts passes labels explicitly — it is a raw `docker run`, not compose", () => {
    const src = readFileSync(join(repoRoot, "backend", "tests", "preload.ts"), "utf8");
    expect(src).toContain("dockerLabelFlags");
    expect(src).toContain("...labelFlags");
  });

  test("every workflow-pinned DEMO_PROJECT carries the CI prefix", () => {
    const workflows = ["e2e.yml", "committee-opencode-nightly.yml"];
    let seen = 0;
    for (const w of workflows) {
      const src = readFileSync(join(repoRoot, ".github", "workflows", w), "utf8");
      for (const line of src.split("\n")) {
        const m = /^\s*DEMO_PROJECT:\s*(\S+)/.exec(line);
        if (!m) continue;
        seen++;
        // A CI project name that did NOT say `rm_ci` would be indistinguishable
        // from the standing stage demo to anything sweeping this host.
        expect({ workflow: w, value: m[1]!.startsWith(`${CI_PROJECT_PREFIX}_`) }).toEqual({ workflow: w, value: true });
      }
    }
    // Both steps in both workflows — boot + always() teardown.
    expect(seen).toBe(4);
  });
});
