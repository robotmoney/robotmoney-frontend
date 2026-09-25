// The agent participant's pending-work route exists and is reachable (issue
// #1026, criterion 124; smoke-production-spec.md §6.2).
//
//   "Agents poll. An agent polls the API for `collecting` sessions it has not
//    yet taken, submits, and sleeps."
//
// THE DEFECT THIS CLOSES. `PARTICIPANT_PENDING_PATH` had no backend handler.
// The participant read the 404 as "no work" and polled for ever in silence. The
// client now throws on a 404 (scripts/agent/participant/main.ts pollForWork),
// so a missing route crash-loops a participant loudly — and this is the route
// it reaches.
//
// REACHABLE MEANS THROUGH THE DISPATCHER. Every request below goes through
// `handleSwarm`, the one function the API's router hands `/api/swarm/*` to, so
// a handler that exists but is not registered is a failure here, not a pass.
// The final test runs the participant's OWN poll function against a live HTTP
// server fronting that dispatcher, so the shape it demands (`{ pending:
// PendingWork[] }`, each item `{ sessionId, subjectId, date }`) is checked by
// the client that will read it, not by a copy of its rules.
import { expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import * as ic from "../src/swarm/domain.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { pollForWork, PARTICIPANT_PENDING_PATH } from "../../scripts/agent/participant/main.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { activeMember, activeSubject, sessionDate, sessionRow, submitTake } from "./support/epoch-fixtures.ts";
import { seatJudge } from "./support/stub-judge.ts";

useCleanDatabasePerTest(import.meta.file);

async function poll(token: string | null, member?: string): Promise<{ status: number; body: any }> {
  const url = `http://localhost${ROUTES.swarm.participants.pending}${member ? `?member=${encodeURIComponent(member)}` : ""}`;
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const res = await handleSwarm(new Request(url, { headers }), new URL(url));
  if (!res) throw new Error("the swarm dispatcher did not route the pending path — the route is unreachable");
  if (res instanceof Response) throw new Error("pending answered with a raw Response, not an envelope");
  return res as { status: number; body: any };
}

async function openedEpoch(prefix: string) {
  const subjectId = await activeSubject(prefix, 3600);
  const opened = await ic.openEpoch(subjectId);
  if (!opened.ok) throw new Error(`openEpoch: ${JSON.stringify(opened)}`);
  return { subjectId, sessionId: opened.sessionId, date: sessionDate(await sessionRow(opened.sessionId)) };
}

test("the path the participant polls is the contract's, and the dispatcher routes it", async () => {
  expect(PARTICIPANT_PENDING_PATH).toBe(ROUTES.swarm.participants.pending);
  const m = await activeMember();
  const res = await poll(m.token, m.id);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ pending: [] });
});

test("a collecting epoch the member has not taken is pending, with the coordinates the participant reads", async () => {
  const m = await activeMember();
  const { subjectId, sessionId, date } = await openedEpoch("pending_open");
  const res = await poll(m.token, m.id);
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.pending)).toBe(true);
  expect(res.body.pending).toHaveLength(1);
  const [item] = res.body.pending;
  expect(item).toMatchObject({ sessionId, subjectId, date });
  expect(typeof item.windowClosesAt).toBe("string");
});

test("a session drops out of the queue once the member has taken it, once its instant passes, and once it turns over", async () => {
  const m = await activeMember();
  const a = await openedEpoch("pending_taken");
  const b = await openedEpoch("pending_late");
  const c = await openedEpoch("pending_turned");
  const ids = async () => ((await poll(m.token, m.id)).body.pending as { sessionId: string }[]).map((p) => p.sessionId).sort();
  expect(await ids()).toEqual([a.sessionId, b.sessionId, c.sessionId].sort());

  // Taken: the member filed its take.
  expect((await submitTake(m, a.date, a.subjectId)).ok).toBe(true);
  // Late: the advertised instant passed, turnover has not run (§4.2 refuses by instant).
  await sql`UPDATE swarm_sessions SET window_closes_at = clock_timestamp() - interval '1 second' WHERE id = ${b.sessionId}`;
  // Turned over: C closed and its successor opened — the successor is pending.
  const turned = await ic.turnOverEpoch(c.subjectId, c.sessionId);
  if (!turned.ok) throw new Error(`turnOverEpoch: ${JSON.stringify(turned)}`);

  expect(await ids()).toEqual([turned.openedSessionId]);
});

test("an excused member is not sent to a session it may not submit to", async () => {
  const m = await activeMember();
  const { sessionId } = await openedEpoch("pending_excused");
  await sql`UPDATE swarm_session_members SET status = 'excused', excused_at = now()
             WHERE session_id = ${sessionId} AND member_id = ${m.id}`;
  expect((await poll(m.token, m.id)).body.pending).toEqual([]);
});

test("refusals: no bearer is 401, a bad bearer is 401, another member's queue is 403, a judge is 403", async () => {
  const m = await activeMember();
  const other = await activeMember();
  expect((await poll(null, m.id)).status).toBe(401);
  expect((await poll("tok_not_a_real_token", m.id)).status).toBe(401);
  const foreign = await poll(m.token, other.id);
  expect(foreign.status).toBe(403);
  expect(foreign.body.error).toBe("token/member mismatch");
  const judge = await seatJudge({ prefix: "pending_judge" });
  const judged = await poll(judge.token, judge.id);
  expect(judged.status).toBe(403);
  expect(judged.body.error).toBe("judge_role_cannot_submit_takes");
});

test("the participant's own poll reads the route over HTTP and returns the first pending item", async () => {
  const m = await activeMember();
  const { subjectId, sessionId, date } = await openedEpoch("pending_http");
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const res = await handleSwarm(req, new URL(req.url));
      if (!res) return new Response("not found", { status: 404 });
      if (res instanceof Response) return res;
      return Response.json(res.body, { status: res.status });
    },
  });
  try {
    const config = {
      apiUrl: `http://127.0.0.1:${server.port}`,
      memberId: m.id,
      token: m.token,
    } as Parameters<typeof pollForWork>[0];
    const work = await pollForWork(config);
    expect(work).toEqual({ sessionId, subjectId, date });

    // Once taken, the same poll reads "no work" — an empty list, not a 404.
    expect((await submitTake(m, date, subjectId)).ok).toBe(true);
    expect(await pollForWork(config)).toBeNull();
  } finally {
    server.stop(true);
  }
});
