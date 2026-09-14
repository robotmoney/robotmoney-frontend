// AC-FE-10, second pass (round-2 code review T04 / T21 / T27 / R16).
//
// The committed AC-FE-10 suite is green, and every one of its fixtures writes
// `jobs.scope_type='swarm_session'` + `scope_id` by hand — the columns
// `createSessionAdmin` sets and the PRODUCTION DRIVER NEVER DOES. The driver
// reaches the queue through `POST /api/swarm/admin/enqueue-job`, which INSERTs
// `(kind, payload, dedupe_key)` and nothing else, so on the shape production
// actually writes every judge-lane join in this feature matched zero rows:
//
//   * `judgeLaneFailureFor()` returned null, so the publish handler's own
//     degrade (worker/handlers/swarm.ts) recorded a session that lost its
//     receipt to a judge outage as a CLEAN SUCCESS;
//   * the report's three diagnostic columns were null and the alert sentence
//     falsely ended "it has no swarm.judge job on file";
//   * and with that clause dead, an operator raising `min_takes` or setting
//     `mode:off` — the two remediations docs/runbooks/v0-5-0-rollout.md
//     promises the alert survives — stopped the session being named anywhere.
//
// Every test here drives the queue through the DRIVER'S OWN PATH.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { canonicalizeSubmission } from "@robotmoney/contract";
import * as admin from "../src/swarm/admin.ts";
import * as ic from "../src/swarm/domain.ts";
import { config } from "../src/config.ts";
import { sql } from "../src/db/client.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { setJudgeConfig } from "../src/swarm/judge-session.ts";
import { getOverviewProjection } from "../src/admin/overview.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import {
  describeMissingReceipt,
  detectMissingReceiptSessions,
  judgeLaneFailureFor,
  MISSING_RECEIPT_LOOKBACK_DAYS,
  MISSING_RECEIPT_REPORT_LIMIT,
} from "../src/swarm/receipt-gap.ts";
import { publishSession as publishSessionJob } from "../src/worker/handlers/swarm.ts";
import { installJudgeStub, removeJudgeStub, STUB_JUDGE_MODEL } from "./support/judge-stub.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

beforeAll(installJudgeStub);
afterAll(removeJudgeStub);
useCleanDatabasePerTest(import.meta.file);

const savedAdmin = { token: config.adminToken, insecure: config.allowInsecure };
beforeEach(() => { config.adminToken = null; config.allowInsecure = true; });
afterAll(() => { config.adminToken = savedAdmin.token; config.allowInsecure = savedAdmin.insecure; });

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

async function member() {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) throw new Error(`member() failed: ${JSON.stringify(r)}`);
  return { id, token: r.token, privateKey };
}

async function submit(m: Awaited<ReturnType<typeof member>>, date: string, subjectId: string) {
  const sub = { memberId: m.id, date, subjectId, nonce: rid("n"), stance: "neutral", confidence: 0.5, body: `${m.id} take` };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  const res = await ic.submitRecommendation(m.token, { ...sub, signature });
  if (res.status !== 201) throw new Error(`submit failed: ${JSON.stringify(res)}`);
}

async function aggregatedSession(prefix: string, takes: number, reuse?: Awaited<ReturnType<typeof member>>[]) {
  const subjectId = rid(prefix);
  await ic.ensureSubject(subjectId, `${prefix} subject`);
  await sql`UPDATE swarm_subjects SET recommendation_type = 'position_actions' WHERE id = ${subjectId}`;
  const session = await ic.openSession(subjectId);
  await ic.publishBrief(session.id, 60);
  const date = session.date instanceof Date ? session.date.toISOString().slice(0, 10) : String(session.date).slice(0, 10);
  for (let i = 0; i < takes; i++) await submit(reuse?.[i] ?? await member(), date, subjectId);
  await admin.closeSessionAdmin(session.id, undefined);
  await admin.aggregateSessionAdmin(session.id, undefined);
  return session.id;
}

/**
 * THE DRIVER'S OWN ENQUEUE — `scripts/lib/swarm/session.ts` calls exactly this
 * endpoint with exactly this body, and the row it produces carries NO
 * `scope_type`/`scope_id`. This is the shape production writes.
 */
async function enqueueJudgeThroughDriver(sessionId: string): Promise<number> {
  const res = await handleSwarm(
    new Request("http://x/api/swarm/admin/enqueue-job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "judge", sessionId }),
    }),
    new URL("http://x/api/swarm/admin/enqueue-job"),
  ) as { status: number; body: { jobId: number } };
  expect(res.status).toBe(200);
  return res.body.jobId;
}

/** The state loop.ts leaves after an exhausted degrade, on a driver-enqueued row. */
async function exhaustDriverJudgeJob(sessionId: string, error = "judge_unavailable") {
  const jobId = await enqueueJudgeThroughDriver(sessionId);
  await sql`UPDATE jobs SET status = 'failed', attempts = 5, last_error = ${error} WHERE id = ${jobId}`;
  return jobId;
}

const alertsFor = async (sessionId: string) =>
  (await getOverviewProjection()).alerts.filter((a) => a.message.includes(sessionId));

// ── T04.1 — the join, on the shape production writes ────────────────────────
test("a DRIVER-enqueued judge job is this session's judge job", async () => {
  await setJudgeConfig({ mode: "enforce", minTakes: 3, model: STUB_JUDGE_MODEL });
  const lost = await aggregatedSession("drv-join", 3);
  const jobId = await exhaustDriverJudgeJob(lost);

  // The row really is driver-shaped: nothing set the admin columns.
  const [row] = await sql`SELECT scope_type, scope_id, payload FROM jobs WHERE id = ${jobId}`;
  expect(row.payload.sessionId).toBe(lost);

  expect(await judgeLaneFailureFor(lost), "the session's own judge failure").toBe("judge_unavailable");
});

test("the publish job DEGRADES for a driver-enqueued session that lost its receipt", async () => {
  await setJudgeConfig({ mode: "enforce", minTakes: 3, model: STUB_JUDGE_MODEL });
  const lost = await aggregatedSession("drv-degrade", 3);
  await exhaustDriverJudgeJob(lost);

  const result = (await publishSessionJob({ sessionId: lost })) as {
    ok?: boolean; error?: string; consensusReceipt: { published: boolean; reason?: string; judgeLastError?: string };
  };
  expect(result.consensusReceipt.reason).toBe("not_judged");
  expect(result.consensusReceipt.judgeLastError).toBe("judge_unavailable");
  expect(result.ok, "a judge outage must not be recorded as a clean SUCCESS").toBe(false);
});

test("the alert names the driver-enqueued job instead of claiming there is none", async () => {
  await setJudgeConfig({ mode: "enforce", minTakes: 3, model: STUB_JUDGE_MODEL });
  const lost = await aggregatedSession("drv-sentence", 3);
  await exhaustDriverJudgeJob(lost);
  await publishSessionJob({ sessionId: lost });

  const report = await detectMissingReceiptSessions();
  const s = report.sessions.find((x) => x.sessionId === lost)!;
  expect(s).toMatchObject({ judgeJobStatus: "failed", judgeJobAttempts: 5, judgeLastError: "judge_unavailable" });
  const line = describeMissingReceipt(s);
  expect(line).not.toContain("it has no swarm.judge job on file");
  expect(line).toContain("judge_unavailable");
});

// ── T04.2 — both runbook remediations, on the driver shape ──────────────────
test("raising min_takes after a DRIVER-shaped loss does not retract the alert", async () => {
  await setJudgeConfig({ mode: "enforce", minTakes: 3, model: STUB_JUDGE_MODEL });
  const lost = await aggregatedSession("drv-mintakes", 3);
  await exhaustDriverJudgeJob(lost);
  await publishSessionJob({ sessionId: lost });
  expect((await detectMissingReceiptSessions()).sessions.map((x) => x.sessionId)).toEqual([lost]);

  await setJudgeConfig({ mode: "enforce", minTakes: 4, model: STUB_JUDGE_MODEL });
  expect((await detectMissingReceiptSessions()).sessions.map((x) => x.sessionId), "still named").toEqual([lost]);
  expect((await alertsFor(lost)).length).toBe(1);
});

test("turning the judge off after a DRIVER-shaped loss does not retract it either", async () => {
  await setJudgeConfig({ mode: "enforce", minTakes: 3, model: STUB_JUDGE_MODEL });
  const lost = await aggregatedSession("drv-modeoff", 3);
  await exhaustDriverJudgeJob(lost);
  await publishSessionJob({ sessionId: lost });
  expect((await detectMissingReceiptSessions()).sessions.map((x) => x.sessionId)).toEqual([lost]);

  await setJudgeConfig({ mode: "off" });
  expect((await detectMissingReceiptSessions()).sessions.map((x) => x.sessionId), "a permanent loss stays named").toEqual([lost]);
  expect((await alertsFor(lost)).length).toBe(1);
});

// ── T04.3 — config_predates must be insensitive to an UNRELATED patch ───────
test("patching only the judge MODEL does not disturb the session's eligibility", async () => {
  // The session has no judge failure of its own, so it is named ONLY by the
  // take-count clause, and that clause needs today's config to be entitled to
  // speak for it. `setJudgeConfig` stamps `updated_at` on EVERY patch, so a
  // model rotation — which changes neither `mode` nor `min_takes` — used to
  // flip `config_predates` false and silently drop the session.
  await setJudgeConfig({ mode: "enforce", minTakes: 3, model: STUB_JUDGE_MODEL });
  const lost = await aggregatedSession("drv-unrelated", 3);
  await ic.publishSession(lost);
  const before = await detectMissingReceiptSessions();
  expect(before.sessions.map((x) => x.sessionId)).toEqual([lost]);
  expect(before.sessions[0].trigger).toBe("eligible_take_count");

  await setJudgeConfig({ model: STUB_JUDGE_MODEL });

  const after = await detectMissingReceiptSessions();
  expect(after.sessions.map((x) => x.sessionId), "an unrelated patch is not a policy change").toEqual([lost]);
  expect(after.sessions[0].trigger).toBe("eligible_take_count");
});

// ── T27 — the 7-day lookback boundary, driven through the module's seam ─────
test("the lookback window decides: just inside is reported, just outside is not", async () => {
  await setJudgeConfig({ mode: "enforce", minTakes: 3, model: STUB_JUDGE_MODEL });
  const inside = await aggregatedSession("look-in", 3);
  const outside = await aggregatedSession("look-out", 3);
  await ic.publishSession(inside);
  await ic.publishSession(outside);

  const now = new Date();
  const day = 86_400_000;
  // Backdate `published_at` AND the judge policy stamp together, so
  // `config_predates` is not what decides either case.
  const insideAt = new Date(now.getTime() - (MISSING_RECEIPT_LOOKBACK_DAYS - 1) * day);
  const outsideAt = new Date(now.getTime() - (MISSING_RECEIPT_LOOKBACK_DAYS + 1) * day);
  await sql`UPDATE swarm_sessions SET published_at = ${insideAt} WHERE id = ${inside}`;
  await sql`UPDATE swarm_sessions SET published_at = ${outsideAt} WHERE id = ${outside}`;
  await sql`UPDATE swarm_judge_config SET updated_at = ${outsideAt}, policy_updated_at = ${outsideAt} WHERE id = 1`;

  const report = await detectMissingReceiptSessions(sql, now, MISSING_RECEIPT_LOOKBACK_DAYS);
  expect(report.lookbackDays).toBe(MISSING_RECEIPT_LOOKBACK_DAYS);
  const named = report.sessions.map((x) => x.sessionId);
  expect(named).toContain(inside);
  expect(named, "older than the window is a historical fact, not an alert").not.toContain(outside);

  // The window is really the parameter, not a constant: widen it and the older
  // session comes back.
  const wide = await detectMissingReceiptSessions(sql, now, MISSING_RECEIPT_LOOKBACK_DAYS + 3);
  expect(wide.sessions.map((x) => x.sessionId)).toContain(outside);
});

// ── T27 — the report cap and its aggregate alert ───────────────────────────
test("21 receiptless sessions: 21 counted, 20 named, ONE aggregate alert naming both", async () => {
  await setJudgeConfig({ mode: "enforce", minTakes: 1, model: STUB_JUDGE_MODEL });
  const total = MISSING_RECEIPT_REPORT_LIMIT + 1;
  // The roster caps at 10 members; one analyst filing one take against each of
  // 21 subjects is the same shape and stays inside it.
  const analyst = [await member()];
  for (let i = 0; i < total; i++) {
    const id = await aggregatedSession(`cap${i}`, 1, analyst);
    await ic.publishSession(id);
  }

  const report = await detectMissingReceiptSessions();
  expect(report.count).toBe(total);
  expect(report.sessions.length).toBe(MISSING_RECEIPT_REPORT_LIMIT);

  const overview = await getOverviewProjection();
  const aggregate = overview.alerts.filter((a) => a.source === "swarm.consensus_receipt");
  expect(aggregate.length, "exactly one aggregate line").toBe(1);
  expect(aggregate[0].message).toContain(String(total));
  expect(aggregate[0].message).toContain(String(MISSING_RECEIPT_REPORT_LIMIT));
});

// ── T21 — ic.publishSession carries the admin path's guards ────────────────
test("ic.publishSession refuses a cancelled session and never re-stamps published_at", async () => {
  await setJudgeConfig({ mode: "off" });
  const sessionId = await aggregatedSession("guard-publish", 2);

  const first = await ic.publishSession(sessionId) as { state: string; transitioned?: boolean };
  expect(first.state).toBe("published");
  expect(first.transitioned).toBe(true);
  const [{ published_at: stamp }] = await sql`SELECT published_at FROM swarm_sessions WHERE id = ${sessionId}`;

  // A redelivered publish job must not move the recorded publication instant —
  // `describeMissingReceipt` names it.
  const again = await ic.publishSession(sessionId) as { transitioned?: boolean };
  expect(again.transitioned, "a re-run transitions nothing").toBe(false);
  const [{ published_at: stamp2 }] = await sql`SELECT published_at FROM swarm_sessions WHERE id = ${sessionId}`;
  expect(new Date(stamp2).toISOString()).toBe(new Date(stamp).toISOString());

  // And a session an operator CANCELLED is NOT flipped to published with no
  // transition, event or audit row. (Cancellation is legal from `collecting`,
  // so the session is cancelled there — the state a publish job redelivered
  // after an operator intervened would find.)
  const cancelSubject = rid("guard-cancel");
  await ic.ensureSubject(cancelSubject, "cancel subject");
  const cancelSession = await ic.openSession(cancelSubject);
  await ic.publishBrief(cancelSession.id, 60);
  const cancelled = cancelSession.id;
  const cancelRes = await admin.cancelSessionAdmin(cancelled, undefined);
  expect(cancelRes.ok, JSON.stringify(cancelRes)).toBe(true);
  const res = await ic.publishSession(cancelled) as { state: string; transitioned?: boolean };
  expect(res.transitioned).toBe(false);
  const [{ state }] = await sql`SELECT state FROM swarm_sessions WHERE id = ${cancelled}`;
  expect(state, "a cancelled session stays cancelled").toBe("cancelled");
});

// ── T21 — a permanently unsatisfiable weights refusal is TERMINAL ──────────
test("a weights refusal over a frozen take set settles once, loudly, not five times", async () => {
  await setJudgeConfig({ mode: "enforce", minTakes: 1, model: STUB_JUDGE_MODEL });
  const subjectId = rid("wt");
  await ic.ensureSubject(subjectId, "weights subject");
  // ensureSubject() types every subject it creates `bucket_weights`
  // (src/swarm/domain.ts), so the weightless take has to be filed while the
  // subject is prose-typed.
  await sql`UPDATE swarm_subjects SET recommendation_type = 'position_actions' WHERE id = ${subjectId}`;
  const session = await ic.openSession(subjectId);
  await ic.publishBrief(session.id, 60);
  const date = session.date instanceof Date ? session.date.toISOString().slice(0, 10) : String(session.date).slice(0, 10);
  await submit(await member(), date, subjectId); // a take with NO weight vector
  // The subject becomes `bucket_weights` only AFTER the weightless take is on
  // file. Since T17/D14 submission itself refuses a weightless take for a
  // `bucket_weights` subject (400), so this is now the ONLY way the state gate
  // 5b exists for can arise: a row filed before the subject was retyped, or
  // before D14 shipped. Gate 5b is deliberately kept as defence in depth, and
  // this is the test that it still settles TERMINALLY rather than retrying.
  await sql`UPDATE swarm_subjects SET recommendation_type = 'bucket_weights' WHERE id = ${subjectId}`;
  await admin.closeSessionAdmin(session.id, undefined);
  await admin.aggregateSessionAdmin(session.id, undefined);
  const judged = await admin.judgeSessionAdmin(session.id, undefined);
  expect(judged.ok, JSON.stringify(judged)).toBe(true);

  const result = (await publishSessionJob({ sessionId: session.id })) as {
    ok?: boolean; terminal?: boolean; error?: string; consensusReceipt: { reason?: string };
  };
  expect(result.consensusReceipt.reason).toBe("weights_absent_for_bucket_weights_subject");
  expect(result.ok, "still a loud failure").toBe(false);
  expect(result.terminal, "a retry cannot change the answer for a frozen take set").toBe(true);
});
