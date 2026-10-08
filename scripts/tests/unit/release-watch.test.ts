// scripts/tests/unit/release-watch.test.ts — how long W1 and R7.4a wait after READY.
//
// Stage run 20261008T042158Z failed W1 check 7 at READY + 6 h: robotmoney-treasury
// and woon had no open window at boot, so the scheduler gave each a first epoch
// that lasts up to 1.5 epochs (system-scheduler-spec §2.2), and both were still
// `collecting`. The watch now derives from that bound (scripts/release/watch.ts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_STEPS, notBeforeOf, renderStep, stepListHash, templateValues } from "../../release/steps.ts";
import { loadTarget, validateTarget } from "../../release/target.ts";
import {
  DEFAULT_JUDGING_SECONDS, DEFAULT_WATCH_HOURS, PRODUCTION_EPOCH_SECONDS, PUBLISH_GRACE_SECONDS, watchHoursFor,
} from "../../release/watch.ts";

const targetsDir = join(import.meta.dir, "../../release/targets");
const HOUR = 3600;

describe("watchHoursFor: the slowest subject's first publish after READY", () => {
  test("production cadence: 1.5 × 6 h + 15 min judging + 30 min grace = 9.75 h, rounded up to 10 h", () => {
    expect(watchHoursFor({ epochSeconds: PRODUCTION_EPOCH_SECONDS, judgingSeconds: DEFAULT_JUDGING_SECONDS, graceSeconds: PUBLISH_GRACE_SECONDS })).toBe(10);
    expect(DEFAULT_WATCH_HOURS).toBe(10);
  });
  test("it rounds up, never down", () => {
    expect(watchHoursFor({ epochSeconds: 4 * HOUR, judgingSeconds: 0, graceSeconds: 0 })).toBe(6);
    expect(watchHoursFor({ epochSeconds: 4 * HOUR, judgingSeconds: 1, graceSeconds: 0 })).toBe(7);
  });
  test("red control: the old 6 h watch is shorter than a first epoch can last", () => {
    // The stage run's treasury and woon sessions opened at boot (04:34:22Z) and
    // were still collecting at READY (04:35:25Z) + 6 h.
    expect(watchHoursFor({ epochSeconds: PRODUCTION_EPOCH_SECONDS, judgingSeconds: 0, graceSeconds: 0 })).toBeGreaterThan(6);
  });
  test("red: a zero, negative or non-finite input throws", () => {
    expect(() => watchHoursFor({ epochSeconds: 0, judgingSeconds: 0, graceSeconds: 0 })).toThrow();
    expect(() => watchHoursFor({ epochSeconds: PRODUCTION_EPOCH_SECONDS, judgingSeconds: -1, graceSeconds: 0 })).toThrow();
    expect(() => watchHoursFor({ epochSeconds: Number.NaN, judgingSeconds: 0, graceSeconds: 0 })).toThrow();
  });
});

describe("the watch length is target data; the step list stays one list", () => {
  test("W1 and R7.4a wait R6.9 + watchHours, and nothing else waits", () => {
    expect(RELEASE_STEPS.filter((s) => s.notBefore).map((s) => [s.id, s.notBefore!.afterStep, s.notBefore!.hours]))
      .toEqual([["W1", "R6.9", "watchHours"], ["R7.4a", "R6.9", "watchHours"]]);
  });
  test("stage and prod both resolve to the derived 10 h, in the template and in the rendered step", () => {
    for (const name of ["stage", "prod"]) {
      const t = loadTarget(join(targetsDir, `${name}.json`));
      expect(t.watchHours).toBe(DEFAULT_WATCH_HOURS);
      for (const id of ["W1", "R7.4a"]) {
        const step = RELEASE_STEPS.find((s) => s.id === id)!;
        expect(notBeforeOf(step, t)).toEqual({ afterStep: "R6.9", hours: 10 });
        expect(renderStep(step, t, templateValues(t, "a".repeat(40), "20261008T000000Z")).notBefore).toEqual({ afterStep: "R6.9", hours: 10 });
      }
    }
  });
  test("a fixed-hours wait resolves to itself; a step without a wait resolves to none", () => {
    expect(notBeforeOf({ notBefore: { afterStep: "X", hours: 3 } }, { watchHours: 99 })).toEqual({ afterStep: "X", hours: 3 });
    expect(notBeforeOf({}, { watchHours: 10 })).toBeUndefined();
  });
  test("the step-list hash covers notBefore, but never a target's watchHours", () => {
    const fixed = RELEASE_STEPS.map((s) => (s.notBefore ? { ...s, notBefore: { afterStep: "R6.9", hours: 6 } } : s));
    expect(stepListHash(fixed)).not.toBe(stepListHash());
    // The hash takes no target, so a longer watchHours on one target cannot make it differ.
    const raw = JSON.parse(readFileSync(join(targetsDir, "stage.json"), "utf8"));
    raw.watchHours = 12;
    const r = validateTarget("stage", raw);
    expect("target" in r && r.target.watchHours).toBe(12);
  });
  test("red: a target file may lengthen the watch, never shorten it below the derived bound", () => {
    const raw = JSON.parse(readFileSync(join(targetsDir, "prod.json"), "utf8"));
    raw.confirmTarget = "db.example.com:25060/rm";
    for (const bad of [6, 9.5, 0, -1, "10"]) {
      raw.watchHours = bad;
      const r = validateTarget("prod", raw);
      expect("errors" in r && r.errors.join("\n")).toContain("watchHours");
    }
    raw.watchHours = 10;
    expect("errors" in validateTarget("prod", raw)).toBe(false);
  });
});
