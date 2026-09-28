// D55 (4), as corrected 2026-09-25: THE WINDOW RUNS TO ITS CLOSE — issue #1026
// criterion 169.
//
// AUTHORITY: docs/decisions.md D55 (4) and
// docs/technical/system-scheduler-spec.md §4.3 and §4.5:
//
//   "A deactivation only sets the subject inactive and publishes
//    `subject.changed`. It does not close the open epoch. No admin or operator
//    early close exists.
//    - The open window stays open until its grid boundary, and takes are
//      accepted until then (§4.2).
//    - The scheduler keeps that session's boundary timer. At the boundary it
//      turns the epoch over as usual (§4.3): the turnover closes the session,
//      records absences and opens no successor, because the subject is
//      inactive. The scheduler then settles the closed epoch …
//    - A reactivation while that window is still open opens nothing, because
//      the subject already has a `collecting` session. The boundary then finds
//      the subject active and opens N+1 as usual."
//
// EVERY EDIT AND EVERY TRANSITION HERE GOES THROUGH A REAL API PROCESS. The
// admin's deactivation and activation carry the operator's store token to the
// subject routes; the boundary is the scheduler's token on `epochs/turnover`,
// exactly what system-scheduler sends when its boundary timer fires; the
// settlement is the scheduler's `epochs/aggregate` and `epochs/finalize`.
// Takes are signed and submitted through the domain, as a participant's
// request lands there.
//
// THE RED CONTROL restores the retired rule — the same-transaction close in
// the deactivation — inside a second real api process, through a `bun
// --preload` rewrite of backend/src/swarm/admin.ts, and shows the checks here
// fail on it. Nothing in the source tree is modified to run it.
//
// The scheduler side of the same rule (keep the timer on deactivation, open
// nothing on a reactivation inside the window, drop the timer when the
// boundary opens no successor) is scripts/tests/unit/system-scheduler-clock.test.ts
// and system-scheduler-rebuild.test.ts, and end to end
// scripts/tests/integration/scheduler-api-runtime.test.ts.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import * as epoch from "../src/swarm/domain.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import {
  activeMember,
  activeSubject,
  collectingSessions,
  sessionDate,
  sessionRow,
  setJudgeMode,
  submitTake,
} from "./support/epoch-fixtures.ts";
import {
  adminHeaders,
  bootApi,
  probe,
  provisionOperatorToken,
  provisionSchedulerToken,
  schedulerHeaders,
  writeRedControlPreload,
  type ApiProcess,
} from "./support/automation-auth.ts";

useCleanDatabase(import.meta.file);

let api: ApiProcess;
let OPERATOR = "";
let SCHEDULER = "";

beforeAll(async () => {
  OPERATOR = await provisionOperatorToken();
  SCHEDULER = await provisionSchedulerToken();
  // Judge mode `off`: settlement is aggregate then finalize, with nothing to
  // wait on, so the whole path to `published` runs inside a test.
  await setJudgeMode("off");
  api = await bootApi({ env: { RM_ENV: "ephemeral" } });
}, 90_000);

afterAll(() => api?.stop());

const A = ROUTES.swarm.admin;

async function version(subjectId: string): Promise<number> {
  const [row] = await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${subjectId}`;
  return Number(row!.version);
}

/** The admin's subject edit, over HTTP under the operator's token. */
async function subjectEdit(target: ApiProcess, route: string, subjectId: string): Promise<number> {
  const res = await probe(target, "POST", route.replace(":id", encodeURIComponent(subjectId)), adminHeaders(OPERATOR), {
    expectedVersion: await version(subjectId),
  });
  return res.status;
}

/** A scheduler transition, over HTTP under the scheduler's token. */
async function transition(route: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await probe(api, "POST", route, schedulerHeaders(SCHEDULER), body);
  return { status: res.status, body: JSON.parse(res.body) };
}

/** The scheduler's first open of a subject's epoch. */
async function opened(prefix: string): Promise<{ subjectId: string; sessionId: string; date: string; closesAt: string }> {
  const subjectId = await activeSubject(prefix, 3600);
  const r = await transition(A.epochOpen, { subjectId });
  expect(r.status).toBeLessThan(300);
  const s = await sessionRow(r.body.sessionId);
  return { subjectId, sessionId: r.body.sessionId, date: sessionDate(s), closesAt: r.body.windowClosesAt };
}

/**
 * Everything "the window runs to its close" asserts about a session after a
 * deactivation and before its boundary: still collecting, nothing captured, no
 * absences, no successor, the only subject.changed event carrying no closed
 * epoch, and still the subject's one collecting session.
 */
async function windowFacts(subjectId: string, sessionId: string) {
  const s = await sessionRow(sessionId);
  const absences = await sql`SELECT 1 FROM swarm_agent_health_events WHERE session_id = ${sessionId}`;
  return {
    state: s.state,
    judgeMode: s.judge_mode,
    successor: s.successor_session_id,
    absences: absences.length,
    collecting: (await collectingSessions(subjectId)).map((x) => x.id),
  };
}

const RUNS_TO_CLOSE = (sessionId: string) => ({
  state: "collecting",
  judgeMode: null,
  successor: null,
  absences: 0,
  collecting: [sessionId],
});

test("169: an admin deactivation mid-window only marks the subject inactive; the window keeps collecting and accepts a take", async () => {
  const filer = await activeMember();
  const silent = await activeMember();
  const { subjectId, sessionId, date } = await opened("deact_mid");
  const head = await epoch.streamHeadSequence();

  expect(await subjectEdit(api, A.subjectDeactivate, subjectId)).toBe(200);

  // The subject is inactive, and that is the only thing that moved.
  const [subject] = await sql<{ status: string }[]>`SELECT status FROM swarm_subjects WHERE id = ${subjectId}`;
  expect(subject!.status).toBe("inactive");
  expect(await windowFacts(subjectId, sessionId)).toEqual(RUNS_TO_CLOSE(sessionId));
  // One event, subject.changed, naming no closed epoch because none closed.
  const events = await sql<{ kind: string; payload: Record<string, unknown> }[]>`
    SELECT kind, payload FROM swarm_stream_events WHERE seq > ${head} ORDER BY seq`;
  expect(events.map((e) => [e.kind, e.payload])).toEqual([["subject.changed", { reason: "deactivated" }]]);
  const [audit] = await sql<{ scope: Record<string, unknown> }[]>`
    SELECT scope FROM audit_log WHERE action = 'subject_deactivate' AND scope->>'subjectId' = ${subjectId}`;
  expect(audit!.scope).toEqual({ subjectId });

  // §4.2: the window is open, so a take after the deactivation is accepted.
  const take = await submitTake(filer, date, subjectId);
  expect(take.ok).toBe(true);
  expect((await sql`SELECT 1 FROM swarm_recommendations WHERE session_id = ${sessionId}`).length).toBe(1);
  // Still no state change: nothing but the boundary closes this window.
  expect(await windowFacts(subjectId, sessionId)).toEqual(RUNS_TO_CLOSE(sessionId));
  void silent;
});

test("169: at the boundary the scheduler's turnover closes and settles the window, records absences, and opens no successor", async () => {
  const filer = await activeMember();
  const silent = await activeMember();
  const { subjectId, sessionId, date } = await opened("deact_boundary");
  expect(await subjectEdit(api, A.subjectDeactivate, subjectId)).toBe(200);
  expect((await submitTake(filer, date, subjectId)).ok).toBe(true);
  const head = await epoch.streamHeadSequence();

  const turned = await transition(A.epochTurnover, { subjectId, expectedSessionId: sessionId });
  expect(turned.status).toBe(200);
  expect(turned.body).toMatchObject({ closedSessionId: sessionId, openedSessionId: null, windowClosesAt: null, replayed: false });

  const closed = await sessionRow(sessionId);
  expect({ state: closed.state, successor: closed.successor_session_id, mode: closed.judge_mode })
    .toEqual({ state: "window_closed", successor: null, mode: "off" });
  expect((await collectingSessions(subjectId)).length).toBe(0);
  // Absences are recorded by the turnover, against the seated roster: the
  // member that filed after the deactivation is on time, the silent one absent.
  const absent = await sql<{ member_id: string }[]>`
    SELECT member_id FROM swarm_agent_health_events WHERE session_id = ${sessionId} AND event_type = 'absent'`;
  expect(absent.map((r) => r.member_id).includes(filer.id)).toBe(false);
  expect(absent.map((r) => r.member_id).includes(silent.id)).toBe(true);
  // The one event the turnover wrote says N closed and nothing opened.
  const events = await sql<{ kind: string; payload: Record<string, unknown> }[]>`
    SELECT kind, payload FROM swarm_stream_events WHERE seq > ${head} ORDER BY seq`;
  expect(events.map((e) => [e.kind, e.payload])).toEqual([
    ["epoch.turned_over", { closedSessionId: sessionId, openedSessionId: null, windowClosesAt: null }],
  ]);

  // Settlement through the ordinary transitions reaches `published`, with the
  // take filed after the deactivation in its take set.
  expect((await transition(A.epochAggregate, { sessionId })).status).toBe(200);
  const fin = await transition(A.epochFinalize, { sessionId });
  expect(fin.status).toBe(200);
  expect(fin.body).toMatchObject({ state: "published", outcome: "not_judged" });
  const frozen = await epoch.loadFrozenTakeSet(sessionId);
  expect(frozen!.takes.map((t) => t.member_id)).toEqual([filer.id]);
  expect((await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${subjectId}`).length).toBe(1);
});

test("169: a reactivation inside the still-open window opens nothing; the boundary then opens N+1 as usual", async () => {
  const { subjectId, sessionId } = await opened("deact_react_inside");
  expect(await subjectEdit(api, A.subjectDeactivate, subjectId)).toBe(200);
  const head = await epoch.streamHeadSequence();

  expect(await subjectEdit(api, A.subjectActivate, subjectId)).toBe(200);
  expect(await windowFacts(subjectId, sessionId)).toEqual(RUNS_TO_CLOSE(sessionId));
  expect((await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${subjectId}`).length).toBe(1);
  // Even the scheduler's open, called anyway, returns the window that is
  // already collecting rather than a second one.
  const again = await transition(A.epochOpen, { subjectId });
  expect(again.body).toMatchObject({ sessionId, created: false });
  expect((await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${subjectId}`).length).toBe(1);
  expect((await sql`SELECT kind FROM swarm_stream_events WHERE seq > ${head}`).map((r: any) => r.kind))
    .toEqual(["subject.changed"]);

  // The boundary finds the subject active and opens N+1.
  const turned = await transition(A.epochTurnover, { subjectId, expectedSessionId: sessionId });
  expect(turned.status).toBe(200);
  expect(typeof turned.body.openedSessionId).toBe("string");
  expect((await collectingSessions(subjectId)).map((x) => x.id)).toEqual([turned.body.openedSessionId]);
});

test("169: a reactivation after the boundary settled the window opens exactly one fresh epoch", async () => {
  const { subjectId, sessionId } = await opened("deact_react_after");
  expect(await subjectEdit(api, A.subjectDeactivate, subjectId)).toBe(200);
  const turned = await transition(A.epochTurnover, { subjectId, expectedSessionId: sessionId });
  expect(turned.body.openedSessionId).toBeNull();
  expect((await transition(A.epochAggregate, { sessionId })).status).toBe(200);
  expect((await transition(A.epochFinalize, { sessionId })).status).toBe(200);

  // The activation itself opens nothing …
  expect(await subjectEdit(api, A.subjectActivate, subjectId)).toBe(200);
  expect((await collectingSessions(subjectId)).length).toBe(0);
  // … and the scheduler's open, on that activation's subject.changed, opens one.
  const reopened = await transition(A.epochOpen, { subjectId });
  expect(reopened.body).toMatchObject({ created: true });
  expect(reopened.body.sessionId).not.toBe(sessionId);
  expect((await collectingSessions(subjectId)).map((x) => x.id)).toEqual([reopened.body.sessionId]);
});

test("169: no admin or operator path closes the window early — every admin subject edit leaves it collecting", async () => {
  const { subjectId, sessionId } = await opened("deact_no_early");
  // Deactivate, activate, deactivate, and an ordinary update: four admin
  // edits, none of them a close.
  expect(await subjectEdit(api, A.subjectDeactivate, subjectId)).toBe(200);
  expect(await subjectEdit(api, A.subjectActivate, subjectId)).toBe(200);
  expect(await subjectEdit(api, A.subjectDeactivate, subjectId)).toBe(200);
  const upd = await probe(api, "POST", A.subjectUpdate.replace(":id", encodeURIComponent(subjectId)), adminHeaders(OPERATOR), {
    expectedVersion: await version(subjectId),
    epochDuration: 1800,
  });
  expect(upd.status).toBe(200);
  expect(await windowFacts(subjectId, sessionId)).toEqual(RUNS_TO_CLOSE(sessionId));
  // The operator's token is refused on the epoch route that would close it.
  const early = await probe(api, "POST", A.epochTurnover, adminHeaders(OPERATOR), { subjectId, expectedSessionId: sessionId });
  expect(early.status).toBe(403);
  // And the retired session verb that used to close a window answers 410.
  const close = await probe(api, "POST", `/api/swarm/admin/sessions/${sessionId}/close`, adminHeaders(OPERATOR), {});
  expect(close.status).toBe(410);
  expect(await windowFacts(subjectId, sessionId)).toEqual(RUNS_TO_CLOSE(sessionId));
});

test("169 RED CONTROL: with the same-transaction close restored in the admin deactivation, the window no longer runs to its close", async () => {
  // The retired rule: deactivateSubjectAdmin closed the open epoch (captured
  // mode and duration, state `window_closed`) in its own transaction. Put
  // exactly that back inside a real api process and run the first test's
  // checks against it.
  const preload = writeRedControlPreload(
    "/src/swarm/admin.ts",
    '    await audit(actor, "subject_deactivate", { subjectId: id }, tx);',
    "    await tx`UPDATE swarm_sessions SET state = 'window_closed', judge_mode = 'off', " +
      "judging_duration_seconds = 900 WHERE subject_id = ${id} AND state = 'collecting'`;\n" +
      '    await audit(actor, "subject_deactivate", { subjectId: id }, tx);',
  );
  const broken = await bootApi({ env: { RM_ENV: "ephemeral" }, preload });
  try {
    const filer = await activeMember();
    const { subjectId, sessionId, date } = await opened("deact_red");
    expect(await subjectEdit(broken, A.subjectDeactivate, subjectId)).toBe(200);
    expect(await windowFacts(subjectId, sessionId)).not.toEqual(RUNS_TO_CLOSE(sessionId));
    expect((await sessionRow(sessionId)).state).toBe("window_closed");
    // … and the take the window promised is refused.
    const take = await submitTake(filer, date, subjectId);
    expect(take).toMatchObject({ ok: false, status: 409, error: "submission window closed" });
  } finally {
    broken.stop();
  }
}, 90_000);
