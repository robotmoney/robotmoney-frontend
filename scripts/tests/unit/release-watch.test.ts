// scripts/tests/unit/release-watch.test.ts — how long the soak (S07-soak-gate, S08-soak-checks, V01-subject-spacing, S09-collect-logs) waits after READY.
//
// Stage run 20261008T042158Z failed S07-soak-gate check 7 at READY + 6 h: robotmoney-treasury
// and woon had no open window at boot, so the scheduler gave each a first epoch
// that lasts up to 1.5 epochs (system-scheduler-spec §2.2), and both were still
// `collecting`. The watch now derives from that bound (scripts/release/watch.ts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_STEPS, notBeforeOf, renderStep, stepListHash, templateValues } from "../../release/steps.ts";
import { loadTarget, validateTarget } from "../../release/target.ts";
import { loadReleaseRunbook } from "../../release/runbook.ts";

/** v0.6.2's own runbook: the template's steps plus its version checks (V01…). */
const V062 = loadReleaseRunbook("v0.6.2").steps;
import {
  DEFAULT_JUDGING_SECONDS, DEFAULT_WATCH_HOURS, PRODUCTION_EPOCH_SECONDS, PUBLISH_GRACE_SECONDS, SOAK_HOURS, watchHoursFor,
} from "../../release/watch.ts";

const targetsDir = join(import.meta.dir, "../../release/targets");
const HOUR = 3600;

describe("watchHoursFor: the slowest subject's first publish after READY", () => {
  test("production cadence: 1.5 × 24 h + 15 min judging + 30 min grace = 36.75 h, rounded up to 37 h", () => {
    expect(watchHoursFor({ epochSeconds: PRODUCTION_EPOCH_SECONDS, judgingSeconds: DEFAULT_JUDGING_SECONDS, graceSeconds: PUBLISH_GRACE_SECONDS })).toBe(37);
    expect(DEFAULT_WATCH_HOURS).toBe(37);
  });
  test("it rounds up, never down", () => {
    expect(watchHoursFor({ epochSeconds: 4 * HOUR, judgingSeconds: 0, graceSeconds: 0 })).toBe(6);
    expect(watchHoursFor({ epochSeconds: 4 * HOUR, judgingSeconds: 1, graceSeconds: 0 })).toBe(7);
  });
  test("red control: a one-epoch watch is shorter than a first epoch can last", () => {
    // The stage run's treasury and woon sessions opened at boot (04:34:22Z) and
    // were still collecting at READY (04:35:25Z) + 6 h.
    expect(watchHoursFor({ epochSeconds: PRODUCTION_EPOCH_SECONDS, judgingSeconds: 0, graceSeconds: 0 })).toBeGreaterThan(24);
  });
  test("red: a zero, negative or non-finite input throws", () => {
    expect(() => watchHoursFor({ epochSeconds: 0, judgingSeconds: 0, graceSeconds: 0 })).toThrow();
    expect(() => watchHoursFor({ epochSeconds: PRODUCTION_EPOCH_SECONDS, judgingSeconds: -1, graceSeconds: 0 })).toThrow();
    expect(() => watchHoursFor({ epochSeconds: Number.NaN, judgingSeconds: 0, graceSeconds: 0 })).toThrow();
  });
});

describe("the soak length is target data; the step list stays one list (owner, 2026-10-14)", () => {
  test("S07-soak-gate, S08-soak-checks and S09-collect-logs wait C11-ready + watchHours in the template, and nothing else waits; a release's version checks wait too", () => {
    expect(RELEASE_STEPS.filter((s) => s.notBefore).map((s) => [s.id, s.notBefore!.afterStep, s.notBefore!.hours]))
      .toEqual([["S07-soak-gate", "C11-ready", "watchHours"], ["S08-soak-checks", "C11-ready", "watchHours"], ["S09-collect-logs", "C11-ready", "watchHours"]]);
    const versionChecks = V062.filter((s) => s.phase === "version");
    expect(versionChecks.length).toBeGreaterThan(0);
    for (const s of versionChecks) expect([s.id, s.notBefore]).toEqual([s.id, { afterStep: "C11-ready", hours: "watchHours" }]);
  });
  test("prod and stage both soak 30 minutes with sessions deferred", () => {
    expect(SOAK_HOURS).toBe(0.5);
    for (const name of ["prod", "stage"]) {
      const t = loadTarget(join(targetsDir, `${name}.json`));
      expect(t.watchHours).toBe(SOAK_HOURS);
      expect(t.watchSessions).toBe("deferred");
      for (const id of ["S07-soak-gate", "S08-soak-checks", "V01-subject-spacing", "S09-collect-logs"]) {
        const step = V062.find((s) => s.id === id)!;
        expect(notBeforeOf(step, t)).toEqual({ afterStep: "C11-ready", hours: SOAK_HOURS });
        expect(renderStep(step, t, templateValues(t, "a".repeat(40), "20261008T000000Z")).notBefore).toEqual({ afterStep: "C11-ready", hours: SOAK_HOURS });
      }
    }
  });
  test("S07-soak-gate and V01-subject-spacing render --sessions from the target: deferred on both by default", () => {
    const rendered = (name: string, id: string) => {
      const t = loadTarget(join(targetsDir, `${name}.json`));
      return renderStep(V062.find((s) => s.id === id)!, t, templateValues(t, "a".repeat(40), "20261008T000000Z")).remote;
    };
    for (const id of ["S07-soak-gate", "V01-subject-spacing"]) for (const name of ["prod", "stage"]) expect(rendered(name, id)).toContain(" --sessions deferred ");
    expect(rendered("prod", "S07-soak-gate")).toContain("bun run prod:gate --mode post-release");
    expect(rendered("prod", "S07-soak-gate")).not.toContain("--defer-sessions");
    expect(rendered("prod", "S08-soak-checks")).toContain("bun run soak:checks --instance rm_prod --since READY-ISO-FROM-R6.9 --full");
    expect(rendered("prod", "S09-collect-logs")).toContain("bun scripts/release/collect-logs.ts --instance rm_prod --since READY-ISO-FROM-R6.9");
  });
  test("the step-list hash is the same for both targets: the templates carry {watchSessions}, never its value", () => {
    for (const s of RELEASE_STEPS) {
      const text = JSON.stringify(s.cmds);
      expect(text).not.toContain("graded");
      expect(text).not.toContain("\"deferred\"");
    }
    const before = stepListHash();
    for (const name of ["stage", "prod"]) {
      const t = loadTarget(join(targetsDir, `${name}.json`));
      for (const s of RELEASE_STEPS) renderStep(s, t, templateValues(t, "a".repeat(40), "20261008T000000Z"));
    }
    expect(stepListHash()).toBe(before);
    const forked = RELEASE_STEPS.map((s) => (s.id === "S07-soak-gate" ? { ...s, cmds: [s.cmds[0]!.map((a) => (a === "{watchSessions}" ? "deferred" : a))] } : s));
    expect(stepListHash(forked)).not.toBe(before);
  });
  test("a fixed-hours wait resolves to itself; a step without a wait resolves to none", () => {
    expect(notBeforeOf({ notBefore: { afterStep: "X", hours: 3 } }, { watchHours: 99 })).toEqual({ afterStep: "X", hours: 3 });
    expect(notBeforeOf({}, { watchHours: 10 })).toBeUndefined();
  });
  test("the step-list hash covers notBefore, but never a target's watchHours", () => {
    const fixed = RELEASE_STEPS.map((s) => (s.notBefore ? { ...s, notBefore: { afterStep: "C11-ready", hours: 6 } } : s));
    expect(stepListHash(fixed)).not.toBe(stepListHash());
    const raw = JSON.parse(readFileSync(join(targetsDir, "stage.json"), "utf8"));
    raw.watchHours = 12;
    const r = validateTarget("stage", raw);
    expect("target" in r && r.target.watchHours).toBe(12);
  });
  test("any positive soak with sessions deferred, on either target; a non-positive or non-number soak refuses", () => {
    for (const name of ["prod", "stage"]) {
      const raw = JSON.parse(readFileSync(join(targetsDir, `${name}.json`), "utf8"));
      raw.confirmTarget = "db.example.com:25060/rm";
      for (const ok of [0.25, 0.5, 2]) {
        raw.watchHours = ok;
        expect("errors" in validateTarget(name, raw)).toBe(false);
      }
      for (const bad of [0, -0.25, Number.NaN, "0.5"]) {
        raw.watchHours = bad;
        const r = validateTarget(name, raw);
        expect("errors" in r && r.errors.join("\n")).toContain("watchHours");
      }
    }
  });
  test("red: a soak that grades sessions must last the derived bound; an unknown sessions mode refuses", () => {
    const raw = JSON.parse(readFileSync(join(targetsDir, "prod.json"), "utf8"));
    raw.confirmTarget = "db.example.com:25060/rm";
    raw.watchSessions = "graded";
    raw.watchHours = 0.5;
    const r = validateTarget("prod", raw);
    expect("errors" in r && r.errors.join("\n")).toContain("watchHours");
    raw.watchHours = DEFAULT_WATCH_HOURS;
    expect("errors" in validateTarget("prod", raw)).toBe(false);
    raw.watchSessions = "skip";
    expect("errors" in validateTarget("prod", raw)).toBe(true);
  });
});
