// D55 (10), issue #1026 [smoke-twin-remote-refusal]: a production dump from
// before 0063 cannot become a remote twin through any tool. The twin tooling
// only ever restores into a local container, and every stage tool that reads a
// remote target with no `deployment_identity` table refuses, changes nothing,
// and names the one-off intervention in the runbook.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PRE_IDENTITY_TWIN_RUNBOOK,
  requireRehearsalTarget,
  resolveDeploymentPolicy,
} from "../../../backend/src/deploy-policy.ts";
import { planTwin } from "../../smoke-twin.ts";

const REPO = join(import.meta.dir, "..", "..", "..");

describe("a remote target with no deployment_identity refuses and names the runbook", () => {
  for (const identity of [null, "unreadable"] as const) {
    test(`stage, remote, identity ${identity ?? "no row"}: refused, naming the runbook and the local alternative`, () => {
      const verdict = resolveDeploymentPolicy({ rmEnv: "stage", connection: "remote", identity });
      expect(verdict.allow).toBe(false);
      if (verdict.allow) return;
      expect(verdict.reason).toContain(PRE_IDENTITY_TWIN_RUNBOOK);
      expect(verdict.reason).toContain("rm_owner");
      expect(verdict.reason).toContain("bun smoke --local dump");
    });
  }

  test("the rehearsal-only preparations (--migrate, --seed, --spoof-keys) name it too when the target is remote", () => {
    for (const preparation of ["migrate", "seed", "spoof-keys"] as const) {
      for (const identity of [null, "unreadable"] as const) {
        const gate = requireRehearsalTarget({ preparation, rmEnv: "stage", identity, explicitlyRequested: true, connection: "remote" });
        expect(gate.allow).toBe(false);
        if (!gate.allow) expect(gate.reason).toContain(PRE_IDENTITY_TWIN_RUNBOOK);
      }
    }
  });

  test("a production or rehearsal identity is refused or allowed as before, with no runbook pointer", () => {
    const production = resolveDeploymentPolicy({ rmEnv: "stage", connection: "remote", identity: "production" });
    expect(production.allow).toBe(false);
    if (!production.allow) expect(production.reason).not.toContain(PRE_IDENTITY_TWIN_RUNBOOK);
    expect(resolveDeploymentPolicy({ rmEnv: "stage", connection: "remote", identity: "rehearsal" }).allow).toBe(true);
  });

  test("a local twin is not pointed at the remote runbook: smoke prepares a --local dump itself", () => {
    const local = requireRehearsalTarget({ preparation: "migrate", rmEnv: "stage", identity: null, explicitlyRequested: true, connection: "local-dump" });
    expect(local.allow).toBe(false);
    if (!local.allow) expect(local.reason).not.toContain(PRE_IDENTITY_TWIN_RUNBOOK);
  });

  test("the runbook the message names exists and describes the receipted rm_owner step", () => {
    const path = join(REPO, PRE_IDENTITY_TWIN_RUNBOOK);
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("rm_owner");
    expect(text).toContain("0063");
    expect(text).toContain("rehearsal");
  });
});

describe("the twin tooling never targets a remote database", () => {
  test("smoke:twin passes no flag that names a remote target, and refuses the ones that do", () => {
    const plan = planTwin([]);
    expect("error" in plan).toBe(false);
    if ("error" in plan) return;
    expect(plan.args).toContain("--local");
    expect(plan.args.some((a) => a === "dump" || a.startsWith("dump="))).toBe(true);
    for (const flag of ["--db", "--external-pg", "--remote", "--local volume"]) {
      expect(plan.args.join(" ")).not.toContain(flag);
      expect("error" in planTwin([flag])).toBe(true);
    }
  });

  test("smoke:twin:once restores into a local container: its boot is `--local dump`, never a remote connection", () => {
    const source = readFileSync(join(REPO, "scripts/lib/smoke-twin-rehearsal.ts"), "utf8");
    const argv = source.split("\n").find((line) => line.includes("const args = [")) ?? "";
    expect(argv).toContain('"--local"');
    expect(argv).toContain('"dump"');
    expect(argv).not.toMatch(/external|--db|--remote/);
  });
});
