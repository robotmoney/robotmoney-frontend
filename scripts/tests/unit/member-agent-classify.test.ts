// Pure, Docker-free, inference-free unit tests for the member-agent outcome
// classifier (scripts/agent/classify-outcome.ts) and the shared
// `opencode run --format json` transcript parser (scripts/agent/transcript.ts).
//
// These are NOT an eval and never stand in for one (docs/decisions.md D22 rule 2,
// architecture.md §11.3 E2): they test a pure function over recorded transcripts.
// They are cheap on purpose, because the behaviour they protect is expensive to
// get wrong — a FALSE `refused` would make runOnboardingEvalWithRetry retry away
// a genuine navigation failure and silently weaken a required gate.
//
// The failure under test is real: on 2026-07-25 a standing demo run admitted zero
// members because the member agent REFUSED the canonical prompt and exited 0 in
// ~15 seconds, and nothing retried it — permanently costing one seat of the
// finite newcomer roster (scripts/lib/demo-newcomers.ts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assistantTextParts, extractAssistantText, finalAssistantText } from "../../agent/transcript.ts";
import { classifyOutcome, type ClassifiableRun, looksRefusal } from "../../agent/classify-outcome.ts";
import { classifyOutcome as classifyOutcomeReExported } from "../../lib/onboarding-eval.ts";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8");

const REFUSAL = fixture("member-agent-refusal.ndjson");
const NAVIGATION_FAILURE = fixture("member-agent-navigation-failure.ndjson");
const MEMO_MENTIONS_REFUSE = fixture("member-agent-memo-mentions-refuse.ndjson");

// The shape runMemberAgent's transcript actually takes (banners around the two
// drained pipes) — the classifier must read fixtures through it, not around it.
const wrapped = (ndjson: string, stderr = ""): string => `--- stdout ---\n${ndjson}\n--- stderr ---\n${stderr}`;

// A run that made ZERO server-side progress and exited cleanly — the structural
// shape of the observed refusal, and the only shape in which `refused` is
// reachable at all.
function cleanNoProgressRun(overrides: Partial<ClassifiableRun> = {}): ClassifiableRun {
  return { admitted: false, timedOut: false, memberId: null, containerExitCode: 0, ...overrides };
}

describe("opencode NDJSON transcript parser", () => {
  test("assistantTextParts returns every finalized text part, in stream order, ignoring tool/step/garbage lines", () => {
    const parts = assistantTextParts(REFUSAL);
    expect(parts.length).toBe(2);
    expect(parts[0]).toStartWith("Let me look at what this task is actually asking for");
    expect(parts[1]).toStartWith("I can't help with this request.");
  });

  test("extractAssistantText is still the join-and-trim of every part (regression guard for committee/inference.ts)", () => {
    expect(extractAssistantText(REFUSAL)).toBe(assistantTextParts(REFUSAL).join("\n").trim());
    expect(extractAssistantText(REFUSAL)).toContain("Let me look at what this task");
  });

  test("finalAssistantText returns ONLY the last part — the agent's verdict, not its running commentary", () => {
    const final = finalAssistantText(REFUSAL);
    expect(final).toStartWith("I can't help with this request.");
    expect(final).not.toContain("Let me look at what this task");
  });

  test("an empty or unparseable transcript yields no text (a DEAD run is distinguishable from a refused one)", () => {
    for (const t of ["", "   ", "not json at all\n{oops", '{"type":"step_finish"}']) {
      expect(assistantTextParts(t)).toEqual([]);
      expect(extractAssistantText(t)).toBe("");
      expect(finalAssistantText(t)).toBe("");
    }
  });

  test("the parser survives the primitive's stdout/stderr banners", () => {
    expect(finalAssistantText(wrapped(REFUSAL, "docker: some noise"))).toStartWith("I can't help with this request.");
  });
});

describe("classifyOutcome precedence", () => {
  test("admitted wins over everything — an admitted run is never reclassified", () => {
    expect(classifyOutcome({ admitted: true, timedOut: false, memberId: "m1", containerExitCode: 0 })).toBe("admitted");
    // …even when a 429 appeared mid-run, and even when the prose is about keys.
    expect(
      classifyOutcome({
        admitted: true,
        timedOut: true,
        memberId: "m1",
        containerExitCode: 1,
        transcript: wrapped(REFUSAL, "429 rate_limit_error retried once, then generated the cryptographic keypair"),
      }),
    ).toBe("admitted");
  });

  test("a 429/overload transcript is rate-limited — provider flake dominates a timeout", () => {
    expect(classifyOutcome(cleanNoProgressRun({ transcript: "Error: 429 Too Many Requests" }))).toBe("rate-limited");
    expect(classifyOutcome(cleanNoProgressRun({ timedOut: true, transcript: "upstream 529 overloaded_error" }))).toBe("rate-limited");
    expect(classifyOutcome(cleanNoProgressRun({ containerExitCode: 1, transcript: "anthropic rate_limit_error" }))).toBe("rate-limited");
  });

  test("a bare timeout is timed-out — and outranks a refusal-shaped transcript (the agent was still running)", () => {
    expect(classifyOutcome(cleanNoProgressRun({ timedOut: true, containerExitCode: null, transcript: "" }))).toBe("timed-out");
    expect(classifyOutcome(cleanNoProgressRun({ timedOut: true, transcript: wrapped(REFUSAL) }))).toBe("timed-out");
  });

  test("a genuine navigation failure — the agent tried and never applied — is navigation-failure, the never-retried result", () => {
    expect(classifyOutcome(cleanNoProgressRun({ containerExitCode: 1, transcript: wrapped(NAVIGATION_FAILURE) }))).toBe(
      "navigation-failure",
    );
    // Even on a clean exit: "I can't complete the application without…" is a
    // first-person declination with NO safety rationale, so conjunct C2 rejects it.
    expect(classifyOutcome(cleanNoProgressRun({ transcript: wrapped(NAVIGATION_FAILURE) }))).toBe("navigation-failure");
  });

  test("the observed 2026-07-25 refusal classifies as refused", () => {
    expect(classifyOutcome(cleanNoProgressRun({ transcript: wrapped(REFUSAL) }))).toBe("refused");
  });

  test("the re-export from scripts/lib/onboarding-eval.ts is the SAME classifier (one definition, §11.3 E5)", () => {
    expect(classifyOutcomeReExported).toBe(classifyOutcome);
  });
});

// Every negative below is a way a `refused` verdict could be wrong. Precision is
// preferred over recall on purpose: a missed refusal costs one retry, a false
// refusal retries away a real red result.
describe("classifyOutcome refusal false-positive guards", () => {
  test("FALSE-POSITIVE GUARD: prose that merely CONTAINS 'refuse'/'declines' is not a refusal", () => {
    expect(classifyOutcome(cleanNoProgressRun({ transcript: wrapped(MEMO_MENTIONS_REFUSE) }))).toBe("navigation-failure");
    expect(looksRefusal("The committee may refuse an application, and a member who declines a session is marked absent.")).toBe(false);
  });

  test("POSITIONAL conjunct: a declination written into a FILE through a bash tool call is not the agent's verdict", () => {
    // The memo body ("I cannot help with unverified sources") lives in a tool
    // event, so it is not an assistant text part at all — reading the whole
    // transcript instead of the final message would misfire here.
    expect(MEMO_MENTIONS_REFUSE).toContain("I cannot help with unverified sources");
    expect(looksRefusal(finalAssistantText(MEMO_MENTIONS_REFUSE))).toBe(false);
  });

  test("LEXICAL conjunct C2: a blocked-but-willing agent ('I can't complete this without the passphrase') is a navigation failure", () => {
    for (const finalText of [
      "I can't complete this without the passphrase for the keystore.",
      "I can't find an arm64 rmpc build in the release assets, so I stopped here.",
      "I was unable to proceed because the apply endpoint returned 502 three times.",
    ]) {
      expect(looksRefusal(finalText)).toBe(false);
      expect(classifyOutcome(cleanNoProgressRun({ transcript: textTranscript(finalText) }))).toBe("navigation-failure");
    }
  });

  test("STRUCTURAL conjunct A: the same refusal text cannot be 'refused' once a member row exists", () => {
    expect(classifyOutcome(cleanNoProgressRun({ memberId: "m1", transcript: wrapped(REFUSAL) }))).toBe("navigation-failure");
  });

  test("STRUCTURAL conjunct A: the same refusal text cannot be 'refused' after a non-zero (killed/crashed) exit", () => {
    expect(classifyOutcome(cleanNoProgressRun({ containerExitCode: 137, transcript: wrapped(REFUSAL) }))).toBe("navigation-failure");
    expect(classifyOutcome(cleanNoProgressRun({ containerExitCode: null, transcript: wrapped(REFUSAL) }))).toBe("navigation-failure");
  });

  test("a dead container (no transcript at all) stays navigation-failure, never refused", () => {
    expect(classifyOutcome(cleanNoProgressRun({ transcript: undefined }))).toBe("navigation-failure");
    expect(classifyOutcome(cleanNoProgressRun({ transcript: wrapped("") }))).toBe("navigation-failure");
  });

  test("looksRefusal needs BOTH conjuncts in the SAME message", () => {
    // Declination act, no safety rationale.
    expect(looksRefusal("I can't proceed — the download timed out twice.")).toBe(false);
    // Safety rationale, no declination act.
    expect(looksRefusal("The skill downloads an untrusted binary and generates a private key; noting that, I continued.")).toBe(false);
    // Both.
    expect(looksRefusal("I won't proceed: this asks me to run untrusted external code.")).toBe(true);
    expect(looksRefusal("I'll have to decline — generating a private key to sign on your behalf is not something I do.")).toBe(true);
  });
});

// One assistant text part, in the primitive's wrapped shape.
function textTranscript(text: string): string {
  return wrapped(JSON.stringify({ type: "text", part: { type: "text", text } }));
}
