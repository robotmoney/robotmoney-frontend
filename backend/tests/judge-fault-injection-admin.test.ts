// THE LEVER'S ADMIN PATH AND ITS EFFECT ON A REAL SESSION (R13), and the
// persisted completion spend (R19).
//
// The pure gates are covered by judge-fault-injection.test.ts. This file is the
// half that needs a database, and it protects four things:
//
//   1. ARMING IS REFUSED ON THE DEFAULT PATH, and the refusal is a 403 an
//      operator can act on rather than an inert row they believe is working.
//   2. ARMING WRITES AN AUDIT ROW — the artifact an acceptance bundle cites to
//      bound the window during which the stack was mutated — and that row does
//      NOT carry the injected body.
//   3. AN ARMED LEVER FAULTS A REAL JUDGING: the session's judgement row reads
//      `source='fallback'`, `fallback_reason='malformed_output'`, and the
//      SESSION'S WEIGHT VECTOR IS BYTE-FOR-BYTE WHAT IT WAS BEFORE.
//   4. THE JUDGEMENT ROW RECORDS WHAT THE COMPLETION COST when the provider
//      reports it, and NULL — not zero — when it does not.
import { afterEach, beforeAll, afterAll, expect, test } from "bun:test";
import * as ic from "../src/swarm/domain.ts";
import * as admin from "../src/swarm/admin.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { judgeSession, setJudgeConfig } from "../src/swarm/judge-session.ts";
import {
  consumeJudgeFaultInjection,
  FAULT_INJECTION_ACCEPTANCE_ENV,
  FAULT_INJECTION_FLAG_ENV,
  getJudgeFaultInjection,
} from "../src/swarm/judge-fault-injection.ts";
import type { JudgeTransport } from "../src/swarm/judge.ts";

useCleanDatabasePerTest(import.meta.file);

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const sessionDate = (s: Record<string, unknown>): string =>
  s.date instanceof Date ? s.date.toISOString().slice(0, 10) : String(s.date).slice(0, 10);

async function activeMember() {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) throw new Error(`activeMember() failed: ${JSON.stringify(r)}`);
  return { id, token: r.token, privateKey };
}

// The CANONICAL FOUR, one entry each. Since T17/D14 a take filed against a
// `bucket_weights` subject that names anything else is refused at submission
// with a 400 `weights_not_canonical_four`, so the two-bucket fixture this test
// was written against can no longer reach a session at all.
const W = [
  { bucket: "agent_tokens", weight: 2 },
  { bucket: "conservative_defi_yield", weight: 1 },
  { bucket: "protocol_tokens", weight: 1 },
  { bucket: "real_world_assets", weight: 0 },
];

async function aggregatedSession(prefix: string, count = 3) {
  const subj = rid(prefix);
  await ic.ensureSubject(subj, `${prefix} subject`);
  await sql`UPDATE swarm_subjects SET recommendation_type = 'bucket_weights' WHERE id = ${subj}`;
  const session = await ic.openSession(subj);
  await ic.publishBrief(session.id, 60);
  const date = sessionDate(session);
  const stances = ["bullish", "cautious", "neutral"];
  for (let i = 0; i < count; i++) {
    const m = await activeMember();
    const sub = {
      memberId: m.id, date, subjectId: subj, nonce: rid("n"),
      stance: stances[i % stances.length]!, confidence: 0.5 + i * 0.1,
      body: `take ${i} on ${subj}`, weights: W,
    };
    const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
    const res = await ic.submitRecommendation(m.token, { ...sub, signature });
    if (res.status !== 201) throw new Error(`submit failed: ${JSON.stringify(res)}`);
  }
  await ic.closeWindow(session.id);
  await ic.aggregateSession(session.id);
  return { subj, session, date };
}

const recOf = async (sessionId: string) =>
  ((await sql`SELECT swarm_recommendation FROM swarm_sessions WHERE id = ${sessionId}`)[0] as any)
    .swarm_recommendation as Record<string, any>;

const judgementOf = async (sessionId: string) =>
  (await sql`
    SELECT source, fallback_reason, model, usage_input_tokens, usage_output_tokens, usage_total_tokens, usage_cost_usd
    FROM swarm_session_judgements WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT 1`)[0] as any;

const MALFORMED = "}{ not json — injected by the AC-E2E-06 lever";

/** Restores whatever the suite's process env carried, test by test. */
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of [FAULT_INJECTION_FLAG_ENV, FAULT_INJECTION_ACCEPTANCE_ENV]) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of [FAULT_INJECTION_FLAG_ENV, FAULT_INJECTION_ACCEPTANCE_ENV]) delete process.env[k];
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
});

// ── 1 + 2. The admin path ─────────────────────────────────────────────────

test("arming the lever is REFUSED by default, and refusing writes no row", async () => {
  const refused = await admin.setJudgeFaultInjectionAdmin({ enabled: true, body: MALFORMED, remaining: 1 });
  expect(refused.ok).toBe(false);
  expect(refused.status).toBe(403);
  expect(refused.error).toBe("fault_injection_refused");
  expect(refused.reason).toBe("flag_absent");
  expect((await getJudgeFaultInjection()).enabled).toBe(false);
  expect(await sql`SELECT 1 FROM audit_log WHERE action = 'judge_fault_injection'`).toHaveLength(0);
});

test("arming writes an audited row that does NOT carry the injected body", async () => {
  process.env[FAULT_INJECTION_FLAG_ENV] = "1";
  const armed = await admin.setJudgeFaultInjectionAdmin({
    enabled: true, body: MALFORMED, remaining: 2, note: "AC-E2E-06 rehearsal",
  });
  expect(armed.ok).toBe(true);
  expect((armed.faultInjection as any).enabled).toBe(true);
  expect((armed.faultInjection as any).remaining).toBe(2);
  // The body is never echoed — not by the write, not by the read.
  expect(JSON.stringify(armed)).not.toContain(MALFORMED);
  expect(JSON.stringify(await admin.getJudgeFaultInjectionAdmin())).not.toContain(MALFORMED);
  // …but WHICH body is armed is still identifiable.
  expect((armed.faultInjection as any).bodyChars).toBe(MALFORMED.length);
  expect((armed.faultInjection as any).bodyDigest).toMatch(/^[0-9a-f]{16}$/);
  expect((armed.warnings as string[])[0]).toContain("TEST-ONLY");

  const rows = await sql`SELECT actor, action, scope FROM audit_log WHERE action = 'judge_fault_injection'` as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].scope.enabled).toBe(true);
  expect(rows[0].scope.acceptanceMutation).toBe(true);
  expect(JSON.stringify(rows[0].scope)).not.toContain(MALFORMED);

  // Disarming is audited too, is never refused, and CLEARS the payload.
  delete process.env[FAULT_INJECTION_FLAG_ENV];
  const off = await admin.setJudgeFaultInjectionAdmin({ enabled: false });
  expect(off.ok).toBe(true);
  const state = await getJudgeFaultInjection();
  expect(state.enabled).toBe(false);
  expect(state.body).toBe("");
  expect(state.remaining).toBe(0);
  expect(await sql`SELECT 1 FROM audit_log WHERE action = 'judge_fault_injection'`).toHaveLength(2);
});

test("an armed lever with no body, or no calls, is refused by the write", async () => {
  process.env[FAULT_INJECTION_FLAG_ENV] = "1";
  expect((await admin.setJudgeFaultInjectionAdmin({ enabled: true, body: "  ", remaining: 1 })).status).toBe(400);
  expect((await admin.setJudgeFaultInjectionAdmin({ enabled: true, body: MALFORMED, remaining: 0 })).status).toBe(400);
  expect((await getJudgeFaultInjection()).enabled).toBe(false);
  // The control: the same call with both present is accepted.
  expect((await admin.setJudgeFaultInjectionAdmin({ enabled: true, body: MALFORMED, remaining: 1 })).ok).toBe(true);
});

test("consuming the lever disarms it at zero", async () => {
  process.env[FAULT_INJECTION_FLAG_ENV] = "1";
  await admin.setJudgeFaultInjectionAdmin({ enabled: true, body: MALFORMED, remaining: 2 });
  await consumeJudgeFaultInjection();
  expect(await getJudgeFaultInjection()).toMatchObject({ enabled: true, remaining: 1 });
  await consumeJudgeFaultInjection();
  const spent = await getJudgeFaultInjection();
  expect(spent).toMatchObject({ enabled: false, remaining: 0, body: "" });
  // A spent lever cannot go negative.
  await consumeJudgeFaultInjection();
  expect((await getJudgeFaultInjection()).remaining).toBe(0);
});

// ── 3. A real judging, faulted ────────────────────────────────────────────

test("an armed lever faults a real judging: fallback prose, named reason, weights untouched", async () => {
  const { session } = await aggregatedSession("fault-lever");
  const before = await recOf(session.id);
  expect(before.weights?.length).toBeGreaterThan(0);

  await setJudgeConfig({ mode: "enforce", model: "test/judge-model" });
  process.env[FAULT_INJECTION_FLAG_ENV] = "1";
  await admin.setJudgeFaultInjectionAdmin({ enabled: true, body: MALFORMED, remaining: 1 });

  // A transport that WOULD have answered perfectly well. The lever is what
  // decides the outcome, not a broken stub.
  const honest: JudgeTransport = {
    model: "test/judge-model",
    complete: async () => JSON.stringify({
      rationale: "A perfectly good model opinion nobody will see.",
      disagreements: [],
      release_safety: { release: "safe", concerns: [] },
    }),
  };
  const result = await judgeSession(session.id, { transport: honest });
  expect(result.ok).toBe(true);
  expect(result.outcome?.source).toBe("fallback");
  expect(result.outcome?.fallbackReason).toBe("malformed_output");

  const row = await judgementOf(session.id);
  expect(row.source).toBe("fallback");
  expect(row.fallback_reason).toBe("malformed_output");
  // THE PROPERTY AC-E2E-06 IS ABOUT: the vector did not move.
  const after = await recOf(session.id);
  expect(JSON.stringify(after.weights)).toBe(JSON.stringify(before.weights));
  expect(after.rationale).not.toContain("nobody will see");
  // …and the lever spent its one call, disarming itself.
  expect(await getJudgeFaultInjection()).toMatchObject({ enabled: false, remaining: 0 });
});

test("a weight-smuggling injected body is ignored, vector unchanged — and the CONTROL that the judge was otherwise live", async () => {
  const { session } = await aggregatedSession("fault-smuggle");
  const before = await recOf(session.id);
  await setJudgeConfig({ mode: "enforce", model: "test/judge-model" });
  process.env[FAULT_INJECTION_FLAG_ENV] = "1";
  const smuggled = JSON.stringify({
    rationale: "Rebalance to these targets.",
    weights: [{ bucket: "agent_tokens", weight: 0.99 }, { bucket: "protocol", weight: 0.01 }],
    disagreements: [],
    release_safety: { release: "safe", concerns: [] },
  });
  await admin.setJudgeFaultInjectionAdmin({ enabled: true, body: smuggled, remaining: 1 });

  const honest: JudgeTransport = { model: "test/judge-model", complete: async () => smuggled };
  const faulted = await judgeSession(session.id, { transport: honest });
  expect(faulted.outcome?.fallbackReason).toBe("malformed_output");
  const after = await recOf(session.id);
  expect(JSON.stringify(after.weights)).toBe(JSON.stringify(before.weights));
  expect(JSON.stringify(after)).not.toContain("0.99");

  // THE CONTROL (C-21). With the lever disarmed, the SAME wiring produces a
  // model-sourced judgement — so the assertions above are about the lever and
  // not about a judge that was never running.
  const { session: live } = await aggregatedSession("fault-control");
  await admin.setJudgeFaultInjectionAdmin({ enabled: false });
  const good: JudgeTransport = {
    model: "test/judge-model",
    complete: async () => JSON.stringify({
      rationale: "The takes converge on a constructive read of the subject.",
      disagreements: [],
      release_safety: { release: "safe", concerns: [] },
    }),
  };
  const honestRun = await judgeSession(live.id, { transport: good });
  expect(honestRun.outcome?.source).toBe("model");
  expect((await judgementOf(live.id)).fallback_reason).toBeNull();
});

// ── 4. R19 — the spend lands on the judgement row ─────────────────────────

test("the judgement row records the completion spend the provider reported", async () => {
  const { session } = await aggregatedSession("judge-spend");
  await setJudgeConfig({ mode: "enforce", model: "test/judge-model" });
  const paid: JudgeTransport = {
    model: "test/judge-model",
    complete: async () => ({
      text: JSON.stringify({
        rationale: "The takes converge on a constructive read of the subject.",
        disagreements: [],
        release_safety: { release: "safe", concerns: [] },
      }),
      usage: { inputTokens: 1820, outputTokens: 611, totalTokens: 2431, costUsd: 0.00042 },
    }),
  };
  const run = await judgeSession(session.id, { transport: paid });
  expect(run.ok).toBe(true);
  const row = await judgementOf(session.id);
  expect(row.source).toBe("model");
  expect(Number(row.usage_input_tokens)).toBe(1820);
  expect(Number(row.usage_output_tokens)).toBe(611);
  expect(Number(row.usage_total_tokens)).toBe(2431);
  expect(Number(row.usage_cost_usd)).toBeCloseTo(0.00042, 8);
});

test("a provider that reports no usage leaves NULL, not zero", async () => {
  const { session } = await aggregatedSession("judge-nospend");
  await setJudgeConfig({ mode: "enforce", model: "test/judge-model" });
  const silent: JudgeTransport = {
    model: "test/judge-model",
    complete: async () => JSON.stringify({
      rationale: "The takes converge on a constructive read of the subject.",
      disagreements: [],
      release_safety: { release: "safe", concerns: [] },
    }),
  };
  await judgeSession(session.id, { transport: silent });
  const row = await judgementOf(session.id);
  expect(row.usage_total_tokens).toBeNull();
  expect(row.usage_cost_usd).toBeNull();
});
