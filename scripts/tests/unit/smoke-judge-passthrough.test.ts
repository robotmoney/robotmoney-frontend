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

// THE DRIVER'S OWN JUDGE CEILING USED TO BE GRADED HERE and is gone with the
// constant it graded. `JUDGE_WAIT_MS` was the model budget plus slack for the
// `swarm.judge` job to be claimed off the single-concurrency swarm lane; there
// is no such job and no such lane (issue #1026 W4). The driver's bound is now
// the ABSOLUTE DEADLINE the API stores when judging is requested
// (system-scheduler-spec.md §4.4), which no constant in this repository may
// restate — §9: "a judging deadline is stored by the API when judging is
// requested and is never restarted". The two settings above still have to reach
// the containers, which is what the rest of this file grades.
