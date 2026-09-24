// The smoke CADENCE PROFILE (issue #371) — executed, not grepped.
//
// WHAT THIS PROTECTS. The standing smoke behind stage.robotmoney-labs.dev used to
// convene each IC subject every ~2 minutes. That reads as a toy and burns
// provider quota on a host that shares its per-IP limits with CI. `bun run smoke
// -- --stage` now selects a REALISTIC profile (6 h per subject, phase-offset so
// a session lands about every 3 h, research every 3 h) while plain `bun run
// smoke` and CI keep today's fast values byte for byte.
//
// A 6-hour timer cannot be observed in CI, so every cadence DECISION lives in
// the pure, side-effect-free scripts/lib/smoke-cadence.ts and is EXECUTED here
// in the required per-PR `unit` workflow: the resolver, the subject planner, the
// session-date rotation and the READY-line renderer, for BOTH profiles.
//
// The two source-text checks at the bottom (smoke-main.ts / smoke-live-smoke.ts
// carry no cadence literal of their own; the stale D25-era analytics comment is
// gone) are ADDITIVE to those executed tests, never a substitute — and each one
// is graded against a deliberately-broken fixture, the same idiom
// scripts/tests/unit/smoke-onboarding-driver.test.ts uses, so a grader that has
// stopped matching is red rather than vacuously green.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
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
  resolveSmokeCadence,
  resolveSmokeCadenceForBoot,
  stageCadenceApplies,
  subjectStaggerMsFor,
} from "../../lib/smoke-cadence.ts";
import { DEMO_SUBJECTS, SMOKE_SUBJECTS } from "../../lib/smoke-mode.ts";

// The subject count is a property of the SCENARIO, and the two scenarios
// disagree — which is exactly why the profile may not carry it as a constant
// (issue #570). Read both from their single source so a new subject is a
// planned change here rather than a silently wrong banner in production.
const DEMO_SUBJECT_COUNT = DEMO_SUBJECTS.length;   // simulation smoke: 2
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

describe("resolveSmokeCadence — one profile per invocation, selected by --stage", () => {
  test("an explicit --cadence override wins over the invocation shape (the fast twin)", () => {
    // The smoke-twin pins the port (→ realistic) but passes --cadence fast, so
    // the override must win BOTH ways: pinned+fast = fast, unpinned+realistic = realistic.
    expect(resolveSmokeCadence({ stage: true, cadence: "fast" }).profile).toBe("fast");
    expect(resolveSmokeCadence({ stage: false, cadence: "realistic" }).profile).toBe("realistic");
  });

  test("fast (default) profile is TODAY'S values, pinned — a globally-slow smoke is a regression", () => {
    const c = resolveSmokeCadence({ stage: false });
    expect(c.profile).toBe("fast");
    expect(c.swarmIntervalMs).toBe(120_000);
    expect(subjectStaggerMsFor(c, DEMO_SUBJECT_COUNT)).toBe(60_000);
    // Onboarding admissions are unchanged on the fast path (AC6).
    expect(c.onboardingFirstMs).toBe(60_000);
    expect(c.onboardingIntervalMs).toBe(300_000);
  });

  test("no argument at all resolves the fast profile (CI never opts in)", () => {
    expect(resolveSmokeCadence()).toEqual(resolveSmokeCadence({ stage: false }));
  });

  test("stage profile convenes each subject every 6 h", () => {
    const c = resolveSmokeCadence({ stage: true });
    expect(c.profile).toBe("realistic");
    expect(c.swarmIntervalMs).toBe(21_600_000);
    // The ~90-minute spacing an outside observer sees on the public smoke is the
    // FOUR-subject smoke scenario staggered on that 6 h grid, not a 90-minute
    // per-subject period. With the simulation smoke's two subjects it is 3 h.
    expect(subjectStaggerMsFor(c, SMOKE_SUBJECT_COUNT)).toBe(90 * 60_000);
    expect(subjectStaggerMsFor(c, DEMO_SUBJECT_COUNT)).toBe(3 * HOUR);
  });

  test("the stagger follows the scenario's OWN subject count — the two scenarios disagree", () => {
    // Regression guard for the constant this replaced: DEMO_SUBJECT_COUNT = 2
    // was baked into REALISTIC.swarmStaggerMs while the production-shaped smoke
    // boot seats four subjects, so the declared stagger was wrong by 2x on the
    // one stack it described.
    expect(SMOKE_SUBJECT_COUNT).not.toBe(DEMO_SUBJECT_COUNT);
    const c = resolveSmokeCadence({ stage: true });
    expect(subjectStaggerMsFor(c, SMOKE_SUBJECT_COUNT)).not.toBe(subjectStaggerMsFor(c, DEMO_SUBJECT_COUNT));
    expect(() => subjectStaggerMsFor(c, 0)).toThrow(/at least one subject/);
    expect(() => subjectStaggerMsFor(c, 2.5)).toThrow(/at least one subject/);
  });

  test("the submission window IS one full cadence interval, in BOTH profiles", () => {
    // This equality is the entire dead-zone fix (issue #570): session N's
    // advertised cutoff is session N+1's convene, so a subject is never without
    // a session accepting takes and no epoch table is needed to say so.
    for (const stage of [false, true]) {
      const c = resolveSmokeCadence({ stage });
      expect(c.swarmWindowMs).toBe(c.swarmIntervalMs);
    }
  });

  test("the window is a whole number of minutes in BOTH profiles: fast 2 min, realistic 6 h", () => {
    // `swarmWindowMinutes()` is gone with the cron payload whose unit it spoke
    // (issue #1026 — there is no publish_brief job to advertise a window on).
    // The PROPERTY it protected is not: a window that is not a whole number of
    // minutes cannot be stated faithfully to a submitter in any surface, so it
    // is asserted here directly against both profiles rather than dropped with
    // the helper.
    expect(resolveSmokeCadence({ stage: false }).swarmWindowMs / 60_000).toBe(2);
    expect(resolveSmokeCadence({ stage: true }).swarmWindowMs / 60_000).toBe(360);
    for (const stage of [false, true]) {
      expect(Number.isInteger(resolveSmokeCadence({ stage }).swarmWindowMs / 60_000)).toBe(true);
    }
  });

  test("the FAST window is bounded so a CI e2e run cannot outlive its 105-minute step", () => {
    // The e2e step drives TWO full sessions and currently takes ~14 minutes.
    // Waiting a real window is additive at worst (agents author DURING it), so
    // the ceiling this adds is 2 x the window.
    const fast = resolveSmokeCadence({ stage: false });
    const addedMs = 2 * fast.swarmWindowMs;
    expect(addedMs).toBeLessThanOrEqual(10 * 60_000);
    expect((14 * 60_000 + addedMs) / 60_000).toBeLessThan(105);
  });

  test("stage research fires every 3 hours; regime fires every 3 hours offset by 30 minutes", () => {
    const c = resolveSmokeCadence({ stage: true });
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
    const c = resolveSmokeCadence({ stage: true });
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
    const fast = resolveSmokeCadence({ stage: false });
    expect(fast.regimeCron).toBe(COMMITTED_REGIME_CRON);
    expect(fast.researchCron).toBe(COMMITTED_RESEARCH_CRON);
  });
});

describe("planSubjectSchedules — prompt on bring-up, phase-offset in steady state", () => {
  for (const stage of [false, true]) {
    const label = stage ? "stage" : "fast";
    const cadence = resolveSmokeCadence({ stage });

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

    test(`[${label}] subjectStaggerMsFor IS the planner's phase offset, for EITHER scenario`, () => {
      for (const count of [DEMO_SUBJECT_COUNT, SMOKE_SUBJECT_COUNT]) {
        const plans = planSubjectSchedules(count, cadence, NOW);
        expect(plans[1].phaseOffsetMs).toBe(subjectStaggerMsFor(cadence, count));
      }
    });
  }

  test("[fast] reproduces today's timetable exactly — 0/120/240 s and 60/180/300 s", () => {
    const plans = planSubjectSchedules(2, resolveSmokeCadence({ stage: false }), NOW);
    expect([0, 1, 2, 3].map((n) => plannedRunAt(plans[0], n) - NOW)).toEqual([0, 120_000, 240_000, 360_000]);
    expect([0, 1, 2, 3].map((n) => plannedRunAt(plans[1], n) - NOW)).toEqual([60_000, 180_000, 300_000, 420_000]);
  });

  test("[stage] bring-up is prompt, then a session every 3 h: 0s, 30s, 3h, 6h, 9h", () => {
    const plans = planSubjectSchedules(2, resolveSmokeCadence({ stage: true }), NOW);
    expect(plannedRunAt(plans[0], 0) - NOW).toBe(0);
    expect(plannedRunAt(plans[1], 0) - NOW).toBe(30_000);
    expect(plannedRunAt(plans[1], 1) - NOW).toBe(3 * HOUR);
    expect(plannedRunAt(plans[0], 1) - NOW).toBe(6 * HOUR);
    expect(plannedRunAt(plans[1], 2) - NOW).toBe(9 * HOUR);
  });

  test("the phase-offset rule follows subjectCount, not a hardcoded 2", () => {
    const cadence = resolveSmokeCadence({ stage: true });
    const plans = planSubjectSchedules(3, cadence, NOW);
    for (const p of plans) expect(p.phaseOffsetMs).toBe(cadence.swarmIntervalMs / 3); // 2 h
    for (const p of plans) expect(p.firstAt - NOW).toBeLessThanOrEqual(DEMO_FIRST_SESSION_MAX_MS);
  });

  test("an impossible subject count THROWS rather than planning an empty timetable", () => {
    const cadence = resolveSmokeCadence({ stage: false });
    expect(() => planSubjectSchedules(0, cadence, NOW)).toThrow(/at least one subject/);
    expect(() => planSubjectSchedules(1.5, cadence, NOW)).toThrow(/at least one subject/);
  });
});

// The former `sessionDateFor` block is GONE with the function. It asserted
// that the smoke's synthetic "today + one day per run" rotation never violated
// UNIQUE(date, subject_id) — a property that only mattered while the CLIENT
// chose session dates. Since migration 0022 Postgres stamps convened_at and
// derives the date, the constraint itself is gone, and nothing in this repo may
// invent a session date to test.

describe("the READY banner cadence line is RENDERED from the resolved profile", () => {
  test("fast profile reports the ~2-min staggered cadence and its window", () => {
    const line = renderCadenceLine(resolveSmokeCadence({ stage: false }), DEMO_SUBJECT_COUNT);
    expect(line).toContain("every ~2 min");
    expect(line).toContain("about every ~1 min"); // 2 subjects staggered
    expect(line).toContain("submission window 2 min");
    expect(line).toContain("research daily at 23:00");
    expect(line).toContain("regime daily at 22:30");
  });

  test("stage profile reports the 6h-swarm / 3h-research cadence and its 6 h window", () => {
    const line = renderCadenceLine(resolveSmokeCadence({ stage: true }), DEMO_SUBJECT_COUNT);
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
    const c = resolveSmokeCadence({ stage: true });
    expect(renderCadenceLine(c, SMOKE_SUBJECT_COUNT)).toContain(`${SMOKE_SUBJECT_COUNT} subjects staggered`);
    expect(renderCadenceLine(c, SMOKE_SUBJECT_COUNT)).toContain("about every ~90 min");
    expect(renderCadenceLine(c, DEMO_SUBJECT_COUNT)).toContain("about every ~3 h");
  });

  test("the two profiles never render the same line", () => {
    expect(renderCadenceLine(resolveSmokeCadence({ stage: true }), DEMO_SUBJECT_COUNT))
      .not.toBe(renderCadenceLine(resolveSmokeCadence({ stage: false }), DEMO_SUBJECT_COUNT));
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
// SOURCE-TEXT CHECKS. smoke-main.ts boots a stack at module load and cannot be
// imported, so these are functions over source text — each one exercised
// against a deliberately-broken fixture below, so it cannot go vacuously green.
// ---------------------------------------------------------------------------
const smokeMain = readFileSync(join(repoRoot, "scripts", "lib", "smoke-main.ts"), "utf8");
const liveSmoke = readFileSync(join(repoRoot, "scripts", "smoke-live-smoke.ts"), "utf8");
const architecture = readdirSync(join(repoRoot, "docs", "architecture"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => readFileSync(join(repoRoot, "docs", "architecture", f), "utf8"))
  .join("\n");

/** Every cadence magic number that must now live ONLY in smoke-cadence.ts. */
const CADENCE_LITERALS = [
  "120_000", "120000", "60_000", "60000", "300_000", "300000",
  "21_600_000", "21600000", "10_800_000", "10800000",
  "86_400_000", "86400_000", "86400000",
];

/** The cadence literals a consumer still carries; empty means single-sourced. */
export function cadenceLiteralsIn(src: string): string[] {
  return CADENCE_LITERALS.filter((lit) => new RegExp(`(?<![\\w_])${lit}(?![\\w_])`).test(src));
}

/** null when the file imports its timings from smoke-cadence.ts; a reason otherwise. */
export function importsCadenceProfile(src: string, expected: string[]): string | null {
  const block = /import\s*\{([\s\S]*?)\}\s*from\s*"\.[^"]*smoke-cadence\.ts";/.exec(src);
  if (!block) return "the file does not import from smoke-cadence.ts — its timings are not single-sourced";
  const missing = expected.filter((name) => !block[1].includes(name));
  return missing.length === 0 ? null : `smoke-cadence.ts import is missing ${missing.join(", ")}`;
}

describe("cadence lives in ONE file — consumers carry no literal of their own", () => {
  test("scripts/lib/smoke-main.ts imports the profile and the planner", () => {
    expect(importsCadenceProfile(smokeMain, ["resolveSmokeCadence", "planSubjectSchedules", "renderCadenceLine"])).toBeNull();
  });

  test("scripts/lib/smoke-main.ts contains no cadence literal", () => {
    expect(cadenceLiteralsIn(smokeMain)).toEqual([]);
  });

  test("scripts/smoke-live-smoke.ts derives its deadline from the profile, with no literal", () => {
    expect(importsCadenceProfile(liveSmoke, ["resolveSmokeCadence"])).toBeNull();
    expect(cadenceLiteralsIn(liveSmoke)).toEqual([]);
  });

  test("the stale pre-D25 analytics comment is gone from smoke-main.ts", () => {
    // Regime/research have not been worker-queue schedules since D25 — they are
    // the analytics-producer's own cron timers.
    expect(smokeMain).not.toContain("regime hourly at :07, research hourly at :37");
  });

  test("the READY banner prints the rendered line, not a hardcoded cadence", () => {
    expect(smokeMain).toContain("renderCadenceLine(cadence, scenario.subjects.length)");
    expect(smokeMain).not.toContain("Demo actions run on a ~2-min staggered cadence.");
  });

  test("docs/architecture.md no longer states ~2-min as the standing-smoke steady state", () => {
    expect(architecture).not.toContain("~2-min staggered cadence");
    expect(architecture).not.toContain("per subject, ~2min cadence");
  });

  test("CI's swarm path DERIVES its window from the cadence profile (issue #570)", () => {
    // This test used to assert the opposite — that swarm/session.ts never reads
    // this module, because "an import here would put the CI gate on a smoke
    // timer". That was right about the risk and wrong about the fix: the
    // submission window IS a cadence timing, and while it was NOT one, the
    // driver hardcoded `windowMinutes: 60` and then closed the window as soon as
    // its own agents settled, so every session advertised an hour and lasted
    // 1-3 minutes. The gate is protected by the FAST window being bounded
    // (asserted above), not by the driver being ignorant of the profile.
    const session = readFileSync(join(repoRoot, "scripts", "lib", "swarm", "session.ts"), "utf8");
    expect(importsCadenceProfile(session, ["resolveSmokeCadence"])).toBeNull();
    expect(session).not.toContain("windowMinutes: 60");
  });
});

describe("red controls: the graders must REPORT a regression", () => {
  test("cadenceLiteralsIn reports an inlined admission interval", () => {
    const broken = smokeMain.replace("cadence.onboardingIntervalMs", "300_000");
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
    const reason = importsCadenceProfile("const x = 1;\n", ["resolveSmokeCadence"]);
    expect(reason).toContain("does not import from smoke-cadence.ts");
  });

  test("importsCadenceProfile reports a file that imports only part of the profile API", () => {
    const partial = 'import { resolveSmokeCadence } from "./smoke-cadence.ts";\n';
    expect(importsCadenceProfile(partial, ["resolveSmokeCadence", "planSubjectSchedules"]))
      .toContain("planSubjectSchedules");
  });

  test("the stale-comment and doc checks are matching real text, not an empty scan", () => {
    // If these anchors ever stop existing the assertions above become vacuous,
    // so prove the graders see the strings when they ARE present.
    const stale = "// smoke schedules seeded above — regime hourly at :07, research hourly at :37, so";
    expect(stale).toContain("regime hourly at :07, research hourly at :37");
    expect("  Demo actions run on a ~2-min staggered cadence.").toContain("~2-min staggered cadence");
    expect(architecture.length).toBeGreaterThan(1000);
    expect(smokeMain.length).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------
// PRODUCTION RUNS PRODUCTION CONSTANTS (issue #570).
//
// The gap this closes is not that CI runs an accelerated clock — it should.
// The gap is that nothing checked production was running production constants:
// prod-bootstrap.ts drift-checks seeded DATA and asserts no config value at
// all, and smoke-live-smoke.ts's deadline is pinned to the FAST profile by
// construction and documented as never deriving from the cadence actually
// running. So no green CI result could distinguish "the driver honours the
// window" from "the window is two minutes".
// ---------------------------------------------------------------------------
describe("assertProductionConstants — the boot refuses to lie about its own cadence", () => {
  const realistic = resolveSmokeCadence({ stage: true });
  const fast = resolveSmokeCadence({ stage: false });

  // WHAT THIS BLOCK STOPPED CHECKING, AND WHY THAT IS NOT A WEAKENING (issue
  // #1026). It used to assert a fourth intent alongside the three below: that
  // the api container's schedule master switch was exported as exactly "0",
  // because compose defaulted it ON and an unset variable silently selected a
  // third, unjudgeable cadence. That hazard has no referent any more. There is
  // no switch, no cron string and no schedule row to be defaulted into
  // (docs/technical/smoke-production-spec.md §6.3: "There is nothing to enable
  // … There are no schedule rows, no cron strings, no `next_run_at`, and no
  // enable command"), and the absence is asserted structurally, over the whole
  // shipping tree, by scripts/tests/unit/no-swarm-cron.test.ts. The three
  // remaining intents — profile, interval, window — are the ones this file was
  // ever able to check, and every case below still runs.

  test("a real production boot passes", () => {
    expect(productionConstantMismatches(realistic, { production: true })).toEqual([]);
    expect(() => assertProductionConstants(realistic, { production: true })).not.toThrow();
  });

  test("a CI/accelerated-clock boot CANNOT satisfy the production branch", () => {
    // The decisive property. A fast-profile boot claiming to be production is
    // fatal, so a green CI run can never be read as evidence about production
    // constants — it is structurally incapable of taking that branch.
    const problems = productionConstantMismatches(fast, { production: true });
    expect(problems.join(" ")).toContain("resolved cadence profile is 'fast'");
    expect(problems.join(" ")).toContain("swarmIntervalMs is 120000");
    expect(problems.join(" ")).toContain("swarmWindowMs is 120000");
    expect(() => assertProductionConstants(fast, { production: true })).toThrow(/REFUSING TO BOOT/);
  });

  test("a non-production boot must be the fast profile — the reverse is also fatal", () => {
    expect(productionConstantMismatches(fast, { production: false })).toEqual([]);
    expect(() => assertProductionConstants(realistic, { production: false }))
      .toThrow(/resolved the 'realistic' profile/);
  });

  test("the check reads NO environment — there is no variable left for a stale export to reach", () => {
    // The red control for the removal above. `productionConstantMismatches` is
    // a function of the cadence and the branch alone, so this file cannot
    // regrow an environment-shaped scheduling knob without the signature
    // changing and this test failing to compile.
    expect(productionConstantMismatches.length).toBe(2);
    expect(assertProductionConstants.length).toBe(2);
    const cadenceSrc = readFileSync(join(repoRoot, "scripts", "lib", "smoke-cadence.ts"), "utf8");
    expect(cadenceSrc).not.toMatch(/process\.env/);
    expect(cadenceSrc).not.toMatch(/SCHEDULES_ENABLED/);
  });

  test("a window that is no longer one full interval is fatal in EITHER branch", () => {
    const drifted = { ...realistic, swarmWindowMs: 60 * 60_000 }; // the old flat hour
    for (const production of [true, false]) {
      expect(productionConstantMismatches(drifted, { production }).join(" "))
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
    });
    expect(realistic.swarmIntervalMs).toBe(PRODUCTION_CADENCE_INTENT.swarmIntervalMs);
    expect(realistic.swarmWindowMs).toBe(PRODUCTION_CADENCE_INTENT.swarmWindowMs);
  });

  test("resolveSmokeCadenceForBoot resolves AND proves, in one step nobody can half-perform", () => {
    expect(resolveSmokeCadenceForBoot({ stage: true })).toEqual(realistic);
    expect(resolveSmokeCadenceForBoot({ stage: false })).toEqual(fast);
  });

  test("a pinned-port boot with an explicit --cadence fast is a TEST boot: resolves fast, no production duties", () => {
    // The smoke-twin. `--static-port` pins the port FOR THE TUNNEL, but
    // `--cadence fast` declares this a TEST boot (production-shaped DATA at the
    // test cadence), so it takes the non-production branch.
    expect(resolveSmokeCadenceForBoot({ stage: true, cadence: "fast" })).toEqual(fast);
  });

  test("an explicit --cadence realistic on the pinned port IS production", () => {
    // Saying the quiet part out loud is not a waiver: being explicit about the
    // default keeps the boot inside the production branch with all its duties.
    expect(resolveSmokeCadenceForBoot({ stage: true, cadence: "realistic" })).toEqual(realistic);
  });

  test("a non-pinned boot cannot opt into the realistic profile — --cadence realistic dies", () => {
    // The one-argument rule holds in BOTH directions: only the port pin may
    // select realistic, so a fast-shaped boot demanding it is a lie the
    // assertion refuses to tell.
    expect(() => resolveSmokeCadenceForBoot({ stage: false, cadence: "realistic" }))
      .toThrow(/non-production boot resolved the 'realistic' profile/);
  });

  test("smoke-main.ts boots through the CHECKED resolver, not the bare one", () => {
    // The bare resolver would boot a stack whose constants nobody proved. A
    // separate assert line next to it is a line that can be deleted or omitted
    // from a new entry point; this cannot be.
    expect(smokeMain).toMatch(
      /resolveSmokeCadenceForBoot\(\{\s*stage: stageCadenceApplies\(staticPortMode, twinBoot\),\s*cadence: parsed\.cadence,?\s*\}\)/,
    );
    expect(smokeMain).not.toMatch(/=\s*resolveSmokeCadence\(/);
    // The stage argument is DERIVED, not the raw flag: a twin wears the same
    // `--static-port` pin and must still run FAST (stageCadenceApplies).
    expect(smokeMain).toContain("const twinBoot = requestsTwin(process.argv);");
  });

  test("the smoke overlay pins NO scheduling switch, because there is none to pin", () => {
    // The other half of the same invariant, inverted by issue #1026. The
    // overlay used to be the belt to this check's braces; now neither has a
    // subject. A reappearing pin here would mean the mechanism came back.
    const overlay = readFileSync(join(repoRoot, "docker-compose.smoke.yml"), "utf8");
    expect(overlay).not.toMatch(/SCHEDULES_ENABLED/);
    expect(overlay).not.toMatch(/_CRON:/);
    // …and the two lanes that survive still receive the shared overlay, which
    // no longer hangs off a service that can be deleted out from under them.
    expect(overlay).toContain("x-smoke-worker: &smoke-worker");
    expect(overlay).toContain("worker-analytics: *smoke-worker");
    expect(overlay).toContain("worker-research: *smoke-worker");
  });
});

describe("stageCadenceApplies — a twin is a test instrument, not the public smoke", () => {
  test("the standing public smoke keeps the six-hour grid", () => {
    expect(stageCadenceApplies(true, false)).toBe(true);
    expect(resolveSmokeCadence({ stage: stageCadenceApplies(true, false) }).swarmIntervalMs).toBe(6 * 60 * 60 * 1000);
  });

  test("a twin runs FAST even though it wears the same --static-port pin", () => {
    // The whole point: a six-hour window makes "did the judge run?" a six-hour
    // question, which is how the judge went unexercised on the standing twin.
    expect(stageCadenceApplies(true, true)).toBe(false);
    const cadence = resolveSmokeCadence({ stage: stageCadenceApplies(true, true) });
    expect(cadence.profile).toBe("fast");
    expect(cadence.swarmWindowMs).toBe(120_000);
  });

  test("an unpinned boot is fast either way", () => {
    expect(stageCadenceApplies(false, false)).toBe(false);
    expect(stageCadenceApplies(false, true)).toBe(false);
  });
});
