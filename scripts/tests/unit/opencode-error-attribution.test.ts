// The cause of a dead opencode run must come from the run's OWN error event —
// never from a guess about an empty stderr.
//
// The regression these pin, observed live on 2026-08-05: the opencode Zen
// workspace ran out of balance at ~15:09Z. `opencode run --format json` reports
// that as a first-class `{"type":"error",…}` line on STDOUT carrying
// `statusCode: 401`, `isRetryable: false` and the provider's own message, and
// writes NOTHING to stderr. Every consumer in this repo dropped that line:
//
//   - the swarm driver threw "stderr was empty, so the likely causes are
//     provider-side: the model was unreachable, rate-limited, unfunded, or
//     returned nothing" — a guess, printed over a stated fact, and labelled the
//     account "(funded)" because a key happened to be set;
//   - the onboarding classifier saw a non-zero exit with no final text and
//     returned `navigation-failure`, "the one outcome that is a real,
//     never-retried red result" — recording a lapsed invoice as evidence that
//     our onboarding instructions do not work.
//
// Six consecutive e2e failures across main and PR #513 were read as an
// intermittent provider outage on that basis, and three autofix reruns were
// spent on a fault whose own payload said `isRetryable: false`.
//
// Hermetic: no container, no network, no model call. The payload is the real
// one, replayed from scripts/tests/fixtures (workspace id scrubbed).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeTranscriptError, redactProviderText, transcriptErrors } from "../../agent/transcript.ts";
import { emptyTranscriptCause } from "../../lib/swarm/inference.ts";
import { classifyInferenceFailure } from "../../agent/inference-failure.ts";
import {
  classifyOutcome,
  type ClassifiableRun,
  explainOutcome,
  harnessFaultOf,
  shouldRetry,
} from "../../agent/classify-outcome.ts";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8");

const INSUFFICIENT_BALANCE = fixture("member-agent-provider-insufficient-balance.ndjson");

// The shape runMemberAgent's transcript actually takes (banners around the two
// drained pipes) — every consumer must read the payload through it, not around it.
const wrapped = (ndjson: string, stderr = ""): string => `--- stdout ---\n${ndjson}\n--- stderr ---\n${stderr}`;

// A finalized assistant text part, for the runs that must NOT be reclassified.
const textPart = (text: string) => JSON.stringify({ type: "text", part: { type: "text", text } });

describe("transcriptErrors — the provider's own account of the failure", () => {
  test("reads the real Insufficient-balance payload: typed discriminator, status, retryability, endpoint", () => {
    const errors = transcriptErrors(INSUFFICIENT_BALANCE);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toEqual({
      name: "APIError",
      // Lifted out of the raw responseBody envelope — the only field that
      // distinguishes an empty balance from any other 401.
      providerType: "CreditsError",
      // The workspace-scoped billing URL is redacted at PARSE time: these
      // errors are printed into CI logs and PR comments.
      message: "Insufficient balance. Manage your billing here: [redacted workspace url]",
      statusCode: 401,
      isRetryable: false,
      url: "https://opencode.ai/zen/v1/chat/completions",
    });
  });

  test("parses through the member-agent's stdout/stderr banners", () => {
    expect(transcriptErrors(wrapped(INSUFFICIENT_BALANCE))).toHaveLength(2);
  });

  test("a transcript with no error event yields none — silence is never invented", () => {
    for (const t of ["", "   ", "not json at all", textPart("a real take"), '{"type":"step_start"}']) {
      expect(transcriptErrors(t)).toEqual([]);
    }
  });

  test("degrades to a named error when the payload is flattened or partial", () => {
    const flat = JSON.stringify({ type: "error", error: { name: "APIError", message: "boom" } });
    expect(transcriptErrors(flat)).toEqual([
      { name: "APIError", providerType: "", message: "boom", statusCode: null, isRetryable: null, url: null },
    ]);
    expect(transcriptErrors('{"type":"error"}')).toEqual([
      { name: "", providerType: "", message: "", statusCode: null, isRetryable: null, url: null },
    ]);
  });

  test("describeTranscriptError states the verdict a reader needs, retryability included", () => {
    const line = describeTranscriptError(transcriptErrors(INSUFFICIENT_BALANCE)[0]!);
    expect(line).toContain("APIError: Insufficient balance.");
    expect(line).toContain("CreditsError");
    expect(line).toContain("HTTP 401");
    expect(line).toContain("NOT retryable");
  });
});

describe("emptyTranscriptCause — evidence first, inference last", () => {
  test("names the structured error instead of speculating about the provider", () => {
    const cause = emptyTranscriptCause(INSUFFICIENT_BALANCE, "");
    expect(cause).toContain("cause=exhausted-credits");
    expect(cause).toContain("Insufficient balance.");
    expect(cause).toContain("HTTP 401");
    expect(cause).toContain("NOT retryable");
    expect(cause).toContain("top it up");
    expect(cause).toContain("NOT an application regression");
    // The retired guess, which is what the six CI failures actually printed.
    expect(cause).not.toContain("the likely causes are provider-side");
  });

  test("an error event on stdout outranks stderr — the guess never reappears alongside a fact", () => {
    const cause = emptyTranscriptCause(INSUFFICIENT_BALANCE, "some unrelated CLI chatter");
    expect(cause).toContain("Insufficient balance.");
    expect(cause).not.toContain("some unrelated CLI chatter");
  });

  test("a retryable error is not mislabelled as needing a human", () => {
    const throttled = JSON.stringify({
      type: "error",
      error: { name: "APIError", data: { message: "Too many requests", statusCode: 429, isRetryable: true } },
    });
    const cause = emptyTranscriptCause(throttled, "");
    expect(cause).toContain("cause=throttled");
    expect(cause).toContain("HTTP 429");
    expect(cause).toContain("worth retrying");
    expect(cause).not.toContain("top it up");
  });

  test("with no error event, a non-empty stderr still points at the LOCAL CLI (2026-07-30 incident)", () => {
    const cause = emptyTranscriptCause("", "SQLITE_ERROR: no such table: session");
    expect(cause).toContain("cause=local-cli-failure");
    expect(cause).toContain("died locally");
    expect(cause).toContain("SQLITE_ERROR");
  });

  test("with neither, it says the cause is unknown rather than naming a culprit", () => {
    const cause = emptyTranscriptCause("", "");
    expect(cause).toContain("cause=empty-response");
    expect(cause).toContain("NO error event");
    expect(cause).toContain("nothing named a cause");
    expect(cause).not.toContain("top it up");
  });
});

describe("a rejected harness credential is not a product result", () => {
  // The exact shape of the 2026-08-05 layer-4 samples: container exited 1, no
  // member row, no authored text, two 401 error events on stdout.
  const deadOnCredential = (overrides: Partial<ClassifiableRun> = {}): ClassifiableRun => ({
    admitted: false,
    timedOut: false,
    memberId: null,
    containerExitCode: 1,
    transcript: wrapped(INSUFFICIENT_BALANCE),
    ...overrides,
  });

  test("classifies as harness-error, naming the provider's verdict", () => {
    const run = deadOnCredential();
    expect(classifyOutcome(run)).toBe("harness-error");
    const fault = harnessFaultOf(run);
    expect(fault?.kind).toBe("provider-rejected-harness-credential");
    expect(fault?.detail).toContain("HTTP 401");
    expect(fault?.detail).toContain("cause=exhausted-credits");
    expect(fault?.detail).toContain("top it up in the provider's billing settings");
    expect(explainOutcome(run).branch).toBe("harness-fault");
  });

  test("the pre-fix ladder called this navigation-failure — a red result about the product", () => {
    // Same run with the provider's error events stripped out: all that is left
    // is the silence the old ladder judged on, and it lands on the red rung.
    const withoutErrorEvents = deadOnCredential({
      transcript: wrapped(
        INSUFFICIENT_BALANCE.split("\n").filter((l) => !l.includes('"type":"error"')).join("\n"),
      ),
    });
    expect(classifyOutcome(withoutErrorEvents)).toBe("navigation-failure");
  });

  test("it is never retried: retrying an unpaid account burns the sweep", () => {
    expect(shouldRetry(classifyOutcome(deadOnCredential()))).toBe(false);
  });

  test("an admitted run is never reclassified, even carrying the same error events", () => {
    expect(classifyOutcome(deadOnCredential({ admitted: true, memberId: "m_1" }))).toBe("admitted");
  });

  test("a run that AUTHORED a take keeps its real result — the side title call may fail alone", () => {
    // opencode issues a small `agent=title` call beside the agent's own; when
    // only that one is rejected the run is still a genuine measurement.
    const authored = deadOnCredential({
      containerExitCode: 0,
      transcript: wrapped(`${INSUFFICIENT_BALANCE}\n${textPart("I installed rmpc and submitted the application.")}`),
    });
    expect(harnessFaultOf(authored)).toBeNull();
    expect(classifyOutcome(authored)).not.toBe("harness-error");
  });

  test("a RETRYABLE provider error stays provider weather, not a harness fault", () => {
    const throttled = deadOnCredential({
      transcript: wrapped(JSON.stringify({
        type: "error",
        error: { name: "APIError", data: { message: "Too many requests", statusCode: 429, isRetryable: true } },
      })),
    });
    expect(harnessFaultOf(throttled)).toBeNull();
    expect(classifyOutcome(throttled)).toBe("rate-limited");
  });
});

// ── Issue #527: the KIND is read off the provider's typed discriminator ──────
// `exhausted-credits` is the one kind that sends a maintainer to a billing
// page, so it must fire on Zen's typed CreditsError and on NOTHING else. A
// bare 401, an "Insufficient balance" substring in unrelated prose, a monthly
// cap and a throttle each keep their own classification.
describe("classifyInferenceFailure — typed discriminator decides, prose never does", () => {
  const errorEvent = (data: Record<string, unknown>, name = "APIError") =>
    JSON.stringify({ type: "error", error: { name, data } });
  const zenBody = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } });
  const kindOf = (ndjson: string, stderr = "") =>
    classifyInferenceFailure(transcriptErrors(ndjson), stderr).kind;

  test("the real captured payload classifies as exhausted-credits", () => {
    const c = classifyInferenceFailure(transcriptErrors(INSUFFICIENT_BALANCE));
    expect(c.kind).toBe("exhausted-credits");
    expect(c.retryable).toBe(false);
    expect(c.error?.providerType).toBe("CreditsError");
  });

  // THE RED CONTROL #527 asks for by name: same 401, same "Insufficient
  // balance" text, different typed discriminator. Credit exhaustion must NOT
  // fire — a revoked key is not a billing problem.
  test("AuthError carrying HTTP 401 and the words 'Insufficient balance' is NOT exhausted credits", () => {
    const kind = kindOf(errorEvent({
      message: "Insufficient balance. Manage your billing here: https://opencode.ai/workspace/wrk_X1Y2Z3A4B5/billing",
      statusCode: 401,
      isRetryable: false,
      responseBody: zenBody("AuthError", "Invalid API key."),
    }));
    expect(kind).toBe("auth-rejected");
  });

  test.each([
    ["AuthError", zenBody("AuthError", "Invalid API key."), 401, "auth-rejected"],
    ["MonthlyLimitError", zenBody("MonthlyLimitError", "Monthly limit reached."), 429, "quota-limited"],
    ["UserLimitError", zenBody("UserLimitError", "User limit reached."), 429, "quota-limited"],
    ["untyped 429", "", 429, "throttled"],
    ["untyped 529", "", 529, "throttled"],
    ["provider 5xx", "", 503, "provider-failure"],
    ["untyped 401", "", 401, "auth-rejected"],
    ["untyped 403", "", 403, "auth-rejected"],
  ] as const)("%s classifies as %s and never as exhausted credits", (_label, body, statusCode, expected) => {
    const kind = kindOf(errorEvent({ statusCode, message: "…", responseBody: body || undefined }));
    expect(kind).toBe(expected);
    expect(kind).not.toBe("exhausted-credits");
  });

  test("an error event with no status and no type is unclassified, not credits", () => {
    expect(kindOf(errorEvent({ message: "something went sideways" }))).toBe("unclassified-error");
  });

  test("malformed JSON on stdout is an empty response, not credits", () => {
    expect(kindOf("{not json at all\n<html>502 Bad Gateway</html>")).toBe("empty-response");
    expect(kindOf("{not json at all", "boom")).toBe("local-cli-failure");
  });

  test("a truly empty response is its own kind, and nothing is invented for it", () => {
    const c = classifyInferenceFailure([], "");
    expect(c.kind).toBe("empty-response");
    expect(c.error).toBeNull();
  });

  test("only the throttle is retryable — every other kind needs a human", () => {
    expect(classifyInferenceFailure(transcriptErrors(errorEvent({ statusCode: 429 }))).retryable).toBe(true);
    for (const ndjson of [INSUFFICIENT_BALANCE, errorEvent({ statusCode: 401 }), errorEvent({ statusCode: 503 })]) {
      expect(classifyInferenceFailure(transcriptErrors(ndjson)).retryable).toBe(false);
    }
  });

  test("the session-title call's duplicate error event does not change the verdict", () => {
    // opencode issues a small `agent=title` call beside the agent's own, so one
    // root cause reaches the stream twice; both name the same fault.
    const c = classifyInferenceFailure(transcriptErrors(INSUFFICIENT_BALANCE));
    expect(transcriptErrors(INSUFFICIENT_BALANCE)).toHaveLength(2);
    expect(c.kind).toBe("exhausted-credits");
  });

  test("an unclassifiable first event does not mask a classified second one", () => {
    const stream = `${errorEvent({ message: "unlabelled" })}\n${INSUFFICIENT_BALANCE}`;
    expect(kindOf(stream)).toBe("exhausted-credits");
  });
});

describe("redaction — the diagnosis names the fault, never the account or the key", () => {
  const PLANTED_KEY = "sk-planted-zen-key-abcdef123456";
  const PLANTED_WORKSPACE = "wrk_01KYMNGS96XZEV3RQ994DFJSVT";
  const PLANTED_ACCOUNT = "acc_01HZZZACCOUNTID9999";
  const leaky = JSON.stringify({
    type: "error",
    error: {
      name: "APIError",
      data: {
        message:
          `Insufficient balance for ${PLANTED_ACCOUNT} (key ${PLANTED_KEY}). ` +
          `Manage your billing here: https://opencode.ai/workspace/${PLANTED_WORKSPACE}/billing`,
        statusCode: 401,
        isRetryable: false,
        responseBody: JSON.stringify({ type: "error", error: { type: "CreditsError", message: "Insufficient balance." } }),
        metadata: { url: `https://opencode.ai/workspace/${PLANTED_WORKSPACE}/billing` },
      },
    },
  });

  test("key, workspace id, account id and the workspace URL are gone from the STRUCTURED error", () => {
    const [e] = transcriptErrors(leaky, [PLANTED_KEY]);
    const serialized = JSON.stringify(e);
    for (const secret of [PLANTED_KEY, PLANTED_WORKSPACE, PLANTED_ACCOUNT, "/workspace/"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("…and from the RENDERED diagnostic, while provider, model class and the billing action survive", () => {
    const rendered = emptyTranscriptCause(leaky, "");
    for (const secret of [PLANTED_KEY, PLANTED_WORKSPACE, PLANTED_ACCOUNT, "/workspace/"]) {
      expect(rendered).not.toContain(secret);
    }
    expect(rendered).toContain("CreditsError");
    expect(rendered).toContain("Insufficient balance");
    expect(rendered).toContain("[redacted workspace url]");
    expect(rendered).toContain("top it up in the provider's billing settings");
  });

  test("redactProviderText leaves ordinary diagnostic prose untouched", () => {
    const plain = "Invalid API key. Check the configured credential.";
    expect(redactProviderText(plain)).toBe(plain);
  });

  test("a short or empty planted secret is never used as a redaction needle", () => {
    // Guard against turning every character into "[redacted credential]".
    expect(redactProviderText("balance is low", ["", "ab"])).toBe("balance is low");
  });
});
