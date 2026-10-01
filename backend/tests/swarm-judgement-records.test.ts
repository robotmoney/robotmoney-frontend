// A judgement is a PUBLIC RECORD of its own, like a take, and a session judged
// by several judges shows each judge's opinion.
//
// What this file pins, each against the way it could quietly go wrong:
//
//   - The public member DTO says who is a judge (`role`), so a reader can tell
//     a judge from a member that simply filed nothing.
//   - The opinion a session carries NAMES its judge (`swarm_recommendation.
//     judge.judged_by`). The fingerprint cannot: two judges given the same
//     prompt over the same take set share `prompt_hash` and `inputs_digest`.
//   - The three public judgement reads serve exactly the public rule
//     (swarm/judgements.ts): `enforce`, applied, published, newest per party.
//     A judgement that never reached the session — a second judge's, late
//     evidence, a historical `shadow` row — leaking here would publish what the
//     lifecycle withheld.
//   - The take receipt names the session it was filed in.
//
// Every judgement here arrives the way it does in production since issue
// #1026: a seated judge signs its model's answer and submits it
// (tests/support/stub-judge.ts). Rows the current writer can no longer produce
// — an anonymous in-house row, a `shadow` row — are PLANTED, because the
// public rule still has to hold over the history that carries them.
import { expect, test } from "bun:test";
import { canonicalizeSubmission, path as routePath, ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import * as admin from "../src/swarm/admin.ts";
import * as ic from "../src/swarm/domain.ts";
import { toMember } from "../src/swarm/projections.ts";
import { seedLiveRoster } from "../src/swarm/roster-seed.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { requestJudgingFor, seatJudge, STUB_JUDGE_MODEL, submitSigned, type TestJudge, enforceJudging } from "./support/stub-judge.ts";
import { ensureProseSubject } from "./support/prose-subject.ts";

useCleanDatabasePerTest(import.meta.file);

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const IN_HOUSE = "robotmoney-in-house";

async function member(prefix: string) {
  const id = rid(prefix);
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) throw new Error(`registerMember failed: ${JSON.stringify(r)}`);
  return { id, token: r.token, privateKey };
}
type Member = Awaited<ReturnType<typeof member>>;

async function submit(
  m: Member, date: string, subjectId: string, body = "a signed take on the subject",
  weights?: { bucket: string; weight: number }[],
) {
  const payload = { memberId: m.id, date, subjectId, nonce: rid("n"), stance: "neutral", confidence: 0.5, body, ...(weights ? { weights } : {}) };
  const signature = await signMessage(canonicalizeSubmission(payload), m.privateKey);
  const res = await ic.submitRecommendation(m.token, { ...payload, signature });
  if (res.status !== 201) throw new Error(`submit failed: ${JSON.stringify(res)}`);
  return res as { status: number; id?: string } & Record<string, unknown>;
}

/** A prose session with two takes, closed, aggregated and in `judging`. */
async function judging(prefix: string) {
  const subjectId = rid(prefix);
  await ensureProseSubject(subjectId, subjectId);
  const session = await ic.openSession(subjectId);
  await ic.publishBrief(session.id, 60);
  const date = session.date instanceof Date ? session.date.toISOString().slice(0, 10) : String(session.date).slice(0, 10);
  for (const voter of [await member("voter_a"), await member("voter_b")]) await submit(voter, date, subjectId);
  await enforceJudging();
  await ic.closeWindow(session.id);
  await ic.aggregateSession(session.id);
  await requestJudgingFor(String(session.id));
  return { subjectId, sessionId: String(session.id), date };
}

function answer(rationale: string, release: "safe" | "hold" = "safe"): string {
  return JSON.stringify({
    rationale,
    disagreements: [],
    release_safety: { release, concerns: release === "hold" ? ["thin"] : [] },
  });
}

async function judgeWith(judge: TestJudge, sessionId: string, rationale: string, release: "safe" | "hold" = "safe") {
  const result = await submitSigned(judge, sessionId, answer(rationale, release));
  if (!result.ok) throw new Error(`submitJudgement refused: ${JSON.stringify(result)}`);
  return result;
}

/** Publish a judged session the way the scheduler does: finalize. */
async function publish(sessionId: string) {
  const done = await ic.finalizeEpoch(sessionId);
  if (!done.ok) throw new Error(`finalizeEpoch refused: ${JSON.stringify(done)}`);
  return done;
}

/** Plant a historical judgement row the current writer cannot produce. */
async function plantHistorical(sessionId: string, o: { mode: "enforce" | "shadow"; applied: boolean; rationale: string }) {
  const [row] = await sql`
    INSERT INTO swarm_session_judgements
      (session_id, mode, source, model, prompt_hash, inputs_digest, take_count, min_takes, applied, opinion, judged_by)
    VALUES (${sessionId}, ${o.mode}, 'model', 'test/judge', ${"a".repeat(64)}, ${"b".repeat(64)}, 2, 3, ${o.applied},
            ${sql.json({ rationale: o.rationale, disagreements: [], release_safety: { release: "safe", thinly_supported: true, take_count: 2, min_takes: 3, concerns: [] } })},
            ${IN_HOUSE})
    RETURNING id`;
  return String(row!.id);
}

async function get(pathname: string) {
  const url = new URL(`http://test${pathname}`);
  const res = await handleSwarm(new Request(url), url);
  if (!res || res instanceof Response) throw new Error(`${pathname} did not answer {status, body}`);
  return res as { status: number; body: any };
}

const recOf = async (sessionId: string) =>
  ((await sql`SELECT swarm_recommendation FROM swarm_sessions WHERE id = ${sessionId}`)[0] as any)
    .swarm_recommendation as Record<string, any>;

const sessionJudgements = (sessionId: string) => get(routePath(ROUTES.swarm.sessionJudgements, { id: sessionId }));
const judgementById = (id: string) => get(routePath(ROUTES.swarm.judgement, { id }));
const memberJudgements = (id: string, query = "") => get(`${routePath(ROUTES.swarm.memberJudgements, { id })}${query}`);

// ── role on the public member DTO ───────────────────────────────────────────

test("the public member DTO emits role: member by default, judge once graduated", async () => {
  const m = await member("role");
  expect((await ic.getMember(m.id))?.role).toBe("member");
  expect((await get(routePath(ROUTES.swarm.member, { id: m.id }))).body.role).toBe("member");

  expect((await admin.setMemberRoleAdmin(m.id, 1, "judge")).ok).toBe(true);
  expect((await ic.getMember(m.id))?.role).toBe("judge");
  const listed = (await get(ROUTES.swarm.members)).body.members.find((x: any) => x.id === m.id);
  expect(listed.role).toBe("judge");
  expect((await get(routePath(ROUTES.swarm.member, { id: m.id }))).body.role).toBe("judge");

  // A row read by a query that never selected the column reads as a member,
  // the same fallback convention `handle` has.
  expect(toMember({ id: "x", status: "active", name: "x" }).role).toBe("member");
});

// ── the adopted opinion names its judge ─────────────────────────────────────

test("the judge of record's opinion carries its member id on the session, spelled as the judgement row spells it", async () => {
  const j = await seatJudge({ prefix: "adopt_member" });
  const s = await judging("adopt_member");
  const res = await judgeWith(j, s.sessionId, "A seated judge's opinion.");
  expect(res.applied).toBe(true);

  const row = (await ic.latestJudgement(s.sessionId)) as any;
  const carried = (await recOf(s.sessionId)).judge;
  expect(carried.judged_by).toBe(j.id);
  expect(carried.judged_by_member_id).toBe(j.id);
  expect(carried.judged_by).toBe(row.judged_by);
  expect(carried.judged_by_member_id).toBe(row.judged_by_member_id);
  // Same object the public session payload serves.
  const served = (await get(routePath(ROUTES.swarm.sessionById, { id: s.sessionId }))).body;
  expect(served.session.swarmRecommendation.judge.judged_by).toBe(j.id);
});

test("a second seated judge's opinion reaches no session, judge block and all", async () => {
  const a = await seatJudge({ prefix: "judge_a" });
  const b = await seatJudge({ prefix: "judge_b" });
  const s = await judging("adopt_second");
  const second = await judgeWith(b, s.sessionId, "Recorded, decides nothing.");
  expect(second.applied).toBe(false);
  expect(await recOf(s.sessionId)).not.toHaveProperty("judge");
  expect((await judgeWith(a, s.sessionId, "The judge of record.")).applied).toBe(true);
  expect((await recOf(s.sessionId)).judge.judged_by).toBe(a.id);
});

// ── GET /api/swarm/sessions/:id/judgements and /api/swarm/judgements/:id ────

test("a session's public judgements: enforce, applied and published only, one per judging party, newest first", async () => {
  const a = await seatJudge({ prefix: "judge_a" });
  const b = await seatJudge({ prefix: "judge_b" });
  const s = await judging("several");

  // HISTORY the current writer cannot produce, planted as an upgraded database
  // holds it: 1. an anonymous in-house enforce row later replaced by its own
  // party (4); 2. an in-house shadow row, never public.
  const r1 = await plantHistorical(s.sessionId, { mode: "enforce", applied: true, rationale: "In-house, first word." });
  const r2 = await plantHistorical(s.sessionId, { mode: "shadow", applied: false, rationale: "In-house, shadow soak." });
  // 3. the second seated judge: eligible, recorded, NOT the judge of record.
  const r3 = String((await judgeWith(b, s.sessionId, "The second judge's view.", "hold")).judgementId);
  // 4. the in-house party's newest applied row, planted after (1).
  const r4 = await plantHistorical(s.sessionId, { mode: "enforce", applied: true, rationale: "In-house, last word." });
  // 5. the judge of record: applied, the consensus.
  const r5 = String((await judgeWith(a, s.sessionId, "The judge of record's view.", "hold")).judgementId);

  // UNPUBLISHED: the session is public, its judgements are not yet.
  const before = await sessionJudgements(s.sessionId);
  expect(before.status).toBe(200);
  expect(before.body).toEqual({ judgements: [] });
  for (const id of [r1, r2, r3, r4, r5]) expect((await judgementById(id)).status).toBe(404);

  expect((await publish(s.sessionId)).outcome).toBe("judged");

  // 6. a late judgement after publication: recorded, never applied.
  const c = await seatJudge({ prefix: "judge_c" });
  const late = await judgeWith(c, s.sessionId, "Too late.");
  expect(late.lateEvidence).toBe(true);
  expect(late.applied).toBe(false);
  const r6 = String(late.judgementId);

  const after = await sessionJudgements(s.sessionId);
  expect(after.status).toBe(200);
  const list = after.body.judgements as any[];
  expect(list.map((x) => x.id)).toEqual([r5, r4]);
  expect(list.map((x) => x.judgedBy)).toEqual([a.id, IN_HOUSE]);
  expect(list.map((x) => x.rationale)).toEqual(["The judge of record's view.", "In-house, last word."]);

  // The exact public shape: nothing admin-only rides along.
  const [ofRecord, inHouse] = list;
  expect(Object.keys(ofRecord).sort()).toEqual([
    "createdAt", "disagreements", "id", "inputsDigest", "judgedBy", "judgedByMemberId", "model",
    "promptHash", "rationale", "recommendsWeights", "releaseSafety", "sessionDate", "sessionId", "source", "subjectId",
  ]);
  // A prose session sets no weights: its judges' calls have nothing to update.
  expect(ofRecord).toMatchObject({
    sessionId: s.sessionId, subjectId: s.subjectId, sessionDate: s.date,
    judgedBy: a.id, judgedByMemberId: a.id, source: "model", model: STUB_JUDGE_MODEL,
    disagreements: [], recommendsWeights: false,
  });
  // The opinion as recorded — two takes against min_takes 3 is thin support,
  // which the parser flags whatever the model said.
  const stored = (await sql`SELECT opinion, prompt_hash, inputs_digest FROM swarm_session_judgements WHERE id = ${r5}`)[0] as any;
  expect(ofRecord.releaseSafety).toEqual(stored.opinion.release_safety);
  expect(ofRecord.releaseSafety).toMatchObject({ thinly_supported: true, take_count: 2, min_takes: 3 });
  expect(ofRecord.releaseSafety.concerns).toContain("thin");
  expect(ofRecord.promptHash).toBe(stored.prompt_hash);
  expect(ofRecord.inputsDigest).toBe(stored.inputs_digest);
  expect(Number.isNaN(Date.parse(ofRecord.createdAt))).toBe(false);
  expect(inHouse).toMatchObject({ judgedBy: IN_HOUSE, judgedByMemberId: null });

  // One judgement by id answers exactly when the list would serve it.
  expect(await judgementById(r5)).toEqual({ status: 200, body: ofRecord });
  expect(await judgementById(r4)).toEqual({ status: 200, body: inHouse });
  expect((await judgementById(r1)).status).toBe(404); // replaced by its own party
  expect((await judgementById(r2)).status).toBe(404); // shadow
  expect((await judgementById(r3)).status).toBe(404); // a second judge's: never applied
  expect((await judgementById(r6)).status).toBe(404); // late evidence: never applied
  expect((await judgementById("abc")).status).toBe(404);
  expect((await judgementById("9".repeat(30))).status).toBe(404);
  expect((await judgementById("999999")).status).toBe(404);

  // An unknown or malformed session is a 404, not an empty list.
  expect((await sessionJudgements(crypto.randomUUID())).status).toBe(404);
  expect((await sessionJudgements("not-a-uuid")).status).toBe(404);
});

test("a judgement on a weights session says its recommendation set weights: its call has a target to update", async () => {
  const subjectId = rid("weights");
  await ic.ensureSubject(subjectId, "weights subject");
  await sql`UPDATE swarm_subjects SET recommendation_type = 'bucket_weights' WHERE id = ${subjectId}`;
  const session = await ic.openSession(subjectId);
  await ic.publishBrief(session.id, 60);
  const date = session.date instanceof Date ? session.date.toISOString().slice(0, 10) : String(session.date).slice(0, 10);
  const weights = [
    { bucket: "conservative_defi_yield", weight: 0.9 }, { bucket: "agent_tokens", weight: 0.1 },
    { bucket: "protocol_tokens", weight: 0 }, { bucket: "real_world_assets", weight: 0 },
  ];
  for (const voter of [await member("wv_a"), await member("wv_b")]) await submit(voter, date, subjectId, "a weighted take", weights);
  await enforceJudging();
  await ic.closeWindow(session.id);
  await ic.aggregateSession(session.id);
  expect((await recOf(String(session.id))).type).toBe("bucket_weights");
  await requestJudgingFor(String(session.id));
  expect((await judgeWith(await seatJudge(), String(session.id), "Weights moved.")).applied).toBe(true);
  await publish(String(session.id));

  const list = (await sessionJudgements(String(session.id))).body.judgements as any[];
  expect(list).toHaveLength(1);
  expect(list[0].recommendsWeights).toBe(true);
  expect((await judgementById(list[0].id)).body.recommendsWeights).toBe(true);
});

test("a date-shaped first segment still means (date, subject), not a session id", async () => {
  // RE_SESSION is tested before the judgements route, so a subject literally
  // named "judgements" keeps resolving through the day route as before.
  await ensureProseSubject("judgements", "A subject named judgements");
  const session = await ic.openSession("judgements");
  const date = session.date instanceof Date ? session.date.toISOString().slice(0, 10) : String(session.date).slice(0, 10);
  const res = await get(routePath(ROUTES.swarm.session, { date, subject: "judgements" }));
  expect(res.status).toBe(200);
  expect(res.body.session.id).toBe(String(session.id));
  expect(res.body).not.toHaveProperty("judgements");
});

// ── GET /api/swarm/members/:id/judgements ───────────────────────────────────

test("a judge's public judgements across sessions, newest first, with the takes route's limit convention", async () => {
  const j = await seatJudge({ prefix: "judge_a_record" });

  const older = await judging("record_older");
  await judgeWith(j, older.sessionId, "Older session.");
  // Another party's historical opinion on the same session: public, but not this judge's.
  await plantHistorical(older.sessionId, { mode: "enforce", applied: true, rationale: "The in-house view of the older session." });
  await publish(older.sessionId);
  expect((await sessionJudgements(older.sessionId)).body.judgements).toHaveLength(2);

  const newer = await judging("record_newer");
  await judgeWith(j, newer.sessionId, "Newer session.");
  await publish(newer.sessionId);

  // Judged but not published: not on the record yet.
  const pending = await judging("record_pending");
  await judgeWith(j, pending.sessionId, "Pending session.");
  // Published, but this judge's only opinion there came after publication.
  const lateOnly = await judging("record_late");
  await sql`UPDATE swarm_sessions SET judging_deadline_at = now() - interval '1 second' WHERE id = ${lateOnly.sessionId}`;
  expect((await publish(lateOnly.sessionId)).outcome).toBe("no_consensus");
  expect((await judgeWith(j, lateOnly.sessionId, "Late only.")).lateEvidence).toBe(true);

  const all = await memberJudgements(j.id);
  expect(all.status).toBe(200);
  expect((all.body.judgements as any[]).map((x) => x.sessionId)).toEqual([newer.sessionId, older.sessionId]);
  expect((all.body.judgements as any[]).every((x) => x.judgedByMemberId === j.id)).toBe(true);

  // Each entry is the same record the session list and the permalink serve.
  const first = all.body.judgements[0];
  expect((await sessionJudgements(newer.sessionId)).body.judgements).toContainEqual(first);
  expect((await judgementById(first.id)).body).toEqual(first);

  const one = await memberJudgements(j.id, "?limit=1");
  expect(one.status).toBe(200);
  expect((one.body.judgements as any[]).map((x) => x.sessionId)).toEqual([newer.sessionId]);

  // Same refusals, same words, as GET /api/swarm/members/:id/takes.
  for (const bad of ["0", "101", "1.5", "abc", "-1"]) {
    const refused = await memberJudgements(j.id, `?limit=${bad}`);
    const takes = await get(`${routePath(ROUTES.swarm.memberTakes, { id: j.id })}?limit=${bad}`);
    expect(refused.status, `limit=${bad}`).toBe(400);
    expect(refused.body).toEqual(takes.body);
  }

  // An unknown member, or one that never judged, is an empty list — as for takes.
  expect(await memberJudgements("no-such-member")).toEqual({ status: 200, body: { judgements: [] } });
  const plain = await member("never_judged");
  expect(await memberJudgements(plain.id)).toEqual({ status: 200, body: { judgements: [] } });
});

// ── the take receipt names its session ──────────────────────────────────────

test("GET /api/swarm/takes/:id carries the sessionId the take was filed in", async () => {
  const subjectId = rid("receipt");
  await ensureProseSubject(subjectId, subjectId);
  const session = await ic.openSession(subjectId);
  await ic.publishBrief(session.id, 60);
  const date = session.date instanceof Date ? session.date.toISOString().slice(0, 10) : String(session.date).slice(0, 10);
  const m = await member("receipt");
  await submit(m, date, subjectId);
  const takeId = String((await sql`SELECT id FROM swarm_recommendations WHERE member_id = ${m.id}`)[0]!.id);

  const receipt = await get(routePath(ROUTES.swarm.take, { id: takeId }));
  expect(receipt.status).toBe(200);
  expect(receipt.body.sessionId).toBe(String(session.id));
  expect(receipt.body.take.id).toBe(takeId);
});

// ── the seeded named judge ──────────────────────────────────────────────────
// LAST in the file: seedLiveRoster() retires every active member not on the
// live roster, and this file shares one database across its tests.

test("Themis, seeded in-house, is a judge whose judgement the session names, and the judge's record lists it once published", async () => {
  await seedLiveRoster();
  const themis = (await sql`SELECT id, operator, role FROM swarm_members WHERE handle = 'themis'`)[0] as any;
  expect(themis, "seedLiveRoster() must have seated a themis row").toBeTruthy();
  expect(themis.role).toBe("judge");
  // The in-house operator is what passes the third-party gate (§6.2).
  expect(themis.operator).toBe("robotmoney");

  // The roster seed holds no signing key the test can use, so Themis's key is
  // rotated to one the test holds — the same move `rotate-key` makes for a
  // participant's credential file.
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const rotated = await admin.rotateMemberKeyAdmin(themis.id, { publicKey: publicKeyB64 }) as any;
  expect(rotated.ok, JSON.stringify(rotated)).toBe(true);
  const judge: TestJudge = { id: themis.id, token: rotated.token, privateKey };

  const s = await judging("themis");
  const res = await judgeWith(judge, s.sessionId, "Themis's opinion.");
  expect(res.applied).toBe(true);
  expect((await recOf(s.sessionId)).judge).toMatchObject({ judged_by: themis.id, judged_by_member_id: themis.id });

  expect((await memberJudgements("themis")).body.judgements).toEqual([]);
  await publish(s.sessionId);
  const record = (await memberJudgements("themis")).body.judgements as any[];
  expect(record.map((x) => [x.sessionId, x.judgedBy])).toEqual([[s.sessionId, themis.id]]);
  expect((await sessionJudgements(s.sessionId)).body.judgements).toEqual(record);
});
