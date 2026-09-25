// T17 / D4 — A WEIGHTLESS OR NON-CANONICAL-FOUR TAKE IS REFUSED AT SUBMISSION.
//
// WHAT THIS PROTECTS. Until this existed the only refusal of a take that a
// `bucket_weights` session cannot use was at RECEIPT ASSEMBLY, and that refusal
// is TERMINAL: gate 5/5b refuse the whole receipt when any frozen take lacks a
// canonical-four vector, and once the window has closed nothing can clear it —
// amendments are gated on `window_closes_at > now()`, `rosterExcuseAdmin` was
// refused once `state != 'scheduled'`, `swarm_recommendations` is append-only at
// the database level, `publishConsensusReceiptAdmin` has no force path, and
// `published` is terminal so `reopenSessionAdmin` cannot reach it either. One
// unprivileged-but-keyed roster member — or any rmpc/MCP/API member, which is
// never asked for weights — destroyed a session's receipt permanently by
// behaving normally.
//
// The fix moves the refusal to the moment it is RECOVERABLE: a 400 while the
// window is open, which the member can answer by amending its take. The
// assembly refusal STAYS (defence in depth, and the only guard over takes
// already on file) — pinned by swarm-analyst-weights-receipt.test.ts.
//
// The lever below is the backstop for sessions ALREADY stuck when this shipped;
// it is audited, and it is deliberately not load-bearing.
import { expect, test } from "bun:test";
import { canonicalizeSubmission, RECEIPT_CANONICAL_BUCKET_ORDER } from "@robotmoney/contract";
import * as admin from "../src/swarm/admin.ts";
import * as ic from "../src/swarm/domain.ts";
import { sql } from "../src/db/client.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const CANON = [...RECEIPT_CANONICAL_BUCKET_ORDER];
const full = (shares: number[]) => CANON.map((bucket, i) => ({ bucket, weight: shares[i]! }));

async function member() {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) throw new Error(`member() failed: ${JSON.stringify(r)}`);
  return { id, token: r.token, privateKey };
}
type Member = Awaited<ReturnType<typeof member>>;

const dayOf = (d: unknown) =>
  d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);

async function submit(
  m: Member,
  date: string,
  subjectId: string,
  weights: { bucket: string; weight: number }[] | null,
) {
  const sub = {
    memberId: m.id, date, subjectId, nonce: rid("n"),
    stance: "neutral", confidence: 0.5, body: `${m.id} take`,
    ...(weights ? { weights } : {}),
  };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  return await ic.submitRecommendation(m.token, { ...sub, signature });
}

/** An open epoch (so it carries a FROZEN roster, seated at open), collecting. */
async function epochSession(subjectId: string) {
  const opened = await ic.openEpoch(subjectId);
  if (!opened.ok) throw new Error(`openEpoch failed: ${JSON.stringify(opened)}`);
  const sessionId = opened.sessionId;
  const row = (await sql`SELECT date FROM swarm_sessions WHERE id = ${sessionId}`)[0];
  return { sessionId, date: dayOf(row.date) };
}

/** An open `bucket_weights` session, brief published, ready for takes. */
async function openBucketWeightsSession(prefix: string) {
  const subjectId = rid(prefix);
  await ic.ensureSubject(subjectId, `${prefix} subject`);
  await sql`UPDATE swarm_subjects SET recommendation_type = 'bucket_weights' WHERE id = ${subjectId}`;
  const session = await ic.openSession(subjectId);
  await ic.publishBrief(session.id, 60);
  return { sessionId: session.id, subjectId, date: dayOf(session.date) };
}

test("a WEIGHTLESS take is refused at submission for a bucket_weights subject, by name", async () => {
  const s = await openBucketWeightsSession("sub-weightless");
  const res = await submit(await member(), s.date, s.subjectId, null);
  expect(res.status).toBe(400);
  expect((res as { error: string }).error).toContain("weights_required_for_bucket_weights_subject");
  // NOTHING IS ON FILE. The refusal must precede the append-only INSERT, or the
  // session is stuck with the row it was refused for.
  const rows = await sql`SELECT 1 FROM swarm_recommendations WHERE session_id = ${s.sessionId}`;
  expect(rows.length).toBe(0);
});

test("a THREE-bucket take is refused at submission", async () => {
  const s = await openBucketWeightsSession("sub-three");
  const res = await submit(await member(), s.date, s.subjectId, [
    { bucket: "agent_tokens", weight: 0.5 },
    { bucket: "conservative_defi_yield", weight: 0.3 },
    { bucket: "protocol_tokens", weight: 0.2 },
  ]);
  expect(res.status).toBe(400);
  expect((res as { error: string }).error).toContain("weights_not_canonical_four");
});

test("an UNKNOWN bucket is refused at submission", async () => {
  const s = await openBucketWeightsSession("sub-unknown");
  const res = await submit(await member(), s.date, s.subjectId, [
    { bucket: "agent_tokens", weight: 0.4 },
    { bucket: "conservative_defi_yield", weight: 0.3 },
    { bucket: "protocol_tokens", weight: 0.2 },
    { bucket: "memecoins", weight: 0.1 },
  ]);
  expect(res.status).toBe(400);
  expect((res as { error: string }).error).toContain("weights_not_canonical_four");
});

test("a FIVE-entry vector is refused at submission", async () => {
  const s = await openBucketWeightsSession("sub-five");
  const res = await submit(await member(), s.date, s.subjectId, [
    ...full([0.4, 0.3, 0.2, 0.1]),
    { bucket: "memecoins", weight: 0.1 },
  ]);
  expect(res.status).toBe(400);
  expect((res as { error: string }).error).toContain("weights_not_canonical_four");
});

test("the canonical four is accepted — 201, and the vector is what was signed", async () => {
  const s = await openBucketWeightsSession("sub-canonical");
  const m = await member();
  const res = await submit(m, s.date, s.subjectId, full([0.4, 0.3, 0.2, 0.1]));
  expect(res.status).toBe(201);
  const row = (await sql`SELECT payload FROM swarm_recommendations
                         WHERE session_id = ${s.sessionId} AND member_id = ${m.id}`)[0];
  const payload = row.payload as { weights: { bucket: string }[] };
  expect(payload.weights.map((w) => w.bucket)).toEqual(CANON);
});

test("a position_actions session is untouched — a weightless take is still a legal take", async () => {
  const subjectId = rid("sub-positions");
  await ic.ensureSubject(subjectId, "position actions subject");
  await sql`UPDATE swarm_subjects SET recommendation_type = 'position_actions' WHERE id = ${subjectId}`;
  const session = await ic.openSession(subjectId);
  await ic.publishBrief(session.id, 60);
  const res = await submit(await member(), dayOf(session.date), subjectId, null);
  expect(res.status).toBe(201);
});

// ── THE OPERATOR LEVER, FOR SESSIONS ALREADY STUCK ─────────────────────────
// A session whose subject was RETYPED to bucket_weights after its takes landed
// reproduces the stuck state exactly — the takes are legal, on file, append-only
// and weightless, and the receipt gate refuses them forever. The lever excuses
// the blocking member from the FROZEN ROSTER after collection, which is what
// `loadFrozenTakeSet` filters on, and re-aggregates.
test("the forced roster excuse is refused without the force flag, and is AUDITED when used", async () => {
  const subjectId = rid("stuck");
  await ic.ensureSubject(subjectId, "stuck subject");
  // `ensureSubject` seeds bucket_weights, so the legacy shape is set
  // explicitly: these takes were filed when the subject asked for prose only.
  await sql`UPDATE swarm_subjects SET recommendation_type = 'position_actions' WHERE id = ${subjectId}`;
  // Members must exist BEFORE the session: an epoch freezes the
  // roster from the active members at creation time, and the frozen roster is
  // what the lever edits.
  const blocked = await member();
  const other = await member();
  const { sessionId, date } = await epochSession(subjectId);

  // Both file a weightless take while the subject is still position_actions —
  // the legacy shape, legal when it was filed.
  expect((await submit(blocked, date, subjectId, null)).status).toBe(201);
  expect((await submit(other, date, subjectId, full([0.25, 0.25, 0.25, 0.25]))).status).toBe(201);

  // The retype is what strands the session: the takes are on file, append-only,
  // weightless, and the receipt gate now refuses them forever.
  await sql`UPDATE swarm_subjects SET recommendation_type = 'bucket_weights' WHERE id = ${subjectId}`;
  await sql`UPDATE swarm_sessions SET window_closes_at = now() WHERE id = ${sessionId}`;
  const closed = await admin.closeSessionAdmin(sessionId, undefined);
  if (!closed.ok) throw new Error(`close failed: ${JSON.stringify(closed)}`);

  // The un-forced lever still refuses once collection has begun — the pre-T17
  // contract, unchanged.
  const plain = await admin.rosterExcuseAdmin(sessionId, blocked.id);
  expect(plain.ok).toBe(false);
  expect((plain as any).status).toBe(409);

  const forced = await admin.rosterExcuseAdmin(sessionId, blocked.id, admin.ADMIN_ACTOR, {
    force: true,
    reason: "take carries no canonical-four vector and cannot be amended",
  });
  expect(forced.ok).toBe(true);

  const excused = (await sql`SELECT status FROM swarm_session_members
                             WHERE session_id = ${sessionId} AND member_id = ${blocked.id}`)[0];
  expect(excused.status).toBe("excused");

  // AUDITED, with the reason and the force flag on the row — the whole point of
  // the lever being a lever and not a database edit.
  const audits = await sql<{ action: string; scope: any }[]>`
    SELECT action, scope FROM audit_log WHERE action = 'roster_excuse_forced'
    ORDER BY id DESC LIMIT 1`;
  expect(audits.length).toBe(1);
  expect(String(audits[0].scope.sessionId)).toBe(String(sessionId));
  expect(String(audits[0].scope.memberId)).toBe(String(blocked.id));
  expect(String(audits[0].scope.reason)).toContain("canonical-four");
  expect(audits[0].scope.state).toBe("window_closed");

  // AND IT ACTUALLY UNSTICKS THE SESSION: re-aggregating now drops the excused
  // member's take from the frozen set, so the rollup carries the surviving
  // canonical-four vector.
  const reaggregated = await admin.aggregateSessionAdmin(sessionId, undefined);
  if (!reaggregated.ok) throw new Error(`re-aggregate failed: ${JSON.stringify(reaggregated)}`);
  const rec = (await sql`SELECT swarm_recommendation FROM swarm_sessions WHERE id = ${sessionId}`)[0]
    .swarm_recommendation as { type: string; weights?: { bucket: string }[] };
  expect(rec.type).toBe("bucket_weights");
  expect(rec.weights?.map((w) => w.bucket)).toEqual(CANON);
});

test("the forced excuse refuses on a TERMINAL session — it is a backstop, not a rewrite", async () => {
  const subjectId = rid("terminal");
  await ic.ensureSubject(subjectId, "terminal subject");
  const m = await member();
  const { sessionId } = await epochSession(subjectId);
  await sql`UPDATE swarm_sessions SET state = 'published' WHERE id = ${sessionId}`;
  const res = await admin.rosterExcuseAdmin(sessionId, m.id, admin.ADMIN_ACTOR, { force: true });
  expect(res.ok).toBe(false);
  expect((res as any).status).toBe(409);
});
