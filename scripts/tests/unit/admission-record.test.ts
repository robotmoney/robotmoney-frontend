// The real-inference admission RECORD (issue #373, docs/architecture.md §11.3
// E6). Reporting rides on the admission `.github/workflows/e2e.yml` already
// spends — one on a push to main, one on its nightly `schedule` mirror — so the
// admission rate over time is derivable from run history rather than from a
// bespoke sampling loop or scorecard module.
//
// The rendering is the one part of that reporting path that CAN be executed in
// CI without inference, and therefore the one part that MUST be: a report that
// only ever runs inside a 40-minute live boot is a report nothing proves. Every
// input below is SYNTHETIC — hand-built OnboardingEvalResults and hand-built
// NDJSON transcripts. Zero inference, no Docker, no network, no skips.
//
// The load-bearing assertion is the LAST describe: `harness-error` must render
// DISTINCTLY from `refused`. They are the two outcomes an on-call reader is
// most likely to conflate, and conflating them is expensive in both directions
// — a harness error laundered as a refusal inflates the product's refusal rate,
// and a refusal reported as a harness error erases the very metric the eval
// exists to produce.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  admissionRecord,
  ADMISSION_RECORD_FILE,
  formatAdmissionRecord,
  formatAdmissionRecords,
  HARNESS_PERMISSION_REJECTION,
  type OnboardingEvalResult,
} from "../../lib/onboarding-eval.ts";

const repoRoot = join(import.meta.dir, "../../..");

/** An NDJSON transcript with `textParts` finalized text parts and `tools` tool events. */
function transcript(finalText: string, tools = 0): string {
  const lines: string[] = [];
  for (let i = 0; i < tools; i++) lines.push(JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "bash" } }));
  lines.push(JSON.stringify({ type: "text", part: { type: "text", text: finalText, time: { end: 1 } } }));
  return `--- stdout ---\n${lines.join("\n")}\n--- stderr ---\n`;
}

function result(over: Partial<OnboardingEvalResult> = {}): OnboardingEvalResult {
  return {
    identity: { runId: "abc12345", name: "Onboarding Eval abc12345", contact: "onboarding-eval-abc12345@example.test" },
    memberId: null,
    steps: [],
    admitted: false,
    applyState: null,
    claimedAt: null,
    onActiveRoster: false,
    timedOut: false,
    containerExitCode: 0,
    containerLaunched: true,
    observerError: null,
    transcript: transcript("done", 3),
    homeVolume: null,
    ...over,
  };
}

describe("admissionRecord reads the existing classifier, and adds nothing to it", () => {
  test("an admitted run records the outcome, model, member id, duration and liveness", () => {
    const r = admissionRecord(
      "deepseek",
      result({ admitted: true, memberId: "member-77", onActiveRoster: true, transcript: transcript("applied and admitted", 12) }),
      1183_000,
    );
    expect(r.outcome).toBe("admitted");
    expect(r.model).toBe("deepseek");
    expect(r.runId).toBe("abc12345");
    expect(r.memberId).toBe("member-77");
    expect(r.durationMs).toBe(1183_000);
    expect(r.liveness.toolEvents).toBe(12);
    expect(r.liveness.textParts).toBe(1);
    expect(r.liveness.eventLines).toBe(13);
    expect(r.scored).toBe(true);
    expect(r.harnessFault).toBeNull();
  });

  test("a wall-clock deadline records `timed-out` with its deciding branch", () => {
    const r = admissionRecord("kimi", result({ timedOut: true }), 1800_000);
    expect(r.outcome).toBe("timed-out");
    expect(r.branch).toBe("wall-clock-deadline");
    expect(r.reason).toContain("wall-clock");
    expect(r.scored).toBe(true);
  });
});

describe("formatAdmissionRecord renders every field the on-call reader needs", () => {
  const rendered = formatAdmissionRecord(
    admissionRecord("deepseek", result({ admitted: true, memberId: "member-77", transcript: transcript("all done", 9) }), 148_500),
  );

  test("it names the outcome, the resolved model id, the member id and the run id", () => {
    expect(rendered).toContain("`admitted`");
    expect(rendered).toContain("`deepseek`");
    expect(rendered).toContain("`member-77`");
    expect(rendered).toContain("`abc12345`");
  });

  test("it renders the duration in seconds", () => {
    expect(rendered).toContain("148.5s");
  });

  test("it renders the agent-liveness counts", () => {
    expect(rendered).toContain("10 agent event line(s)");
    expect(rendered).toContain("9 tool event(s)");
    expect(rendered).toContain("1 text part(s)");
  });

  test("a run that minted no member row says so rather than printing `null`", () => {
    const none = formatAdmissionRecord(admissionRecord("deepseek", result({ timedOut: true }), 1_000));
    expect(none).toContain("_none minted_");
    expect(none).not.toContain("`null`");
  });
});

describe("`harness-error` renders DISTINCTLY from `refused`", () => {
  // (A) The harness stopped the run: a tool call was rejected by a permission
  // rule in the harness's own generated opencode.json. Nothing about the
  // PRODUCT was measured.
  const harness = admissionRecord(
    "deepseek",
    result({ transcript: transcript(`tool failed: ${HARNESS_PERMISSION_REJECTION}`, 4) }),
    600_000,
  );
  // (B) The model declined the onboarding prompt with a safety rationale — the
  // three-conjunct refusal shape scripts/agent/classify-outcome.ts requires.
  const refused = admissionRecord(
    "deepseek",
    result({
      transcript: transcript(
        "I cannot help with this request. It asks me to download and execute untrusted external code and generate cryptographic signing keys, which raises security concerns.",
        4,
      ),
    }),
    240_000,
  );

  test("the two synthetic runs really do classify differently", () => {
    expect(harness.outcome).toBe("harness-error");
    expect(refused.outcome).toBe("refused");
  });

  test("only the harness error carries a fault, and only it is excluded from the denominator", () => {
    expect(harness.harnessFault?.kind).toBe("agent-blocked-by-harness-permissions");
    expect(harness.scored).toBe(false);
    expect(refused.harnessFault).toBeNull();
    expect(refused.scored).toBe(true);
  });

  test("the harness-error rendering names the fault and says it measured nothing about the product", () => {
    const text = formatAdmissionRecord(harness);
    expect(text).toContain("HARNESS ERROR [agent-blocked-by-harness-permissions]");
    expect(text).toContain("NOT a measurement of the product");
    expect(text).toContain("EXCLUDED from the admission-rate denominator");
  });

  test("the refusal rendering says the opposite — a real, scored measurement", () => {
    const text = formatAdmissionRecord(refused);
    expect(text).toContain("DECLINED");
    expect(text).toContain("counted in the admission-rate denominator");
    expect(text).not.toContain("HARNESS ERROR");
    expect(text).not.toContain("NOT a measurement of the product");
  });

  test("the two renderings are not interchangeable text", () => {
    expect(formatAdmissionRecord(harness)).not.toBe(formatAdmissionRecord(refused));
  });
});

describe("formatAdmissionRecords summarises the run's admissions", () => {
  test("harness errors are excluded from the denominator it reports", () => {
    const records = [
      admissionRecord("deepseek", result({ admitted: true, memberId: "m1" }), 100),
      admissionRecord("kimi", result({ timedOut: true }), 200),
      admissionRecord("kimi", result({ transcript: transcript(`x ${HARNESS_PERMISSION_REJECTION}`) }), 300),
    ];
    const text = formatAdmissionRecords(records);
    expect(text).toContain("1/2 scored admission(s) reached the active roster");
    expect(text).toContain("1 excluded as harness errors");
    // Every record still appears in full — exclusion is from the DENOMINATOR,
    // never from the report. A harness error hidden from the report is exactly
    // the laundering the outcome class exists to prevent.
    expect(text).toContain("HARNESS ERROR");
  });

  test("no admission at all renders as such, never as a 0/0 rate", () => {
    const text = formatAdmissionRecords([]);
    expect(text).toContain("_no admission ran on this event_");
    expect(text).not.toContain("0/0");
  });
});

// ── The wiring: the record has to actually reach a human ────────────────────
describe("the record is wired into e2e.yml on both green and red runs", () => {
  const e2eYml = readFileSync(join(repoRoot, ".github/workflows/e2e.yml"), "utf8");
  const stepBlocks = e2eYml.split(/\n\s*- name:/).slice(1);
  const stepWith = (needle: string): string => {
    const block = stepBlocks.find((b) => b.includes(needle));
    if (!block) throw new Error(`e2e.yml has no step containing ${JSON.stringify(needle)}`);
    return block;
  };

  test("one file path, one definition — the workflow names the constant's value", () => {
    expect(ADMISSION_RECORD_FILE).toBe("onboarding-admission-record.md");
    expect(e2eYml).toContain(ADMISSION_RECORD_FILE);
  });

  test("the record is folded into the job summary, on `if: always()`", () => {
    const step = stepWith(`cat ${ADMISSION_RECORD_FILE} >> "$GITHUB_STEP_SUMMARY"`);
    expect(step).toMatch(/^\s*if: always\(\)/m);
  });

  test("the record is uploaded as an artifact, on `if: always()`", () => {
    const step = stepWith("actions/upload-artifact");
    expect(step).toMatch(/^\s*if: always\(\)/m);
    expect(step).toContain(`path: ${ADMISSION_RECORD_FILE}`);
  });

  test("the smoke writes the record BEFORE it throws on a failed admission", () => {
    // Otherwise a RED admission — the one an on-call reader most needs the
    // record for — would record nothing at all.
    const smokeMain = readFileSync(join(repoRoot, "scripts/lib/smoke-main.ts"), "utf8");
    const writeAt = smokeMain.indexOf("formatAdmissionRecords(records)");
    const throwAt = smokeMain.indexOf("admission(s) did not reach the active roster");
    expect(writeAt).toBeGreaterThan(0);
    expect(throwAt).toBeGreaterThan(writeAt);
  });

  test("the record file is gitignored — it is a CI artifact, never source", () => {
    expect(readFileSync(join(repoRoot, ".gitignore"), "utf8")).toContain(ADMISSION_RECORD_FILE);
  });
});
