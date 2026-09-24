// THE JUDGE'S TRANSPORT SETTINGS NO LONGER REACH THE STACK (D52, issue #1026).
//
// F4/T18 once put SWARM_JUDGE_TIMEOUT_MS and SWARM_JUDGE_BASE_URL on
// DEMO_COMPOSE_PASSTHROUGH, because `api` ran the judge inline and an exported
// budget reached nothing without them. The judge is a participant now: it takes
// its model key and its transport from credential.json, and `api` interpolates
// neither setting (docker-compose.yml). Forwarding them would carry a value to
// no service, so this suite now pins that they are NOT forwarded.
import { describe, expect, test } from "bun:test";
import { DEMO_COMPOSE_PASSTHROUGH, smokePassthroughEnv } from "../../lib/smoke-compose-passthrough.ts";

describe("judge transport settings are not forwarded: no stack service judges", () => {
  test.each(["SWARM_JUDGE_TIMEOUT_MS", "SWARM_JUDGE_BASE_URL", "OPENCODE_API_KEY"])("%s is NOT on DEMO_COMPOSE_PASSTHROUGH", (key) => {
    expect(DEMO_COMPOSE_PASSTHROUGH as readonly string[]).not.toContain(key);
  });

  test("an exported value never reaches the compose environment", () => {
    const out = smokePassthroughEnv({
      SWARM_JUDGE_TIMEOUT_MS: "240000",
      SWARM_JUDGE_BASE_URL: "https://opencode.ai/zen/v1",
      OPENCODE_API_KEY: "sk-planted",
    });
    expect(out).not.toHaveProperty("SWARM_JUDGE_TIMEOUT_MS");
    expect(out).not.toHaveProperty("SWARM_JUDGE_BASE_URL");
    expect(out).not.toHaveProperty("OPENCODE_API_KEY");
  });

  test("red control: a key that IS on the list does survive, so the check above is not vacuous", () => {
    expect(smokePassthroughEnv({ SWARM_JUDGE_FAULT_INJECTION: "1" })).toHaveProperty("SWARM_JUDGE_FAULT_INJECTION", "1");
  });
});

// C-27 — THE FAULT-INJECTION LEVER MUST BE REACHABLE THROUGH THE DOCUMENTED
// BOOT, the gap SWARM_JUDGE_TIMEOUT_MS once had and the same fix shape.
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
