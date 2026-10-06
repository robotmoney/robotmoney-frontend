// The old single e2e.yml booted one stack and ran every domain against it in one
// 15-minute step, so a red X said "e2e" and nothing else. It is now one workflow
// per domain, e2e-*.yml, each its own check, sharing setup and teardown through
// the composite actions in .github/actions/. This file pins the shape that
// split depends on, so it cannot quietly erode back into copies or back into one.
//
// Runs in the required `unit.yml` job — `bun run test:unit`. Pure file reads.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const wfDir = join(repoRoot, ".github", "workflows");
const actionsDir = join(repoRoot, ".github", "actions");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  shell?: string;
  if?: string;
}
interface Job {
  if?: string;
  "timeout-minutes"?: number;
  steps?: Step[];
}
interface Workflow {
  name?: string;
  env?: Record<string, string>;
  jobs?: Record<string, Job>;
}

const e2eFiles = readdirSync(wfDir).filter((f) => /^e2e-.+\.ya?ml$/.test(f)).sort();
const read = (path: string): string => readFileSync(path, "utf8");
const parse = (f: string): Workflow => Bun.YAML.parse(read(join(wfDir, f))) as Workflow;

describe("e2e is split by domain, with no single e2e.yml left", () => {
  test("there is no e2e.yml or e2e.yaml", () => {
    expect(existsSync(join(wfDir, "e2e.yml"))).toBe(false);
    expect(existsSync(join(wfDir, "e2e.yaml"))).toBe(false);
  });

  test("the four domains exist", () => {
    expect(e2eFiles).toEqual(["e2e-lifecycle.yml", "e2e-onboarding.yml", "e2e-swarm.yml", "e2e-web.yml"]);
  });

  for (const f of e2eFiles) {
    const name = f.replace(/\.ya?ml$/, "");

    describe(f, () => {
      const wf = parse(f);
      const jobs = Object.entries(wf.jobs ?? {});

      test("its workflow name, its single job id and its file name agree, so the check reads as the domain", () => {
        expect(wf.name).toBe(name);
        expect(jobs.map(([id]) => id)).toEqual([name]);
      });

      test("it is a system-correctness workflow", () => {
        expect(wf.env?.CI_CLASS).toBe("system-correctness");
      });

      test("its job defers on draft PRs and carries a job-level timeout (a composite step cannot)", () => {
        const [, job] = jobs[0]!;
        expect(job.if ?? "").toContain("github.event.pull_request.draft == false");
        expect(typeof job["timeout-minutes"]).toBe("number");
      });

      test("it boots through the shared setup and ends with the shared teardown under always()", () => {
        const steps = jobs[0]![1].steps ?? [];
        const boot = steps.find((s) => s.uses === "./.github/actions/e2e-setup");
        const teardown = steps.find((s) => s.uses === "./.github/actions/e2e-teardown");
        expect(boot, `${f} uses ./.github/actions/e2e-setup`).toBeDefined();
        expect(teardown, `${f} uses ./.github/actions/e2e-teardown`).toBeDefined();
        expect(teardown!.if ?? "").toContain("always()");
        expect(steps.at(-1)).toBe(teardown);
        expect(steps.findIndex((s) => s.uses === "actions/checkout@v4")).toBe(0);
      });

      test("it does not carry its own copy of the boot", () => {
        const text = read(join(wfDir, f));
        expect(text).not.toContain("scripts/smoke.ts --local");
        expect(text).not.toContain("docker compose -p");
        expect(text).not.toContain("setup-buildx-action");
      });
    });
  }
});

describe("the shared composite actions", () => {
  for (const action of ["e2e-setup", "e2e-teardown"]) {
    describe(action, () => {
      const text = read(join(actionsDir, action, "action.yml"));
      const parsed = Bun.YAML.parse(text) as { runs?: { using?: string; steps?: Step[] } };

      test("is a composite action", () => {
        expect(parsed.runs?.using).toBe("composite");
      });

      test("every run step names its shell (a composite requires it)", () => {
        const missing = (parsed.runs?.steps ?? []).filter((s) => typeof s.run === "string" && !s.shell).map((s) => s.name ?? s.run);
        expect(missing).toEqual([]);
      });

      test("reads no `secrets` (a composite cannot; the caller passes them as inputs)", () => {
        // Comments may say the word; an expression may not.
        expect(text).not.toMatch(/\$\{\{[^}]*\bsecrets\./);
      });

      test("sets no step-level timeout-minutes (unsupported in a composite; the job carries it)", () => {
        expect(text).not.toMatch(/^\s+timeout-minutes:/m);
      });
    });
  }

  test("every teardown step runs under always()", () => {
    const parsed = Bun.YAML.parse(read(join(actionsDir, "e2e-teardown", "action.yml"))) as { runs?: { steps?: Step[] } };
    const steps = parsed.runs?.steps ?? [];
    expect(steps.length).toBeGreaterThan(2);
    for (const s of steps) expect({ step: s.name, if: s.if }).toEqual({ step: s.name, if: "always()" });
  });
});
