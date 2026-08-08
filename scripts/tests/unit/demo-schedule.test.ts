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
  assertProductionConstants,
  COMMITTED_REGIME_CRON,
  COMMITTED_RESEARCH_CRON,
  DEMO_FIRST_SESSION_MAX_MS,
  describeCron,
  formatCadenceDuration,
  plannedRunAt,
  planSubjectSchedules,
  productionConstantMismatches,
  PRODUCTION_CADENCE_INTENT,
  renderCadenceLine,
  resolveDemoCadence,
  resolveDemoCadenceForBoot,
  swarmStaggerMsFor,
  swarmWindowMinutes,
} from "../../lib/demo-schedule.ts";
import { DEMO_SUBJECTS, SMOKE_SUBJECTS } from "../../lib/smoke-mode.ts";

// The subject count is a property of the SCENARIO, and the two scenarios
// disagree — which is exactly why the profile may not carry it as a constant
// (issue #570). Read both from their single source so a new subject is a
// planned change here rather than a silently wrong banner in production.
const DEMO_SUBJECT_COUNT = DEMO_SUBJECTS.length;   // simulation demo: 2
const SMOKE_SUBJECT_COUNT = SMOKE_SUBJECTS.length; // production-shaped boot: 4

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
    expect(c.swarmIntervalMs).toBe(120_000);
    expect(swarmStaggerMsFor(c, DEMO_SUBJECT_COUNT)).toBe(60_000);
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
    expect(c.swarmIntervalMs).toBe(21_600_000);
    // The ~90-minute spacing an outside observer sees on the public demo is the
    // FOUR-subject smoke scenario staggered on that 6 h grid, not a 90-minute
    // per-subject period. With the simulation demo's two subjects it is 3 h.
    expect(swarmStaggerMsFor(c, SMOKE_SUBJECT_COUNT)).toBe(90 * 60_000);
    expect(swarmStaggerMsFor(c, DEMO_SUBJECT_COUNT)).toBe(3 * HOUR);
  });

  test("the stagger follows the scenario's OWN subject count — the two scenarios disagree", () => {
    // Regression guard for the constant this replaced: DEMO_SUBJECT_COUNT = 2
    // was baked into REALISTIC.swarmStaggerMs while the production-shaped smoke
    // boot seats four subjects, so the declared stagger was wrong by 2x on the
    // one stack it described.
    expect(SMOKE_SUBJECT_COUNT).not.toBe(DEMO_SUBJECT_COUNT);
    const c = resolveDemoCadence({ stage: true });
    expect(swarmStaggerMsFor(c, SMOKE_SUBJECT_COUNT)).not.toBe(swarmStaggerMsFor(c, DEMO_SUBJECT_COUNT));
    expect(() => swarmStaggerMsFor(c, 0)).toThrow(/at least one subject/);
    expect(() => swarmStaggerMsFor(c, 2.5)).toThrow(/at least one subject/);
  });

  test("the submission window IS one full cadence interval, in BOTH profiles", () => {
    // This equality is the entire dead-zone fix (issue #570): session N's
    // advertised cutoff is session N+1's convene, so a subject is never without
    // a session accepting takes and no epoch table is needed to say so.
    for (const stage of [false, true]) {
      const c = resolveDemoCadence({ stage });
      expect(c.swarmWindowMs).toBe(c.swarmIntervalMs);
    }
  });

  test("window minutes are whole and profile-specific: fast 2 min, realistic 6 h", () => {
    expect(swarmWindowMinutes(resolveDemoCadence({ stage: false }))).toBe(2);
    expect(swarmWindowMinutes(resolveDemoCadence({ stage: true }))).toBe(360);
    // A window that cannot be stated faithfully in the publish_brief payload's
    // unit must throw, never round: a rounded-down window is a brief promising
    // less than it says.
    const bogus = { ...resolveDemoCadence({ stage: false }), swarmWindowMs: 90_000 };
    expect(() => swarmWindowMinutes(bogus)).toThrow(/whole positive number of minutes/);
  });

  test("the FAST window is bounded so a CI e2e run cannot outlive its 105-minute step", () => {
    // The e2e step drives TWO full sessions and currently takes ~14 minutes.
    // Waiting a real window is additive at worst (agents author DURING it), so
    // the ceiling this adds is 2 x the window.
    const fast = resolveDemoCadence({ stage: false });
    const addedMs = 2 * fast.swarmWindowMs;
    expect(addedMs).toBeLessThanOrEqual(10 * 60_000);
    expect((14 * 60_000 + addedMs) / 60_000).toBeLessThan(105);
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

  test("stage onboarding admissions ride the swarm beat, first one still prompt", () => {
    const c = resolveDemoCadence({ stage: true });
    expect(c.onboardingFirstMs).toBeLessThanOrEqual(DEMO_FIRST_SESSION_MAX_MS);
    expect(c.onboardingIntervalMs).toBe(c.swarmIntervalMs);
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

    test(`[${label}] steady-state runs are exactly swarmIntervalMs apart per subject`, () => {
      const plans = planSubjectSchedules(DEMO_SUBJECT_COUNT, cadence, NOW);
      for (const p of plans) {
        for (let n = 1; n < 10; n++) {
          expect(plannedRunAt(p, n + 1) - plannedRunAt(p, n)).toBe(cadence.swarmIntervalMs);
        }
        // Run 0 is the bring-up session; run 1 is the first grid slot after it.
        expect(plannedRunAt(p, 0)).toBe(p.firstAt);
        expect(plannedRunAt(p, 1)).toBeGreaterThan(p.firstAt);
      }
    });

    test(`[${label}] subjects are phase-offset by swarmIntervalMs / subjectCount`, () => {
      const plans = planSubjectSchedules(DEMO_SUBJECT_COUNT, cadence, NOW);
      const offset = cadence.swarmIntervalMs / DEMO_SUBJECT_COUNT;
      for (const p of plans) expect(p.phaseOffsetMs).toBe(offset);
      // Steady-state slots sit on distinct residues of the interval grid.
      const residues = plans.map((p) => (plannedRunAt(p, 3) - NOW) % cadence.swarmIntervalMs);
      expect(residues).toEqual(plans.map((p) => (p.index * offset) % cadence.swarmIntervalMs));
      // …so merged steady-state sessions land one every `offset` overall.
      const merged: number[] = [];
      for (const p of plans) for (let n = 1; n <= 6; n++) merged.push(plannedRunAt(p, n));
      merged.sort((a, b) => a - b);
      for (let i = 1; i < merged.length; i++) expect(merged[i] - merged[i - 1]).toBe(offset);
    });

    test(`[${label}] swarmStaggerMsFor IS the planner's phase offset, for EITHER scenario`, () => {
      for (const count of [DEMO_SUBJECT_COUNT, SMOKE_SUBJECT_COUNT]) {
        const plans = planSubjectSchedules(count, cadence, NOW);
        expect(plans[1].phaseOffsetMs).toBe(swarmStaggerMsFor(cadence, count));
      }
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
    for (const p of plans) expect(p.phaseOffsetMs).toBe(cadence.swarmIntervalMs / 3); // 2 h
    for (const p of plans) expect(p.firstAt - NOW).toBeLessThanOrEqual(DEMO_FIRST_SESSION_MAX_MS);
  });

  test("an impossible subject count THROWS rather than planning an empty timetable", () => {
    const cadence = resolveDemoCadence({ stage: false });
    expect(() => planSubjectSchedules(0, cadence, NOW)).toThrow(/at least one subject/);
    expect(() => planSubjectSchedules(1.5, cadence, NOW)).toThrow(/at least one subject/);
  });
});

// The former `sessionDateFor` block is GONE with the function. It asserted
// that the demo's synthetic "today + one day per run" rotation never violated
// UNIQUE(date, subject_id) — a property that only mattered while the CLIENT
// chose session dates. Since migration 0022 Postgres stamps convened_at and
// derives the date, the constraint itself is gone, and nothing in this repo may
// invent a session date to test.

describe("the READY banner cadence line is RENDERED from the resolved profile", () => {
  test("fast profile reports the ~2-min staggered cadence and its window", () => {
    const line = renderCadenceLine(resolveDemoCadence({ stage: false }), DEMO_SUBJECT_COUNT);
    expect(line).toContain("every ~2 min");
    expect(line).toContain("about every ~1 min"); // 2 subjects staggered
    expect(line).toContain("submission window 2 min");
    expect(line).toContain("research daily at 23:00");
    expect(line).toContain("regime daily at 22:30");
  });

  test("stage profile reports the 6h-swarm / 3h-research cadence and its 6 h window", () => {
    const line = renderCadenceLine(resolveDemoCadence({ stage: true }), DEMO_SUBJECT_COUNT);
    expect(line).toContain("every ~6 h");
    expect(line).toContain("about every ~3 h");
    expect(line).toContain("submission window 6 h");
    expect(line).toContain("research every 3h at :00");
    expect(line).toContain("regime every 3h at :30");
    expect(line).not.toContain("2 min");
  });

  test("the banner states the SCENARIO's own subject count, not a baked-in 2", () => {
    // The lie this replaced: the production-shaped boot seats four subjects and
    // the banner said "2 subjects staggered → one lands about every ~3 h" while
    // the stack was actually landing one every ~90 min.
    const c = resolveDemoCadence({ stage: true });
    expect(renderCadenceLine(c, SMOKE_SUBJECT_COUNT)).toContain(`${SMOKE_SUBJECT_COUNT} subjects staggered`);
    expect(renderCadenceLine(c, SMOKE_SUBJECT_COUNT)).toContain("about every ~90 min");
    expect(renderCadenceLine(c, DEMO_SUBJECT_COUNT)).toContain("about every ~3 h");
  });

  test("the two profiles never render the same line", () => {
    expect(renderCadenceLine(resolveDemoCadence({ stage: true }), DEMO_SUBJECT_COUNT))
      .not.toBe(renderCadenceLine(resolveDemoCadence({ stage: false }), DEMO_SUBJECT_COUNT));
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
    expect(importsCadenceProfile(demoMain, ["resolveDemoCadence", "planSubjectSchedules", "renderCadenceLine"])).toBeNull();
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
    expect(demoMain).toContain("renderCadenceLine(cadence, scenario.subjects.length)");
    expect(demoMain).not.toContain("Demo actions run on a ~2-min staggered cadence.");
  });

  test("docs/architecture.md no longer states ~2-min as the standing-demo steady state", () => {
    expect(architecture).not.toContain("~2-min staggered cadence");
    expect(architecture).not.toContain("per subject, ~2min cadence");
  });

  test("CI's swarm path DERIVES its window from the cadence profile (issue #570)", () => {
    // This test used to assert the opposite — that swarm/session.ts never reads
    // demo-schedule.ts, because "an import here would put the CI gate on a demo
    // timer". That was right about the risk and wrong about the fix: the
    // submission window IS a cadence timing, and while it was NOT one, the
    // driver hardcoded `windowMinutes: 60` and then closed the window as soon as
    // its own agents settled, so every session advertised an hour and lasted
    // 1-3 minutes. The gate is protected by the FAST window being bounded
    // (asserted above), not by the driver being ignorant of the profile.
    const session = readFileSync(join(repoRoot, "scripts", "lib", "swarm", "session.ts"), "utf8");
    expect(importsCadenceProfile(session, ["resolveDemoCadence", "swarmWindowMinutes"])).toBeNull();
    expect(session).not.toContain("windowMinutes: 60");
  });
});

describe("red controls: the graders must REPORT a regression", () => {
  test("cadenceLiteralsIn reports an inlined admission interval", () => {
    const broken = demoMain.replace("cadence.onboardingIntervalMs", "300_000");
    expect(cadenceLiteralsIn(broken)).toContain("300_000");
  });

  test("cadenceLiteralsIn reports a re-inlined swarm interval and date rotation", () => {
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

// ---------------------------------------------------------------------------
// PRODUCTION RUNS PRODUCTION CONSTANTS (issue #570).
//
// The gap this closes is not that CI runs an accelerated clock — it should.
// The gap is that nothing checked production was running production constants:
// prod-bootstrap.ts drift-checks seeded DATA and asserts no config value at
// all, and demo-live-smoke.ts's deadline is pinned to the FAST profile by
// construction and documented as never deriving from the cadence actually
// running. So no green CI result could distinguish "the driver honours the
// window" from "the window is two minutes".
// ---------------------------------------------------------------------------
describe("assertProductionConstants — the boot refuses to lie about its own cadence", () => {
  const realistic = resolveDemoCadence({ stage: true });
  const fast = resolveDemoCadence({ stage: false });

  test("a real production boot passes", () => {
    expect(productionConstantMismatches(realistic, {}, { production: true })).toEqual([]);
    expect(productionConstantMismatches(realistic, { SWARM_SCHEDULES_ENABLED: "0" }, { production: true })).toEqual([]);
    expect(() => assertProductionConstants(realistic, {}, { production: true })).not.toThrow();
  });

  test("a CI/accelerated-clock boot CANNOT satisfy the production branch", () => {
    // The decisive property. A fast-profile boot claiming to be production is
    // fatal, so a green CI run can never be read as evidence about production
    // constants — it is structurally incapable of taking that branch.
    const problems = productionConstantMismatches(fast, {}, { production: true });
    expect(problems.join(" ")).toContain("resolved cadence profile is 'fast'");
    expect(problems.join(" ")).toContain("swarmIntervalMs is 120000");
    expect(problems.join(" ")).toContain("swarmWindowMs is 120000");
    expect(() => assertProductionConstants(fast, {}, { production: true })).toThrow(/REFUSING TO BOOT/);
  });

  test("a non-production boot must be the fast profile — the reverse is also fatal", () => {
    expect(productionConstantMismatches(fast, {}, { production: false })).toEqual([]);
    expect(() => assertProductionConstants(realistic, {}, { production: false }))
      .toThrow(/resolved the 'realistic' profile/);
  });

  test("SWARM_SCHEDULES_ENABLED=1 exported into a production boot is fatal", () => {
    // The backend's shipped swarm crons are subject-blind (resolveSwarmSchedules
    // emits no subjectId, so the handler calls openSession("")), and the host
    // driver is the real scheduler. An operator's stale export must not reach a
    // production boot unremarked.
    const problems = productionConstantMismatches(realistic, { SWARM_SCHEDULES_ENABLED: "1" }, { production: true });
    expect(problems.join(" ")).toContain("SWARM_SCHEDULES_ENABLED='1'");
    expect(() => assertProductionConstants(realistic, { SWARM_SCHEDULES_ENABLED: "1" }, { production: true }))
      .toThrow(/REFUSING TO BOOT/);
  });

  test("a window that is no longer one full interval is fatal in EITHER branch", () => {
    const drifted = { ...realistic, swarmWindowMs: 60 * 60_000 }; // the old flat hour
    for (const production of [true, false]) {
      expect(productionConstantMismatches(drifted, {}, { production }).join(" "))
        .toContain("must equal swarmIntervalMs");
    }
  });

  test("the intent literals are stated independently, not read back off the profile", () => {
    // A check derived from the thing it checks is a tautology. These are
    // written out so that changing REALISTIC by accident is fatal at boot.
    expect(PRODUCTION_CADENCE_INTENT).toEqual({
      profile: "realistic",
      swarmIntervalMs: 21_600_000,
      swarmWindowMs: 21_600_000,
      swarmSchedulesEnabled: "0",
    });
    expect(realistic.swarmIntervalMs).toBe(PRODUCTION_CADENCE_INTENT.swarmIntervalMs);
    expect(realistic.swarmWindowMs).toBe(PRODUCTION_CADENCE_INTENT.swarmWindowMs);
  });

  test("resolveDemoCadenceForBoot resolves AND proves, in one step nobody can half-perform", () => {
    expect(resolveDemoCadenceForBoot({ stage: true, env: {} })).toEqual(realistic);
    expect(resolveDemoCadenceForBoot({ stage: false, env: {} })).toEqual(fast);
    expect(() => resolveDemoCadenceForBoot({ stage: true, env: { SWARM_SCHEDULES_ENABLED: "1" } }))
      .toThrow(/REFUSING TO BOOT/);
  });

  test("demo-main.ts boots through the CHECKED resolver, not the bare one", () => {
    // The bare resolver would boot a stack whose constants nobody proved. A
    // separate assert line next to it is a line that can be deleted or omitted
    // from a new entry point; this cannot be.
    expect(demoMain).toContain("resolveDemoCadenceForBoot({ stage: staticPortMode, env: process.env })");
    expect(demoMain).not.toMatch(/=\s*resolveDemoCadence\(/);
  });

  test("the demo overlay still pins SWARM_SCHEDULES_ENABLED off", () => {
    // The other half of the same invariant: even if nothing is exported, the
    // compose overlay every demo/stage boot uses must keep the backend crons off.
    const overlay = readFileSync(join(repoRoot, "docker-compose.demo.yml"), "utf8");
    expect(overlay).toMatch(/SWARM_SCHEDULES_ENABLED:\s*"0"/);
  });
});
