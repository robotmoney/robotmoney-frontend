// PUBLISHING THE CONSENSUS RECEIPT, END TO END (issue #754).
//
// The sibling file (consensus-receipt-assembler.test.ts) drives the PURE
// assembler and pins the conformance vector. This one drives everything the
// pure half cannot reach: the stored artifact, the public URL, immutability,
// and the two properties that are only true of a receipt built out of a REAL
// database — the key that signed a take rather than the member's current one,
// and a nonce that cannot be carried into a second session.
//
// NOTHING IS MOCKED. Real members with real Ed25519 keys, real submissions
// through submitRecommendation(), the real aggregator, the real judge (with no
// model configured, so it takes its documented template-fallback path), and the
// real HTTP dispatcher. The database is a clean clone of the migrated schema
// per file; if Postgres is unavailable the suite fails loudly rather than
// skipping.
import { expect, test } from "bun:test";
import { ROUTES, canonicalizeSubmission, path } from "@robotmoney/contract";
import * as admin from "../src/swarm/admin.ts";
import * as ic from "../src/swarm/domain.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { sql } from "../src/db/client.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { setJudgeConfig, judgeSession } from "../src/swarm/judge-session.ts";
import { ConsensusReceiptRefusal, publishConsensusReceipt, getConsensusReceipt, verifyAssembledReceipt } from "../src/swarm/consensus-receipt.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const CANONICAL_FOUR = ["agent_tokens", "conservative_defi_yield", "protocol_tokens", "real_world_assets"];
const get = (p: string) => handleSwarm(new Request(`http://localhost${p}`), new URL(`http://localhost${p}`));

async function member() {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) throw new Error(`member() failed: ${JSON.stringify(r)}`);
  return { id, token: r.token, privateKey, publicKeyB64 };
}
type Member = Awaited<ReturnType<typeof member>>;

async function submit(m: Member, date: string, subjectId: string, weights: number[] | null, o: { stance?: string; nonce?: string } = {}) {
  const sub = {
    memberId: m.id, date, subjectId, nonce: o.nonce ?? rid("n"),
    stance: o.stance ?? "neutral", confidence: 0.5, body: `${m.id} take`,
    ...(weights ? { weights: CANONICAL_FOUR.map((bucket, i) => ({ bucket, weight: weights[i]! })) } : {}),
  };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  const res = await ic.submitRecommendation(m.token, { ...sub, signature });
  if (res.status !== 201) throw new Error(`submit failed: ${JSON.stringify(res)}`);
  return sub;
}

/**
 * A collecting session with takes on file — everything up to, but not
 * including, the close/aggregate/judge/publish ladder.
 */
async function collectingSession(prefix: string, weights: (number[] | null)[], mode: "shadow" | "enforce" = "enforce") {
  const subjectId = rid(prefix);
  await ic.ensureSubject(subjectId, `${prefix} subject`);
  await sql`UPDATE swarm_subjects SET recommendation_type = 'bucket_weights' WHERE id = ${subjectId}`;
  // The judge is `off` by shipped default. Turned on here rather than in a
  // beforeAll so it is set against THIS file's cloned database, whatever order
  // the harness creates it in.
  //
  // ENFORCE, NOT SHADOW, and that is now load-bearing rather than incidental.
  // In `shadow` applyOpinion() is never called: the judgement is recorded and
  // the session keeps its aggregator-authored prose. A receipt embeds only the
  // opinion the session ADOPTED, so a shadow session has nothing to assemble —
  // asserted directly further down.
  await setJudgeConfig({ mode, minTakes: 2 });
  const session = await ic.openSession(subjectId);
  await ic.publishBrief(session.id, 60);
  const date = session.date instanceof Date ? session.date.toISOString().slice(0, 10) : String(session.date).slice(0, 10);
  const members: Member[] = [];
  for (const vector of weights) {
    const m = await member();
    members.push(m);
    await submit(m, date, subjectId, vector);
  }
  return { subjectId, sessionId: session.id, date, members };
}

const stateOf = async (sessionId: string): Promise<string> =>
  String(((await sql`SELECT state FROM swarm_sessions WHERE id = ${sessionId}`)[0] as any).state);

/**
 * Take a collecting session all the way to `published` THROUGH THE ADMIN
 * LADDER — close, aggregate, judge, publish — because every one of those is a
 * guarded transition and the receipt is now assembled only from a session that
 * has reached the end of it.
 */
async function advanceToPublished(sessionId: string) {
  const closed = await admin.closeSessionAdmin(sessionId, undefined);
  if (!closed.ok) throw new Error(`close failed: ${JSON.stringify(closed)}`);
  const aggregated = await admin.aggregateSessionAdmin(sessionId, undefined);
  if (!aggregated.ok) throw new Error(`aggregate failed: ${JSON.stringify(aggregated)}`);
  // No model is configured, so the judge takes its template-fallback path and
  // records `source: "fallback"` — a complete, anchorable opinion.
  const judged = await admin.judgeSessionAdmin(sessionId, undefined);
  if (!judged.ok) throw new Error(`judge failed: ${JSON.stringify(judged)}`);
  const published = await admin.publishSessionAdmin(sessionId, undefined);
  if (!published.ok) throw new Error(`publish failed: ${JSON.stringify(published)}`);
  return judged;
}

/** A PUBLISHED, judged, weighted session — the only state a receipt assembles from. */
async function judgedSession(prefix: string, weights: (number[] | null)[]) {
  const session = await collectingSession(prefix, weights);
  await advanceToPublished(session.sessionId);
  return session;
}

test("a judged session publishes a receipt that is fetchable, verified, and byte-consistent", async () => {
  const { sessionId, subjectId } = await judgedSession("recpub", [[0.15, 0.55, 0.2, 0.1], [0.1, 0.65, 0.15, 0.1]]);

  const published = await admin.publishConsensusReceiptAdmin(sessionId);
  expect(published.ok).toBe(true);
  expect(published.status).toBe(200);
  // THE URL IS DERIVED FROM THE SESSION ID AND NOTHING ELSE — no digest, no
  // build id, no deploy stamp — which is what makes it stable across redeploys.
  const url = path(ROUTES.swarm.sessionConsensusReceipt, { id: sessionId });
  expect((published as any).receipt.url).toBe(url);
  expect(url).toBe(`/api/swarm/sessions/${sessionId}/consensus-receipt`);

  const res = (await get(url)) as { status: number; body: any };
  expect(res.status).toBe(200);
  expect(res.body.verified).toBe(true);
  expect(res.body.unverifiedReasons).toEqual([]);
  expect(res.body.sessionId).toBe(sessionId);
  expect(res.body.subjectId).toBe(subjectId);
  expect(res.body.schemaVersion).toBe("1.0");

  // The payload carries everything the issue's first acceptance criterion names.
  const receipt = res.body.receipt;
  expect(receipt.weights.map((w: any) => w.bucket)).toEqual(CANONICAL_FOUR);
  expect(receipt.weights.reduce((t: number, w: any) => t + w.weight_bps, 0)).toBe(10_000);
  expect(receipt.judge.rationale.length).toBeGreaterThan(0);
  expect(receipt.judge.source).toBe("fallback");
  // THE MODE IS IN THE SIGNED BYTES. A verifier holding only the receipt can
  // tell an opinion the session adopted from one it withheld.
  expect(receipt.judge.mode).toBe("enforce");
  expect(res.body.canonicalBytes).toContain('"mode":"enforce"');
  // And each entry names WHICH revision it carries.
  for (const s of receipt.analyst_signatures) expect(s.revision).toBe(1);
  // The session revision the receipt attests to is recorded beside the row, so
  // a later divergence would be a detectable fact rather than an invisible one.
  const [pinned] = (await sql`
    SELECT session_version FROM swarm_consensus_receipts WHERE session_id = ${sessionId}`) as any[];
  const [live] = (await sql`SELECT state, version FROM swarm_sessions WHERE id = ${sessionId}`) as any[];
  expect(live.state).toBe("published");
  expect(Number(pinned.session_version)).toBe(Number(live.version));
  expect(receipt.prompt_hash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(receipt.inputs_digest).toMatch(/^0x[0-9a-f]{64}$/);
  expect(receipt.analyst_signatures).toHaveLength(2);
  for (const s of receipt.analyst_signatures) {
    expect(s.public_key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(s.signature).toMatch(/^[A-Za-z0-9+/]{86}==$/);
  }
  expect(res.body.signatures.every((s: any) => s.verified)).toBe(true);

  // Read twice: the SAME bytes, and every signature re-verified on each read
  // rather than a stored flag being echoed.
  const again = (await get(url)) as { status: number; body: any };
  expect(again.body.canonicalBytes).toBe(res.body.canonicalBytes);
  expect(again.body.verified).toBe(true);

  // ACROSS A REDEPLOY, and this is what that reduces to. A redeploy replaces the
  // process and keeps the database, so "the URL is stable and serves
  // byte-identical content across one" is true exactly when (a) the path carries
  // no process- or build-scoped component and (b) the bytes come out of
  // Postgres rather than out of this process. Both are asserted rather than
  // argued: the path is `path(ROUTES…, { id })` over the session id alone —
  // already checked above — and the served bytes are compared against the
  // column they were read from. Nothing is memoized in module scope; a restarted
  // api reads the same row and answers the same bytes.
  const [row] = (await sql`
    SELECT canonical_bytes, receipt FROM swarm_consensus_receipts WHERE session_id = ${sessionId}`) as any[];
  expect(res.body.canonicalBytes).toBe(row.canonical_bytes);
  expect(res.body.receipt).toEqual(row.receipt);
});

test("a published receipt is IMMUTABLE: re-publishing returns the same bytes even after the session moves", async () => {
  const { sessionId } = await judgedSession("recimm", [[0.25, 0.25, 0.25, 0.25], [0.25, 0.25, 0.25, 0.25]]);
  const first = await publishConsensusReceipt(sessionId);

  // The session's recommendation is NOT append-only — a later judge run in
  // `enforce` rewrites its prose — so a receipt that re-assembled on every call
  // would silently change the bytes an anchored digest commits to.
  await sql`
    UPDATE swarm_sessions
    SET swarm_recommendation = jsonb_set(swarm_recommendation, '{rationale}', '"rewritten after publication"')
    WHERE id = ${sessionId}`;

  const second = await publishConsensusReceipt(sessionId);
  expect(second.canonicalBytes).toBe(first.canonicalBytes);
  expect(second.publishedAt).toBe(first.publishedAt);
  expect(JSON.stringify(second.receipt)).toBe(JSON.stringify(first.receipt));
  expect((second.receipt.judge as any).rationale).not.toBe("rewritten after publication");
});

test("the stored receipt refuses UPDATE and DELETE at the database, not merely in the code", async () => {
  const { sessionId } = await judgedSession("recguard", [[0.4, 0.3, 0.2, 0.1], [0.1, 0.2, 0.3, 0.4]]);
  await publishConsensusReceipt(sessionId);

  // UPDATE — migration 0042's own trigger. The append-only guard shared with
  // every other protected table does NOT cover UPDATE, and for this table the
  // difference matters: amending these bytes does not amend the receipt, it
  // orphans the on-chain digest that commits to them.
  let raised: any = null;
  try {
    await sql`UPDATE swarm_consensus_receipts SET canonical_bytes = 'tampered' WHERE session_id = ${sessionId}`;
  } catch (e) { raised = e; }
  expect(raised).not.toBeNull();
  expect(String(raised.message)).toContain("immutable once published");

  // DELETE and TRUNCATE — the shared append-only guard (migrations 0032/0042).
  raised = null;
  try { await sql`DELETE FROM swarm_consensus_receipts WHERE session_id = ${sessionId}`; } catch (e) { raised = e; }
  expect(String(raised?.message)).toContain("append-only");
  raised = null;
  try { await sql.unsafe(`TRUNCATE swarm_consensus_receipts CASCADE`); } catch (e) { raised = e; }
  expect(String(raised?.message)).toContain("append-only");

  const [row] = (await sql`SELECT canonical_bytes FROM swarm_consensus_receipts WHERE session_id = ${sessionId}`) as any[];
  expect(row.canonical_bytes).not.toBe("tampered");
});

test("KEY ROTATION: the receipt embeds the key that SIGNED, and keeps verifying after the roster moves on", async () => {
  const { sessionId, members } = await judgedSession("recrot", [[0.5, 0.2, 0.2, 0.1], [0.2, 0.5, 0.2, 0.1]]);
  const rotator = members[0]!;

  // Rotate BEFORE publishing, so the assembler is the thing under test: the
  // member's currently-active key is now a different key from the one that
  // signed the take on file. Every other read path in this repo resolves a
  // take's key as `AND k.active` and would publish the wrong one (issue #697).
  const fresh = await generateKeyPair();
  const rotated = await admin.rotateMemberKeyAdmin(rotator.id, { publicKey: fresh.publicKeyB64 });
  expect(rotated.ok).toBe(true);
  const [current] = (await sql`
    SELECT public_key FROM swarm_member_keys WHERE member_id = ${rotator.id} AND active = true`) as any[];
  expect(current.public_key).toBe(fresh.publicKeyB64);
  expect(current.public_key).not.toBe(rotator.publicKeyB64);

  const stored = await publishConsensusReceipt(sessionId);
  const embedded = (stored.receipt.analyst_signatures as any[]).find((s) => s.member_id === rotator.id);
  expect(embedded.public_key).toBe(rotator.publicKeyB64);
  expect(embedded.public_key).not.toBe(fresh.publicKeyB64);

  // And it still verifies — read-time verification uses the embedded key and
  // never consults the roster, so a second rotation changes nothing either.
  const second = await generateKeyPair();
  await admin.rotateMemberKeyAdmin(rotator.id, { publicKey: second.publicKeyB64 });
  const verdict = await getConsensusReceipt(sessionId);
  expect(verdict!.verified).toBe(true);
  expect(verdict!.signatures.every((s) => s.verified)).toBe(true);
});

test("a receipt whose payload no longer matches its published bytes is SERVED as unverified, not as valid", async () => {
  // Built by INSERTING a receipt whose stored payload disagrees with its stored
  // bytes, because the honest path cannot produce one: migration 0042 refuses
  // the UPDATE that would tamper with a published row. The point being checked
  // is the READ side — that a receipt which does not check out comes back 200
  // and unverified rather than being passed off as valid or hidden.
  const { sessionId } = await judgedSession("recunver", [[0.25, 0.25, 0.25, 0.25], [0.25, 0.25, 0.25, 0.25]]);
  const honest = await publishConsensusReceipt(sessionId);

  const other = await judgedSession("recunver2", [[0.25, 0.25, 0.25, 0.25], [0.25, 0.25, 0.25, 0.25]]);
  const tampered = JSON.parse(JSON.stringify(honest.receipt));
  tampered.session_id = other.sessionId;
  tampered.subject_id = other.subjectId;
  tampered.judge.rationale = "a rationale nobody wrote";
  const [judgement] = (await sql`
    SELECT id FROM swarm_session_judgements WHERE session_id = ${other.sessionId} ORDER BY id DESC LIMIT 1`) as any[];
  const [version] = (await sql`SELECT version FROM swarm_sessions WHERE id = ${other.sessionId}`) as any[];
  await sql`
    INSERT INTO swarm_consensus_receipts (session_id, subject_id, schema_version, judgement_id, session_version, receipt, canonical_bytes)
    VALUES (${other.sessionId}, ${other.subjectId}, '1.0', ${judgement.id}, ${Number(version.version)},
            ${sql.json(tampered)}, ${honest.canonicalBytes})`;

  const res = (await get(path(ROUTES.swarm.sessionConsensusReceipt, { id: other.sessionId }))) as { status: number; body: any };
  expect(res.status).toBe(200);
  expect(res.body.verified).toBe(false);
  expect(res.body.unverifiedReasons.join(" ")).toContain("no longer canonicalizes");
  // The analyst signatures themselves are untouched and still check out — which
  // is exactly why signature checking alone is not enough for an aggregate.
  expect(res.body.signatures.every((s: any) => s.verified)).toBe(true);
});

test("refusals reach the operator with a reason: an unjudged session, and a non-canonical weight vector", async () => {
  // Never judged: there is no opinion, no prompt_hash and no inputs_digest to
  // carry, so there is nothing to assemble. Published all the same —
  // `aggregated -> published` stays legal with the judge off — so the refusal
  // reported is about the judgement and not about the state.
  await setJudgeConfig({ mode: "off", minTakes: 2 });
  const bare = await collectingSession("recunjudged", [[0.25, 0.25, 0.25, 0.25]], "shadow");
  await setJudgeConfig({ mode: "off", minTakes: 2 });
  expect((await admin.closeSessionAdmin(bare.sessionId, undefined)).ok).toBe(true);
  expect((await admin.aggregateSessionAdmin(bare.sessionId, undefined)).ok).toBe(true);
  expect((await admin.publishSessionAdmin(bare.sessionId, undefined)).ok).toBe(true);

  const refusedUnjudged = await admin.publishConsensusReceiptAdmin(bare.sessionId);
  expect(refusedUnjudged.ok).toBe(false);
  expect(refusedUnjudged.status).toBe(409);
  expect((refusedUnjudged as any).error).toBe("not_judged");
  expect((await get(path(ROUTES.swarm.sessionConsensusReceipt, { id: bare.sessionId }))) as any).toMatchObject({ status: 404 });

  // A THREE-BUCKET vector: valid to the producer, publicly served, and
  // uncarriable by schema 1.0. Refused rather than published with the
  // allocation silently dropped.
  const threeSubject = rid("recthree");
  await ic.ensureSubject(threeSubject, "three bucket subject");
  await sql`UPDATE swarm_subjects SET recommendation_type = 'bucket_weights' WHERE id = ${threeSubject}`;
  await setJudgeConfig({ mode: "enforce", minTakes: 2 });
  const s3 = await ic.openSession(threeSubject);
  await ic.publishBrief(s3.id, 60);
  const date3 = s3.date instanceof Date ? s3.date.toISOString().slice(0, 10) : String(s3.date).slice(0, 10);
  for (let i = 0; i < 2; i++) {
    const mi = await member();
    const sub = {
      memberId: mi.id, date: date3, subjectId: threeSubject, nonce: rid("n"),
      stance: "neutral", confidence: 0.5, body: "three buckets",
      weights: [
        { bucket: "agent_tokens", weight: 0.5 },
        { bucket: "conservative_defi_yield", weight: 0.3 },
        { bucket: "protocol_tokens", weight: 0.2 },
      ],
    };
    const res = await ic.submitRecommendation(mi.token, { ...sub, signature: await signMessage(canonicalizeSubmission(sub), mi.privateKey) });
    expect(res.status).toBe(201);
  }
  await advanceToPublished(s3.id);

  // The public API really does serve an allocation for this session — which is
  // the contradiction a silent omission would create.
  const served = (await sql`SELECT swarm_recommendation FROM swarm_sessions WHERE id = ${s3.id}`)[0] as any;
  expect(served.swarm_recommendation.weights).toHaveLength(3);

  const refusedWeights = await admin.publishConsensusReceiptAdmin(s3.id);
  expect(refusedWeights.ok).toBe(false);
  expect((refusedWeights as any).error).toBe("weights_not_canonical_four");
  expect((refusedWeights as any).details.join(" ")).toContain("real_world_assets");
  const [none] = (await sql`SELECT count(*)::int AS n FROM swarm_consensus_receipts WHERE session_id = ${s3.id}`) as any[];
  expect(none.n).toBe(0);
});

test("REPLAY: a member's nonce is single-use across sessions, and the assembler refuses one that is not", async () => {
  const first = await judgedSession("recreplay", [[0.25, 0.25, 0.25, 0.25], [0.25, 0.25, 0.25, 0.25]]);
  const replayer = first.members[0]!;
  const [take] = (await sql`
    SELECT nonce, payload, signature FROM swarm_recommendations
    WHERE session_id = ${first.sessionId} AND member_id = ${replayer.id}`) as any[];

  // The live refusal: re-submitting a used nonce into a NEW session is rejected
  // before anything is written.
  const second = rid("recreplay2");
  await ic.ensureSubject(second, "replay target");
  await sql`UPDATE swarm_subjects SET recommendation_type = 'bucket_weights' WHERE id = ${second}`;
  const s2 = await ic.openSession(second);
  await ic.publishBrief(s2.id, 60);
  const date2 = s2.date instanceof Date ? s2.date.toISOString().slice(0, 10) : String(s2.date).slice(0, 10);
  await expect(submit(replayer, date2, second, [0.25, 0.25, 0.25, 0.25], { nonce: take.nonce }))
    .rejects.toThrow(/replay/);

  // And the assembler's OWN refusal, which is what a stranger checking the
  // receipt is relying on rather than on a constraint they cannot see. The
  // constraint is lifted for the length of this assertion so a replayed row can
  // exist at all, then restored.
  await sql.unsafe(`ALTER TABLE swarm_recommendations DROP CONSTRAINT swarm_recommendations_member_id_nonce_key`);
  try {
    await sql`
      INSERT INTO swarm_recommendations (session_id, member_id, subject_id, date, nonce, stance, confidence, body, payload, signature, verified, revision)
      VALUES (${s2.id}, ${replayer.id}, ${second}, ${date2}, ${take.nonce}, 'neutral', 0.5, 'replayed',
              ${sql.json(take.payload)}, ${take.signature}, true, 1)`;
    await advanceToPublished(s2.id);

    let raised: ConsensusReceiptRefusal | null = null;
    try { await publishConsensusReceipt(s2.id); } catch (e) { raised = e as ConsensusReceiptRefusal; }
    expect(raised).toBeInstanceOf(ConsensusReceiptRefusal);
    expect(raised!.reason).toBe("nonce_replayed");
    expect(raised!.message).toContain("already filed against a different session");
  } finally {
    await sql.unsafe(
      `ALTER TABLE swarm_recommendations ADD CONSTRAINT swarm_recommendations_member_id_nonce_key UNIQUE (member_id, nonce)`,
    ).catch(() => {});
  }
});

// ── The two blockers, driven through documented admin operations ────────────
// Both of these were DEMONSTRATED against a live database before they were
// fixed: each produced a signed, immutable, chain-anchorable artifact that
// contradicted the session it was about, served as `verified: true` with no
// divergence signal on any surface. Each test below reproduces the exact
// sequence and asserts that publication is now REFUSED, by name.

test("BLOCKER 1: aggregate, judge, reopen, amend — and the receipt is REFUSED, not silently stale", async () => {
  const { sessionId, date, subjectId, members } = await collectingSession("recreopen", [
    [0.25, 0.25, 0.25, 0.25],
    [0.25, 0.25, 0.25, 0.25],
  ]);
  expect((await admin.closeSessionAdmin(sessionId, undefined)).ok).toBe(true);
  expect((await admin.aggregateSessionAdmin(sessionId, undefined)).ok).toBe(true);
  expect((await admin.judgeSessionAdmin(sessionId, undefined)).ok).toBe(true);
  expect(await stateOf(sessionId)).toBe("judged");

  // THE ORIGINAL SEQUENCE, step for step, and every one of these is a
  // documented admin transition that still succeeds. Only the receipt refuses.
  const before = (await sql`SELECT swarm_recommendation FROM swarm_sessions WHERE id = ${sessionId}`)[0] as any;
  expect(before.swarm_recommendation.weights.map((w: any) => w.weight_bps ?? w.weight))
    .toEqual([0.25, 0.25, 0.25, 0.25]);

  // A receipt is refused BEFORE the reopen, because the session is not
  // terminal — this is the gate that makes the rest unreachable rather than
  // merely unlikely.
  const early = await admin.publishConsensusReceiptAdmin(sessionId);
  expect(early.ok).toBe(false);
  expect((early as any).error).toBe("session_not_published");
  expect((early as any).message).toContain("publish the session first");

  expect((await admin.closeSessionAdmin(sessionId, undefined)).ok).toBe(true);
  expect((await admin.reopenSessionAdmin(sessionId, undefined)).ok).toBe(true);
  expect(await stateOf(sessionId)).toBe("collecting");
  // Member A amends: a REVISION, so the member count does not change and the
  // old cardinality-only cross-check saw nothing.
  await submit(members[0]!, date, subjectId, [0.9, 0.05, 0.03, 0.02], { stance: "bullish" });
  expect((await admin.closeSessionAdmin(sessionId, undefined)).ok).toBe(true);
  expect((await admin.aggregateSessionAdmin(sessionId, undefined)).ok).toBe(true);

  const after = (await sql`SELECT swarm_recommendation FROM swarm_sessions WHERE id = ${sessionId}`)[0] as any;
  expect(after.swarm_recommendation.stances).toEqual({ bullish: 1, neutral: 1 });
  expect(after.swarm_recommendation.weights).not.toEqual(before.swarm_recommendation.weights);

  // Still refused, and now for the reason that names what changed: the
  // judgement on file describes the take set BEFORE the amendment.
  await sql`UPDATE swarm_sessions SET state = 'published' WHERE id = ${sessionId}`;
  const stale = await admin.publishConsensusReceiptAdmin(sessionId);
  expect(stale.ok).toBe(false);
  expect(["judgement_stale", "judgement_not_adopted"]).toContain((stale as any).error);
  const [none] = (await sql`SELECT count(*)::int AS n FROM swarm_consensus_receipts WHERE session_id = ${sessionId}`) as any[];
  expect(none.n).toBe(0);
});

test("BLOCKER 1b: a receipt is refused from EVERY non-terminal state, by name", async () => {
  const { sessionId } = await collectingSession("recstates", [[0.25, 0.25, 0.25, 0.25], [0.25, 0.25, 0.25, 0.25]]);
  const seen: string[] = [];
  for (const advance of [
    async () => { expect(await stateOf(sessionId)).toBe("collecting"); },
    async () => { expect((await admin.closeSessionAdmin(sessionId, undefined)).ok).toBe(true); },
    async () => { expect((await admin.aggregateSessionAdmin(sessionId, undefined)).ok).toBe(true); },
    async () => { expect((await admin.judgeSessionAdmin(sessionId, undefined)).ok).toBe(true); },
  ]) {
    await advance();
    const refused = await admin.publishConsensusReceiptAdmin(sessionId);
    expect(refused.ok).toBe(false);
    expect((refused as any).error).toBe("session_not_published");
    seen.push(await stateOf(sessionId));
  }
  // Loud-skip-never: the loop really did walk four distinct states.
  expect(seen).toEqual(["collecting", "window_closed", "aggregated", "judged"]);

  // And the same session publishes cleanly the moment it is terminal.
  expect((await admin.publishSessionAdmin(sessionId, undefined)).ok).toBe(true);
  const ok = await admin.publishConsensusReceiptAdmin(sessionId);
  expect(ok.ok).toBe(true);
});

test("BLOCKER 2: a SHADOW judgement never reaches a receipt, and an enforce one is bound by equality", async () => {
  // Shadow is the DOCUMENTED ROLLOUT MODE — operators are told to sit in it
  // "for as long as it takes to trust it" — so before this, by the design of
  // the rollout, the first receipts ever published would have carried model
  // prose the session never showed.
  const shadow = await collectingSession("recshadow", [[0.25, 0.25, 0.25, 0.25], [0.25, 0.25, 0.25, 0.25]], "shadow");
  expect((await admin.closeSessionAdmin(shadow.sessionId, undefined)).ok).toBe(true);
  expect((await admin.aggregateSessionAdmin(shadow.sessionId, undefined)).ok).toBe(true);
  const judgedShadow = await admin.judgeSessionAdmin(shadow.sessionId, undefined);
  expect(judgedShadow.ok).toBe(true);
  expect((judgedShadow as any).judge.mode).toBe("shadow");
  expect((judgedShadow as any).judge.applied).toBe(false);
  expect((await admin.publishSessionAdmin(shadow.sessionId, undefined)).ok).toBe(true);

  // The judgement row IS on file — this is not "no judgement", it is "an
  // opinion the session never adopted".
  const [rows] = (await sql`
    SELECT count(*)::int AS n FROM swarm_session_judgements WHERE session_id = ${shadow.sessionId}`) as any[];
  expect(rows.n).toBe(1);
  const [sess] = (await sql`SELECT swarm_recommendation FROM swarm_sessions WHERE id = ${shadow.sessionId}`) as any[];
  expect(sess.swarm_recommendation.judge).toBeUndefined();

  const refused = await admin.publishConsensusReceiptAdmin(shadow.sessionId);
  expect(refused.ok).toBe(false);
  expect((refused as any).error).toBe("judgement_not_adopted");
  expect((refused as any).message).toContain("`shadow`");
  const [none] = (await sql`
    SELECT count(*)::int AS n FROM swarm_consensus_receipts WHERE session_id = ${shadow.sessionId}`) as any[];
  expect(none.n).toBe(0);

  // THE NEWEST ROW IS NOT THE ADOPTED ROW. Judge in enforce (applied), then
  // record a LATER shadow judgement over the same inputs — identical
  // prompt_hash and inputs_digest, higher id. `ORDER BY id DESC LIMIT 1` would
  // embed the shadow one; binding to the session's own judge block does not.
  const live = await collectingSession("recbound", [[0.15, 0.55, 0.2, 0.1], [0.1, 0.65, 0.15, 0.1]]);
  expect((await admin.closeSessionAdmin(live.sessionId, undefined)).ok).toBe(true);
  expect((await admin.aggregateSessionAdmin(live.sessionId, undefined)).ok).toBe(true);
  const enforced = await admin.judgeSessionAdmin(live.sessionId, undefined);
  expect(enforced.ok).toBe(true);
  expect((enforced as any).judge.applied).toBe(true);
  const adoptedId = String((enforced as any).judge.judgementId);

  await setJudgeConfig({ mode: "shadow", minTakes: 2 });
  const later = await judgeSession(live.sessionId);
  expect(later.ok).toBe(true);
  expect(Number(later.judgementId)).toBeGreaterThan(Number(adoptedId));
  const [latest] = (await sql`
    SELECT id, mode FROM swarm_session_judgements WHERE session_id = ${live.sessionId} ORDER BY id DESC LIMIT 1`) as any[];
  expect(latest.mode).toBe("shadow");

  expect((await admin.publishSessionAdmin(live.sessionId, undefined)).ok).toBe(true);
  const published = await admin.publishConsensusReceiptAdmin(live.sessionId);
  expect(published.ok).toBe(true);
  // The receipt is joined to the ADOPTED judgement, not the newest one.
  const [stored] = (await sql`
    SELECT judgement_id FROM swarm_consensus_receipts WHERE session_id = ${live.sessionId}`) as any[];
  expect(String(stored.judgement_id)).toBe(adoptedId);
  // And it says so inside the signed bytes.
  const body = (await get(path(ROUTES.swarm.sessionConsensusReceipt, { id: live.sessionId }))) as any;
  expect(body.body.receipt.judge.mode).toBe("enforce");
  expect(body.body.verified).toBe(true);
  // The judge block in the receipt IS the judge block the session serves.
  const [record] = (await sql`SELECT swarm_recommendation FROM swarm_sessions WHERE id = ${live.sessionId}`) as any[];
  expect(body.body.receipt.judge.rationale).toBe(record.swarm_recommendation.rationale);
  expect(body.body.receipt.judge.release_safety).toEqual(record.swarm_recommendation.release_safety);
});

test("a LATE FIRST take names its remedy instead of reading like a corrupted rollup", async () => {
  // The deadline is the advertised `window_closes_at` TIMESTAMP, not the state
  // (domain.ts submitRecommendation), so a member filing their FIRST take after
  // aggregation gets a 201 — supported product behaviour, and the reason only
  // AMENDMENTS are confined to TAKES_AMENDABLE_STATES. The rollup then
  // describes one member fewer than the take set does.
  const { sessionId, date, subjectId } = await collectingSession("reclate", [
    [0.25, 0.25, 0.25, 0.25],
    [0.25, 0.25, 0.25, 0.25],
  ]);
  await advanceToPublished(sessionId);
  const latecomer = await member();
  await submit(latecomer, date, subjectId, [0.25, 0.25, 0.25, 0.25]);

  const refused = await admin.publishConsensusReceiptAdmin(sessionId);
  expect(refused.ok).toBe(false);
  expect((refused as any).error).toBe("session_not_reaggregated");
  // THE MESSAGE NAMES THE FIX. Previously this surfaced as `semantics_invalid`
  // with "stances: counts do not sum to quorum.submitted" and "release_safety:
  // take_count !== quorum.submitted" — accurate, and a dead end for an operator.
  expect((refused as any).message).toContain("re-aggregate and re-judge");
  expect((refused as any).message).toContain("3 take(s)");
});

test("the shipped verifier catches a submission filed under the wrong member, over real signatures", async () => {
  // The signature check cannot catch this: each entry's signature verifies
  // against the key beside it, because the keys move with the submissions. Only
  // parsing the carried string and comparing it to the entry it sits in does —
  // and that check is in `receiptSemanticErrors`, which is the verifier a
  // third party runs, not a private write-time assertion.
  const { sessionId } = await judgedSession("recswap", [[0.15, 0.55, 0.2, 0.1], [0.1, 0.65, 0.15, 0.1]]);
  const honest = await publishConsensusReceipt(sessionId);
  expect((await getConsensusReceipt(sessionId))!.verified).toBe(true);

  const swapped = JSON.parse(JSON.stringify(honest.receipt));
  const [a, b] = swapped.analyst_signatures;
  [a.canonical_submission, b.canonical_submission] = [b.canonical_submission, a.canonical_submission];
  [a.public_key, b.public_key] = [b.public_key, a.public_key];
  [a.signature, b.signature] = [b.signature, a.signature];

  const verdict = await verifyAssembledReceipt(swapped, honest.canonicalBytes);
  // EVERY SIGNATURE STILL VERIFIES — that is exactly the point.
  expect(verdict.signatures.every((s) => s.verified)).toBe(true);
  expect(verdict.verified).toBe(false);
  expect(verdict.unverifiedReasons.join(" ")).toContain("is filed under");
});
