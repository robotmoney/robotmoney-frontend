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
  test("prod waits the derived 10 h graded; stage waits 15 minutes deferred (owner decision 2026-10-08)", () => {
    for (const [name, hours, sessions] of [["prod", 10, "graded"], ["stage", 0.25, "deferred"]] as const) {
      const t = loadTarget(join(targetsDir, `${name}.json`));
      expect(t.watchHours).toBe(hours);
      expect(t.watchSessions).toBe(sessions);
      for (const id of ["W1", "R7.4a"]) {
        const step = RELEASE_STEPS.find((s) => s.id === id)!;
        expect(notBeforeOf(step, t)).toEqual({ afterStep: "R6.9", hours });
        expect(renderStep(step, t, templateValues(t, "a".repeat(40), "20261008T000000Z")).notBefore).toEqual({ afterStep: "R6.9", hours });
      }
    }
  });
  test("W1 and R7.4a render --sessions from the target: graded on prod, deferred on stage", () => {
    const rendered = (name: string, id: string) => {
      const t = loadTarget(join(targetsDir, `${name}.json`));
      return renderStep(RELEASE_STEPS.find((s) => s.id === id)!, t, templateValues(t, "a".repeat(40), "20261008T000000Z")).remote;
    };
    for (const id of ["W1", "R7.4a"]) {
      expect(rendered("prod", id)).toContain(" --sessions graded ");
      expect(rendered("prod", id)).not.toContain("deferred");
      expect(rendered("stage", id)).toContain(" --sessions deferred ");
    }
    expect(rendered("prod", "W1")).toContain("bun run prod:gate --mode post-release");
    expect(rendered("prod", "W1")).not.toContain("--defer-sessions");
    expect(rendered("stage", "R7.4a")).toContain("bun scripts/release/schedule-parity.ts");
  });
  test("the step-list hash is the same for both targets: the templates carry {watchSessions}, never its value", () => {
    for (const s of RELEASE_STEPS) {
      const text = JSON.stringify(s.cmds);
      expect(text).not.toContain("graded");
      expect(text).not.toContain("\"deferred\"");
    }
    const before = stepListHash();
    // Rendering for either target leaves the hash untouched; it takes no target at all.
    for (const name of ["stage", "prod"]) {
      const t = loadTarget(join(targetsDir, `${name}.json`));
      for (const s of RELEASE_STEPS) renderStep(s, t, templateValues(t, "a".repeat(40), "20261008T000000Z"));
    }
    expect(stepListHash()).toBe(before);
    // red control: hard-coding the value into the template changes the hash.
    const forked = RELEASE_STEPS.map((s) => (s.id === "W1" ? { ...s, cmds: [s.cmds[0]!.map((a) => (a === "{watchSessions}" ? "deferred" : a))] } : s));
    expect(stepListHash(forked)).not.toBe(before);
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
  test("red: production may lengthen the watch, never shorten it below the derived bound", () => {
    const raw = JSON.parse(readFileSync(join(targetsDir, "prod.json"), "utf8"));
    raw.confirmTarget = "db.example.com:25060/rm";
    for (const bad of [0.25, 6, 9.5, 0, -1, "10"]) {
      raw.watchHours = bad;
      const r = validateTarget("prod", raw);
      expect("errors" in r && r.errors.join("\n")).toContain("watchHours");
    }
    raw.watchHours = 10;
    expect("errors" in validateTarget("prod", raw)).toBe(false);
    raw.watchHours = 12;
    expect("errors" in validateTarget("prod", raw)).toBe(false);
  });
  test("red: production never defers sessions, even with a long watch", () => {
    const raw = JSON.parse(readFileSync(join(targetsDir, "prod.json"), "utf8"));
    raw.watchHours = 24;
    raw.watchSessions = "deferred";
    const r = validateTarget("prod", raw);
    expect("errors" in r && r.errors.join("\n")).toContain("watchSessions");
    raw.watchSessions = "skip";
    expect("errors" in validateTarget("prod", raw)).toBe(true);
  });
  test("stage: any positive watch with sessions deferred; a graded stage watch keeps the 10 h floor", () => {
    const raw = JSON.parse(readFileSync(join(targetsDir, "stage.json"), "utf8"));
    for (const ok of [0.25, 1, 10]) {
      raw.watchHours = ok;
      expect("errors" in validateTarget("stage", raw)).toBe(false);
    }
    for (const bad of [0, -0.25, Number.NaN, "0.25"]) {
      raw.watchHours = bad;
      const r = validateTarget("stage", raw);
      expect("errors" in r && r.errors.join("\n")).toContain("watchHours");
    }
    // red control: a short watch that grades sessions would fail check 7 on every first epoch.
    raw.watchHours = 0.25;
    raw.watchSessions = "graded";
    const r = validateTarget("stage", raw);
    expect("errors" in r && r.errors.join("\n")).toContain("watchHours");
    delete raw.watchSessions;
    expect("errors" in validateTarget("stage", raw)).toBe(true);
  });
});
