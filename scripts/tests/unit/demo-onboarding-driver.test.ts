// The standing demo's onboarding driver rides the RETRY wrapper and names the
// classified outcome (docs/architecture.md §11 R8 / §11.3 E4, issue #278).
//
// WHAT THIS PROTECTS. On 2026-07-25 a standing demo run admitted ZERO members.
// The member agent REFUSED the canonical onboarding prompt, the container
// exited cleanly (code 0) after ~15 seconds, all seven observed steps stayed
// pending — and nothing retried it. Because the newcomer roster is FIXED and
// FINITE (scripts/lib/demo-newcomers.ts), that single unretried refusal
// permanently forfeited a seat: the demo could never admit that person again.
// The driver called the bare `runOnboardingEval`, whose result it treated as a
// real navigation failure, and the log said so in as many words ("this is a
// real eval result, not retried").
//
// Two changes fixed it, and this file is what keeps them:
//   1. the driver calls `runOnboardingEvalWithRetry`, so a `refused` or
//      `rate-limited` attempt gets one retry with a derived identity; and
//   2. it LOGS the classified outcome, so a refusal and a genuine navigation
//      failure — identical in the step strip — are distinguishable in the log.
//
// scripts/lib/demo-main.ts does its setup at module scope and boots a stack on
// import, so it cannot be imported into a unit test. The checks below are
// therefore written as FUNCTIONS OVER SOURCE TEXT — the same idiom
// scripts/tests/unit/e2e-onboarding-eval-pr-cost.test.ts uses for workflow YAML
// — and the same function that grades the real file is pointed at a
// deliberately-broken fixture, so a check that has stopped matching is red
// rather than vacuously green.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const demoMain = readFileSync(join(repoRoot, "scripts", "lib", "demo-main.ts"), "utf8");

/**
 * The body of `onboardingDriver()` — the standing demo's per-newcomer
 * admission loop — from its declaration to the `void onboardingDriver();` that
 * starts it. Throws if the anchor is gone, so a rename is red here rather than
 * silently reducing every check below to a scan over an empty string.
 */
export function onboardingDriverBody(src: string): string {
  const start = src.indexOf("async function onboardingDriver()");
  if (start === -1) throw new Error("demo-main.ts no longer declares onboardingDriver() — this suite's anchor is gone");
  const end = src.indexOf("void onboardingDriver();", start);
  if (end === -1) throw new Error("demo-main.ts no longer starts onboardingDriver() — this suite's anchor is gone");
  return src.slice(start, end);
}

/** null when the driver rides the retry wrapper; a reason string otherwise. */
export function ridesRetryWrapper(body: string): string | null {
  if (!/await\s+runOnboardingEvalWithRetry\(/.test(body)) {
    return "onboardingDriver() does not await runOnboardingEvalWithRetry — an unretried refusal forfeits a finite roster seat";
  }
  // The bare form must be GONE from the driver, not merely joined by the
  // wrapper: one surviving call site is one seat that can still be lost.
  const bare = body.match(/(?<!WithRetry)\brunOnboardingEval\((?!WithRetry)/g);
  if (bare) return `onboardingDriver() still calls the bare runOnboardingEval ${bare.length} time(s)`;
  return null;
}

/** null when the driver logs the classified outcome; a reason string otherwise. */
export function logsClassifiedOutcome(body: string): string | null {
  if (!/classifyOutcome\(result\)/.test(body)) {
    return "onboardingDriver() never classifies the result — a refusal and a navigation failure are then indistinguishable";
  }
  // The real call spans several lines, so this looks INSIDE a log(...) call
  // rather than at one line of it.
  const logsOutcome = /\blog\([\s\S]{0,300}?\$\{outcome\}/.test(body);
  const logsEvidence = /formatOutcomeEvidence\(explainOutcome\(result\)\)/.test(body);
  if (!logsOutcome) return "the classified outcome is computed but never written to the log";
  if (!logsEvidence) return "the outcome's deciding branch/liveness evidence is never logged — a misclassification stays invisible";
  return null;
}

describe("the demo's onboarding driver (scripts/lib/demo-main.ts)", () => {
  const body = onboardingDriverBody(demoMain);

  test("the extracted driver body is the real one — not an empty or truncated slice", () => {
    expect(body.length).toBeGreaterThan(500);
    expect(body).toContain("plannedNewcomer(n)");
    expect(body).toContain("startOnboarding(");
  });

  test("it rides runOnboardingEvalWithRetry — a refusal can no longer forfeit a roster seat", () => {
    expect(ridesRetryWrapper(body)).toBeNull();
  });

  test("it logs the classified outcome and the evidence that decided it", () => {
    expect(logsClassifiedOutcome(body)).toBeNull();
  });

  test("the bare runOnboardingEval is not even imported by the driver's module", () => {
    // The demo's CI sweep block already used the wrapper; with the driver moved
    // over, nothing in this file needs the unretried form at all.
    const importBlock = demoMain.slice(demoMain.indexOf("} from \"./onboarding-eval.ts\";") - 400, demoMain.indexOf("} from \"./onboarding-eval.ts\";"));
    expect(importBlock).toContain("runOnboardingEvalWithRetry");
    expect(importBlock).toContain("classifyOutcome");
    expect(importBlock.match(/(?<!WithRetry)\brunOnboardingEval,/)).toBeNull();
  });

  test("the driver still distinguishes a NEVER-retried outcome in its log wording", () => {
    // A blanket "retries exhausted" on every failure would erase the very
    // distinction §11 R8 depends on: a navigation failure is a real red result.
    expect(body).toContain("this is a real eval result, never retried");
    expect(body).toContain("retries exhausted");
  });
});

// ---------------------------------------------------------------------------
// RED CONTROLS. The same functions, pointed at the code as it was on the day
// the demo lost a seat. Both must report, or the checks above prove nothing.
// ---------------------------------------------------------------------------
const PRE_FIX_DRIVER = `async function onboardingDriver(): Promise<void> {
    for (let n = 0; n < NEWCOMER_NAMES.length; n++) {
      const planned = plannedNewcomer(n);
      startOnboarding(identity.runId, identity.name);
      try {
        const result: OnboardingEvalResult = await runOnboardingEval({
          repoRoot,
          composeProject: project,
          identity,
        });
        if (!result.admitted) {
          log(
            \`onboarding \${identity.name} (#\${n + 1}) FAILED — \` +
              "before reaching the active roster; this is a real eval result, not retried",
          );
          continue;
        }
      } catch (err) { /* ... */ }
    }
  }
  `;

describe("red control: the 2026-07-25 driver, which lost a seat to one refusal", () => {
  test("the extractor still finds a driver body in the pre-fix source", () => {
    expect(onboardingDriverBody(`${PRE_FIX_DRIVER}void onboardingDriver();`)).toContain("runOnboardingEval(");
  });

  test("ridesRetryWrapper REPORTS the bare, unretried call", () => {
    const reason = ridesRetryWrapper(PRE_FIX_DRIVER);
    expect(reason).not.toBeNull();
    expect(reason).toContain("runOnboardingEvalWithRetry");
  });

  test("a driver that calls BOTH is still reported — one surviving bare call is one losable seat", () => {
    const both = `${PRE_FIX_DRIVER}\nawait runOnboardingEvalWithRetry({});\n`;
    const reason = ridesRetryWrapper(both);
    expect(reason).not.toBeNull();
    expect(reason).toContain("still calls the bare runOnboardingEval");
  });

  test("logsClassifiedOutcome REPORTS a driver that never classifies", () => {
    const reason = logsClassifiedOutcome(PRE_FIX_DRIVER);
    expect(reason).not.toBeNull();
    expect(reason).toContain("never classifies");
  });

  test("logsClassifiedOutcome REPORTS a driver that classifies but never logs it", () => {
    const silent = "const outcome = classifyOutcome(result);\nif (outcome === \"refused\") continue;\n";
    expect(logsClassifiedOutcome(silent)).toContain("never written to the log");
  });

  test("logsClassifiedOutcome REPORTS a driver that logs the label but drops the evidence", () => {
    const thin = "const outcome = classifyOutcome(result);\nlog(`FAILED (${outcome})`);\n";
    expect(logsClassifiedOutcome(thin)).toContain("evidence");
  });

  test("a missing anchor THROWS rather than grading an empty string", () => {
    expect(() => onboardingDriverBody("export const x = 1;\n")).toThrow(/anchor is gone/);
    expect(() => onboardingDriverBody("async function onboardingDriver() {}\n")).toThrow(/anchor is gone/);
  });
});
