// PROJECT FUSION RC2 — AN ALLOCATION SESSION MUST PRODUCE AN ALLOCATION,
// proved on the EPOCH path (issue #1026 criterion 114).
//
// v0.5.0-rc.1 could not. The take-authoring contract was {body, stance,
// confidence}, so `meanTakeWeights()` never had a vector to average,
// `consensus-receipt.ts` omitted the (schema-optional) `weights` field, and a
// `bucket_weights` session published a signed, judge-attested, read-time
// verified receipt that said nothing about the allocation — with every layer
// below behaving correctly and nothing calling it a failure.
//
// WHY THIS FILE WAS REWRITTEN RATHER THAN RESTORED. Its first version drove
// publication through the `swarm.publish` worker handler, and the judge through
// the inline `judgeSessionAdmin`; both were deleted with the swarm lane
// (5d6476c4), and the pin went with them. The system now settles a session
// exactly one way (system-scheduler-spec.md §4): `openEpoch` → signed takes →
// `turnOverEpoch` → `aggregateEpoch` → `requestJudging` → the judge of record's
// SIGNED judgement over the participant route (`submitJudgement`) → `POST
// /api/swarm/admin/epochs/finalize`, whose handler (`finalizeAndAttest`)
// publishes and then assembles the receipt. Every scenario below goes through
// that path end to end — the finalize call is an HTTP request through
// `handleSwarmAdmin`, so the receipt is assembled by the code that runs in
// production, not by a test calling the assembler directly.
//
// This file pins BOTH halves of the fix at the layer that publishes:
//
//  1. Takes that carry a vector INSIDE their signed canonical bytes produce a
//     receipt whose four weights are the largest-remainder conversion of the
//     deterministic mean, summing to exactly 10,000 bps, in canonical bucket
//     order — and the receipt's own verifier recomputes them from the embedded
//     submissions rather than trusting the producer.
//  2. A `bucket_weights` session with NO vector (or with one that not every
//     take authored) is REFUSED BY NAME, and because the reason is not an
//     expected refusal the finalize answer carries `receiptFailed` — while the
//     session itself is still published, because §4.4 makes that outcome final.
//
// The parser and prompt half of the same fix is pinned hermetically in
// scripts/tests/unit/swarm-take-weights.test.ts; the submission-time refusal of
// a weightless take is backend/tests/swarm-take-weights-submission.test.ts.
import { expect, test, beforeEach } from "bun:test";
import { canonicalizeSubmission, RECEIPT_CANONICAL_BUCKET_ORDER } from "@robotmoney/contract";
import * as epoch from "../src/swarm/domain.ts";
import { sql } from "../src/db/client.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { getConsensusReceipt } from "../src/swarm/consensus-receipt.ts";
import { handleSwarmAdmin } from "../src/api/routes/swarm-admin.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { activeSubject, rid, sessionDate, sessionRow, setJudgeMode } from "./support/epoch-fixtures.ts";
import { inHouseJudge, submitSigned, STUB_JUDGE_REPLY } from "./support/stub-judge.ts";
import { provisionSchedulerToken, schedulerHeaders } from "./support/automation-auth.ts";

// Per TEST: every scenario seats its own members, and SWARM_ROSTER_CAP is
// enforced on each admission.
useCleanDatabasePerTest(import.meta.file);

// Store-issued, like the real credential (smoke spec §3, D52 (1)); there is no
// env token and no insecure mode to fall back on. Per test, because each test
// gets its own database (the clone hook above runs first).
let SCHEDULER = "";
beforeEach(async () => {
  SCHEDULER = await provisionSchedulerToken();
});

const CANON = [...RECEIPT_CANONICAL_BUCKET_ORDER];
const full = (shares: number[]) => CANON.map((bucket, i) => ({ bucket, weight: shares[i]! }));
type Vector = { bucket: string; weight: number }[] | null;

async function member() {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await epoch.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) throw new Error(`member() failed: ${JSON.stringify(r)}`);
  return { id, token: r.token, privateKey };
}

/** Submit one signed take by `m`, the vector (if any) INSIDE the signed canonical bytes. */
async function submit(m: Awaited<ReturnType<typeof member>>, date: string, subjectId: string, weights: Vector) {
  const sub = {
    memberId: m.id, date, subjectId, nonce: rid("n"),
    stance: "neutral", confidence: 0.5, body: `${m.id} take`,
    ...(weights ? { weights } : {}),
  };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  const res = await epoch.submitRecommendation(m.token, { ...sub, signature });
  if (res.status !== 201) throw new Error(`submit failed: ${JSON.stringify(res)}`);
}

/** POST epochs/finalize through the real admin handler — the call system-scheduler makes. */
async function finalizeOverHttp(sessionId: string) {
  const req = new Request("http://x/api/swarm/admin/epochs/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...schedulerHeaders(SCHEDULER) },
    body: JSON.stringify({ sessionId }),
  });
  const res = await handleSwarmAdmin(req, new URL(req.url));
  if (!res) throw new Error("epochs/finalize fell through the admin handler");
  return res as { status: number; body: Record<string, any> };
}

/**
 * An epoch of a subject of `type`, with one signed take per vector, closed,
 * aggregated and put into `judging`. Returns the CLOSED epoch.
 *
 * `retypeForTakes` is the weightless-take shape. The submission gate refuses a
 * weightless or partial take for a `bucket_weights` subject, which is the
 * point of that gate — but the ASSEMBLY gates are defence in depth over takes
 * ALREADY ON FILE, and this is how such a take comes to exist: it was filed
 * while the subject still asked for prose only, and the subject was retyped
 * afterwards (migration 0051 did exactly that). The brief was published under
 * the real type, so the session's ASK is unchanged.
 */
async function judgingEpoch(
  prefix: string,
  type: "bucket_weights" | "position_actions",
  vectors: Vector[],
  opts: { retypeForTakes?: boolean } = {},
) {
  await setJudgeMode("enforce");
  await sql`UPDATE swarm_judge_config SET min_takes = ${vectors.length} WHERE id = 1`;
  const subjectId = await activeSubject(prefix, 3600);
  await sql`UPDATE swarm_subjects SET recommendation_type = ${type} WHERE id = ${subjectId}`;
  // One member per take, active BEFORE the epoch opens: an epoch seats every
  // active member at open and its roster is fixed after that, so a member
  // activated mid-epoch joins the next one (admin-surface.md US-C3).
  const members = [];
  for (let i = 0; i < vectors.length; i++) members.push(await member());
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error(`openEpoch: ${JSON.stringify(opened)}`);
  const date = sessionDate(await sessionRow(opened.sessionId));
  if (opts.retypeForTakes) await sql`UPDATE swarm_subjects SET recommendation_type = 'position_actions' WHERE id = ${subjectId}`;
  for (const [i, v] of vectors.entries()) await submit(members[i]!, date, subjectId, v);
  if (opts.retypeForTakes) await sql`UPDATE swarm_subjects SET recommendation_type = ${type} WHERE id = ${subjectId}`;
  const turned = await epoch.turnOverEpoch(subjectId, opened.sessionId);
  if (!turned.ok) throw new Error(`turnOverEpoch: ${JSON.stringify(turned)}`);
  const sessionId = turned.closedSessionId;
  const aggregated = await epoch.aggregateEpoch(sessionId);
  if (!aggregated.ok) throw new Error(`aggregateEpoch: ${JSON.stringify(aggregated)}`);
  const requested = await epoch.requestJudging(sessionId);
  if (!requested.ok) throw new Error(`requestJudging: ${JSON.stringify(requested)}`);
  return { subjectId, sessionId, openedSessionId: opened.sessionId };
}

/** The judge of record signs and submits its judgement; the session becomes `judged`. */
async function judgedByRecord(sessionId: string, opinion = STUB_JUDGE_REPLY) {
  const r = await submitSigned(await inHouseJudge(), sessionId, opinion);
  if (!r.ok || !r.judgeOfRecord || !r.applied) throw new Error(`judgement not adopted: ${JSON.stringify(r)}`);
  expect((await sessionRow(sessionId)).state).toBe("judged");
}

// ── AC-FMT-03 / AC-FMT-04 / AC-E2E-01 ───────────────────────────────────────
test("signed analyst vectors reach the receipt as four canonical buckets totalling exactly 10,000 bps", async () => {
  // Deliberately awkward shares: three members whose mean lands off an exact
  // bps boundary, so the total is 10,000 only if largest-remainder ran.
  const { sessionId } = await judgingEpoch("weights-happy", "bucket_weights", [
    full([0.15, 0.55, 0.2, 0.1]),
    full([0.1, 0.7, 0.1, 0.1]),
    full([0.2, 0.45, 0.25, 0.1]),
  ]);
  await judgedByRecord(sessionId);

  const res = await finalizeOverHttp(sessionId);
  expect(res.status).toBe(200);
  expect(res.body.outcome).toBe("judged");
  expect(res.body.consensusReceipt, JSON.stringify(res.body)).toEqual({ published: true });
  expect(res.body.receiptFailed).toBeUndefined();

  const stored = await getConsensusReceipt(sessionId);
  expect(stored, "the receipt exists").not.toBeNull();
  const receipt = stored!.receipt as { weights?: { bucket: string; weight_bps: number }[] };

  // 1. THE FIELD IS THERE AT ALL — the rc.1 failure, stated positively.
  expect(receipt.weights, "a bucket_weights receipt carries the allocation").toBeDefined();
  // 2. EXACTLY THE FOUR PRD BUCKETS, IN CANONICAL ORDER (AC-FMT-04).
  expect(receipt.weights!.map((w) => w.bucket)).toEqual(CANON);
  // 3. EXACTLY 10,000 BPS (AC-FMT-03) — integers, nothing negative.
  expect(receipt.weights!.reduce((n, w) => n + w.weight_bps, 0)).toBe(10_000);
  for (const w of receipt.weights!) {
    expect(Number.isInteger(w.weight_bps)).toBe(true);
    expect(w.weight_bps).toBeGreaterThanOrEqual(0);
  }
  // 4. A STRANGER CAN REPRODUCE IT. The public read recomputes the vector from
  //    the embedded canonical_submission blobs and reports any divergence — so
  //    this passing means the receipt's weights ARE the mean of the signed
  //    takes, not a producer-local claim.
  expect(stored!.unverifiedReasons).toEqual([]);
  expect(stored!.verified).toBe(true);

  // 5. AND THE VECTOR IS INSIDE THE SIGNED BYTES, which is the whole point:
  //    `canonical_submission` is what each analyst's ed25519 signature covers.
  const entries = (stored!.receipt as { analyst_signatures: { canonical_submission: string }[] }).analyst_signatures;
  expect(entries.length).toBe(3);
  for (const entry of entries) {
    const signed = JSON.parse(entry.canonical_submission) as { weights?: { bucket: string }[] };
    expect(signed.weights, "the analyst SIGNED the vector, it was not attached afterwards").toBeDefined();
    expect(signed.weights!.map((w) => w.bucket)).toEqual(CANON);
  }
});

// ── The loud gate (finding §4(d)) ───────────────────────────────────────────
test("a bucket_weights session whose takes carry no vector is refused BY NAME, reported as receiptFailed, and still published", async () => {
  const { sessionId } = await judgingEpoch("weights-absent", "bucket_weights", [null, null], { retypeForTakes: true });
  await judgedByRecord(sessionId);

  const res = await finalizeOverHttp(sessionId);
  // The session IS published — finalize committed and §4.4 makes that final —
  // and the receipt failure is reported beside the outcome, not instead of it.
  expect(res.status).toBe(200);
  expect(res.body.outcome).toBe("judged");
  expect((await sessionRow(sessionId)).state).toBe("published");
  // THE rc.1 BEHAVIOUR WAS `{published: true}` WITH NO `weights` KEY. Now the
  // reason is named, and names the actual condition rather than a schema error.
  expect(res.body.consensusReceipt).toEqual({
    published: false,
    reason: "weights_absent_for_bucket_weights_subject",
  });
  // NOT an expected refusal (finalizeAndAttest's allowlist), so the answer is
  // marked failed rather than absorbed into a clean publish.
  expect(res.body.receiptFailed, "an allocation session that produced no allocation is a FAILED receipt").toBe(true);
  expect(res.body.receiptError).toContain("weights_absent_for_bucket_weights_subject");

  // Nothing was written: no half-receipt, no weightless receipt.
  expect((await sql`SELECT 1 FROM swarm_consensus_receipts WHERE session_id = ${sessionId}`).length).toBe(0);
});

// ── The boundary: position_actions is untouched ─────────────────────────────
test("a position_actions session publishes its receipt without a vector — the gate is typed, not global", async () => {
  const { sessionId, subjectId } = await judgingEpoch("weights-positions", "position_actions", [null, null]);
  // The type is ASSERTED, not assumed: the gate must key on the subject, never
  // on "no vector arrived".
  const [row] = await sql<{ recommendation_type: string }[]>`
    SELECT recommendation_type FROM swarm_subjects WHERE id = ${subjectId}`;
  expect(row.recommendation_type).toBe("position_actions");
  await judgedByRecord(sessionId);

  const res = await finalizeOverHttp(sessionId);
  expect(res.body.consensusReceipt, JSON.stringify(res.body)).toEqual({ published: true });
  const stored = await getConsensusReceipt(sessionId);
  expect((stored!.receipt as { weights?: unknown }).weights, "never asked for, never invented").toBeUndefined();
});

// ── The brief states the ask (the half the member client reads) ─────────────
test("a bucket_weights epoch's brief declares the vector REQUIRED over the four canonical buckets", async () => {
  const bucketSubject = await activeSubject("brief-bw", 3600);
  await sql`UPDATE swarm_subjects SET recommendation_type = 'bucket_weights' WHERE id = ${bucketSubject}`;
  const bw = await epoch.openEpoch(bucketSubject);
  if (!bw.ok) throw new Error("openEpoch failed");
  const bwBrief = await epoch.getBriefBySession(bw.sessionId);
  const bwSchema = (bwBrief!.body as { takeSchema: { weights: { optional: boolean; buckets: string[] } } }).takeSchema;
  expect(bwSchema.weights.optional, "an allocation session ASKS for the allocation").toBe(false);
  expect(bwSchema.weights.buckets).toEqual(CANON);
  // And the subject the member client reads the ask off is on the brief.
  expect((bwBrief!.body as { subject: { recommendationType: string } }).subject.recommendationType)
    .toBe("bucket_weights");

  const paSubject = await activeSubject("brief-pa", 3600);
  await sql`UPDATE swarm_subjects SET recommendation_type = 'position_actions' WHERE id = ${paSubject}`;
  const pa = await epoch.openEpoch(paSubject);
  if (!pa.ok) throw new Error("openEpoch failed");
  const paBrief = await epoch.getBriefBySession(pa.sessionId);
  const paSchema = (paBrief!.body as { takeSchema: { weights: { optional: boolean } } }).takeSchema;
  expect(paSchema.weights.optional, "a position_actions session does not").toBe(true);
});

// ── The judge still cannot author a number (finding §4(c)) ──────────────────
//
// RE-ASSERTED HERE ON PURPOSE. The analyst prompt now legitimately contains
// numbers and the brief the judge reads DECLARES the vector required, so the
// one boundary that keeps "math decides and the judge explains" true has to be
// proved again over a session that actually has an allocation to steal. The
// judge is a participant now: its signed answer is REFUSED by the API, nothing
// is recorded, no consensus exists at the deadline, and the session publishes
// `no_consensus` — with its own allocation still the real mean of the takes.
test("a judge answer that tries to author weights is refused outright: no judgement, no_consensus, no receipt, the math still decides", async () => {
  const { sessionId } = await judgingEpoch("weights-smuggle", "bucket_weights", [
    full([0.15, 0.55, 0.2, 0.1]),
    full([0.05, 0.75, 0.1, 0.1]),
  ]);
  const smuggle = JSON.stringify({
    rationale: "I have recomputed the allocation myself.",
    disagreements: [],
    release_safety: { release: "safe", concerns: [] },
    weights: CANON.map((bucket) => ({ bucket, weight: bucket === "agent_tokens" ? 1 : 0 })),
  });
  const judged = await submitSigned(await inHouseJudge(), sessionId, smuggle);
  // Refused by the smuggle's own name.
  expect(judged.ok).toBe(false);
  if (!judged.ok) expect(judged.error).toBe("judgement_refused:weight_like_field:weights");
  expect((await sql`SELECT 1 FROM swarm_session_judgements WHERE session_id = ${sessionId}`).length).toBe(0);

  // The deadline passes with no consensus: finalize decides no_consensus, and
  // the receipt refusal is the EXPECTED one — no certificate, by design.
  await sql`UPDATE swarm_sessions SET judging_deadline_at = clock_timestamp() - interval '1 second',
                                      judging_requested_at = clock_timestamp() - interval '2 seconds'
             WHERE id = ${sessionId}`;
  const res = await finalizeOverHttp(sessionId);
  expect(res.body.outcome).toBe("no_consensus");
  expect(res.body.consensusReceipt).toEqual({ published: false, reason: "no_consensus" });
  expect(res.body.receiptFailed).toBeUndefined();
  expect(await getConsensusReceipt(sessionId)).toBeFalsy();

  // The math still decided: the session's own served allocation is the real
  // mean of the two signed takes (agent_tokens: (0.15 + 0.05) / 2 = 0.10),
  // never the model's 1.0.
  const live = (await sessionRow(sessionId)).swarm_recommendation as { weights: { bucket: string; weight: number }[] };
  expect(live.weights.find((w) => w.bucket === "agent_tokens")!.weight).toBeCloseTo(0.1, 6);
});

// ── RC2 review finding: the allocation's SUPPORT is a gate, not an accident ──
//
// Gate 5 asks that a `bucket_weights` session produce an allocation. It said
// nothing about WHO produced it, and `meanTakeWeights()` divides by the number
// of VECTORS it found rather than by the number of takes. So a receipt could
// publish an allocation authored by a minority of the takes it attests to.

test("a 1-of-3 allocation is REFUSED: the receipt may not claim support it does not have", async () => {
  // The reviewer's PROBE A, exactly: one signed vector, two weightless takes.
  const { sessionId } = await judgingEpoch("weights-minority", "bucket_weights", [
    full([1, 0, 0, 0]),
    null,
    null,
  ], { retypeForTakes: true });
  await judgedByRecord(sessionId);
  const res = await finalizeOverHttp(sessionId);
  expect(res.body.consensusReceipt).toEqual({ published: false, reason: "weights_not_authored_by_every_take" });
  expect(res.body.receiptFailed, "a receipt claiming support it lacks is a FAILED receipt").toBe(true);
  expect(res.body.receiptError).toContain("weights_not_authored_by_every_take");
  expect((await sql`SELECT 1 FROM swarm_consensus_receipts WHERE session_id = ${sessionId}`).length).toBe(0);
});

test("a take that never NAMED a bucket cannot be counted as a 0.00 vote on it", async () => {
  // The reviewer's PROBE B: a four-bucket vector beside a three-bucket one.
  // The UNION is the canonical four, so without the support gate the member
  // who never mentioned `real_world_assets` would be recorded voting 0.00.
  const { sessionId } = await judgingEpoch("weights-union", "bucket_weights", [
    full([0.25, 0.25, 0.25, 0.25]),
    [
      { bucket: "agent_tokens", weight: 0.5 },
      { bucket: "conservative_defi_yield", weight: 0.3 },
      { bucket: "protocol_tokens", weight: 0.2 },
    ],
  ], { retypeForTakes: true });
  await judgedByRecord(sessionId);
  const res = await finalizeOverHttp(sessionId);
  expect(res.body.consensusReceipt).toEqual({ published: false, reason: "weights_not_authored_by_every_take" });
  expect(res.body.receiptFailed).toBe(true);
});

test("every take carrying the canonical four still publishes — the gate is about SUPPORT, not about vectors", async () => {
  // The control that keeps the two tests above non-vacuous.
  const { sessionId } = await judgingEpoch("weights-unanimous", "bucket_weights", [
    full([0.25, 0.25, 0.25, 0.25]),
    full([0.5, 0.3, 0.1, 0.1]),
    full([0, 0.9, 0.05, 0.05]),
  ]);
  await judgedByRecord(sessionId);
  const res = await finalizeOverHttp(sessionId);
  expect(res.body.consensusReceipt).toEqual({ published: true });

  const stored = await getConsensusReceipt(sessionId);
  const receipt = stored!.receipt as { weights: { bucket: string; weight_bps: number }[] };
  expect(receipt.weights.reduce((n, w) => n + w.weight_bps, 0)).toBe(10_000);
  expect(stored!.verified).toBe(true);
  const entries = (stored!.receipt as { analyst_signatures: { canonical_submission: string }[] }).analyst_signatures;
  expect(entries.length).toBe(3);
  for (const entry of entries) {
    const signed = JSON.parse(entry.canonical_submission) as { weights?: { bucket: string }[] };
    expect(signed.weights!.map((w) => w.bucket).sort()).toEqual([...CANON].sort());
  }
});

test("a rollup vector that is not the canonical four keeps its OWN, more specific refusal", async () => {
  // Ordering matters: when NO take names the fourth bucket the rollup itself is
  // not canonical-four, and `weights_not_canonical_four` is the more specific
  // fact about that session. The support gate must not shadow it.
  const three = [
    { bucket: "agent_tokens", weight: 0.5 },
    { bucket: "conservative_defi_yield", weight: 0.3 },
    { bucket: "protocol_tokens", weight: 0.2 },
  ];
  const { sessionId } = await judgingEpoch("weights-three-bucket", "bucket_weights", [three, three], {
    retypeForTakes: true,
  });
  await judgedByRecord(sessionId);
  const res = await finalizeOverHttp(sessionId);
  expect(res.body.consensusReceipt.reason).toBe("weights_not_canonical_four");
  expect(res.body.receiptFailed).toBe(true);
});
