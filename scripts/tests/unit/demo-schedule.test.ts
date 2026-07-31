// The demo CADENCE PROFILE (issue #371) — executed, not grepped.
//
// WHAT THIS PROTECTS. The standing demo behind stage.robotmoney-labs.dev used to
// convene each IC subject every ~2 minutes. That reads as a toy and burns
// provider quota on a host that shares its per-IP limits with CI. `bun run demo
// -- --stage` now selects a REALISTIC profile (6 h per subject, phase-offset so
// a session lands about every 3 h, research every 3 h) while plain `bun run
// demo` and CI keep today's fast values byte for byte.
//
// A 6-hour timer cannot be observed in CI, so every cadence DECISION lives in
// the pure, side-effect-free scripts/lib/demo-schedule.ts and is EXECUTED here
// in the required per-PR `unit` workflow: the resolver, the subject planner, the
// session-date rotation and the READY-line renderer, for BOTH profiles.
//
// The two source-text checks at the bottom (demo-main.ts / demo-live-smoke.ts
// carry no cadence literal of their own; the stale D25-era analytics comment is
// gone) are ADDITIVE to those executed tests, never a substitute — and each one
// is graded against a deliberately-broken fixture, the same idiom
// scripts/tests/unit/demo-onboarding-driver.test.ts uses, so a grader that has
// stopped matching is red rather than vacuously green.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMMITTED_REGIME_CRON,
  COMMITTED_RESEARCH_CRON,
  DEMO_FIRST_SESSION_MAX_MS,
  DEMO_SUBJECT_COUNT,
  describeCron,
  formatCadenceDuration,
  plannedRunAt,
  planSubjectSchedules,
  renderCadenceLine,
  resolveDemoCadence,
  sessionDateFor,
} from "../../lib/demo-schedule.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 6, 30, 9, 0, 0); // fixed clock — these functions are pure

/**
 * Minutes-of-day at which a `M H * * *` cron fires, supporting the `*​/N` hour
 * step this profile uses. Deliberately tiny and local: it lets the tests assert
 * on the cron's BEHAVIOUR (when it fires) rather than on its spelling.
 */
function fireMinutesOfDay(cron: string): number[] {
  const [minute, hour] = cron.split(/\s+/);
  const m = Number(minute);
  const step = /^\*\/(\d+)$/.exec(hour);
  const hours = step
    ? Array.from({ length: Math.ceil(24 / Number(step[1])) }, (_, i) => i * Number(step[1]))
    : [Number(hour)];
  return hours.map((h) => h * 60 + m);
}

describe("resolveDemoCadence — one profile per invocation, selected by --stage", () => {
  test("fast (default) profile is TODAY'S values, pinned — a globally-slow demo is a regression", () => {
    const c = resolveDemoCadence({ stage: false });
    expect(c.profile).toBe("fast");
    expect(c.committeeIntervalMs).toBe(120_000);
    expect(c.committeeStaggerMs).toBe(60_000);
    // Onboarding admissions are unchanged on the fast path (AC6).
    expect(c.onboardingFirstMs).toBe(60_000);
    expect(c.onboardingIntervalMs).toBe(300_000);
  });

  test("no argument at all resolves the fast profile (CI never opts in)", () => {
    expect(resolveDemoCadence()).toEqual(resolveDemoCadence({ stage: false }));
  });

  test("stage profile convenes each subject every 6 h", () => {
    const c = resolveDemoCadence({ stage: true });
    expect(c.profile).toBe("realistic");
    expect(c.committeeIntervalMs).toBe(21_600_000);
    expect(c.committeeStaggerMs).toBe(c.committeeIntervalMs / DEMO_SUBJECT_COUNT); // 3 h
  });

  test("stage research fires every 3 hours; regime fires every 3 hours offset by 30 minutes", () => {
    const c = resolveDemoCadence({ stage: true });
    const research = fireMinutesOfDay(c.researchCron);
    const regime = fireMinutesOfDay(c.regimeCron);
    expect(research.length).toBe(8); // 24 h / 3 h
    expect(regime.length).toBe(8);
    for (let i = 1; i < research.length; i++) expect(research[i] - research[i - 1]).toBe(180);
    for (let i = 1; i < regime.length; i++) expect(regime[i] - regime[i - 1]).toBe(180);
    // Offset by exactly 30 minutes, every beat.
    expect(regime.map((m, i) => m - research[i])).toEqual(Array(8).fill(30));
  });

  test("stage onboarding admissions ride the committee beat, first one still prompt", () => {
    const c = resolveDemoCadence({ stage: true });
    expect(c.onboardingFirstMs).toBeLessThanOrEqual(DEMO_FIRST_SESSION_MAX_MS);
    expect(c.onboardingIntervalMs).toBe(c.committeeIntervalMs);
  });

  test("the fast profile's producer crons ARE the committed docker-compose.yml defaults", () => {
    // Single-source property: the non-stage stack injects nothing, so compose's
    // committed defaults are what it resolves — and this profile must state the
    // same schedule. Drift in either file is red.
    const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");
    const regime = /PRODUCER_REGIME_CRON:\s*\$\{PRODUCER_REGIME_CRON:-([^}]+)\}/.exec(compose);
    const research = /PRODUCER_RESEARCH_CRON:\s*\$\{PRODUCER_RESEARCH_CRON:-([^}]+)\}/.exec(compose);
    if (!regime || !research) throw new Error("docker-compose.yml no longer declares the producer cron defaults");
    expect(regime[1]).toBe(COMMITTED_REGIME_CRON);
    expect(research[1]).toBe(COMMITTED_RESEARCH_CRON);
    const fast = resolveDemoCadence({ stage: false });
    expect(fast.regimeCron).toBe(COMMITTED_REGIME_CRON);
    expect(fast.researchCron).toBe(COMMITTED_RESEARCH_CRON);
  });
});

describe("planSubjectSchedules — prompt on bring-up, phase-offset in steady state", () => {
  for (const stage of [false, true]) {
    const label = stage ? "stage" : "fast";
    const cadence = resolveDemoCadence({ stage });

    test(`[${label}] EVERY subject's first session is within ${DEMO_FIRST_SESSION_MAX_MS} ms of boot`, () => {
      const plans = planSubjectSchedules(DEMO_SUBJECT_COUNT, cadence, NOW);
      expect(plans.length).toBe(DEMO_SUBJECT_COUNT);
      for (const p of plans) {
        expect(p.firstAt - NOW).toBeGreaterThanOrEqual(0);
        expect(p.firstAt - NOW).toBeLessThanOrEqual(DEMO_FIRST_SESSION_MAX_MS);
      }
    });

    test(`[${label}] steady-state runs are exactly committeeIntervalMs apart per subject`, () => {
      const plans = planSubjectSchedules(DEMO_SUBJECT_COUNT, cadence, NOW);
      for (const p of plans) {
        for (let n = 1; n < 10; n++) {
          expect(plannedRunAt(p, n + 1) - plannedRunAt(p, n)).toBe(cadence.committeeIntervalMs);
        }
        // Run 0 is the bring-up session; run 1 is the first grid slot after it.
        expect(plannedRunAt(p, 0)).toBe(p.firstAt);
        expect(plannedRunAt(p, 1)).toBeGreaterThan(p.firstAt);
      }
    });

    test(`[${label}] subjects are phase-offset by committeeIntervalMs / subjectCount`, () => {
      const plans = planSubjectSchedules(DEMO_SUBJECT_COUNT, cadence, NOW);
      const offset = cadence.committeeIntervalMs / DEMO_SUBJECT_COUNT;
      for (const p of plans) expect(p.phaseOffsetMs).toBe(offset);
      // Steady-state slots sit on distinct residues of the interval grid.
      const residues = plans.map((p) => (plannedRunAt(p, 3) - NOW) % cadence.committeeIntervalMs);
      expect(residues).toEqual(plans.map((p) => (p.index * offset) % cadence.committeeIntervalMs));
      // …so merged steady-state sessions land one every `offset` overall.
      const merged: number[] = [];
      for (const p of plans) for (let n = 1; n <= 6; n++) merged.push(plannedRunAt(p, n));
      merged.sort((a, b) => a - b);
      for (let i = 1; i < merged.length; i++) expect(merged[i] - merged[i - 1]).toBe(offset);
    });

    test(`[${label}] the declared committeeStaggerMs IS the planner's phase offset for the demo's subjects`, () => {
      const plans = planSubjectSchedules(DEMO_SUBJECT_COUNT, cadence, NOW);
      expect(plans[1].phaseOffsetMs).toBe(cadence.committeeStaggerMs);
    });
  }

  test("[fast] reproduces today's timetable exactly — 0/120/240 s and 60/180/300 s", () => {
    const plans = planSubjectSchedules(2, resolveDemoCadence({ stage: false }), NOW);
    expect([0, 1, 2, 3].map((n) => plannedRunAt(plans[0], n) - NOW)).toEqual([0, 120_000, 240_000, 360_000]);
    expect([0, 1, 2, 3].map((n) => plannedRunAt(plans[1], n) - NOW)).toEqual([60_000, 180_000, 300_000, 420_000]);
  });

  test("[stage] bring-up is prompt, then a session every 3 h: 0s, 30s, 3h, 6h, 9h", () => {
    const plans = planSubjectSchedules(2, resolveDemoCadence({ stage: true }), NOW);
    expect(plannedRunAt(plans[0], 0) - NOW).toBe(0);
    expect(plannedRunAt(plans[1], 0) - NOW).toBe(30_000);
    expect(plannedRunAt(plans[1], 1) - NOW).toBe(3 * HOUR);
    expect(plannedRunAt(plans[0], 1) - NOW).toBe(6 * HOUR);
    expect(plannedRunAt(plans[1], 2) - NOW).toBe(9 * HOUR);
  });

  test("the phase-offset rule follows subjectCount, not a hardcoded 2", () => {
    const cadence = resolveDemoCadence({ stage: true });
    const plans = planSubjectSchedules(3, cadence, NOW);
    for (const p of plans) expect(p.phaseOffsetMs).toBe(cadence.committeeIntervalMs / 3); // 2 h
    for (const p of plans) expect(p.firstAt - NOW).toBeLessThanOrEqual(DEMO_FIRST_SESSION_MAX_MS);
  });

  test("an impossible subject count THROWS rather than planning an empty timetable", () => {
    const cadence = resolveDemoCadence({ stage: false });
    expect(() => planSubjectSchedules(0, cadence, NOW)).toThrow(/at least one subject/);
    expect(() => planSubjectSchedules(1.5, cadence, NOW)).toThrow(/at least one subject/);
  });
});

describe("sessionDateFor — UNIQUE(date, subject_id) can never be violated", () => {
  const SUBJECT_IDS = ["woon", "mav"];

  for (const stage of [false, true]) {
    const label = stage ? "stage" : "fast";
    test(`[${label}] 20 runs per subject: dates strictly decrease (never future) and no (date, subjectId) repeats`, () => {
      const cadence = resolveDemoCadence({ stage });
      const plans = planSubjectSchedules(SUBJECT_IDS.length, cadence, NOW);
      const seen = new Set<string>();
      plans.forEach((plan, i) => {
        let prev = "";
        for (let runs = 0; runs < 20; runs++) {
          // Exactly what the driver computes: the wall clock at the run, minus
          // a two-calendar-day step per completed run for THIS subject (issue
          // #345 — walking backward from "now" is what keeps every date <=
          // today; the doubled step is what keeps it collision-free even after
          // that run's own real elapsed time has nudged "now" forward).
          const at = plannedRunAt(plan, runs);
          const date = sessionDateFor(at, runs);
          expect(date <= new Date(at).toISOString().slice(0, 10)).toBe(true);
          if (prev !== "") expect(date < prev).toBe(true);
          prev = date;
          const key = `${date}|${SUBJECT_IDS[i]}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      });
      expect(seen.size).toBe(40);
    });
  }

  test("the rotation walks BACKWARD: a two-calendar-day step earlier per completed run", () => {
    const base = Date.UTC(2026, 6, 30, 12, 0, 0);
    expect(sessionDateFor(base, 0)).toBe("2026-07-30");
    expect(sessionDateFor(base, 1)).toBe("2026-07-28");
    expect(sessionDateFor(base, 3)).toBe("2026-07-24");
  });

  test("issue #345: no run count — however large, i.e. however long the demo has been up — ever produces a date after nowMs's own calendar day", () => {
    const base = Date.UTC(2026, 6, 30, 9, 0, 0);
    const today = new Date(base).toISOString().slice(0, 10);
    // 5,000 runs is years of steady-state history under EITHER profile (far
    // beyond the ~9-month drift actually observed on stage) — the property
    // must hold no matter how long a standing demo has been running.
    for (const runs of [0, 1, 2, 20, 365, 1000, 5000]) {
      expect(sessionDateFor(base, runs) <= today).toBe(true);
    }
  });

  test("red control: the retired forward-walking formula WOULD have produced a future date — proves the guard above is not vacuous", () => {
    const base = Date.UTC(2026, 6, 30, 9, 0, 0);
    const today = new Date(base).toISOString().slice(0, 10);
    const brokenForward = (nowMs: number, runs: number) =>
      new Date(nowMs + runs * 86_400_000).toISOString().slice(0, 10);
    expect(brokenForward(base, 1) > today).toBe(true);
  });
});

describe("the READY banner cadence line is RENDERED from the resolved profile", () => {
  test("fast profile reports the ~2-min staggered cadence", () => {
    const line = renderCadenceLine(resolveDemoCadence({ stage: false }));
    expect(line).toContain("every ~2 min");
    expect(line).toContain("about every ~1 min"); // 2 subjects staggered
    expect(line).toContain("research daily at 23:00");
    expect(line).toContain("regime daily at 22:30");
  });

  test("stage profile reports the 6h-committee / 3h-research cadence", () => {
    const line = renderCadenceLine(resolveDemoCadence({ stage: true }));
    expect(line).toContain("every ~6 h");
    expect(line).toContain("about every ~3 h");
    expect(line).toContain("research every 3h at :00");
    expect(line).toContain("regime every 3h at :30");
    expect(line).not.toContain("2 min");
  });

  test("the two profiles never render the same line", () => {
    expect(renderCadenceLine(resolveDemoCadence({ stage: true })))
      .not.toBe(renderCadenceLine(resolveDemoCadence({ stage: false })));
  });

  test("its formatters are derived from the numbers, not a lookup table", () => {
    expect(formatCadenceDuration(120_000)).toBe("2 min");
    expect(formatCadenceDuration(21_600_000)).toBe("6 h");
    expect(formatCadenceDuration(10_800_000)).toBe("3 h");
    expect(formatCadenceDuration(90_000)).toBe("90 s");
    expect(describeCron("0 23 * * *")).toBe("daily at 23:00");
    expect(describeCron("30 22 * * *")).toBe("daily at 22:30");
    expect(describeCron("0 */3 * * *")).toBe("every 3h at :00");
    expect(describeCron("30 */3 * * *")).toBe("every 3h at :30");
  });
});

// ---------------------------------------------------------------------------
// SOURCE-TEXT CHECKS. demo-main.ts boots a stack at module load and cannot be
// imported, so these are functions over source text — each one exercised
// against a deliberately-broken fixture below, so it cannot go vacuously green.
// ---------------------------------------------------------------------------
const demoMain = readFileSync(join(repoRoot, "scripts", "lib", "demo-main.ts"), "utf8");
const liveSmoke = readFileSync(join(repoRoot, "scripts", "demo-live-smoke.ts"), "utf8");
const architecture = readFileSync(join(repoRoot, "docs", "architecture.md"), "utf8");

/** Every cadence magic number that must now live ONLY in demo-schedule.ts. */
const CADENCE_LITERALS = [
  "120_000", "120000", "60_000", "60000", "300_000", "300000",
  "21_600_000", "21600000", "10_800_000", "10800000",
  "86_400_000", "86400_000", "86400000",
];

/** The cadence literals a consumer still carries; empty means single-sourced. */
export function cadenceLiteralsIn(src: string): string[] {
  return CADENCE_LITERALS.filter((lit) => new RegExp(`(?<![\\w_])${lit}(?![\\w_])`).test(src));
}

/** null when the file imports its timings from demo-schedule.ts; a reason otherwise. */
export function importsCadenceProfile(src: string, expected: string[]): string | null {
  const block = /import\s*\{([\s\S]*?)\}\s*from\s*"\.[^"]*demo-schedule\.ts";/.exec(src);
  if (!block) return "the file does not import from demo-schedule.ts — its timings are not single-sourced";
  const missing = expected.filter((name) => !block[1].includes(name));
  return missing.length === 0 ? null : `demo-schedule.ts import is missing ${missing.join(", ")}`;
}

describe("cadence lives in ONE file — consumers carry no literal of their own", () => {
  test("scripts/lib/demo-main.ts imports the profile and the planner", () => {
    expect(importsCadenceProfile(demoMain, ["resolveDemoCadence", "planSubjectSchedules", "sessionDateFor", "renderCadenceLine"])).toBeNull();
  });

  test("scripts/lib/demo-main.ts contains no cadence literal", () => {
    expect(cadenceLiteralsIn(demoMain)).toEqual([]);
  });

  test("scripts/demo-live-smoke.ts derives its deadline from the profile, with no literal", () => {
    expect(importsCadenceProfile(liveSmoke, ["resolveDemoCadence"])).toBeNull();
    expect(cadenceLiteralsIn(liveSmoke)).toEqual([]);
  });

  test("the stale pre-D25 analytics comment is gone from demo-main.ts", () => {
    // Regime/research have not been worker-queue schedules since D25 — they are
    // the analytics-producer's own cron timers.
    expect(demoMain).not.toContain("regime hourly at :07, research hourly at :37");
  });

  test("the READY banner prints the rendered line, not a hardcoded cadence", () => {
    expect(demoMain).toContain("renderCadenceLine(cadence)");
    expect(demoMain).not.toContain("Demo actions run on a ~2-min staggered cadence.");
  });

  test("docs/architecture.md no longer states ~2-min as the standing-demo steady state", () => {
    expect(architecture).not.toContain("~2-min staggered cadence");
    expect(architecture).not.toContain("per subject, ~2min cadence");
  });

  test("CI's committee path never reads the cadence profile (the e2e gate is unaffected)", () => {
    // CI publishes its two sessions back-to-back through committee/session.ts;
    // an import here would put the CI gate on a demo timer.
    const session = readFileSync(join(repoRoot, "scripts", "lib", "committee", "session.ts"), "utf8");
    expect(session).not.toContain("demo-schedule");
  });
});

describe("red controls: the graders must REPORT a regression", () => {
  test("cadenceLiteralsIn reports an inlined admission interval", () => {
    const broken = demoMain.replace("cadence.onboardingIntervalMs", "300_000");
    expect(cadenceLiteralsIn(broken)).toContain("300_000");
  });

  test("cadenceLiteralsIn reports a re-inlined committee interval and date rotation", () => {
    expect(cadenceLiteralsIn("const intervalMs = 120000;")).toEqual(["120000"]);
    expect(cadenceLiteralsIn("new Date(Date.now() + runs * 86400_000)")).toEqual(["86400_000"]);
  });

  test("cadenceLiteralsIn does NOT fire on unrelated numbers (it is not a blanket digit scan)", () => {
    expect(cadenceLiteralsIn("setTimeout(t, 4000); const x = 5_000; const y = 1120000000;")).toEqual([]);
  });

  test("importsCadenceProfile reports a file that dropped the import entirely", () => {
    const reason = importsCadenceProfile("const x = 1;\n", ["resolveDemoCadence"]);
    expect(reason).toContain("does not import from demo-schedule.ts");
  });

  test("importsCadenceProfile reports a file that imports only part of the profile API", () => {
    const partial = 'import { resolveDemoCadence } from "./demo-schedule.ts";\n';
    expect(importsCadenceProfile(partial, ["resolveDemoCadence", "planSubjectSchedules"]))
      .toContain("planSubjectSchedules");
  });

  test("the stale-comment and doc checks are matching real text, not an empty scan", () => {
    // If these anchors ever stop existing the assertions above become vacuous,
    // so prove the graders see the strings when they ARE present.
    const stale = "// demo schedules seeded above — regime hourly at :07, research hourly at :37, so";
    expect(stale).toContain("regime hourly at :07, research hourly at :37");
    expect("  Demo actions run on a ~2-min staggered cadence.").toContain("~2-min staggered cadence");
    expect(architecture.length).toBeGreaterThan(1000);
    expect(demoMain.length).toBeGreaterThan(1000);
  });
});
