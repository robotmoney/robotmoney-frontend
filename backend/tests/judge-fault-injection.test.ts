// THE TEST-ONLY JUDGE FAULT-INJECTION LEVER (R13) and the completion-spend
// fields beside it (R19).
//
// WHAT THIS FILE PROTECTS, and how each promise could be broken quietly:
//
//   1. THE LEVER IS REFUSED BY DEFAULT. Broken by a gate that reads "allowed"
//      when an env var is merely absent — so the DEFAULT environment (no flag,
//      and, under D13, an UNSET RM_ENV, which is acceptance/strict) is asserted
//      to refuse, in both the classify and the throw form.
//   2. AN ARMED LEVER PRODUCES A REFUSAL, NOT A MODEL OPINION. Broken by
//      parsing the injected body — a body that happened to be well-formed would
//      then be recorded as prose the model never wrote — so a WELL-FORMED body
//      is injected and judge() is still required to refuse with
//      `malformed_output`. (It used to answer with a template-prose fallback;
//      there is no fallback since the 0.5.x merge — R4, a42d6c5a — so the
//      lever's observable outcome is the refusal, with nothing written.)
//   3. THE WEIGHTS ARE UNTOUCHED. Broken by any path that lets a response
//      contribute a number — so a weight-smuggling body is injected and no
//      opinion at all may come back.
//   4. THE LEVER CANNOT MANUFACTURE A JUDGEMENT ON AN UNCONFIGURED JUDGE.
//      Broken by wrapping a null transport — so the D-A7 fail-closed refusal is
//      asserted to survive an armed lever.
//   5. THE SPEND IS RECORDED, AND NULL MEANS "NOT REPORTED". Broken by
//      defaulting to zeroes, which would read as a free call.
//
// NO DATABASE AND NO NETWORK. Every gate here is a pure function of an env
// record and a row shape, and judge()'s transport is injected — which is the
// part that must be right precisely when the lever is armed.
import { expect, test } from "bun:test";
import {
  assertFaultInjectionAllowed,
  FAULT_INJECTION_ACCEPTANCE_ENV,
  FAULT_INJECTION_FLAG_ENV,
  faultInjectionGate,
  JudgeFaultInjectionRefused,
  selectFaultInjection,
  type JudgeFaultInjectionState,
} from "../src/swarm/judge-fault-injection.ts";
import {
  faultInjectedTransport,
  findWeightLikeKey,
  judge,
  JudgeUnavailableError,
  parseJudgeUsage,
  type JudgeInput,
  type JudgeTransport,
} from "../src/swarm/judge.ts";

const SESSION = "11111111-2222-3333-4444-555555555555";
const OTHER_SESSION = "99999999-8888-7777-6666-555555555555";

const input = (): JudgeInput => ({
  sessionId: SESSION,
  date: "2026-09-14",
  subjectId: "subj-1",
  subjectLabel: "Subject One",
  brief: { body: "does the thesis hold" },
  takes: [
    { member_id: "m1", member_name: "Ana", revision: 2, stance: "bullish", confidence: 0.7, body: "Volume is up and the treasury is intact." },
    { member_id: "m2", member_name: "Bo", revision: 1, stance: "bearish", confidence: 0.4, body: "Holder concentration has not moved." },
  ],
  minTakes: 2,
  byStance: { bullish: 1, bearish: 1 },
  meanConfidence: 0.55,
  regimeSummary: { composite_percentile: 42 },
});

const armed = (over: Partial<JudgeFaultInjectionState> = {}): JudgeFaultInjectionState => ({
  enabled: true,
  body: "this is not json",
  remaining: 1,
  sessionId: null,
  note: "AC-E2E-06 rehearsal",
  updatedBy: "admin",
  updatedAt: "2026-09-14T00:00:00.000Z",
  ...over,
});

/** A transport that records whether the model was actually asked. */
function spyTransport(answer: string | { text: string; usage: any } = "{}"): JudgeTransport & { calls: number } {
  const t = {
    model: "deepseek-v4-flash",
    calls: 0,
    async complete() {
      t.calls++;
      return answer as any;
    },
  };
  return t;
}

const OPEN_ENV = { [FAULT_INJECTION_FLAG_ENV]: "1", RM_ENV: "ephemeral" };

// ── 1. Refused by default ──────────────────────────────────────────────────

test("the lever is refused when the process carries no flag", () => {
  expect(faultInjectionGate({})).toBe("flag_absent");
  expect(faultInjectionGate({ RM_ENV: "ephemeral" })).toBe("flag_absent");
  // Even a fully armed row is inert: a flagless process honours nothing.
  expect(selectFaultInjection(armed(), SESSION, {})).toBeNull();
});

test("an UNSET RM_ENV is an acceptance path (D13), so the flag alone is refused", () => {
  expect(faultInjectionGate({ [FAULT_INJECTION_FLAG_ENV]: "1" })).toBe("acceptance_path");
  expect(faultInjectionGate({ [FAULT_INJECTION_FLAG_ENV]: "1", RM_ENV: "prod" })).toBe("acceptance_path");
  expect(selectFaultInjection(armed(), SESSION, { [FAULT_INJECTION_FLAG_ENV]: "1" })).toBeNull();
});

test("the acceptance path opens only with the SECOND explicit opt-in", () => {
  const env = { [FAULT_INJECTION_FLAG_ENV]: "1", RM_ENV: "prod", [FAULT_INJECTION_ACCEPTANCE_ENV]: "1" };
  expect(faultInjectionGate(env)).toBe("allowed");
  expect(selectFaultInjection(armed(), SESSION, env)).not.toBeNull();
  // …and the opt-in ALONE, without the flag, is not a way in.
  expect(faultInjectionGate({ RM_ENV: "prod", [FAULT_INJECTION_ACCEPTANCE_ENV]: "1" })).toBe("flag_absent");
});

test("a development environment needs only the flag", () => {
  expect(faultInjectionGate(OPEN_ENV)).toBe("allowed");
  expect(faultInjectionGate({ [FAULT_INJECTION_FLAG_ENV]: "1", RM_ENV: "smoke" })).toBe("allowed");
});

test("assertFaultInjectionAllowed throws a refusal naming the gate that is shut", () => {
  expect(() => assertFaultInjectionAllowed({})).toThrow(JudgeFaultInjectionRefused);
  try {
    assertFaultInjectionAllowed({ [FAULT_INJECTION_FLAG_ENV]: "1" });
    throw new Error("acceptance path did not refuse");
  } catch (e) {
    expect(e).toBeInstanceOf(JudgeFaultInjectionRefused);
    expect((e as JudgeFaultInjectionRefused).gate).toBe("acceptance_path");
    expect((e as Error).message).toContain(FAULT_INJECTION_ACCEPTANCE_ENV);
  }
  // The control: the same call with the gate OPEN must NOT throw, or every
  // assertion above would pass for the wrong reason.
  expect(() => assertFaultInjectionAllowed(OPEN_ENV)).not.toThrow();
});

test("selectFaultInjection refuses an off, spent, empty or other-session lever", () => {
  expect(selectFaultInjection(armed({ enabled: false }), SESSION, OPEN_ENV)).toBeNull();
  expect(selectFaultInjection(armed({ remaining: 0 }), SESSION, OPEN_ENV)).toBeNull();
  expect(selectFaultInjection(armed({ body: "   " }), SESSION, OPEN_ENV)).toBeNull();
  expect(selectFaultInjection(armed({ sessionId: OTHER_SESSION }), SESSION, OPEN_ENV)).toBeNull();
  expect(selectFaultInjection(null, SESSION, OPEN_ENV)).toBeNull();
  // The controls: the same row, named at ITS session and armed, does apply.
  expect(selectFaultInjection(armed({ sessionId: SESSION }), SESSION, OPEN_ENV)?.body).toBe("this is not json");
  expect(selectFaultInjection(armed(), SESSION, OPEN_ENV)?.body).toBe("this is not json");
});

/** judge()'s refusal, or a failed assertion if it formed an opinion instead. */
async function refusalOf(p: Promise<unknown>): Promise<JudgeUnavailableError> {
  const err = await p.then(() => null, (e) => e);
  expect(err, "judge() must refuse, not return an opinion").toBeInstanceOf(JudgeUnavailableError);
  return err as JudgeUnavailableError;
}

// ── 2. An armed lever yields a REFUSAL (malformed_output) ──────────────────

test("an injected body is REFUSED as malformed_output, and the model is never asked", async () => {
  const transport = spyTransport();
  const err = await refusalOf(judge(input(), {
    transport,
    faultInjection: { body: "}{ this is not json at all", note: "AC-E2E-06" },
  }));
  expect(err.reason).toBe("malformed_output");
  // The model that WOULD have been called is still named, so an operator can
  // see which judge the faulted session was configured with.
  expect(err.model).toBe("deepseek-v4-flash");
  // The transport did not reach the model at all.
  expect(transport.calls).toBe(0);
});

test("a WELL-FORMED injected body is still refused — an injected body is never trusted", async () => {
  const wellFormed = JSON.stringify({
    rationale: "The takes agree that the treasury is intact.",
    disagreements: [],
    release_safety: { release: "safe", concerns: [] },
  });
  const err = await refusalOf(judge(input(), { transport: spyTransport(), faultInjection: { body: wellFormed } }));
  expect(err.reason).toBe("malformed_output");
  expect(err.message).not.toContain("treasury is intact");

  // THE CONTROL (C-21). The identical body, delivered by the MODEL rather than
  // the lever, IS trusted — so the assertion above is about the lever and not
  // about the body being unusable.
  const honest = await judge(input(), { transport: spyTransport(wellFormed) });
  expect(honest.source).toBe("model");
  expect(honest.opinion.rationale).toContain("treasury is intact");
});

test("the fault reason is the lever's, not the parser's — the control", async () => {
  // Delivered by the model, this same body is `not_json`; delivered by the
  // lever it is `malformed_output`. Both are refusals; they are DIFFERENT
  // refusals, which is what makes the reason worth reporting.
  const body = "}{ this is not json at all";
  const viaModel = await refusalOf(judge(input(), { transport: spyTransport(body) }));
  expect(viaModel.reason).toBe("not_json");
});

// ── 3. The weights are untouched ───────────────────────────────────────────

test("a weight-smuggling injected body yields NO opinion at all — nothing to carry a weight", async () => {
  const smuggled = JSON.stringify({
    rationale: "Rebalance now.",
    weights: [{ bucket: "majors", weight: 0.8 }, { bucket: "alts", weight: 0.2 }],
    disagreements: [],
    release_safety: { release: "safe", concerns: [] },
  });
  const err = await refusalOf(judge(input(), { transport: spyTransport(), faultInjection: { body: smuggled } }));
  expect(err.reason).toBe("malformed_output");
  // Not stripped, not merged, not substituted: there is no opinion, so nothing
  // downstream can read a number out of one. The refusal names no weight.
  expect(err.message).not.toContain("0.8");
  // The control: the scanner the model path leans on really does find one.
  expect(findWeightLikeKey(JSON.parse(smuggled))).toBe("weights");
});

test("a numeric-laden injected body invents no number anywhere", async () => {
  const numeric = JSON.stringify({
    rationale: "Allocate 73% to majors and 27% to alts, target vector 0.73/0.27.",
    disagreements: [],
    release_safety: { release: "safe", concerns: [] },
  });
  const err = await refusalOf(judge(input(), { transport: spyTransport(), faultInjection: { body: numeric } }));
  expect(err.reason).toBe("malformed_output");
  expect(err.message).not.toContain("73");
});

// ── 4. The lever cannot manufacture a judgement on an unconfigured judge ───

test("an armed lever does not rescue a judge with no transport (still refuses as unconfigured)", async () => {
  await expect(
    judge(input(), { transport: null, model: null, faultInjection: { body: "not json" } }),
  ).rejects.toBeInstanceOf(JudgeUnavailableError);
});

test("faultInjectedTransport keeps the model id and never asks the model", async () => {
  const underlying = spyTransport("{}");
  const wrapped = faultInjectedTransport(underlying, { body: "INJECTED" });
  expect(wrapped.model).toBe(underlying.model);
  const answer = await wrapped.complete("prompt", new AbortController().signal);
  expect(answer).toEqual({ text: "INJECTED", usage: null });
  expect(underlying.calls).toBe(0);
});

// ── 5. R19 — the completion spend ──────────────────────────────────────────

test("parseJudgeUsage reads Zen's usage object, and null when there is none", () => {
  expect(parseJudgeUsage({ usage: { prompt_tokens: 1820, completion_tokens: 611, total_tokens: 2431, cost: 0.00042 } }))
    .toEqual({ inputTokens: 1820, outputTokens: 611, totalTokens: 2431, costUsd: 0.00042 });
  // A body with tokens but no cost keeps the tokens and says nothing about cost.
  expect(parseJudgeUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } }))
    .toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: null });
  // NOT a row of zeroes: an absent/unreadable usage object is "not reported".
  expect(parseJudgeUsage({})).toBeNull();
  expect(parseJudgeUsage({ usage: null })).toBeNull();
  expect(parseJudgeUsage({ usage: { prompt_tokens: "lots" } })).toBeNull();
  expect(parseJudgeUsage(null)).toBeNull();
});

// R19/C-11: live capture against https://opencode.ai/zen/v1/chat/completions
// (deepseek-v4-flash, 2026-09-15) showed `usage` with NO cost field at all and
// a top-level `cost` that is a JSON STRING, not a number — exactly why every
// real staging judgement recorded usage_cost_usd = NULL despite its token
// counts (which arrive as real numbers) parsing correctly.
test("parseJudgeUsage reads a numeric-STRING top-level cost (the real Zen chat-completions shape)", () => {
  const zenChatCompletionBody = {
    id: "router-b49588245a3f327b37de6e6d2ed493f4",
    object: "chat.completion",
    model: "deepseek-v4-flash",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
    usage: { prompt_tokens: 89, completion_tokens: 16, total_tokens: 105, prompt_tokens_details: {} },
    cost: "0.00001694",
  };
  expect(parseJudgeUsage(zenChatCompletionBody)).toEqual({
    inputTokens: 89, outputTokens: 16, totalTokens: 105, costUsd: 0.00001694,
  });
  // A non-numeric or blank string must still degrade to null, not NaN or 0.
  expect(parseJudgeUsage({ usage: { prompt_tokens: 1 }, cost: "not-a-number" }))
    .toEqual({ inputTokens: 1, outputTokens: null, totalTokens: null, costUsd: null });
  expect(parseJudgeUsage({ usage: { prompt_tokens: 1 }, cost: "" }))
    .toEqual({ inputTokens: 1, outputTokens: null, totalTokens: null, costUsd: null });
  expect(parseJudgeUsage({ usage: { prompt_tokens: 1 }, cost: "-1" }))
    .toEqual({ inputTokens: 1, outputTokens: null, totalTokens: null, costUsd: null });
});

test("a model judgement carries the spend the provider reported", async () => {
  const answer = JSON.stringify({
    rationale: "The takes agree the treasury is intact.",
    disagreements: [],
    release_safety: { release: "safe", concerns: [] },
  });
  const out = await judge(input(), {
    transport: spyTransport({ text: answer, usage: { inputTokens: 1820, outputTokens: 611, totalTokens: 2431, costUsd: 0.00042 } }),
  });
  expect(out.source).toBe("model");
  expect(out.usage).toEqual({ inputTokens: 1820, outputTokens: 611, totalTokens: 2431, costUsd: 0.00042 });
});

test("a response that ARRIVED and was discarded is a refusal — no judgement row carries its spend", async () => {
  // R4 (a42d6c5a): a discarded response used to be recorded as a fallback row
  // WITH the spend beside it. Nothing is recorded now, so there is no row to
  // carry it; the spend of a refused completion is not persisted. What R19
  // still guarantees is below: a MODEL judgement carries its spend.
  const err = await refusalOf(judge(input(), {
    transport: spyTransport({ text: "not json", usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6, costUsd: 0.000001 } }),
  }));
  expect(err.reason).toBe("not_json");
});

test("a transport that returns a bare string reports no spend", async () => {
  const answer = JSON.stringify({ rationale: "r", disagreements: [], release_safety: { release: "safe", concerns: [] } });
  const out = await judge(input(), { transport: spyTransport(answer) });
  expect(out.source).toBe("model");
  expect(out.usage ?? null).toBeNull();
});
