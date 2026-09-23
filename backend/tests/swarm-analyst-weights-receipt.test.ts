// PROJECT FUSION RC2 — AN ALLOCATION SESSION MUST PRODUCE AN ALLOCATION.
//
// v0.5.0-rc.1 could not. The take-authoring contract was {body, stance,
// confidence}, so `meanTakeWeights()` never had a vector to average,
// `consensus-receipt.ts` omitted the (schema-optional) `weights` field, and a
// `bucket_weights` session published a signed, judge-attested, read-time
// verified receipt that said nothing about the allocation — with every layer
// below behaving correctly and nothing calling it a failure. AC-FMT-03,
// AC-FMT-04 and AC-E2E-01 all failed on that one hole.
//
// This file pins BOTH halves of the fix at the layer that publishes:
//
//  1. Takes that carry a vector INSIDE their signed canonical bytes produce a
//     receipt whose four weights are the largest-remainder conversion of the
//     deterministic mean, summing to exactly 10,000 bps, in canonical bucket
//     order — and the receipt's own verifier recomputes them from the embedded
//     submissions rather than trusting the producer.
//  2. A `bucket_weights` session with NO vector is REFUSED BY NAME
//     (`weights_absent_for_bucket_weights_subject`) and, because that reason is
//     not in EXPECTED_RECEIPT_REFUSALS, the cadence run DEGRADES instead of
//     reporting a clean publish.
//
// The parser and prompt half of the same fix is pinned hermetically in
// scripts/tests/unit/swarm-take-weights.test.ts — it needs no database.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { canonicalizeSubmission, RECEIPT_CANONICAL_BUCKET_ORDER } from "@robotmoney/contract";
import * as admin from "../src/swarm/admin.ts";
import * as ic from "../src/swarm/domain.ts";
import { sql } from "../src/db/client.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { setJudgeConfig } from "../src/swarm/judge-session.ts";
import { getConsensusReceipt } from "../src/swarm/consensus-receipt.ts";
import { publishSession as publishSessionJob } from "../src/worker/handlers/swarm.ts";
import { installJudgeStub, removeJudgeStub, resetJudgeStubAnswer, setJudgeStubAnswer, STUB_JUDGE_MODEL } from "./support/judge-stub.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

beforeAll(installJudgeStub);
afterAll(removeJudgeStub);
useCleanDatabasePerTest(import.meta.file);

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const CANON = [...RECEIPT_CANONICAL_BUCKET_ORDER];

async function member() {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) throw new Error(`member() failed: ${JSON.stringify(r)}`);
  return { id, token: r.token, privateKey };
}
type Member = Awaited<ReturnType<typeof member>>;

/** Submit one take. `weights` null = the rc.1 shape: a legal, weightless take. */
async function submit(m: Member, date: string, subjectId: string, weights: number[] | null) {
  const sub = {
    memberId: m.id, date, subjectId, nonce: rid("n"),
    stance: "neutral", confidence: 0.5, body: `${m.id} take`,
    ...(weights ? { weights: CANON.map((bucket, i) => ({ bucket, weight: weights[i]! })) } : {}),
  };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  const res = await ic.submitRecommendation(m.token, { ...sub, signature });
  if (res.status !== 201) throw new Error(`submit failed: ${JSON.stringify(res)}`);
}

/** A judged-but-unpublished `bucket_weights` session over the supplied vectors. */
async function bucketWeightsSession(prefix: string, vectors: (number[] | null)[]) {
  const subjectId = rid(prefix);
  await ic.ensureSubject(subjectId, `${prefix} subject`);
  await sql`UPDATE swarm_subjects SET recommendation_type = 'bucket_weights' WHERE id = ${subjectId}`;
  await setJudgeConfig({ mode: "enforce", minTakes: vectors.length, model: STUB_JUDGE_MODEL });
  const session = await ic.openSession(subjectId);
  await ic.publishBrief(session.id, 60);
  const date = session.date instanceof Date
    ? session.date.toISOString().slice(0, 10)
    : String(session.date).slice(0, 10);
  // T17: the submission gate now refuses a weightless or non-canonical-four
  // take for a `bucket_weights` subject, which is the point — but the ASSEMBLY
  // gates below are defence in depth over takes ALREADY ON FILE, and this is
  // how such a take comes to exist: it was filed while the subject still asked
  // for prose only, and the subject was retyped afterwards (migration 0051 did
  // exactly that). The brief above was published under the real type, so the
  // session's ASK is unchanged; only the moment the takes landed differs.
  await sql`UPDATE swarm_subjects SET recommendation_type = 'position_actions' WHERE id = ${subjectId}`;
  for (const v of vectors) await submit(await member(), date, subjectId, v);
  await sql`UPDATE swarm_subjects SET recommendation_type = 'bucket_weights' WHERE id = ${subjectId}`;
  const closed = await admin.closeSessionAdmin(session.id, undefined);
  if (!closed.ok) throw new Error(`close failed: ${JSON.stringify(closed)}`);
  const aggregated = await admin.aggregateSessionAdmin(session.id, undefined);
  if (!aggregated.ok) throw new Error(`aggregate failed: ${JSON.stringify(aggregated)}`);
  const judged = await admin.judgeSessionAdmin(session.id, undefined);
  if (!judged.ok) throw new Error(`judge failed: ${JSON.stringify(judged)}`);
  return { sessionId: session.id, subjectId };
}

// ── AC-FMT-03 / AC-FMT-04 / AC-E2E-01 ───────────────────────────────────────
test("signed analyst vectors reach the receipt as four canonical buckets totalling exactly 10,000 bps", async () => {
  // Deliberately awkward shares: three members whose mean lands off an exact
  // bps boundary, so the total is 10,000 only if largest-remainder ran.
  const { sessionId } = await bucketWeightsSession("weights-happy", [
    [0.15, 0.55, 0.2, 0.1],
    [0.1, 0.7, 0.1, 0.1],
    [0.2, 0.45, 0.25, 0.1],
  ]);

  const result = (await publishSessionJob({ sessionId })) as {
    state: string; consensusReceipt: { published: boolean; reason?: string };
  };
  expect(result.consensusReceipt, JSON.stringify(result)).toEqual({ published: true });

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
  // 4. A STRANGER CAN REPRODUCE IT. `verifyAssembledReceipt` (through the public
  //    read) recomputes the vector from the embedded canonical_submission blobs
  //    and reports any divergence — so this passing means the receipt's weights
  //    ARE the mean of the signed takes, not a producer-local claim.
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
test("a bucket_weights session whose takes carry no vector is refused BY NAME and degrades the cadence run", async () => {
  const { sessionId } = await bucketWeightsSession("weights-absent", [null, null]);

  const result = (await publishSessionJob({ sessionId })) as {
    ok?: boolean; error?: string; consensusReceipt: { published: boolean; reason?: string };
  };

  // THE rc.1 BEHAVIOUR WAS `{published: true}` WITH NO `weights` KEY. Now the
  // reason is named, and names the actual condition rather than a schema error.
  expect(result.consensusReceipt).toEqual({
    published: false,
    reason: "weights_absent_for_bucket_weights_subject",
  });
  // NOT in EXPECTED_RECEIPT_REFUSALS, so loop.ts's isDegradedResult() matches
  // and the run goes red. Without this the refusal would be as quiet as the
  // receipt it replaced.
  expect(result.ok, "an allocation session that produced no allocation is a DEGRADED run").toBe(false);
  expect(result.error).toContain("weights_absent_for_bucket_weights_subject");

  // Nothing was written: no half-receipt, no weightless receipt.
  expect((await sql`SELECT 1 FROM swarm_consensus_receipts WHERE session_id = ${sessionId}`).length).toBe(0);
});

// ── The boundary: position_actions is untouched ─────────────────────────────
test("a position_actions session still publishes without a vector — the gate is typed, not global", async () => {
  const subjectId = rid("weights-positions");
  await ic.ensureSubject(subjectId, "position actions subject");
  // `ensureSubject` seeds `bucket_weights`, so the type is set explicitly and
  // then ASSERTED — the gate must key on the subject, never on "no vector
  // arrived".
  await sql`UPDATE swarm_subjects SET recommendation_type = 'position_actions' WHERE id = ${subjectId}`;
  const row = (await sql`SELECT recommendation_type FROM swarm_subjects WHERE id = ${subjectId}`)[0] as
    { recommendation_type: string | null };
  expect(row.recommendation_type).toBe("position_actions");

  await setJudgeConfig({ mode: "enforce", minTakes: 2, model: STUB_JUDGE_MODEL });
  const session = await ic.openSession(subjectId);
  await ic.publishBrief(session.id, 60);
  const date = session.date instanceof Date
    ? session.date.toISOString().slice(0, 10)
    : String(session.date).slice(0, 10);
  await submit(await member(), date, subjectId, null);
  await submit(await member(), date, subjectId, null);
  await admin.closeSessionAdmin(session.id, undefined);
  await admin.aggregateSessionAdmin(session.id, undefined);
  await admin.judgeSessionAdmin(session.id, undefined);

  const result = (await publishSessionJob({ sessionId: session.id })) as {
    ok?: boolean; consensusReceipt: { published: boolean; reason?: string };
  };
  expect(result.consensusReceipt, JSON.stringify(result)).toEqual({ published: true });
  const stored = await getConsensusReceipt(session.id);
  expect((stored!.receipt as { weights?: unknown }).weights, "never asked for, never invented").toBeUndefined();
});

// ── The brief states the ask (the half the member client reads) ─────────────
test("a bucket_weights brief declares the vector REQUIRED over the four canonical buckets", async () => {
  const bucketSubject = rid("brief-bw");
  await ic.ensureSubject(bucketSubject, "bucket weights subject");
  await sql`UPDATE swarm_subjects SET recommendation_type = 'bucket_weights' WHERE id = ${bucketSubject}`;
  const bwSession = await ic.openSession(bucketSubject);
  await ic.publishBrief(bwSession.id, 60);
  const bwBrief = await ic.getBriefBySession(bwSession.id);
  const bwSchema = (bwBrief!.body as { takeSchema: { weights: { optional: boolean; buckets: string[] } } }).takeSchema;
  expect(bwSchema.weights.optional, "an allocation session ASKS for the allocation").toBe(false);
  expect(bwSchema.weights.buckets).toEqual(CANON);
  // And the subject the member client reads the ask off is on the brief.
  expect((bwBrief!.body as { subject: { recommendationType: string } }).subject.recommendationType)
    .toBe("bucket_weights");

  const paSubject = rid("brief-pa");
  await ic.ensureSubject(paSubject, "position actions subject");
  await sql`UPDATE swarm_subjects SET recommendation_type = 'position_actions' WHERE id = ${paSubject}`;
  const paSession = await ic.openSession(paSubject);
  await ic.publishBrief(paSession.id, 60);
  const paBrief = await ic.getBriefBySession(paSession.id);
  const paSchema = (paBrief!.body as { takeSchema: { weights: { optional: boolean } } }).takeSchema;
  expect(paSchema.weights.optional, "a position_actions session does not").toBe(true);
});

// ── The judge still cannot author a number (finding §4(c)) ──────────────────
//
// RE-ASSERTED HERE ON PURPOSE. The analyst prompt now legitimately contains
// numbers and the brief the judge reads now DECLARES the vector required, so
// the one boundary that keeps "math decides and the judge explains" true has to
// be proved again over a session that actually has an allocation to steal.
//
// Issue #1019 changed the SECOND half of this story. The whole response is
// REJECTED as a weight-smuggling attempt (findWeightLikeKey), which is still
// a `source: 'fallback'` outcome — the model's numbers never reach anything,
// weights or otherwise. But a fallback outcome is now (rightly) refused a
// CERTIFICATE: `judgement_not_authored` (consensus-receipt.ts). A receipt
// attests "the judge read the takes and wrote this", and template prose
// standing in for a model that just tried to smuggle a vector is exactly the
// case that refusal exists for. So this test's proof shifts from "the
// published receipt's numbers are the real mean" to "no receipt is published
// at all, AND the live session's own allocation (what the public API and any
// later, properly-authored receipt would serve) is still the real mean" —
// the invariant survives even though the artifact this test used to inspect
// no longer exists for a fallback judgement.
test("a judge response that tries to author weights is rejected outright, and the receipt refuses to certify the resulting fallback opinion", async () => {
  setJudgeStubAnswer(JSON.stringify({
    rationale: "I have recomputed the allocation myself.",
    disagreements: [],
    release_safety: { release: "safe", concerns: [] },
    // The smuggle: a whole vector, in the model's own answer.
    weights: CANON.map((bucket) => ({ bucket, weight: bucket === "agent_tokens" ? 1 : 0 })),
  }));
  try {
    const { sessionId } = await bucketWeightsSession("weights-smuggle", [
      [0.15, 0.55, 0.2, 0.1],
      [0.05, 0.75, 0.1, 0.1],
    ]);

    // The judgement WAS recorded — that row is how a misbehaving model
    // becomes visible — as a fallback, with the smuggled vector nowhere in
    // its opinion.
    const [judgement] = (await sql`
      SELECT source, opinion FROM swarm_session_judgements WHERE session_id = ${sessionId}`) as any[];
    expect(judgement.source).toBe("fallback");
    expect(JSON.stringify(judgement.opinion)).not.toContain("agent_tokens");
    expect(judgement.opinion.rationale).not.toContain("I have recomputed the allocation myself");

    const result = (await publishSessionJob({ sessionId })) as {
      ok?: boolean; consensusReceipt: { published: boolean; reason?: string };
    };
    // NOT published — the certificate is refused, by name, rather than
    // signed over template prose.
    expect(result.consensusReceipt).toEqual({ published: false, reason: "judgement_not_authored" });
    expect(result.ok).toBe(false);

    const stored = await getConsensusReceipt(sessionId);
    expect(stored).toBeFalsy();

    // The math still decided: the session's own served allocation is the
    // real mean of the two signed takes (agent_tokens: (0.15 + 0.05) / 2 =
    // 0.10), never the model's 1.0 — the invariant a receipt would have
    // attested to, still true with no receipt to attest it.
    const [live] = (await sql`SELECT swarm_recommendation FROM swarm_sessions WHERE id = ${sessionId}`) as any[];
    const weights = live.swarm_recommendation.weights as { bucket: string; weight: number }[];
    const agentTokens = weights.find((w) => w.bucket === "agent_tokens")!;
    expect(agentTokens.weight).toBeCloseTo(0.1, 6);
  } finally {
    resetJudgeStubAnswer();
  }
});


// ── RC2 review finding: the allocation's SUPPORT is a gate, not an accident ──
//
// Gate 5 asks that a `bucket_weights` session produce an allocation. It said
// nothing about WHO produced it, and `meanTakeWeights()` divides by the number
// of VECTORS it found rather than by the number of takes. So a receipt could
// publish an allocation authored by a minority of the takes it attests to,
// with `release_safety.take_count` reporting all of them, `thinly_supported`
// false, `release` safe, and `receiptSemanticErrors` recomputing the same mean
// over the same minority subset and verifying clean. Nothing in the signed
// bytes disclosed it, and nothing could have.
//
// Reachable in the RC's own pipeline, not theoretical: the member client reads
// the brief with `allowStatuses: [404]`, so a member racing the brief authors
// prose only, and an rmpc/MCP/API member is never asked for a vector at all.

/** Submit a take carrying an ARBITRARY weights array — including a partial one. */
async function submitRaw(m: Member, date: string, subjectId: string, weights: { bucket: string; weight: number }[] | null) {
  const sub = {
    memberId: m.id, date, subjectId, nonce: rid("n"),
    stance: "neutral", confidence: 0.5, body: `${m.id} take`,
    ...(weights ? { weights } : {}),
  };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  const res = await ic.submitRecommendation(m.token, { ...sub, signature });
  if (res.status !== 201) throw new Error(`submit failed: ${JSON.stringify(res)}`);
}

/** A judged `bucket_weights` session over arbitrary per-take weight arrays. */
async function rawVectorSession(prefix: string, vectors: ({ bucket: string; weight: number }[] | null)[]) {
  const subjectId = rid(prefix);
  await ic.ensureSubject(subjectId, `${prefix} subject`);
  await sql`UPDATE swarm_subjects SET recommendation_type = 'bucket_weights' WHERE id = ${subjectId}`;
  await setJudgeConfig({ mode: "enforce", minTakes: vectors.length, model: STUB_JUDGE_MODEL });
  const session = await ic.openSession(subjectId);
  await ic.publishBrief(session.id, 60);
  const date = session.date instanceof Date
    ? session.date.toISOString().slice(0, 10)
    : String(session.date).slice(0, 10);
  // T17: the submission gate now refuses a weightless or non-canonical-four
  // take for a `bucket_weights` subject, which is the point — but the ASSEMBLY
  // gates below are defence in depth over takes ALREADY ON FILE, and this is
  // how such a take comes to exist: it was filed while the subject still asked
  // for prose only, and the subject was retyped afterwards (migration 0051 did
  // exactly that). The brief above was published under the real type, so the
  // session's ASK is unchanged; only the moment the takes landed differs.
  await sql`UPDATE swarm_subjects SET recommendation_type = 'position_actions' WHERE id = ${subjectId}`;
  for (const v of vectors) await submitRaw(await member(), date, subjectId, v);
  await sql`UPDATE swarm_subjects SET recommendation_type = 'bucket_weights' WHERE id = ${subjectId}`;
  const closed = await admin.closeSessionAdmin(session.id, undefined);
  if (!closed.ok) throw new Error(`close failed: ${JSON.stringify(closed)}`);
  const aggregated = await admin.aggregateSessionAdmin(session.id, undefined);
  if (!aggregated.ok) throw new Error(`aggregate failed: ${JSON.stringify(aggregated)}`);
  const judged = await admin.judgeSessionAdmin(session.id, undefined);
  if (!judged.ok) throw new Error(`judge failed: ${JSON.stringify(judged)}`);
  return session.id;
}

const full = (shares: number[]) => CANON.map((bucket, i) => ({ bucket, weight: shares[i]! }));

test("a 1-of-3 allocation is REFUSED: the receipt may not claim support it does not have", async () => {
  // The reviewer's PROBE A, exactly: one signed vector, two weightless takes.
  // Before this gate it published `{published: true}` with weights
  // [10000, 0, 0, 0], take_count 3, thinly_supported false, release safe.
  const sessionId = await rawVectorSession("weights-minority", [
    full([1, 0, 0, 0]),
    null,
    null,
  ]);

  const result = (await publishSessionJob({ sessionId })) as {
    ok?: boolean; error?: string; consensusReceipt: { published: boolean; reason?: string };
  };
  expect(result.consensusReceipt).toEqual({
    published: false,
    reason: "weights_not_authored_by_every_take",
  });
  expect(result.ok, "a receipt claiming support it lacks is a DEGRADED run").toBe(false);
  expect(result.error).toContain("weights_not_authored_by_every_take");
  expect((await sql`SELECT 1 FROM swarm_consensus_receipts WHERE session_id = ${sessionId}`).length).toBe(0);
});

test("a take that never NAMED a bucket cannot be counted as a 0.00 vote on it", async () => {
  // The reviewer's PROBE B: a four-bucket vector beside a three-bucket one.
  // The UNION is the canonical four, so `weights_not_canonical_four` is
  // satisfied and the receipt published [3750, 2750, 2250, 1250] — in which the
  // member who never mentioned `real_world_assets` had been recorded as voting
  // exactly 0.00 for it.
  const sessionId = await rawVectorSession("weights-union", [
    full([0.25, 0.25, 0.25, 0.25]),
    [
      { bucket: "agent_tokens", weight: 0.5 },
      { bucket: "conservative_defi_yield", weight: 0.3 },
      { bucket: "protocol_tokens", weight: 0.2 },
    ],
  ]);

  const result = (await publishSessionJob({ sessionId })) as {
    ok?: boolean; consensusReceipt: { published: boolean; reason?: string };
  };
  expect(result.consensusReceipt.published).toBe(false);
  expect(result.consensusReceipt.reason).toBe("weights_not_authored_by_every_take");
  expect(result.ok).toBe(false);
});

test("every take carrying the canonical four still publishes — the gate is about SUPPORT, not about vectors", async () => {
  // The control that keeps the two tests above non-vacuous.
  const sessionId = await rawVectorSession("weights-unanimous", [
    full([0.25, 0.25, 0.25, 0.25]),
    full([0.5, 0.3, 0.1, 0.1]),
    full([0, 0.9, 0.05, 0.05]),
  ]);
  const result = (await publishSessionJob({ sessionId })) as { consensusReceipt: { published: boolean } };
  expect(result.consensusReceipt).toEqual({ published: true });

  const stored = await getConsensusReceipt(sessionId);
  const receipt = stored!.receipt as {
    weights: { bucket: string; weight_bps: number }[];
    release_safety?: { take_count?: number };
  };
  expect(receipt.weights.reduce((n, w) => n + w.weight_bps, 0)).toBe(10_000);
  expect(stored!.verified).toBe(true);
  // And the claim the finding is about now holds by construction: every take
  // the receipt attests to authored the allocation it carries.
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
  const sessionId = await rawVectorSession("weights-three-bucket", [three, three]);
  const result = (await publishSessionJob({ sessionId })) as {
    ok?: boolean; consensusReceipt: { published: boolean; reason?: string };
  };
  expect(result.consensusReceipt.reason).toBe("weights_not_canonical_four");
});
