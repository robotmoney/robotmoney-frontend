// `bun run twin:accelerate` (standing check SR.9): a stage twin's subjects on a short
// epoch grid through the admin API, the open windows pulled in, the scheduler rebuilt.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_EPOCH_SECONDS, MIN_EPOCH_SECONDS, parseArgs, planCloses, refusal, RETIME_SQL } from "../../twin-accelerate.ts";

describe("arguments", () => {
  test("default epoch, explicit epoch and judging", () => {
    expect(parseArgs([])).toEqual({ epoch: DEFAULT_EPOCH_SECONDS, judging: null });
    expect(parseArgs(["--epoch", "600", "--judging", "300"])).toEqual({ epoch: 600, judging: 300 });
  });
  test("refuses a missing, fractional or too-short value", () => {
    expect(parseArgs(["--epoch"])).toHaveProperty("error");
    expect(parseArgs(["--epoch", "9.5"])).toHaveProperty("error");
    expect(parseArgs(["--epoch", String(MIN_EPOCH_SECONDS - 1)])).toHaveProperty("error");
    expect(parseArgs(["--judging", "30"])).toHaveProperty("error");
  });
});

describe("the plan", () => {
  test("subjects spread across one epoch, the first after E/n", () => {
    const now = Date.parse("2026-10-07T00:00:00Z");
    const plan = planCloses(now, 900, ["a", "b", "c", "d"]);
    expect(plan.map((p) => (p.closeMs - now) / 1000)).toEqual([225, 450, 675, 900]);
    expect(plan.map((p) => p.subjectId)).toEqual(["a", "b", "c", "d"]);
  });
  test("the re-time only moves a collecting window of that subject EARLIER, with psql variables", () => {
    expect(RETIME_SQL).toContain("state = 'collecting'");
    expect(RETIME_SQL).toContain("subject_id = :'sid'");
    expect(RETIME_SQL).toContain("window_closes_at > :'close'::timestamptz");
  });
});

describe("refusals", () => {
  test("production is refused", () => {
    expect(refusal({ RM_ENV: "prod" })).toMatch(/RM_ENV is prod/);
    expect(refusal({ RM_ENV: "stage" })).toBeNull();
  });
  test("only a smoke-twin stack is accepted, and the scheduler is restarted so its timers rebuild", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "twin-accelerate.ts"), "utf8");
    expect(src).toContain('resolveGateStack(argv, env, ["smoke-twin"])');
    expect(src).toContain('serviceContainer(stack.project, "system-scheduler")');
    expect(src).toContain('["docker", "restart", scheduler]');
  });
});
