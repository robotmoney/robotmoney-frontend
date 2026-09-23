// F4/T18 — THE JUDGE BUDGET MUST BE REACHABLE THROUGH THE DOCUMENTED BOOT.
//
// Written before the fix (QA plan §12.7.2). `docker-compose.yml` interpolates
// `SWARM_JUDGE_TIMEOUT_MS: ${SWARM_JUDGE_TIMEOUT_MS:-}` into api and
// worker-swarm, but `bun run smoke:stage` builds the compose environment from
// `DEMO_COMPOSE_PASSTHROUGH` — and neither the timeout nor the base URL was on
// it. So an operator who exported the value got an EMPTY variable in the
// container and the 60 s default anyway: the QA run had to bypass the boot and
// recreate one service by hand with 27 values re-supplied. This is the same
// rescue `OPENCODE_API_KEY` needed in this release.
import { describe, expect, test } from "bun:test";
import { DEMO_COMPOSE_PASSTHROUGH, smokePassthroughEnv } from "../../lib/smoke-compose-passthrough.ts";
import { JUDGE_LANE_CLAIM_SLACK_MS, JUDGE_WAIT_MS } from "../../lib/swarm/session.ts";
import { DEFAULT_JUDGE_TIMEOUT_MS } from "../../../backend/src/swarm/judge-budget.ts";

describe("judge transport settings reach the stack through the documented boot", () => {
  test.each(["SWARM_JUDGE_TIMEOUT_MS", "SWARM_JUDGE_BASE_URL"])("%s is on DEMO_COMPOSE_PASSTHROUGH", (key) => {
    expect(DEMO_COMPOSE_PASSTHROUGH as readonly string[]).toContain(key);
  });

  test("an exported budget survives into the compose environment", () => {
    const out = smokePassthroughEnv({ SWARM_JUDGE_TIMEOUT_MS: "240000", SWARM_JUDGE_BASE_URL: "https://opencode.ai/zen/v1" });
    expect(out.SWARM_JUDGE_TIMEOUT_MS).toBe("240000");
    expect(out.SWARM_JUDGE_BASE_URL).toBe("https://opencode.ai/zen/v1");
  });

  test("an unset budget still passes nothing, so the compose default stands", () => {
    expect(smokePassthroughEnv({})).not.toHaveProperty("SWARM_JUDGE_TIMEOUT_MS");
  });
});

// C-27 — THE FAULT-INJECTION LEVER MUST BE REACHABLE THROUGH THE DOCUMENTED
// BOOT, same gap as SWARM_JUDGE_TIMEOUT_MS above and the same fix shape.
// `docker-compose.yml` interpolates `SWARM_JUDGE_FAULT_INJECTION` and
// `SWARM_JUDGE_FAULT_INJECTION_ACCEPTANCE_OPT_IN` into api and worker-swarm,
// but until DEMO_COMPOSE_PASSTHROUGH named them an operator exporting either
// got an EMPTY variable in the container and every judging (and every arm
// attempt) silently refused with `flag_absent`.
describe("judge fault-injection flags reach the stack through the documented boot", () => {
  test.each(["SWARM_JUDGE_FAULT_INJECTION", "SWARM_JUDGE_FAULT_INJECTION_ACCEPTANCE_OPT_IN"])(
    "%s is on DEMO_COMPOSE_PASSTHROUGH",
    (key) => {
      expect(DEMO_COMPOSE_PASSTHROUGH as readonly string[]).toContain(key);
    },
  );

  test("exported fault-injection flags survive into the compose environment", () => {
    const out = smokePassthroughEnv({
      SWARM_JUDGE_FAULT_INJECTION: "1",
      SWARM_JUDGE_FAULT_INJECTION_ACCEPTANCE_OPT_IN: "1",
    });
    expect(out.SWARM_JUDGE_FAULT_INJECTION).toBe("1");
    expect(out.SWARM_JUDGE_FAULT_INJECTION_ACCEPTANCE_OPT_IN).toBe("1");
  });

  test("unset fault-injection flags still pass nothing, so the lever stays inert by default", () => {
    const out = smokePassthroughEnv({});
    expect(out).not.toHaveProperty("SWARM_JUDGE_FAULT_INJECTION");
    expect(out).not.toHaveProperty("SWARM_JUDGE_FAULT_INJECTION_ACCEPTANCE_OPT_IN");
  });
});

// The driver's ceiling is DERIVED, not a coincidence: it used to be a bare
// 120_000 whose comment claimed the model call was "bounded at ~60s" — true of
// the old default and false of this one. A ceiling below the budget it is
// waiting on guarantees the driver publishes before the judging can land.
test("JUDGE_WAIT_MS is derived from the judge budget and leaves claim slack", () => {
  expect(JUDGE_WAIT_MS).toBeGreaterThan(DEFAULT_JUDGE_TIMEOUT_MS);
});

test("the ceiling is the budget plus the named lane slack, not a literal", () => {
  expect(JUDGE_WAIT_MS).toBe(DEFAULT_JUDGE_TIMEOUT_MS + JUDGE_LANE_CLAIM_SLACK_MS);
  expect(JUDGE_LANE_CLAIM_SLACK_MS).toBeGreaterThan(0);
});
