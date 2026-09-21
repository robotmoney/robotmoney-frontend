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
//     A `shadow` opinion leaking here would publish what the mode withholds.
//   - The take receipt names the session it was filed in.
//
// The model is injected (a fixed transport) wherever the entry point allows it,
// and the shared local stub serves the entry points that do not.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { canonicalizeSubmission, path as routePath, ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import * as admin from "../src/swarm/admin.ts";
import * as ic from "../src/swarm/domain.ts";
import { judgeSession, latestJudgement, setJudgeConfig } from "../src/swarm/judge-session.ts";
import type { JudgeTransport } from "../src/swarm/judge.ts";
import { toMember } from "../src/swarm/projections.ts";
import { seedLiveRoster } from "../src/swarm/roster-seed.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { installJudgeStub, removeJudgeStub, STUB_JUDGE_MODEL } from "./support/judge-stub.ts";
import { ensureProseSubject } from "./support/prose-subject.ts";

useCleanDatabasePerTest(import.meta.file);
beforeAll(() => { installJudgeStub(); });
afterAll(() => { removeJudgeStub(); });

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

async function judgeMember(prefix: string) {
  const m = await member(prefix);
  const granted = await admin.setMemberRoleAdmin(m.id, 1, "judge");
  if (!granted.ok) throw new Error(`setMemberRoleAdmin failed: ${JSON.stringify(granted)}`);
  return m;
}

async function submit(m: Member, date: string, subjectId: string, body = "a signed take on the subject") {
  const payload = { memberId: m.id, date, subjectId, nonce: rid("n"), stance: "neutral", confidence: 0.5, body };
  const signature = await signMessage(canonicalizeSubmission(payload), m.privateKey);
  const res = await ic.submitRecommendation(m.token, { ...payload, signature });
  if (res.status !== 201) throw new Error(`submit failed: ${JSON.stringify(res)}`);
  return res as { status: number; id?: string } & Record<string, unknown>;
}

/** A prose session with two takes, closed and aggregated: judgeable, not published. */
async function aggregated(prefix: string) {
  const subjectId = rid(prefix);
  await ensureProseSubject(subjectId, subjectId);
  const session = await ic.openSession(subjectId);
  await ic.publishBrief(session.id, 60);
  const date = session.date instanceof Date ? session.date.toISOString().slice(0, 10) : String(session.date).slice(0, 10);
  for (const voter of [await member("voter_a"), await member("voter_b")]) await submit(voter, date, subjectId);
  await ic.closeWindow(session.id);
  await ic.aggregateSession(session.id);
  return { subjectId, sessionId: String(session.id), date };
}

function answer(rationale: string, release: "safe" | "hold" = "safe"): JudgeTransport {
  const text = JSON.stringify({
    rationale,
    disagreements: [],
    release_safety: { release, concerns: release === "hold" ? ["thin"] : [] },
  });
  return { model: "test/judge", complete: async () => text };
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

const judgementIds = async (sessionId: string) =>
  (await sql`SELECT id, mode, applied, judged_by FROM swarm_session_judgements WHERE session_id = ${sessionId} ORDER BY id`) as any[];

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

test("an enforce opinion carries judged_by on the session: the in-house worker, through the production entry point", async () => {
  await setJudgeConfig({ mode: "enforce", model: STUB_JUDGE_MODEL });
  const s = await aggregated("adopt_in_house");
  const res = await admin.judgeSessionAdmin(s.sessionId, undefined) as any;
  expect(res.ok).toBe(true);
  expect(res.judge.applied).toBe(true);

  const row = await latestJudgement(s.sessionId) as any;
  const carried = (await recOf(s.sessionId)).judge;
  expect(carried.judged_by).toBe(IN_HOUSE);
  expect(carried.judged_by).toBe(row.judged_by);
  // Only a seated member has a member id to name.
  expect(carried).not.toHaveProperty("judged_by_member_id");
  // Same object the public session payload serves.
  const served = (await get(routePath(ROUTES.swarm.sessionById, { id: s.sessionId }))).body;
  expect(served.session.swarmRecommendation.judge.judged_by).toBe(IN_HOUSE);
});

test("an enforce opinion by a seated judge carries its member id, spelled as the judgement row spells it", async () => {
  await setJudgeConfig({ mode: "enforce", model: STUB_JUDGE_MODEL, thirdPartyEnabled: true });
  const j = await judgeMember("adopt_member");
  const s = await aggregated("adopt_member");
  const res = await judgeSession(s.sessionId, { judgeMemberId: j.id, transport: answer("A seated judge's opinion.") });
  expect(res.ok).toBe(true);
  expect(res.applied).toBe(true);

  const row = await latestJudgement(s.sessionId) as any;
  const carried = (await recOf(s.sessionId)).judge;
  expect(carried.judged_by).toBe(j.id);
  expect(carried.judged_by_member_id).toBe(j.id);
  expect(carried.judged_by).toBe(row.judged_by);
  expect(carried.judged_by_member_id).toBe(row.judged_by_member_id);
});

test("a shadow opinion still reaches no session, judge block and all", async () => {
  await setJudgeConfig({ mode: "shadow", model: STUB_JUDGE_MODEL });
  const s = await aggregated("adopt_shadow");
  expect((await judgeSession(s.sessionId, { transport: answer("Withheld.") })).ok).toBe(true);
  expect(await recOf(s.sessionId)).not.toHaveProperty("judge");
});

// ── GET /api/swarm/sessions/:id/judgements and /api/swarm/judgements/:id ────

test("a session's public judgements: enforce, applied and published only, one per judging party, newest first", async () => {
  const j = await judgeMember("several");
  const s = await aggregated("several");

  // 1. in-house, enforce — later replaced by its own party (4).
  await setJudgeConfig({ mode: "enforce", model: STUB_JUDGE_MODEL, thirdPartyEnabled: true });
  expect((await judgeSession(s.sessionId, { transport: answer("In-house, first word.") })).applied).toBe(true);
  // 2. in-house, shadow — never public, even though it is newer than (1).
  await setJudgeConfig({ mode: "shadow", model: STUB_JUDGE_MODEL });
  expect((await judgeSession(s.sessionId, { transport: answer("In-house, shadow soak.") })).ok).toBe(true);
  // 3. a seated judge, enforce.
  await setJudgeConfig({ mode: "enforce", model: STUB_JUDGE_MODEL });
  expect((await judgeSession(s.sessionId, { judgeMemberId: j.id, transport: answer("The seated judge's view.", "hold") })).applied).toBe(true);
  // 4. in-house again, enforce — this party's newest applied opinion.
  expect((await judgeSession(s.sessionId, { transport: answer("In-house, last word.") })).applied).toBe(true);

  const [r1, r2, r3, r4] = (await judgementIds(s.sessionId)).map((r) => String(r.id));
  expect([r1, r2, r3, r4].every(Boolean)).toBe(true);

  // UNPUBLISHED: the session is public, its judgements are not yet.
  const before = await sessionJudgements(s.sessionId);
  expect(before.status).toBe(200);
  expect(before.body).toEqual({ judgements: [] });
  for (const id of [r1, r2, r3, r4]) expect((await judgementById(id!)).status).toBe(404);

  expect((await ic.publishSession(s.sessionId)).state).toBe("published");

  // 5. a seated-judge enforce opinion AFTER publication: recorded, never applied.
  const late = await judgeSession(s.sessionId, { judgeMemberId: j.id, transport: answer("Too late.") });
  expect(late.ok).toBe(true);
  expect(late.applied).toBe(false);
  const r5 = String(late.judgementId);

  const after = await sessionJudgements(s.sessionId);
  expect(after.status).toBe(200);
  const list = after.body.judgements as any[];
  expect(list.map((x) => x.id)).toEqual([r4, r3]);
  expect(list.map((x) => x.judgedBy)).toEqual([IN_HOUSE, j.id]);
  expect(list.map((x) => x.rationale)).toEqual(["In-house, last word.", "The seated judge's view."]);

  // The exact public shape: nothing admin-only rides along.
  const [inHouse, seated] = list;
  expect(Object.keys(inHouse).sort()).toEqual([
    "createdAt", "disagreements", "id", "inputsDigest", "judgedBy", "judgedByMemberId", "model",
    "promptHash", "rationale", "releaseSafety", "sessionDate", "sessionId", "source", "subjectId",
  ]);
  expect(inHouse).toMatchObject({
    sessionId: s.sessionId, subjectId: s.subjectId, sessionDate: s.date,
    judgedBy: IN_HOUSE, judgedByMemberId: null, source: "model", model: "test/judge",
    disagreements: [],
  });
  // The opinion as recorded — two takes against min_takes 3 is thin support,
  // which the judge flags whatever the model said.
  const stored = (await sql`SELECT opinion, prompt_hash, inputs_digest FROM swarm_session_judgements WHERE id = ${r4!}`)[0] as any;
  expect(inHouse.releaseSafety).toEqual(stored.opinion.release_safety);
  expect(inHouse.releaseSafety).toMatchObject({ thinly_supported: true, take_count: 2, min_takes: 3 });
  expect(inHouse.promptHash).toBe(stored.prompt_hash);
  expect(inHouse.inputsDigest).toBe(stored.inputs_digest);
  expect(Number.isNaN(Date.parse(inHouse.createdAt))).toBe(false);
  expect(seated).toMatchObject({ judgedBy: j.id, judgedByMemberId: j.id });
  expect(seated.releaseSafety.concerns).toContain("thin");

  // One judgement by id answers exactly when the list would serve it.
  expect(await judgementById(r4!)).toEqual({ status: 200, body: inHouse });
  expect(await judgementById(r3!)).toEqual({ status: 200, body: seated });
  expect((await judgementById(r1!)).status).toBe(404); // replaced by its own party
  expect((await judgementById(r2!)).status).toBe(404); // shadow
  expect((await judgementById(r5)).status).toBe(404); // enforce, never applied
  expect((await judgementById("abc")).status).toBe(404);
  expect((await judgementById("9".repeat(30))).status).toBe(404);
  expect((await judgementById("999999")).status).toBe(404);

  // An unknown or malformed session is a 404, not an empty list.
  expect((await sessionJudgements(crypto.randomUUID())).status).toBe(404);
  expect((await sessionJudgements("not-a-uuid")).status).toBe(404);
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
  await setJudgeConfig({ mode: "enforce", model: STUB_JUDGE_MODEL, thirdPartyEnabled: true });
  const j = await judgeMember("record");

  const older = await aggregated("record_older");
  await judgeSession(older.sessionId, { judgeMemberId: j.id, transport: answer("Older session.") });
  // Another party's opinion on the same session: public, but not this judge's.
  await judgeSession(older.sessionId, { transport: answer("The in-house view of the older session.") });
  await ic.publishSession(older.sessionId);
  expect((await sessionJudgements(older.sessionId)).body.judgements).toHaveLength(2);

  const newer = await aggregated("record_newer");
  await judgeSession(newer.sessionId, { judgeMemberId: j.id, transport: answer("Newer session.") });
  await ic.publishSession(newer.sessionId);

  // Judged but not published: not on the record yet.
  const pending = await aggregated("record_pending");
  await judgeSession(pending.sessionId, { judgeMemberId: j.id, transport: answer("Pending session.") });
  // Published, but the judge's only opinion was shadow.
  const shadowOnly = await aggregated("record_shadow");
  await setJudgeConfig({ mode: "shadow", model: STUB_JUDGE_MODEL });
  await judgeSession(shadowOnly.sessionId, { judgeMemberId: j.id, transport: answer("Shadow only.") });
  await ic.publishSession(shadowOnly.sessionId);

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

// ── the production entry point, with the seeded named judge ─────────────────
// LAST in the file: seedLiveRoster() retires every active member not on the
// live roster, and this file shares one database across its tests.

test("Themis judging through judgeSessionAdmin: the session names Themis, and the judge's record lists it once published", async () => {
  await seedLiveRoster();
  const themisId = ((await sql`SELECT id FROM swarm_members WHERE handle = 'themis'`)[0] as any)?.id as string;
  expect(themisId, "seedLiveRoster() must have seated a themis row").toBeTruthy();
  expect((await ic.getMember("themis"))?.role).toBe("judge");

  await setJudgeConfig({ mode: "enforce", model: STUB_JUDGE_MODEL });
  const s = await aggregated("themis");
  const res = await admin.judgeSessionAdmin(s.sessionId, undefined) as any;
  expect(res.ok).toBe(true);
  expect(res.judge.applied).toBe(true);
  expect((await recOf(s.sessionId)).judge).toMatchObject({ judged_by: themisId, judged_by_member_id: themisId });

  expect((await memberJudgements("themis")).body.judgements).toEqual([]);
  expect((await ic.publishSession(s.sessionId)).state).toBe("published");
  const record = (await memberJudgements("themis")).body.judgements as any[];
  expect(record.map((x) => [x.sessionId, x.judgedBy])).toEqual([[s.sessionId, themisId]]);
  expect((await sessionJudgements(s.sessionId)).body.judgements).toEqual(record);
});
