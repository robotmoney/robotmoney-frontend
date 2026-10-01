// NO JUDGE SETTING OF ANY KIND REACHES THE STACK (D52, D55 (3); issue #1026).
//
// F4/T18 once put SWARM_JUDGE_TIMEOUT_MS and SWARM_JUDGE_BASE_URL on
// DEMO_COMPOSE_PASSTHROUGH, because `api` ran the judge inline and an exported
// budget reached nothing without them. The judge is a participant now: it takes
// its model key and its transport from credential.json, and `api` interpolates
// neither setting (docker-compose.yml).
//
// C-27 then added the test-only judge FAULT-INJECTION lever
// (SWARM_JUDGE_FAULT_INJECTION and its acceptance opt-in) to the list, so an
// operator could arm it through the documented boot. D55 (3) retires that
// lever: docker-compose.yml no longer hands either variable to `api`, and the
// passthrough no longer names them. This suite pins that neither the judge's
// transport nor the lever is forwarded — an exported value reaches no container.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_COMPOSE_PASSTHROUGH, smokePassthroughEnv } from "../../lib/smoke-compose-passthrough.ts";

const RETIRED_JUDGE_KEYS = [
  "SWARM_JUDGE_TIMEOUT_MS",
  "SWARM_JUDGE_BASE_URL",
  "OPENCODE_API_KEY",
  // D55 (3): the fault-injection lever is retired from the stack.
  "SWARM_JUDGE_FAULT_INJECTION",
  "SWARM_JUDGE_FAULT_INJECTION_ACCEPTANCE_OPT_IN",
] as const;

describe("judge settings are not forwarded: no stack service judges, and the fault-injection lever is retired", () => {
  test.each([...RETIRED_JUDGE_KEYS])("%s is NOT on DEMO_COMPOSE_PASSTHROUGH", (key) => {
    expect(DEMO_COMPOSE_PASSTHROUGH as readonly string[]).not.toContain(key);
  });

  test("an exported value never reaches the compose environment", () => {
    const out = smokePassthroughEnv(Object.fromEntries(RETIRED_JUDGE_KEYS.map((key) => [key, "1"])));
    for (const key of RETIRED_JUDGE_KEYS) expect(out).not.toHaveProperty(key);
  });

  test("red control: a key that IS on the list does survive, so the checks above are not vacuous", () => {
    expect(smokePassthroughEnv({ PROJECTS_SOURCE: "live" })).toHaveProperty("PROJECTS_SOURCE", "live");
  });

  test("docker-compose.yml interpolates neither fault-injection variable into any service", () => {
    const compose = readFileSync(join(import.meta.dir, "..", "..", "..", "docker-compose.yml"), "utf8");
    const code = compose.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    expect(code).not.toContain("SWARM_JUDGE_FAULT_INJECTION");
  });
});

// THE DRIVER'S OWN JUDGE CEILING USED TO BE GRADED HERE and is gone with the
// constant it graded. `JUDGE_WAIT_MS` was the model budget plus slack for the
// `swarm.judge` job to be claimed off the single-concurrency swarm lane; there
// is no such job and no such lane (issue #1026 W4). The driver's bound is now
// the ABSOLUTE DEADLINE the API stores when judging is requested
// (system-scheduler-spec.md §4.4), which no constant in this repository may
// restate — §9: "a judging deadline is stored by the API when judging is
// requested and is never restarted".
