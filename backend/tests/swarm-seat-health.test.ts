// Issue 1495: outside seats can see their own health, and admin hears when one
// goes quiet.
//
// Covers the seat's own health read (member and judge), the on-time marker on
// the judgement answer, the admin judgement lookup by id and the judge feed's
// off-switch state and take filter. The missed-session count for judges and the
// quiet-seat alerts are asserted in swarm-dormant-seats.test.ts.
import { expect, test } from "bun:test";
import * as ic from "../src/swarm/domain.ts";
import { handleJudgeParticipant } from "../src/api/routes/swarm-judge-participant.ts";
import { handleSwarmAdmin } from "../src/api/routes/swarm-admin.ts";
import { _resetJudgeRefusals, recordJudgeRefusal } from "../src/swarm/judge-refusals.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { provisionOperatorToken } from "./support/automation-auth.ts";
import { activeMember, activeSubject, sessionDate, sessionRow, setJudgeMode, submitTake, type TestMember } from "./support/epoch-fixtures.ts";
import { seatJudge, signedJudgement, type TestJudge } from "./support/stub-judge.ts";

useCleanDatabase(import.meta.file);

const url = (p: string) => new URL(`http://test${p}`);
const getHealth = (token: string | null, query = "") =>
  handleJudgeParticipant(
    new Request(`http://test/api/swarm/participants/health${query}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    url(`/api/swarm/participants/health${query}`),
  ) as Promise<{ status: number; body: any }>;

let author: TestMember | null = null;

/** A session parked in `judging` with one signed take, as §4.4 leaves it. */
async function judgingSession(prefix: string): Promise<string> {
  await setJudgeMode("enforce");
  author ??= await activeMember();
  const subjectId = await activeSubject(prefix, 600);
  const opened = await ic.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const took = await submitTake(author, sessionDate(await sessionRow(opened.sessionId)), subjectId, { body: `a take on ${prefix}` });
  if (took.status !== 201) throw new Error(`submitTake failed: ${JSON.stringify(took)}`);
  const turned = await ic.turnOverEpoch(subjectId, opened.sessionId);
  if (!turned.ok) throw new Error("turnOverEpoch failed");
  await ic.aggregateEpoch(turned.closedSessionId);
  const requested = await ic.requestJudging(turned.closedSessionId);
  if (!requested.ok) throw new Error("requestJudging failed");
  return turned.closedSessionId;
}

const expireDeadline = (sessionId: string) =>
  fixtureDb`UPDATE swarm_sessions SET judging_deadline_at = now() - interval '1 second' WHERE id = ${sessionId}`;

async function submit(j: TestJudge, sessionId: string) {
  const r = await ic.submitJudgement(j.token, await signedJudgement(j, sessionId));
  if (!r.ok) throw new Error(`submitJudgement failed: ${JSON.stringify(r)}`);
  return r;
}

test("a member reads its own health: role, key fingerprint, last take, missed count and refusals", async () => {
  _resetJudgeRefusals();
  const mine = await activeMember();
  const other = await activeMember();
  const sessionId = await judgingSession("sh_member");
  await fixtureDb`INSERT INTO swarm_agent_health_events (event_type, session_id, member_id, detail)
                  VALUES ('rejected_take', ${sessionId}, ${mine.id}, ${fixtureDb.json({ status: 409, code: "submission_window_closed" })}),
                         ('rejected_take', ${sessionId}, ${other.id}, ${fixtureDb.json({ status: 409, code: "excused" })})`;

  const res = await getHealth(mine.token);
  expect(res.status).toBe(200);
  expect(res.body.memberId).toBe(mine.id);
  expect(res.body.role).toBe("member");
  expect(res.body.activeKeyFingerprint).toMatch(/\S{8,}/);
  expect(res.body.lastTakeAt).toBeNull();
  expect(typeof res.body.missedThreshold).toBe("number");
  expect(res.body.refusals.map((r: any) => r.code)).toEqual(["submission_window_closed"]);
  expect(res.body.judgements).toBeUndefined();
  // Only this seat's data: the other member's refusal is not in it.
  expect(JSON.stringify(res.body)).not.toContain("excused");
  expect(JSON.stringify(res.body)).not.toContain(other.id);

  // The seat's own id is accepted; another seat's id and no bearer are refused.
  expect((await getHealth(mine.token, `?member=${mine.id}`)).status).toBe(200);
  expect((await getHealth(mine.token, `?member=${other.id}`)).status).toBe(403);
  expect((await getHealth(null)).status).toBe(401);
  expect((await getHealth("not-a-token")).status).toBe(401);
});

test("a judge's health lists its judgements each marked on_time, after_deadline, late_evidence or drawn", async () => {
  _resetJudgeRefusals();
  const j = await seatJudge({ prefix: "sh_judge" });
  const onTime = await judgingSession("sh_on_time");
  const afterDeadline = await judgingSession("sh_after");
  const late = await judgingSession("sh_late");
  const drawn = await judgingSession("sh_drawn");

  // The answer says at submit time whether it beat the deadline.
  const first = await submit(j, onTime);
  expect(first.onTime).toBe(true);
  expect(first.lateEvidence).toBe(false);
  await expireDeadline(afterDeadline);
  const second = await submit(j, afterDeadline);
  expect(second.onTime).toBe(false);
  expect(second.lateEvidence).toBe(false);
  // A resend says the same thing it said the first time.
  expect((await submit(j, onTime)).onTime).toBe(true);
  expect((await submit(j, afterDeadline)).onTime).toBe(false);

  await submit(j, late);
  await submit(j, drawn);
  await fixtureDb`UPDATE swarm_session_judgements SET applied_skipped_reason = 'late_evidence'
                   WHERE session_id = ${late} AND judged_by_member_id = ${j.id}`;
  await fixtureDb`UPDATE swarm_session_judgements SET applied = true, applied_skipped_reason = NULL
                   WHERE session_id = ${drawn} AND judged_by_member_id = ${j.id}`;
  recordJudgeRefusal({ memberId: j.id, sessionId: drawn, reason: "model_timeout", detail: "slow" });

  const res = await getHealth(j.token);
  expect(res.status).toBe(200);
  expect(res.body.role).toBe("judge");
  const timing = Object.fromEntries(res.body.judgements.map((x: any) => [x.sessionId, x.timing]));
  expect(timing).toEqual({
    [onTime]: "on_time",
    [afterDeadline]: "after_deadline",
    [late]: "late_evidence",
    [drawn]: "drawn",
  });
  expect(res.body.refusals.map((r: any) => [r.kind, r.code])).toEqual([["judge_report", "model_timeout"]]);
});

test("a judgement submitted between the deadline and publication is marked not on time", async () => {
  const j = await seatJudge({ prefix: "sh_between" });
  const sessionId = await judgingSession("sh_between");
  await expireDeadline(sessionId);
  const r = await submit(j, sessionId);
  expect(r.state).toBe("judging");
  expect(r.onTime).toBe(false);
  expect(r.lateEvidence).toBe(false);
  expect(typeof r.judgingDeadlineAt).toBe("string");
});

test("admin opens any judgement by id without a session id, and an unknown id is 404", async () => {
  const operator = await provisionOperatorToken();
  const j = await seatJudge({ prefix: "sh_admin" });
  const drawnSession = await judgingSession("sh_admin_drawn");
  const undrawnSession = await judgingSession("sh_admin_undrawn");
  const drawnId = (await submit(j, drawnSession)).judgementId;
  const undrawnId = (await submit(j, undrawnSession)).judgementId;
  await fixtureDb`UPDATE swarm_session_judgements SET applied = true, applied_skipped_reason = NULL WHERE id = ${drawnId}`;

  const get = async (id: string, token: string | null = operator) => {
    const p = `/api/swarm/admin/judgements/${id}`;
    return (await handleSwarmAdmin(
      new Request(`http://x${p}`, { headers: token ? { "X-Admin-Token": token } : {} }),
      new URL(`http://x${p}`),
    )) as { status: number; body: any };
  };
  const drawn = await get(String(drawnId));
  expect(drawn.status).toBe(200);
  expect(drawn.body.sessionId).toBe(drawnSession);
  expect(drawn.body.judgement.drawn || drawn.body.judgement.applied).toBe(true);
  expect(drawn.body.timing).toBe("drawn");
  const undrawn = await get(String(undrawnId));
  expect(undrawn.status).toBe(200);
  expect(undrawn.body.sessionId).toBe(undrawnSession);
  expect(undrawn.body.judgement.applied).toBe(false);
  expect(undrawn.body.timing).toBe("on_time");
  expect((await get("999999999")).status).toBe(404);
  expect((await get("not-a-number")).status).toBe(404);
  // Privileged like every admin route.
  expect((await get(String(drawnId), null)).status).toBe(403);
});

test("the judge feed says outside judging is off, then serves only sessions with a take", async () => {
  const outside = await seatJudge({ prefix: "sh_outside", operator: "someone-else" });
  const inHouse = await seatJudge({ prefix: "sh_house" });
  const withTake = await judgingSession("sh_feed");

  await fixtureDb`UPDATE swarm_judge_config SET third_party_enabled = false WHERE id = 1`;
  const off = await ic.judgeFeedFor(outside.id);
  expect(off.judging).toBe("outside_judging_disabled");
  expect(off.pending).toEqual([]);
  expect(off.message).toContain("Outside judging is switched off");
  // An in-house seat is served whatever the switch says.
  const house = await ic.judgeFeedFor(inHouse.id);
  expect(house.judging).toBe("enabled");
  expect(house.pending.map((p) => p.sessionId)).toContain(withTake);

  await fixtureDb`UPDATE swarm_judge_config SET third_party_enabled = true WHERE id = 1`;
  const on = await ic.judgeFeedFor(outside.id);
  expect(on.judging).toBe("enabled");
  expect(on.pending.map((p) => p.sessionId)).toContain(withTake);

  // A session in judging with no take at all is not offered.
  const subjectId = await activeSubject("sh_empty", 600);
  const opened = await ic.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  await fixtureDb`UPDATE swarm_sessions SET state = 'judging', judging_requested_at = now(),
                         judging_deadline_at = now() + interval '10 minutes'
                   WHERE id = ${opened.sessionId}`;
  const empty = await ic.judgeFeedFor(inHouse.id);
  expect(empty.pending.map((p) => p.sessionId)).not.toContain(opened.sessionId);
  expect(empty.pending.map((p) => p.sessionId)).toContain(withTake);

});
