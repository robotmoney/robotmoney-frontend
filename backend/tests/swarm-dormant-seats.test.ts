// Issue 1269: a seat's consecutive missed sessions, counted from the dormancy
// baseline (migration 0122) and shown, never acted on.
//
// Drives a subject's epochs the way system-scheduler does (open the first,
// turn each over into the next): an epoch seats every active member when it
// opens, and the turnover that closes it records an `absent` row for each
// seated member with no take. So `convene(n)` leaves n - 1 closed sessions,
// each one an absence for a member who filed nothing.
//
// The threshold is SWARM_DORMANCY_THRESHOLD_SESSIONS=3 here, as the issue's
// test plan sets it; the status line is the page's own helper.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import * as admin from "../src/swarm/admin.ts";
import * as ic from "../src/swarm/domain.ts";
import { dormancyThresholdSessions, silentSessionsByMember } from "../src/swarm/dormancy.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { handleSwarmAdmin } from "../src/api/routes/swarm-admin.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { activeSubject, sessionDate, sessionRow, setJudgeMode, submitTake, type TestMember } from "./support/epoch-fixtures.ts";
import { provisionOperatorToken } from "./support/automation-auth.ts";
import * as epochFixtures from "./support/epoch-fixtures.ts";
import { getOverviewProjection } from "../src/admin/overview.ts";
import { seatJudge, signedJudgement } from "./support/stub-judge.ts";

// The page's helper, loaded from the frontend module that renders the line.
// A computed specifier, so the backend typecheck does not resolve a browser
// module it has no declarations for.
const MEMBER_STATUS = join(import.meta.dir, "../../frontend/public/assets/js/app/lib/member-status.js");
const { memberStatusLine } = (await import(MEMBER_STATUS)) as {
  memberStatusLine: (member: { silentSessions: number | null; silentThreshold?: number }) => string | null;
};

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

const previousThreshold = process.env.SWARM_DORMANCY_THRESHOLD_SESSIONS;
beforeAll(() => { process.env.SWARM_DORMANCY_THRESHOLD_SESSIONS = "3"; });
afterAll(() => {
  if (previousThreshold === undefined) delete process.env.SWARM_DORMANCY_THRESHOLD_SESSIONS;
  else process.env.SWARM_DORMANCY_THRESHOLD_SESSIONS = previousThreshold;
});

useCleanDatabasePerTest(import.meta.file);

let OPERATOR = "";
beforeEach(async () => {
  OPERATOR = await provisionOperatorToken();
  currentEpoch.clear();
  judgingAuthor = null;
});

type Member = { id: string; token: string; privateKey: CryptoKey };

// addMemberAdmin sets activated_at = now(), so every session convened after
// it counts (registerMember leaves activation null).
async function activeMember(name: string): Promise<Member> {
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const added = await admin.addMemberAdmin({ name, publicKey: publicKeyB64 });
  if (added.status !== 201) throw new Error(`activeMember(${name}) failed: ${JSON.stringify(added)}`);
  return { id: (added as any).member.id as string, token: (added as any).token as string, privateKey };
}

const currentEpoch = new Map<string, string>();

/** Open the subject's first epoch, or turn the current one over into the next. */
async function nextSession(subjectId: string): Promise<string> {
  const current = currentEpoch.get(subjectId);
  if (!current) {
    const opened = await ic.openEpoch(subjectId);
    if (!opened.ok) throw new Error(`openEpoch failed: ${JSON.stringify(opened)}`);
    currentEpoch.set(subjectId, opened.sessionId);
    return opened.sessionId;
  }
  const turned = await ic.turnOverEpoch(subjectId, current);
  if (!turned.ok) throw new Error(`turnOverEpoch failed: ${JSON.stringify(turned)}`);
  currentEpoch.set(subjectId, turned.openedSessionId!);
  return turned.openedSessionId!;
}

async function convene(subjectId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) ids.push(await nextSession(subjectId));
  return ids;
}

async function submit(m: Member, sessionId: string, subjectId: string) {
  const date = sessionDate(await sessionRow(sessionId));
  const sub = { memberId: m.id, date, subjectId, nonce: rid("n"), stance: "bullish", confidence: 0.7, body: "x" };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  const r = await ic.submitRecommendation(m.token, { ...sub, signature });
  if (r.status !== 201) throw new Error(`submit(${m.id}) failed: ${JSON.stringify(r)}`);
}

async function absences(memberId: string): Promise<number> {
  const [row] = await fixtureDb<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm_agent_health_events
     WHERE member_id = ${memberId} AND event_type = 'absent'`;
  return row!.n;
}

const silentOf = async (memberId: string) => (await ic.getMember(memberId))!.silentSessions;

test("the threshold reads SWARM_DORMANCY_THRESHOLD_SESSIONS, 7 by default", () => {
  expect(dormancyThresholdSessions()).toBe(3);
  expect(dormancyThresholdSessions({})).toBe(7);
});

test("three missed sessions reach the threshold and show the status line; two do not", async () => {
  const subjectId = await activeSubject("dormant-three", 3600);
  const silent = await activeMember("dormant-silent");
  const near = await activeMember("dormant-near");
  const first = await nextSession(subjectId); // seats both
  await submit(near, first, subjectId);
  await convene(subjectId, 3); // `silent`: 3 absences; `near`: present once, then 2 absences

  // The served payload carries the threshold, so the helper gets no explicit one.
  const silentMember = (await ic.getMember(silent.id))!;
  expect(silentMember.silentSessions).toBe(3);
  expect(silentMember.silentThreshold).toBe(3);
  expect(memberStatusLine(silentMember)).toBe("Silent: missed 3 consecutive sessions");

  const nearMember = (await ic.getMember(near.id))!;
  expect(nearMember.silentSessions).toBe(2);
  expect(memberStatusLine(nearMember)).toBeNull();
});

test("absences on sessions convened before the baseline are not counted", async () => {
  const subjectId = await activeSubject("dormant-baseline", 3600);
  const m = await activeMember("dormant-before");
  await convene(subjectId, 10);
  expect(await absences(m.id)).toBe(9);
  expect(await silentOf(m.id)).toBe(9);

  // The upgrade goes through now: what came before counts against no one.
  await fixtureDb`UPDATE swarm_dormancy_baseline SET counted_from = now()`;
  expect(await silentOf(m.id)).toBe(0);
});

test("a member at or above the threshold stays active, keyed and seated as expected", async () => {
  const subjectId = await activeSubject("dormant-stays", 3600);
  const m = await activeMember("dormant-stays");
  await convene(subjectId, 5); // four absences
  expect(await silentOf(m.id)).toBe(4);
  expect(4).toBeGreaterThanOrEqual(dormancyThresholdSessions());

  const next = await nextSession(subjectId);
  const [member] = await fixtureDb<{ status: string }[]>`SELECT status FROM swarm_members WHERE id = ${m.id}`;
  expect(member!.status).toBe("active");
  const keys = await fixtureDb<{ active: boolean }[]>`SELECT active FROM swarm_member_keys WHERE member_id = ${m.id}`;
  expect(keys.some((k) => k.active)).toBe(true);
  const [seat] = await fixtureDb<{ status: string }[]>`
    SELECT status FROM swarm_session_members WHERE session_id = ${next} AND member_id = ${m.id}`;
  expect(seat?.status).toBe("expected");
});

test("a take resets the count: absent twice, present once, absent twice gives 2", async () => {
  const subjectId = await activeSubject("dormant-reset", 3600);
  const m = await activeMember("dormant-reset");
  await convene(subjectId, 3); // absent on two
  expect(await silentOf(m.id)).toBe(2);
  await submit(m, currentEpoch.get(subjectId)!, subjectId);
  expect(await silentOf(m.id)).toBe(0);
  await convene(subjectId, 3); // present on the third, absent on two more
  expect(await absences(m.id)).toBe(4);
  expect(await silentOf(m.id)).toBe(2);
});

test("a session on which the operator excused the seat does not count", async () => {
  const subjectId = await activeSubject("dormant-excused", 3600);
  const m = await activeMember("dormant-excused");
  await convene(subjectId, 2); // absent on one
  const excusedOn = currentEpoch.get(subjectId)!;
  expect((await admin.rosterExcuseAdmin(excusedOn, m.id, admin.ADMIN_ACTOR, { force: true })).status).toBe(200);
  await convene(subjectId, 2); // the excused session closes, then one more absence
  expect(await silentOf(m.id)).toBe(2);

  // An excusal written over an absence already on file does not count either.
  const [{ session_id }] = await fixtureDb<{ session_id: string }[]>`
    SELECT e.session_id FROM swarm_agent_health_events e
      JOIN swarm_sessions s ON s.id = e.session_id
     WHERE e.member_id = ${m.id} AND e.event_type = 'absent'
     ORDER BY s.convened_at DESC LIMIT 1`;
  await fixtureDb`UPDATE swarm_session_members SET status = 'excused', excused_at = now()
                   WHERE session_id = ${session_id} AND member_id = ${m.id}`;
  expect(await silentOf(m.id)).toBe(1);
});

test("a judge-role member's count is its own, not its member absences", async () => {
  const subjectId = await activeSubject("dormant-judge", 3600);
  const m = await activeMember("dormant-judge");
  await convene(subjectId, 5);
  expect(await absences(m.id)).toBe(4);
  const [{ version }] = await fixtureDb<{ version: number }[]>`SELECT version FROM swarm_members WHERE id = ${m.id}`;
  expect((await admin.setMemberRoleAdmin(m.id, Number(version), "judge")).status).toBe(200);
  // No session of this judge's was ever offered for judging, so nothing counts.
  expect(await silentOf(m.id)).toBe(0);
  expect((await silentSessionsByMember()).get(m.id)).toBe(0);
});

// A session in judging with one take, its deadline already past.
let judgingAuthor: TestMember | null = null;
async function judgedSession(prefix: string, deadlineAgo = "1 second"): Promise<string> {
  await setJudgeMode("enforce");
  judgingAuthor ??= await seatedAuthor();
  const subjectId = await activeSubject(prefix, 600);
  const opened = await ic.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const took = await submitTake(judgingAuthor, sessionDate(await sessionRow(opened.sessionId)), subjectId, { body: `a take on ${prefix}` });
  if (took.status !== 201) throw new Error(`submitTake failed: ${JSON.stringify(took)}`);
  const turned = await ic.turnOverEpoch(subjectId, opened.sessionId);
  if (!turned.ok) throw new Error("turnOverEpoch failed");
  await ic.aggregateEpoch(turned.closedSessionId);
  const requested = await ic.requestJudging(turned.closedSessionId);
  if (!requested.ok) throw new Error("requestJudging failed");
  await fixtureDb.unsafe(`UPDATE swarm_sessions SET judging_deadline_at = now() - interval '${deadlineAgo}' WHERE id = '${turned.closedSessionId}'`);
  return turned.closedSessionId;
}
const seatedAuthor = () => epochFixtures.activeMember();

test("a judge with no on-time answer in a session has its count incremented, an on-time answer resets it, a member's count is unchanged", async () => {
  const judge = await seatJudge({ prefix: "dormant_judge" });
  const member = await activeMember("dormant-judge-member");
  const first = await judgedSession("dj_first");
  const second = await judgedSession("dj_second");
  await judgedSession("dj_third");
  expect(await silentOf(judge.id)).toBe(3);
  // The member's count is its own absences, which judging does not touch.
  const memberCount = await silentOf(member.id);
  expect(memberCount).toBe(await absences(member.id));

  // An answer after the deadline is not on time: the session still counts.
  await ic.submitJudgement(judge.token, await signedJudgement(judge, first));
  expect(await silentOf(judge.id)).toBe(3);

  // An on-time answer to a later session resets the count for every earlier one.
  await fixtureDb`UPDATE swarm_sessions SET judging_deadline_at = now() + interval '1 hour' WHERE id = ${second}`;
  const answered = await ic.submitJudgement(judge.token, await signedJudgement(judge, second));
  expect(answered.ok && answered.onTime).toBe(true);
  // The answer landed exactly at the deadline, which is on time; the session has since ended.
  await fixtureDb`UPDATE swarm_sessions SET judging_deadline_at =
                    (SELECT created_at FROM swarm_session_judgements WHERE session_id = ${second}) WHERE id = ${second}`;
  await judgedSession("dj_fourth", "1 millisecond");
  expect(await silentOf(judge.id)).toBe(1);

  // An outside judge is not charged while outside judging is off.
  const outside = await seatJudge({ prefix: "dormant_outside", operator: "someone-else" });
  await fixtureDb`UPDATE swarm_judge_config SET third_party_enabled = false WHERE id = 1`;
  expect(await silentOf(outside.id)).toBe(0);
  await fixtureDb`UPDATE swarm_judge_config SET third_party_enabled = true WHERE id = 1`;
  expect(await silentOf(outside.id)).toBeGreaterThan(0);
  // The member's count is still just its own absences (the fourth session added one).
  expect(await silentOf(member.id)).toBe(memberCount! + 1);
  expect(await silentOf(member.id)).toBe(await absences(member.id));
});

test("the admin overview names a member past the threshold and a judge quiet for a day, and not a seat under it", async () => {
  // The judged sessions come first, so the members below are seated in none of them.
  const judge = await seatJudge({ prefix: "dormant_alert_judge" });
  const fresh = await seatJudge({ prefix: "dormant_alert_fresh" });
  await fixtureDb`UPDATE swarm_dormancy_baseline SET counted_from = now() - interval '3 days'`;
  await judgedSession("da_old", "25 hours");
  // `fresh` activated after the old session ended: its first miss is under a day old.
  await fixtureDb`UPDATE swarm_members SET activated_at = now() - interval '2 hours' WHERE id = ${fresh.id}`;
  await judgedSession("da_recent", "1 hour");

  const subjectId = await activeSubject("dormant-alerts", 3600);
  const quiet = await activeMember("dormant-quiet");
  const near = await activeMember("dormant-near-alert");
  await convene(subjectId, 4); // three absences each, the threshold
  expect((await ic.getMember(quiet.id))!.silentSessions).toBe(3);
  await submit(near, currentEpoch.get(subjectId)!, subjectId); // resets `near`
  await convene(subjectId, 2); // `near` is at 1

  const alerts = (await getOverviewProjection()).alerts.filter((a) => a.source.startsWith("swarm.quiet_seat:"));
  const sources = alerts.map((a) => a.source);
  expect(sources).toContain(`swarm.quiet_seat:${quiet.id}`);
  expect(sources).toContain(`swarm.quiet_seat:${judge.id}`);
  expect(sources).not.toContain(`swarm.quiet_seat:${near.id}`);
  expect(sources).not.toContain(`swarm.quiet_seat:${fresh.id}`);
  expect(alerts.find((a) => a.source.endsWith(quiet.id))!.message).toContain("threshold of 3");
});

test("GET /api/swarm/members/:id and the admin list serve silentSessions", async () => {
  const subjectId = await activeSubject("dormant-route", 3600);
  const seated = await activeMember("dormant-route");
  const gone = await activeMember("dormant-gone");
  await convene(subjectId, 4);
  const [{ version }] = await fixtureDb<{ version: number }[]>`SELECT version FROM swarm_members WHERE id = ${gone.id}`;
  expect((await admin.deactivateMemberAdmin(gone.id, Number(version))).status).toBe(200);

  const get = async (id: string) => {
    const p = `/api/swarm/members/${id}`;
    const res = await handleSwarm(new Request(`http://localhost${p}`), new URL(`http://localhost${p}`));
    expect(res?.status).toBe(200);
    return res!.body as { silentSessions: number | null; silentThreshold: number };
  };
  const seatedBody = await get(seated.id);
  expect(seatedBody.silentSessions).toBe(3);
  expect(seatedBody.silentThreshold).toBe(3);
  expect(memberStatusLine(seatedBody)).toBe("Silent: missed 3 consecutive sessions");
  expect((await get(gone.id)).silentSessions).toBeNull();

  const res = await handleSwarmAdmin(
    new Request("http://x/api/swarm/admin/members", { method: "GET", headers: { "X-Admin-Token": OPERATOR } }),
    new URL("http://x/api/swarm/admin/members"),
  );
  expect(res?.status).toBe(200);
  const members = (res!.body as { members: { id: string; silentSessions: number | null; silentThreshold: number }[] }).members;
  const seatedRow = members.find((x) => x.id === seated.id)!;
  expect(seatedRow.silentSessions).toBe(3);
  expect(seatedRow.silentThreshold).toBe(3);
  expect(memberStatusLine(seatedRow)).toBe("Silent: missed 3 consecutive sessions");
  expect(members.find((x) => x.id === gone.id)?.silentSessions).toBeNull();
});

test("migration 0122 leaves one baseline row, and re-applying it keeps that row's counted_from", async () => {
  const before = await fixtureDb<{ counted_from: Date }[]>`SELECT counted_from FROM swarm_dormancy_baseline`;
  expect(before.length).toBe(1);
  const file = join(import.meta.dir, "../migrations/0122_swarm_dormancy_baseline.sql");
  await fixtureDb.unsafe(await Bun.file(file).text());
  const after = await fixtureDb<{ counted_from: Date }[]>`SELECT counted_from FROM swarm_dormancy_baseline`;
  expect(after.length).toBe(1);
  expect(after[0]!.counted_from.toISOString()).toBe(before[0]!.counted_from.toISOString());
});
