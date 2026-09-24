// The smoke's onboarding admissions ride the RETRY wrapper and name the
// classified outcome (docs/architecture.md §11 R8 / §11.3 E4, issue #278) —
// and, since issue #1026, `bun smoke` runs NO standing in-process driver at all.
//
// SPEC §1 (issue #1026). "`bun smoke --static-port` brings up the production
// cluster and **exits**. Containers stay up under Docker." A process that exits
// at readiness cannot host a loop that admits newcomers or convenes sessions for
// hours afterwards, so the standing onboarding driver and the standing swarm
// loop are retired from smoke-main.ts: sessions are the system-scheduler's
// (scheduler spec), and takes and admissions are participants' — standing
// containers (smoke spec §6.2) that outlive the invoking terminal. What remains
// in the boot is the CI real-inference admission sweep, which must still ride
// the retry wrapper with the running stack's exact compose environment. The
// graders below stay exported and red-controlled, so a driver re-introduced
// anywhere is held to the same standard.
//
// WHAT THIS PROTECTS. On 2026-07-25 a standing smoke run admitted ZERO members.
// The member agent REFUSED the canonical onboarding prompt, the container
// exited cleanly (code 0) after ~15 seconds, all seven observed steps stayed
// pending — and nothing retried it. Because the newcomer roster is FIXED and
// FINITE (scripts/lib/smoke-newcomers.ts), that single unretried refusal
// permanently forfeited a seat: the smoke could never admit that person again.
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
// scripts/lib/smoke-main.ts does its setup at module scope and boots a stack on
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
const smokeMain = readFileSync(join(repoRoot, "scripts", "lib", "smoke-main.ts"), "utf8");

/**
 * The body of `onboardingDriver()` — the standing smoke's per-newcomer
 * admission loop — from its declaration to the `void onboardingDriver();` that
 * starts it. Throws if the anchor is gone, so a rename is red here rather than
 * silently reducing every check below to a scan over an empty string.
 */
export function onboardingDriverBody(src: string): string {
  const start = src.indexOf("async function onboardingDriver()");
  if (start === -1) throw new Error("smoke-main.ts no longer declares onboardingDriver() — this suite's anchor is gone");
  const end = src.indexOf("void onboardingDriver();", start);
  if (end === -1) throw new Error("smoke-main.ts no longer starts onboardingDriver() — this suite's anchor is gone");
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

/**
 * null when the admission delays come from the cadence profile; a reason
 * otherwise. Issue #371 moved the driver off its own 60_000 / 300_000 literals
 * so a `--stage` boot admits one newcomer per swarm interval (6 h) instead
 * of one every five minutes, while plain `bun run smoke` is unchanged.
 */
export function admissionDelaysComeFromProfile(body: string): string | null {
  const literals = ["60_000", "60000", "300_000", "300000"].filter((lit) =>
    new RegExp(`(?<![\\w_])${lit}(?![\\w_])`).test(body),
  );
  if (literals.length > 0) {
    return `onboardingDriver() still hardcodes admission timing (${literals.join(", ")}) instead of reading the cadence profile`;
  }
  const missing = ["cadence.onboardingFirstMs", "cadence.onboardingIntervalMs"].filter((ref) => !body.includes(ref));
  return missing.length === 0
    ? null
    : `onboardingDriver() never reads ${missing.join(" / ")} — its cadence is not profile-driven`;
}

/** Every smoke admission must reuse the exact environment of its live stack. */
export function retryCallsReuseStackEnvironment(src: string, expectedCalls = 1): string | null {
  const calls = [...src.matchAll(/await\s+runOnboardingEvalWithRetry\(\{[\s\S]*?\n\s*\}\);/g)].map((m) => m[0]);
  if (calls.length !== expectedCalls) {
    return `expected exactly ${expectedCalls} smoke retry-wrapper call site(s), found ${calls.length}`;
  }
  const missing = calls.filter((call) => !/composeSpawnEnv:\s*stack\.spawnEnv/.test(call));
  return missing.length === 0
    ? null
    : `${missing.length}/${calls.length} smoke retry-wrapper call site(s) re-resolve Compose without stack.spawnEnv`;
}

/**
 * Issue #317: every admission attempt must get a retained, tailable,
 * per-prospect transcript (scripts/lib/smoke-prospect-transcript.ts) — not
 * only a console line the shared smoke log prints on failure. null when the
 * driver wires it correctly (started before the attempt, wired as the retry
 * wrapper's SINK, and closed out on every exit path — admitted, failed, and
 * thrown); a reason string otherwise.
 */
export function retainsProspectTranscript(body: string): string | null {
  if (!/startProspectTranscript\(/.test(body)) {
    return "onboardingDriver() never calls startProspectTranscript — no per-prospect transcript is retained";
  }
  if (!/onStructuredEvent:\s*transcript\.sink/.test(body)) {
    return "onboardingDriver() does not wire transcript.sink as onStructuredEvent — retry-wrapper events never reach the retained transcript";
  }
  // Must NOT wire a shared `telemetry:` option instead — see
  // scripts/lib/smoke-prospect-transcript.ts's doc comment: that would freeze
  // every later retry attempt's `attempt` tag at the first attempt's value.
  if (/telemetry:\s*transcript/.test(body)) {
    return "onboardingDriver() wires transcript as a shared `telemetry:` option instead of `onStructuredEvent` — later retry attempts would misreport their attempt number";
  }
  if (!/transcript\.finish\(result,/.test(body)) {
    return "onboardingDriver() never calls transcript.finish(result, …) — admitted and failed outcomes are never durably recorded";
  }
  if (!/transcript\.finishThrew\(/.test(body)) {
    return "onboardingDriver() never calls transcript.finishThrew(...) in its catch block — a harness throw leaves the transcript looking permanently in-progress";
  }
  return null;
}

/**
 * null when `src` hosts no standing in-process driver and does not stay
 * resident after readiness; a reason string otherwise (spec §1).
 */
export function runsNoStandingDriver(src: string): string | null {
  for (const retired of ["async function onboardingDriver(", "async function swarmDriver(", "void onboardingDriver()", "void swarmDriver()"]) {
    if (src.includes(retired)) return `smoke-main.ts still hosts a standing driver (${retired}) — bun smoke exits at readiness (spec §1)`;
  }
  if (/new Promise<never>\(/.test(src)) return "smoke-main.ts still awaits a never-settling promise after readiness";
  return null;
}

describe("the smoke's onboarding admissions (scripts/lib/smoke-main.ts)", () => {
  test("bun smoke hosts no standing onboarding or swarm driver, and never stays resident (spec §1)", () => {
    expect(runsNoStandingDriver(smokeMain)).toBeNull();
    // It exits 0 once readiness is logged: the READY line, then process.exit(0).
    const ready = smokeMain.indexOf("log(`READY");
    expect(ready).toBeGreaterThan(-1);
    expect(smokeMain.indexOf("process.exit(0);", ready)).toBeGreaterThan(ready);
  });

  test("the CI sweep rides runOnboardingEvalWithRetry — a refusal cannot forfeit a seat there either", () => {
    const sweep = smokeMain.slice(smokeMain.indexOf('if (process.env.ONBOARDING_REAL_EVAL === "1")'));
    expect(ridesRetryWrapper(sweep)).toBeNull();
  });

  test("the bare runOnboardingEval is not even imported by the boot", () => {
    const importBlock = smokeMain.slice(smokeMain.indexOf("} from \"./onboarding-eval.ts\";") - 400, smokeMain.indexOf("} from \"./onboarding-eval.ts\";"));
    expect(importBlock).toContain("runOnboardingEvalWithRetry");
    expect(importBlock.match(/(?<!WithRetry)\brunOnboardingEval,/)).toBeNull();
  });

  test("the CI sweep reuses the running stack's exact Compose environment", () => {
    expect(retryCallsReuseStackEnvironment(smokeMain)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RED CONTROLS. The same functions, pointed at the code as it was on the day
// the smoke lost a seat. Both must report, or the checks above prove nothing.
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

  test("the stack-environment guard reports a call site that drops composeSpawnEnv", () => {
    const broken = smokeMain.replaceAll("composeSpawnEnv: stack.spawnEnv,", "");
    expect(retryCallsReuseStackEnvironment(broken)).toContain("1/1");
  });

  // Issue #1026 controls: the retired standing driver and the forever-await
  // that kept `bun smoke` resident are both REPORTED.
  test("runsNoStandingDriver REPORTS the retired standing onboarding driver", () => {
    expect(runsNoStandingDriver(`${PRE_FIX_DRIVER}void onboardingDriver();`)).toContain("onboardingDriver");
  });

  test("runsNoStandingDriver REPORTS the retired forever-await", () => {
    expect(runsNoStandingDriver("await new Promise<never>(() => { /* run forever */ });")).toContain("never-settling");
  });

  // Issue #317 controls: a driver that launches the eval but never retains a
  // per-prospect transcript, or wires it wrong, must be REPORTED.
  test("retainsProspectTranscript REPORTS a driver that never calls startProspectTranscript", () => {
    const reason = retainsProspectTranscript("await runOnboardingEvalWithRetry({ identity });\n");
    expect(reason).toContain("startProspectTranscript");
  });

  test("retainsProspectTranscript REPORTS a driver that starts the transcript but never wires its sink", () => {
    const reason = retainsProspectTranscript(
      "const transcript = startProspectTranscript({ identity });\nawait runOnboardingEvalWithRetry({ identity });\n",
    );
    expect(reason).toContain("onStructuredEvent");
  });

  test("retainsProspectTranscript REPORTS a driver that wires a shared `telemetry:` option instead of the sink", () => {
    const reason = retainsProspectTranscript(
      "const transcript = startProspectTranscript({ identity });\n" +
        "await runOnboardingEvalWithRetry({ identity, onStructuredEvent: transcript.sink, telemetry: transcript.telemetry });\n" +
        "transcript.finish(result, 0);\ntranscript.finishThrew(err, 0);\n",
    );
    expect(reason).toContain("telemetry:");
  });

  test("retainsProspectTranscript REPORTS a driver that never closes out a finished attempt", () => {
    const reason = retainsProspectTranscript(
      "const transcript = startProspectTranscript({ identity });\n" +
        "await runOnboardingEvalWithRetry({ identity, onStructuredEvent: transcript.sink });\n",
    );
    expect(reason).toContain("transcript.finish(result");
  });

  test("retainsProspectTranscript REPORTS a driver whose catch block never calls finishThrew", () => {
    const reason = retainsProspectTranscript(
      "const transcript = startProspectTranscript({ identity });\n" +
        "await runOnboardingEvalWithRetry({ identity, onStructuredEvent: transcript.sink });\n" +
        "transcript.finish(result, 0);\n",
    );
    expect(reason).toContain("finishThrew");
  });

  test("retainsProspectTranscript accepts a driver wired the way the retired one was", () => {
    const wired =
      "const transcript = startProspectTranscript({ identity });\n" +
      "await runOnboardingEvalWithRetry({ identity, onStructuredEvent: transcript.sink });\n" +
      "transcript.finish(result, 0);\n} catch (err) {\ntranscript.finishThrew(err, 0);\n";
    expect(retainsProspectTranscript(wired)).toBeNull();
  });

  // Issue #371 controls. The pre-#371 driver read its delays from two constants
  // it declared itself; the grader must report BOTH failure shapes, or "no
  // literals" would pass on a driver that reads nothing at all.
  const PRE_371_DELAYS = `const FIRST_ONBOARD_MS = 60_000;
  const ONBOARD_INTERVAL_MS = 300_000;
  const delay = n === 0 ? FIRST_ONBOARD_MS : ONBOARD_INTERVAL_MS;`;

  test("admissionDelaysComeFromProfile REPORTS the hardcoded 60_000 / 300_000 driver", () => {
    const reason = admissionDelaysComeFromProfile(PRE_371_DELAYS);
    expect(reason).not.toBeNull();
    expect(reason).toContain("60_000");
    expect(reason).toContain("300_000");
  });

  test("admissionDelaysComeFromProfile REPORTS a driver with no literals that reads no profile either", () => {
    const reason = admissionDelaysComeFromProfile("const delay = someOtherThing;");
    expect(reason).toContain("cadence.onboardingFirstMs");
  });

  test("admissionDelaysComeFromProfile REPORTS a driver that reads only half the profile", () => {
    const half = "const delay = n === 0 ? cadence.onboardingFirstMs : 300000;";
    expect(admissionDelaysComeFromProfile(half)).toContain("300000");
  });

  test("re-inlining the interval into a profile-driven driver body is caught", () => {
    const profiled = "const delay = admissionDelayMs(admitted, cadence.onboardingFirstMs, cadence.onboardingIntervalMs);";
    expect(admissionDelaysComeFromProfile(profiled)).toBeNull();
    const broken = profiled.replaceAll("cadence.onboardingIntervalMs", "300_000");
    expect(admissionDelaysComeFromProfile(broken)).toContain("300_000");
  });
});
