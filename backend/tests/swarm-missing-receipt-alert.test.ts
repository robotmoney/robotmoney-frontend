// AC-FE-10 — "AN ELIGIBLE SESSION THAT FAILS TO PRODUCE A RECEIPT CANNOT
// DISAPPEAR SILENTLY."
//
// This file reproduces, end to end, the exact sequence the 1.13 N5 staging run
// captured against v0.5.0-rc.1 — aggregate, judge fails every attempt, publish,
// recover — and asserts the half that was missing: that the session is STILL
// NAMED after the lane is healthy again.
//
// What rc.1 did, and why every step was individually defensible:
//   * the judge lane degraded and the `swarm.judge` alert fired (correct);
//   * `worker/loop.ts` settled the session's judge job `succeeded` once its
//     retries were spent, carrying last_error `judge_unavailable`;
//   * `publishConsensusReceiptAdmin` refused with `not_judged`, the first entry
//     in EXPECTED_RECEIPT_REFUSALS, so the publish run stayed successful;
//   * the next session judged fine and the lane alert CLEARED.
// Session 157777c9 — 3 verified takes, published, 404 at its public URL — was
// then named by nothing, anywhere.
//
// Two assertions close that, and both are here: the publish run DEGRADES at the
// moment of loss, and the session keeps its own alert for as long as the
// receipt is missing.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { canonicalizeSubmission } from "@robotmoney/contract";
import * as admin from "../src/swarm/admin.ts";
import * as ic from "../src/swarm/domain.ts";
import { sql } from "../src/db/client.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { setJudgeConfig } from "../src/swarm/judge-session.ts";
import { getOverviewProjection } from "../src/admin/overview.ts";
import { detectMissingReceiptSessions } from "../src/swarm/receipt-gap.ts";
import { publishSession as publishSessionJob } from "../src/worker/handlers/swarm.ts";
import { installJudgeStub, removeJudgeStub, STUB_JUDGE_MODEL } from "./support/judge-stub.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

beforeAll(installJudgeStub);
afterAll(removeJudgeStub);
useCleanDatabasePerTest(import.meta.file);

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

async function member() {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) throw new Error(`member() failed: ${JSON.stringify(r)}`);
  return { id, token: r.token, privateKey };
}

async function submit(m: Awaited<ReturnType<typeof member>>, date: string, subjectId: string) {
  const sub = {
    memberId: m.id, date, subjectId, nonce: rid("n"),
    stance: "neutral", confidence: 0.5, body: `${m.id} take`,
  };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  const res = await ic.submitRecommendation(m.token, { ...sub, signature });
  if (res.status !== 201) throw new Error(`submit failed: ${JSON.stringify(res)}`);
}

/** A `position_actions` session aggregated with `takes` verified takes. */
async function aggregatedSession(prefix: string, takes: number) {
  const subjectId = rid(prefix);
  await ic.ensureSubject(subjectId, `${prefix} subject`);
  await sql`UPDATE swarm_subjects SET recommendation_type = 'position_actions' WHERE id = ${subjectId}`;
  const session = await ic.openSession(subjectId);
  await ic.publishBrief(session.id, 60);
  const date = session.date instanceof Date
    ? session.date.toISOString().slice(0, 10)
    : String(session.date).slice(0, 10);
  for (let i = 0; i < takes; i++) await submit(await member(), date, subjectId);
  await admin.closeSessionAdmin(session.id, undefined);
  await admin.aggregateSessionAdmin(session.id, undefined);
  return session.id;
}

/**
 * The state `worker/loop.ts` leaves after an exhausted degrade: the session's
 * own `swarm.judge` job SUCCEEDED, attempts spent, `last_error` recorded. Not a
 * fabrication — it is the row observed on staging for session 157777c9.
 */
async function judgeLaneExhausted(sessionId: string, error = "judge_unavailable") {
  await sql`
    INSERT INTO jobs (kind, payload, run_after, dedupe_key, scope_type, scope_id, requested_by,
                      status, attempts, last_error)
    VALUES ('swarm.judge', ${sql.json({ sessionId } as never)}, now(), ${`swarm:${sessionId}:judge`},
            'swarm_session', ${sessionId}, 'test', 'succeeded', 5, ${error})
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL
      DO UPDATE SET status = 'succeeded', attempts = 5, last_error = EXCLUDED.last_error`;
}

const alertsFor = async (sessionId: string) =>
  (await getOverviewProjection()).alerts.filter((a) => a.message.includes(sessionId));

test("the N5 sequence: an eligible session loses its receipt, and is still named after the lane recovers", async () => {
  await setJudgeConfig({ mode: "enforce", minTakes: 3, model: STUB_JUDGE_MODEL });

  // 1. THE VICTIM: eligible (3 verified takes), judged by nobody.
  const lost = await aggregatedSession("n5-lost", 3);
  await judgeLaneExhausted(lost);

  // 2. PUBLISH. rc.1 returned a clean success here carrying a quiet
  //    `{published:false, reason:"not_judged"}`.
  const result = (await publishSessionJob({ sessionId: lost })) as {
    state: string; ok?: boolean; error?: string;
    consensusReceipt: { published: boolean; reason?: string; judgeLastError?: string };
  };
  expect(result.state).toBe("published");
  expect(result.consensusReceipt.published).toBe(false);
  expect(result.consensusReceipt.reason).toBe("not_judged");
  expect(result.consensusReceipt.judgeLastError).toBe("judge_unavailable");
  expect(result.ok, "the judge WAS asked and never answered — this run degrades").toBe(false);
  expect(result.error).toContain("judge was asked and never answered");

  // 3. THE LANE RECOVERS: a later session judges and publishes normally. In the
  //    staging run this is the moment every trace of the loss disappeared.
  const healthy = await aggregatedSession("n5-healthy", 3);
  const judged = await admin.judgeSessionAdmin(healthy, undefined);
  expect(judged.ok, JSON.stringify(judged)).toBe(true);
  const healthyPublish = (await publishSessionJob({ sessionId: healthy })) as {
    consensusReceipt: { published: boolean };
  };
  expect(healthyPublish.consensusReceipt).toEqual({ published: true });

  // 4. THE ASSERTION THE CRITERION IS ABOUT: after full recovery, something
  //    still names the session that lost its receipt.
  const report = await detectMissingReceiptSessions();
  expect(report.sessions.map((s) => s.sessionId)).toEqual([lost]);
  expect(report.sessions[0]).toMatchObject({
    takeCount: 3,
    judgeJobStatus: "succeeded",
    judgeLastError: "judge_unavailable",
  });

  const alerts = await alertsFor(lost);
  expect(alerts.length, "the alert is SESSION-scoped, not kind-scoped").toBe(1);
  expect(alerts[0].level).toBe("failed");
  expect(alerts[0].source).toBe(`swarm.consensus_receipt:${lost}`);
  expect(alerts[0].message).toContain("NO consensus receipt");
  // The healthy session is not named.
  expect(await alertsFor(healthy)).toEqual([]);
});

test("a later successful publication RESOLVES it — the alert is derived, not a row to clear", async () => {
  // AC-FE-10's staging clause, in full: "a controlled missing-publication
  // condition alerts and a later successful publication resolves it."
  //
  // The session here IS judged in enforce, and is then published WITHOUT its
  // receipt — the condition an operator can actually repair, and the one the
  // cadence produces whenever `swarm.publish` lands before the receipt does.
  // (A session published with no judgement at all, the test above, is
  // UNREPAIRABLE: `published` is terminal, so judgeSessionAdmin answers
  // `terminal_state:published` and the receipt can never exist. It keeps its
  // alert until it ages out of the lookback window, which is the honest
  // reporting of a permanent loss rather than a stuck alert.)
  await setJudgeConfig({ mode: "enforce", minTakes: 2, model: STUB_JUDGE_MODEL });
  const sessionId = await aggregatedSession("n5-resolve", 2);
  const judged = await admin.judgeSessionAdmin(sessionId, undefined);
  expect(judged.ok, JSON.stringify(judged)).toBe(true);

  // Publish the SESSION only — `ic.publishSession` is the state transition, and
  // the admin HTTP route deliberately returns without a receipt (the cadence
  // handler is the only path that folds one in).
  await ic.publishSession(sessionId);
  expect((await detectMissingReceiptSessions()).sessions.map((s) => s.sessionId)).toEqual([sessionId]);
  expect((await alertsFor(sessionId)).length, "alerts while the receipt is missing").toBe(1);

  // The operator does what the alert says. Nothing clears an alert row, because
  // there is no alert row — the receipt's existence is the whole signal.
  const receipt = await admin.publishConsensusReceiptAdmin(sessionId, "test");
  expect(receipt.ok, JSON.stringify(receipt)).toBe(true);

  expect((await detectMissingReceiptSessions()).sessions).toEqual([]);
  expect(await alertsFor(sessionId)).toEqual([]);
  const overview = await getOverviewProjection();
  expect(overview.alerts.some((a) => a.source === "swarm.consensus_receipt" && a.level === "healthy")).toBe(true);
});

// ── The distinction the criterion explicitly requires ───────────────────────
// "Scheduler/worker tests distinguish NO SCHEDULED WORK from MISSING/FAILED
// publication." The N5 run had this control sitting beside the real failure:
// session b1d5242d, published with no receipt and ZERO takes.
test("a session below min_takes is NOT reported — no scheduled work is not a failure", async () => {
  await setJudgeConfig({ mode: "enforce", minTakes: 3, model: STUB_JUDGE_MODEL });
  const zeroTake = await aggregatedSession("n5-zero-takes", 0);
  const thin = await aggregatedSession("n5-thin", 2);
  await publishSessionJob({ sessionId: zeroTake });
  await publishSessionJob({ sessionId: thin });

  const reported = (await detectMissingReceiptSessions()).sessions.map((s) => s.sessionId);
  expect(reported).not.toContain(zeroTake);
  expect(reported).not.toContain(thin);
  expect(await alertsFor(zeroTake)).toEqual([]);
  expect(await alertsFor(thin)).toEqual([]);
});

// ── The shipped default must not paint the feed red ─────────────────────────
test("judge mode `off` reports nothing: a control working as designed raises no alert", async () => {
  await setJudgeConfig({ mode: "off" });
  const sessionId = await aggregatedSession("n5-judge-off", 3);
  const result = (await publishSessionJob({ sessionId })) as { ok?: boolean; consensusReceipt: { reason?: string } };
  // Still `not_judged`, and still a clean run: nobody was asked, so nothing was
  // lost. This is the entry EXPECTED_RECEIPT_REFUSALS exists for.
  expect(result.consensusReceipt.reason).toBe("not_judged");
  expect(result).not.toHaveProperty("ok");

  const report = await detectMissingReceiptSessions();
  expect(report.judgeMode).toBe("off");
  expect(report.sessions).toEqual([]);
  expect(await alertsFor(sessionId)).toEqual([]);
});

// ── `shadow` IS A CONTROL WORKING AS DESIGNED, LIKE `off` ───────────────────
// RC2 review finding. The first cut suppressed only `off`, so every eligible
// session in `shadow` — the documented rollout mode in which a receipt is
// deliberately never produced — fired a `failed` alert. `judge-session.ts` says
// "SHADOW NEVER APPLIES" and `worker/handlers/swarm.ts` lists the resulting
// `judgement_not_adopted` as a benign refusal, so a permanently red feed was
// the module's own stated failure mode: "an alert that fires on a control
// working as designed buries the ones that mean something".
test("judge mode `shadow` reports nothing: the receipt is unreachable by design", async () => {
  await setJudgeConfig({ mode: "shadow", minTakes: 3, model: STUB_JUDGE_MODEL });
  const sessionId = await aggregatedSession("n5-shadow", 3);
  const judged = await admin.judgeSessionAdmin(sessionId, undefined);
  expect(judged.ok, JSON.stringify(judged)).toBe(true);
  expect((judged as { judge?: { mode?: string; applied?: boolean } }).judge)
    .toMatchObject({ mode: "shadow", applied: false });

  // The publish run is CLEAN: a shadow judgement is withheld by design.
  const result = (await publishSessionJob({ sessionId })) as {
    ok?: boolean; consensusReceipt: { published: boolean; reason?: string };
  };
  expect(result.consensusReceipt).toEqual({ published: false, reason: "judgement_not_adopted" });
  expect(result).not.toHaveProperty("ok");

  const report = await detectMissingReceiptSessions();
  expect(report.judgeMode).toBe("shadow");
  expect(report.sessions, "a receipt is unreachable in shadow — nothing was lost").toEqual([]);
  expect(await alertsFor(sessionId)).toEqual([]);
  // And no healthy line either: "every eligible session has a receipt" would be
  // a reassurance about something that cannot happen in this mode.
  const overview = await getOverviewProjection();
  expect(overview.alerts.some((a) => a.source === "swarm.consensus_receipt")).toBe(false);
});

// ── The alert must survive an unrelated operator action ─────────────────────
// RC2 review finding, proved against a real Postgres: the eligibility test read
// `min_takes` LIVE, so RAISING it — the same admin patch path the release
// runbook uses — silently retracted the alert for a session that is still
// permanently receiptless. Nothing was left behind, because the signal is
// derived. "Cannot disappear silently" has to mean cannot be made to.
test("raising min_takes AFTER the loss does not retract the alert", async () => {
  await setJudgeConfig({ mode: "enforce", minTakes: 3, model: STUB_JUDGE_MODEL });
  const lost = await aggregatedSession("n5-retro-mintakes", 3);
  await judgeLaneExhausted(lost);
  await publishSessionJob({ sessionId: lost });

  expect((await detectMissingReceiptSessions()).sessions.map((x) => x.sessionId)).toEqual([lost]);
  expect((await alertsFor(lost)).length).toBe(1);

  // An ordinary, unrelated operator action.
  await setJudgeConfig({ mode: "enforce", minTakes: 4, model: STUB_JUDGE_MODEL });

  const after = await detectMissingReceiptSessions();
  expect(after.minTakes, "the config really did move").toBe(4);
  expect(after.sessions.map((x) => x.sessionId), "the session is STILL named").toEqual([lost]);
  expect(after.sessions[0]).toMatchObject({
    takeCount: 3,
    trigger: "judge_lane_failure",
    judgeLastError: "judge_unavailable",
  });
  expect((await alertsFor(lost)).length).toBe(1);
  // And the receipt really is still missing — the alert is not stale.
  expect((await sql`SELECT 1 FROM swarm_consensus_receipts WHERE session_id = ${lost}`).length).toBe(0);
});

test("turning the judge OFF after the loss does not retract it either", async () => {
  // The same lever, pulled the other way. Today's config may only vouch for a
  // session it PREDATES: `swarm_judge_config.updated_at` moving past the
  // session's `published_at` is what tells the check that the mode on file is
  // not the mode that applied.
  await setJudgeConfig({ mode: "enforce", minTakes: 3, model: STUB_JUDGE_MODEL });
  const lost = await aggregatedSession("n5-retro-mode-off", 3);
  await judgeLaneExhausted(lost);
  await publishSessionJob({ sessionId: lost });
  expect((await detectMissingReceiptSessions()).sessions.map((x) => x.sessionId)).toEqual([lost]);

  await setJudgeConfig({ mode: "off" });

  const after = await detectMissingReceiptSessions();
  expect(after.judgeMode).toBe("off");
  expect(after.sessions.map((x) => x.sessionId), "a permanent loss stays named").toEqual([lost]);
  expect((await alertsFor(lost)).length).toBe(1);
});

test("turning the judge ON does not retro-flag every session published while it was off", async () => {
  // The other direction of the same rule, and the reason the lookback window
  // exists: a session published while the judge was off has no judge failure of
  // its own, so nothing about it was lost — and `updated_at` moving past it
  // must not manufacture an alert.
  await setJudgeConfig({ mode: "off" });
  const quiet = await aggregatedSession("n5-was-off", 3);
  await publishSessionJob({ sessionId: quiet });
  expect((await detectMissingReceiptSessions()).sessions).toEqual([]);

  await setJudgeConfig({ mode: "enforce", minTakes: 3, model: STUB_JUDGE_MODEL });

  const after = await detectMissingReceiptSessions();
  expect(after.judgeMode).toBe("enforce");
  expect(after.sessions.map((x) => x.sessionId)).toEqual([]);
  expect(await alertsFor(quiet)).toEqual([]);
});
