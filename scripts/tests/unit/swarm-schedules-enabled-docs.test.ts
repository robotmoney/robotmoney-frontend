// Operator-surface documentation guard for SWARM_SCHEDULES_ENABLED (issue
// #888, split from #824). PR #810 made a `--static-port` boot REFUSE to start
// unless this variable says exactly "0" (assertProductionConstants,
// scripts/lib/smoke-schedule.ts) — but the surfaces an operator actually reads
// were left inconsistent: deployment.md's required-in-prod list (§5) never
// named the variable, and .env.example asserted TWO contradictory things in
// the same paragraph — "set it to 1 ... for a real deployment" right above a
// second paragraph demanding exactly "0" in production — while also citing a
// docker-compose.demo.yml that no longer exists (renamed to
// docker-compose.smoke.yml). This test pins the fix so both regressions can
// never silently reappear.
//
// Runs in the required unit.yml root job via `bun run test:unit`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

describe("deployment.md §5 lists SWARM_SCHEDULES_ENABLED as required-in-prod", () => {
  test("the required-in-prod section (§5) names the variable and its required value", () => {
    const deployment = read("docs/runbooks/deployment.md");
    const section5 = deployment.slice(
      deployment.indexOf("## 5. Application & data secrets"),
      deployment.indexOf("## 6. Least privilege"),
    );
    expect(section5.length).toBeGreaterThan(0);
    expect(section5).toContain("SWARM_SCHEDULES_ENABLED=0");
    expect(section5).toContain("required in prod");
  });

  test("rollout-procedure.md's callout distinguishes the container pin from the boot-time assertion", () => {
    const rollout = read("docs/runbooks/rollout-procedure.md");
    expect(rollout).toContain("Two different `SWARM_SCHEDULES_ENABLED` checks, at two different layers");
    expect(rollout).toContain("api container's own");
    expect(rollout).toContain("host-side, boot-time");
  });
});

describe(".env.example's SWARM_SCHEDULES_ENABLED block is internally consistent", () => {
  const env = read(".env.example");

  test("no longer names the renamed docker-compose.demo.yml file", () => {
    expect(env).not.toContain("docker-compose.demo.yml");
  });

  test("does not tell an operator to set it to 1 'for a real deployment'", () => {
    // The exact stale, self-contradicting claim: it directly disagreed with
    // the very next paragraph's "REFUSES to start unless this says exactly
    // '0'" for a production (--static-port) boot.
    expect(env).not.toContain("for a real deployment");
    expect(env).not.toContain("production runs the documented 06:00-10:00 UTC defaults");
  });

  test("still states the shipped default is 0", () => {
    expect(env).toContain("SWARM_SCHEDULES_ENABLED=0");
  });

  test("still explains unset is not safe (issue #806) and production requires exactly 0", () => {
    expect(env).toContain("REFUSES to start unless this says exactly \"0\"");
  });

  test("justification names parity/overlay-independence rather than only the hazard the overlay already prevents", () => {
    // The real value stated is that .env never silently drifts from the
    // container's behavior, and that this keeps working if the overlay pin
    // is ever removed — not just "the hazard the overlay already forecloses".
    expect(env).toContain("unconditionally");
    expect(env).toContain("never silently out of sync");
    expect(env).toContain("refactored away");
  });
});
