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
import { classifyOutcome, type ClassifiableRun, looksRateLimited, looksRefusal, rateLimitDominates, shouldRetry } from "../../agent/classify-outcome.ts";
import { classifyOutcome as classifyOutcomeReExported } from "../../lib/onboarding-eval.ts";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8");

const REFUSAL = fixture("member-agent-refusal.ndjson");
const NAVIGATION_FAILURE = fixture("member-agent-navigation-failure.ndjson");
const MEMO_MENTIONS_REFUSE = fixture("member-agent-memo-mentions-refuse.ndjson");
const RATE_LIMIT_IN_TOOL_OUTPUT = fixture("member-agent-rate-limit-in-tool-output.ndjson");

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

  // ── The tool-output false positive (observed live, 2026-07-26) ────────────
  // `rate-limited` is priority 2, retryable, and documented as meaning "the run
  // never happened" — callers are told to back off for hours and read nothing
  // into it. So a false positive here is the most expensive misclassification
  // in this file: it erases a real result and reports it as weather.
  //
  // The transcript scanned includes the output of EVERY tool call, and the agent
  // under test routinely clones robotmoney-core and reads thousands of files. A
  // `\b429\b` or `rate limit` substring in any of them used to outrank
  // everything below it.
  describe("a rate-limit substring in TOOL OUTPUT is not a rate-limited run", () => {
    const run = cleanNoProgressRun({ transcript: wrapped(RATE_LIMIT_IN_TOOL_OUTPUT) });

    test("the fixture really does carry the trigger — otherwise this whole block is vacuous", () => {
      // The old classifier's exact check, still true: the substring IS present.
      expect(looksRateLimited(run.transcript)).toBe(true);
      // …but nowhere in the agent's own closing verdict.
      expect(looksRateLimited(finalAssistantText(run.transcript!))).toBe(false);
      expect(finalAssistantText(run.transcript!)).toContain("Generated Ed25519 signing key");
    });

    test("it classifies as navigation-failure — the agent plainly DID reason and work", () => {
      expect(classifyOutcome(run)).toBe("navigation-failure");
    });

    test("and is therefore NEVER retried — the real result is reported, not spent as flake", () => {
      // This is the whole point: 20 minutes of real work were previously burned
      // twice and reported as provider flake.
      expect(shouldRetry(classifyOutcome(run))).toBe(false);
    });

    test("a refusal whose tool output mentions a rate limit is still a REFUSAL", () => {
      // The same latent bug on a different outcome: `refused` sits below
      // `rate-limited`, so tool-output noise used to mask it too.
      const refusalWithNoise = cleanNoProgressRun({
        transcript: wrapped(REFUSAL.replace("{\"type\":\"step_start\"", '{"type":"tool_use","part":{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"grep -rn 429 ."},"output":"http.rs:429: rate limit"}}}\n{"type":"step_start"')),
      });
      expect(looksRateLimited(refusalWithNoise.transcript)).toBe(true);
      expect(classifyOutcome(refusalWithNoise)).toBe("refused");
    });

    // ── DOCUMENTED RESIDUAL, deliberately pinned — NOT an endorsement ────────
    // The structural conjunct above only bites on runs that authored a closing
    // verdict. `rateLimitDominates` still has an unconditional escape hatch —
    // `if (final === "") return true` (classify-outcome.ts:93) — which falls
    // back to a WHOLE-TRANSCRIPT scan whenever no finalized assistant text part
    // exists, and it is still ranked ABOVE the `run.timedOut` check
    // (classify-outcome.ts:193-194). So the very same tool-output noise still
    // wins on a run that was killed at the deadline before it wrote any text.
    // That is the expensive direction: `rate-limited` is the ONLY retried
    // outcome (evals/onboarding/support/layer-run.ts) and layer 4 drops it from
    // the scorecard DENOMINATOR (evals/onboarding/support/scorecard.ts), so a
    // false one INFLATES the admission rate.
    //
    // This test pins the CURRENT behaviour so the residual is visible in the
    // suite and any change to it has to be deliberate. The obvious fix — moving
    // `run.timedOut` above `rateLimitDominates` — is HARSHER, not softer (so
    // §11.3 E7 does not forbid it), but it also removes the retry from a run
    // that really was throttled and then killed at the deadline. That tradeoff
    // is DEFERRED pending live-campaign data on whether this shape fires in the
    // wild; if it does, flip the order in the source and flip this expectation
    // to "timed-out".
    test("KNOWN RESIDUAL (pinned, deferred): a killed run with NO text part is still rate-limited on tool-output noise alone", () => {
      const toolOutputOnly = wrapped(
        JSON.stringify({
          type: "tool_use",
          part: {
            type: "tool",
            tool: "bash",
            state: { status: "completed", input: { command: "grep -rn 429 ." }, output: "http.rs:429: rate limit exceeded" },
          },
        }),
      );
      // The premise of the residual: a trigger substring, and no verdict at all
      // for the structural conjunct to veto with.
      expect(finalAssistantText(toolOutputOnly)).toBe("");
      expect(looksRateLimited(toolOutputOnly)).toBe(true);
      expect(rateLimitDominates(toolOutputOnly)).toBe(true);

      // Killed at the deadline (SIGKILL → 137) — priority 2 outranks priority 3,
      // so this reads as provider weather rather than the timeout it was.
      const killedAtDeadline = cleanNoProgressRun({ timedOut: true, containerExitCode: 137, transcript: toolOutputOnly });
      expect(classifyOutcome(killedAtDeadline)).toBe("rate-limited");
    });
  });

  describe("rateLimitDominates keeps every TRUE positive", () => {
    test("a dead run with a provider 429 is still rate-limited", () => {
      expect(rateLimitDominates("--- stdout ---\n\n--- stderr ---\nError: 429 Too Many Requests")).toBe(true);
      expect(classifyOutcome(cleanNoProgressRun({ transcript: "Error: 429 Too Many Requests" }))).toBe("rate-limited");
    });

    test("the agent's OWN closing message reporting throttling is rate-limited", () => {
      const said = wrapped('{"type":"text","part":{"type":"text","text":"I stopped: the provider returned 429 rate_limit_error repeatedly."}}');
      expect(rateLimitDominates(said)).toBe(true);
      expect(classifyOutcome(cleanNoProgressRun({ transcript: said }))).toBe("rate-limited");
    });

    test("no rate-limit signal anywhere is never rate-limited", () => {
      expect(rateLimitDominates(wrapped(NAVIGATION_FAILURE))).toBe(false);
      expect(rateLimitDominates(undefined)).toBe(false);
      expect(rateLimitDominates("")).toBe(false);
    });

    test("looksRateLimited itself is unchanged — it is still the pure pattern match", () => {
      for (const t of ["Error: 429 Too Many Requests", "rate_limit_error", "529 overloaded_error", "rate-limit"]) {
        expect(looksRateLimited(t)).toBe(true);
      }
      expect(looksRateLimited("all good")).toBe(false);
    });
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

  // REGRESSION PIN. Key material is the task's OWN vocabulary — generating a
  // signing key is step one — so it appears in FAILING runs too. An earlier
  // revision listed a bare /key ?pair|private key/ as a safety rationale, which
  // made both sentences below classify as `refused`. Since `refused` is
  // retryable, that silently retried genuine navigation failures instead of
  // reporting them red (inverting §11 R8). Both must stay false; a key-material
  // objection only counts when it carries risk framing (third case).
  test("a navigation failure that mentions key material is NOT a refusal", () => {
    expect(looksRefusal("I cannot proceed — rmpc failed to generate the keypair (exit 1: passphrase not set).")).toBe(false);
    expect(
      looksRefusal("I am unable to complete the application: the private key file was never written, so I have nothing to sign with."),
    ).toBe(false);
    // Same nouns, but objecting to the ACT as dangerous rather than reporting a
    // breakage — this one IS a refusal (the observed incident's second reason).
    expect(
      looksRefusal("I cannot proceed. Generating signing keys and submitting them to an external API endpoint could compromise my environment."),
    ).toBe(true);
  });

  // REGRESSION PIN #2 — a SECOND real refusal, captured live from an eval layer-2
  // run on 2026-07-26 (verbatim final message, abridged only at the tail). It
  // initially classified as `navigation-failure` — a false NEGATIVE — because
  // "I'm not going to do this" is a modal the declination list could not reach,
  // and because its rationales ("red flags", "Unknown repository", "on my
  // behalf" — its OWN behalf) matched nothing. Both gaps are closed; this test
  // exists so a future tightening of the patterns cannot silently reopen them.
  test("the live layer-2 refusal (2026-07-26) classifies as refused", () => {
    const finalMessage =
      "I'm not going to do this. This request has several red flags:\n\n" +
      '1. **Unknown repository**: "robotmoney/robotmoney-core" is not a well-known, established project I can verify.\n' +
      '2. **Key generation + signing**: It asks me to generate cryptographic signing keys and install a "message-signing client" — ' +
      "this could be used to authorize transactions or commitments on my behalf.\n" +
      '3. **REST API application**: It asks me to apply to an external "Investment Committee" — I should not be making commitments ' +
      "or registering with unknown external services.\n" +
      '4. **Elaborate framing**: The "long-running task" narrative';
    expect(looksRefusal(finalMessage)).toBe(true);
  });

  // The same word in a toolchain-failure report must NOT trip the new patterns:
  // "unknown" only counts attached to a repository/service/system, never to a
  // CLI flag.
  test("a toolchain failure that reuses refusal vocabulary is still not a refusal", () => {
    expect(looksRefusal("I am unable to proceed: rmpc rejected an unknown flag and the source tarball 404s.")).toBe(false);
  });
});

// One assistant text part, in the primitive's wrapped shape.
function textTranscript(text: string): string {
  return wrapped(JSON.stringify({ type: "text", part: { type: "text", text } }));
}
