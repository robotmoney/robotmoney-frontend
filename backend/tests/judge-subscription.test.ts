// W4.7 — the judge subscription (issue #1026).
//
// AUTHORITY: docs/technical/smoke-production-spec.md §6.2, verbatim:
//
//   "Judges subscribe. A judge holds an authenticated stream to the API and
//    receives judging requests created by the scheduler's request-judging
//    transition (scheduler spec §4.4). The request is state, not a fleeting
//    event: on every connect or reconnect the API serves every session in
//    `judging` for which this judge has not yet submitted, so a judge that was
//    down when the request was created still obtains it if it returns before
//    the deadline. ... Redelivery can never change an outcome: a submission
//    after finalize is recorded as late evidence. The deadline and finalization
//    belong to the scheduler, never to the judge, so an absent judge delays
//    nothing and yields `no_consensus`."
//
// THIS IS A DIFFERENT CONTRACT FROM THE SCHEDULER'S STREAM, deliberately, and
// the difference is the first thing this file asserts. The scheduler's stream
// (backend/tests/api-event-stream.test.ts) is a cursor, a sequence and a gap.
// This one has none of those three. It carries STATE: what is outstanding for
// this judge right now, recomputed on every connect. A judge that missed the
// moment its work was created has lost nothing, because there was no moment to
// miss — which is precisely why reusing the sequence machinery here would be
// the wrong answer rather than a saving.
//
// NOTHING IS FABRICATED anywhere in this file. There is no fallback judgement,
// no template opinion and no default verdict; the absent-judge test asserts
// that the session publishes `no_consensus` with nothing invented in its place.
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import * as epoch from "../src/swarm/domain.ts";
import * as judge from "../src/swarm/domain.ts";
import { inputsDigest } from "../src/swarm/judge.ts";
import { handleJudgeParticipant } from "../src/api/routes/swarm-judge-participant.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import {
  activeSubject, activeMember, sessionDate, setJudgeMode, sessionRow, submitTake, type TestMember,
} from "./support/epoch-fixtures.ts";
import { seatJudge, signedJudgement, STUB_JUDGE_REPLY, type TestJudge } from "./support/stub-judge.ts";

useCleanDatabase(import.meta.file);

/** What a judge's model answered — the raw text a participant submits. */
const OPINION = STUB_JUDGE_REPLY;

/** A SIGNED submission, built exactly as judge-client.ts builds one. */
const submission = (j: TestJudge, sessionId: string) => signedJudgement(j, sessionId, OPINION);

// THREE PARTICIPANTS FOR THE WHOLE FILE, memoized.
//
// Not fastidiousness: the roster has a hard cap (SWARM_ROSTER_CAP) and a
// per-test member exhausts it halfway through the file. Reuse is safe here
// because every test builds its OWN session, and the pending set is keyed by
// (session, judge) — so two tests sharing a judge cannot see each other's work
// unless the filter is broken, which is itself worth catching.
let judgeA: TestJudge | null = null;
let judgeB: TestJudge | null = null;
let plain: TestMember | null = null;
let author: TestMember | null = null;

/**
 * An in-house participant with `role = judge` — the credential the
 * subscription authenticates. Judge A's id sorts before judge B's, so A is the
 * judge of record whenever both are seated (scheduler spec §4.4: chosen by
 * member id, never by arrival).
 */
async function activeJudge(which: "a" | "b" = "a"): Promise<TestJudge> {
  const cached = which === "a" ? judgeA : judgeB;
  if (cached) return cached;
  const j = await seatJudge({ prefix: which === "a" ? "judge_a" : "judge_b" });
  if (which === "a") judgeA = j;
  else judgeB = j;
  return j;
}

/** A seated member with no judge role. */
async function activePlainMember(): Promise<TestMember> {
  if (!plain) plain = await activeMember();
  return plain;
}

/**
 * A session parked in `judging` with its stored deadline, exactly as §4.4
 * leaves it — carrying one signed take, because a session with nothing in it
 * is refused as `nothing_to_judge`.
 */
async function judgingSession(prefix: string): Promise<{ sessionId: string; deadlineAt: string }> {
  await setJudgeMode("enforce");
  // The author exists BEFORE the epoch opens, so the epoch seats it: the
  // roster is fixed at open, and a member activated afterwards is refused.
  author ??= await activeMember();
  const subjectId = await activeSubject(prefix, 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const took = await submitTake(author, sessionDate(await sessionRow(opened.sessionId)), subjectId, { body: `a take on ${prefix}` });
  if (took.status !== 201) throw new Error(`submitTake failed: ${JSON.stringify(took)}`);
  const turned = await epoch.turnOverEpoch(subjectId, opened.sessionId);
  if (!turned.ok) throw new Error("turnOverEpoch failed");
  await epoch.aggregateEpoch(turned.closedSessionId);
  const requested = await epoch.requestJudging(turned.closedSessionId);
  if (!requested.ok) throw new Error("requestJudging failed");
  return { sessionId: turned.closedSessionId, deadlineAt: requested.deadlineAt };
}

/** Move a stored deadline into the past. The instant is the API's fact; only a test may move it. */
async function expireDeadline(sessionId: string): Promise<void> {
  await sql`UPDATE swarm_sessions SET judging_deadline_at = now() - interval '1 second' WHERE id = ${sessionId}`;
}

async function readFrames(res: Response, want: number, budgetMs = 5000) {
  const frames: { type: string; data: any }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + budgetMs;
  let buffer = "";
  try {
    while (frames.length < want && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const type = /^event: (.+)$/m.exec(raw)?.[1];
        const data = /^data: (.+)$/m.exec(raw)?.[1];
        if (type && data) frames.push({ type, data: JSON.parse(data) });
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

// ─────────────────────────────────────────────────────────────────────────────
// The request is STATE
// ─────────────────────────────────────────────────────────────────────────────

test("a judge is served every judging session it has not submitted", async () => {
  const j = await activeJudge();
  const a = await judgingSession("js_a");
  const b = await judgingSession("js_b");

  const pending = await judge.pendingJudgingFor(j.id);
  const ids = pending.map((p) => p.sessionId);
  expect(ids).toContain(a.sessionId);
  expect(ids).toContain(b.sessionId);
  expect(pending.find((p) => p.sessionId === a.sessionId)!.judgingDeadlineAt).toBe(a.deadlineAt);
});

test("each request carries the frozen input the judge is to read — the object the API digests at submission", async () => {
  const j = await activeJudge();
  const { sessionId } = await judgingSession("js_input");
  const served = (await judge.pendingJudgingFor(j.id)).find((p) => p.sessionId === sessionId)!;
  expect(served.input.sessionId).toBe(sessionId);
  expect(served.input.takes.map((t) => t.body)).toEqual(["a take on js_input"]);
  // The digest the judge signs over what it was served is the one the API
  // recomputes from the frozen take set: a submission signed over it lands.
  const signed = await signedJudgement(j, sessionId, OPINION, { inputsDigest: inputsDigest(served.input) });
  expect((await judge.submitJudgement(j.token, signed)).ok).toBe(true);
});

test("a session this judge has a TAKE in is not its work, and is never served to it", async () => {
  // Scheduler spec §4.4: an eligible judgement is signed by a judge "that has
  // no take in that session". The author's own member row is made a judge
  // here to prove the filter is the take, not the role.
  const { sessionId } = await judgingSession("js_own_take");
  await sql`UPDATE swarm_members SET role = 'judge' WHERE id = ${author!.id}`;
  try {
    expect((await judge.pendingJudgingFor(author!.id)).map((p) => p.sessionId)).not.toContain(sessionId);
  } finally {
    await sql`UPDATE swarm_members SET role = 'member' WHERE id = ${author!.id}`;
  }
});

test("a judge that was DOWN when the request was created gets it when it returns", async () => {
  // The whole point of state over event: the request existed before this judge
  // ever connected, and there is no replay buffer, no cursor and no missed
  // frame — the connect recomputes.
  const { sessionId } = await judgingSession("js_down");
  const j = await activeJudge();
  expect((await judge.pendingJudgingFor(j.id)).map((p) => p.sessionId)).toContain(sessionId);
});

test("the same work is served AGAIN on a reconnect, until this judge submits", async () => {
  const j = await activeJudge();
  const { sessionId } = await judgingSession("js_reconnect");

  const first = await readFrames(judge.openJudgeStream(j.id, { keepaliveMs: 5000, refreshMs: 20 }), 1);
  expect(first[0].type).toBe("pending");
  expect(first[0].data.pending.map((p: any) => p.sessionId)).toContain(sessionId);

  // Disconnected and back. Nothing was retained on the server's side for this
  // judge, and nothing needed to be.
  const second = await readFrames(judge.openJudgeStream(j.id, { keepaliveMs: 5000, refreshMs: 20 }), 1);
  expect(second[0].type).toBe("pending");
  expect(second[0].data.pending.map((p: any) => p.sessionId)).toContain(sessionId);
});

test("once this judge has submitted, the session is no longer served to it", async () => {
  const j = await activeJudge();
  const { sessionId } = await judgingSession("js_submitted");
  const done = await judge.submitJudgement(j.token, await submission(j, sessionId));
  expect(done.ok).toBe(true);
  expect((await judge.pendingJudgingFor(j.id)).map((p) => p.sessionId)).not.toContain(sessionId);
});

test("the pending filter is per judge: one judge's judgement is not another's", async () => {
  // THE ROW IS PLANTED, and the reason is worth stating because it looks like a
  // shortcut and is not. A real `submitJudgement` by judge A on a session in
  // `judging` also RECORDS THE CONSENSUS, which moves the session to `judged`
  // and takes it out of everyone's pending set — correctly, per §4.4. So a
  // two-judge submission cannot isolate the property under test. What is under
  // test is the filter's scope: it excludes a session because THIS judge has a
  // judgement on it, never because some judge does. A filter keyed on the
  // session alone would silence every other judge the moment one answered.
  const a = await activeJudge("a");
  const b = await activeJudge("b");
  const { sessionId } = await judgingSession("js_two_judges");
  await sql`
    INSERT INTO swarm_session_judgements
      (session_id, mode, source, model, prompt_hash, inputs_digest, take_count, min_takes, opinion,
       judged_by, judged_by_member_id)
    VALUES (${sessionId}, 'enforce', 'model', 'test/participant-judge', 'ph', 'id', 1, 1,
            ${sql.json(JSON.parse(OPINION))}, ${a.id}, ${a.id})`;
  expect((await judge.pendingJudgingFor(a.id)).map((p) => p.sessionId)).not.toContain(sessionId);
  expect((await judge.pendingJudgingFor(b.id)).map((p) => p.sessionId)).toContain(sessionId);
  expect((await sessionRow(sessionId)).state).toBe("judging");
});

test("a session that is not in judging is served to nobody", async () => {
  const j = await activeJudge();
  await setJudgeMode("enforce");
  const subjectId = await activeSubject("js_collecting", 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  expect((await judge.pendingJudgingFor(j.id)).map((p) => p.sessionId)).not.toContain(opened.sessionId);
});

test("the subscription carries no cursor and no sequence — it is state, not the scheduler's stream", async () => {
  const j = await activeJudge();
  await judgingSession("js_no_cursor");
  const frames = await readFrames(judge.openJudgeStream(j.id, { keepaliveMs: 5000, refreshMs: 20 }), 1);
  expect(frames[0].data.cursor).toBeUndefined();
  expect(frames[0].data.seq).toBeUndefined();
  expect(frames[0].data.pending[0].seq).toBeUndefined();
});

// ─────────────────────────────────────────────────────────────────────────────
// The submission route
// ─────────────────────────────────────────────────────────────────────────────

test("a submission is authenticated by the judge's own participant credential", async () => {
  const j = await activeJudge();
  const { sessionId } = await judgingSession("js_auth");
  const refused = await judge.submitJudgement("not-a-token", await submission(j, sessionId));
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.status).toBe(401);
  // Nothing was written by the refused call.
  expect((await sessionRow(sessionId)).state).toBe("judging");

  const ok = await judge.submitJudgement(j.token, await submission(j, sessionId));
  expect(ok.ok).toBe(true);
});

test("a member that is not a judge cannot submit a judgement", async () => {
  const notAJudge = await activePlainMember();
  const j = await activeJudge();
  const { sessionId } = await judgingSession("js_role");
  // Even carrying a judge's valid signature, a bearer without the role is refused.
  const refused = await judge.submitJudgement(notAJudge.token, await submission(j, sessionId));
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.error).toBe("judge_role_required");
});

test("the submission records the consensus with its acceptance instant", async () => {
  const j = await activeJudge();
  const { sessionId } = await judgingSession("js_instant");
  const before = Date.now();
  const ok = await judge.submitJudgement(j.token, await submission(j, sessionId));
  expect(ok.ok).toBe(true);
  if (!ok.ok) return;

  const row = await sessionRow(sessionId);
  expect(row.state).toBe("judged");
  expect(row.consensus_recorded_at).not.toBeNull();
  const recorded = new Date(row.consensus_recorded_at).getTime();
  expect(recorded).toBeGreaterThanOrEqual(before - 1000);
  expect(ok.recordedAt).toBe(new Date(row.consensus_recorded_at).toISOString());

  // Wired to part 1's transition rather than duplicating it: the judgement row
  // this route wrote is the one the consensus points at, and the `session.judged`
  // event exists because `recordJudgingConsensus` wrote it in its own
  // transaction.
  const [judgement] = await sql<{ judged_by_member_id: string }[]>`
    SELECT judged_by_member_id FROM swarm_session_judgements WHERE id = ${ok.judgementId}`;
  expect(judgement.judged_by_member_id).toBe(j.id);
  const [event] = await sql<{ payload: any }[]>`
    SELECT payload FROM swarm_stream_events WHERE session_id = ${sessionId} AND kind = 'session.judged'`;
  expect(event.payload.judgementId).toBe(ok.judgementId);
});

test("nothing is fabricated: the stored judgement is the judge's own opinion, with no fallback source", async () => {
  const j = await activeJudge();
  const { sessionId } = await judgingSession("js_no_fallback");
  const ok = await judge.submitJudgement(j.token, await submission(j, sessionId));
  expect(ok.ok).toBe(true);
  if (!ok.ok) return;
  const [row] = await sql<{ source: string; fallback_reason: string | null; opinion: any }[]>`
    SELECT source, fallback_reason, opinion FROM swarm_session_judgements WHERE id = ${ok.judgementId}`;
  expect(row.source).toBe("model");
  expect(row.fallback_reason).toBeNull();
  // The judge's own words, parsed by the API — plus the thin-support arithmetic
  // the parser owns (one take against the default minimum of three), and
  // nothing else.
  const said = JSON.parse(OPINION);
  expect(row.opinion.rationale).toBe(said.rationale);
  expect(row.opinion.disagreements).toEqual(said.disagreements);
  expect(row.opinion.release_safety).toMatchObject({ take_count: 1, thinly_supported: true, release: "hold" });
});

test("a submission with no opinion is refused rather than filled in", async () => {
  const j = await activeJudge();
  const { sessionId } = await judgingSession("js_empty");
  const refused = await judge.submitJudgement(j.token, { ...await submission(j, sessionId), opinion: undefined as any });
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.status).toBe(400);
  expect((await sessionRow(sessionId)).state).toBe("judging");
});

// ─────────────────────────────────────────────────────────────────────────────
// Redelivery never changes a finalized outcome
// ─────────────────────────────────────────────────────────────────────────────

test("a redelivered submission from the same judge changes nothing", async () => {
  const j = await activeJudge();
  const { sessionId } = await judgingSession("js_redeliver");
  const first = await judge.submitJudgement(j.token, await submission(j, sessionId));
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const recorded = (await sessionRow(sessionId)).consensus_recorded_at;

  const again = await judge.submitJudgement(j.token, await submission(j, sessionId));
  expect(again.ok).toBe(true);
  if (!again.ok) return;
  expect(again.duplicate).toBe(true);
  expect(again.judgementId).toBe(first.judgementId);
  expect(new Date((await sessionRow(sessionId)).consensus_recorded_at).getTime()).toBe(new Date(recorded).getTime());
});

test("a submission after finalize is late evidence only", async () => {
  const j = await activeJudge("a");
  const late = await activeJudge("b");
  const { sessionId } = await judgingSession("js_late");
  await expireDeadline(sessionId);
  const finalized = await epoch.finalizeEpoch(sessionId);
  expect(finalized.ok).toBe(true);
  if (!finalized.ok) return;
  expect(finalized.outcome).toBe("no_consensus");

  const after = await judge.submitJudgement(late.token, await submission(late, sessionId));
  expect(after.ok).toBe(true);
  if (!after.ok) return;
  expect(after.lateEvidence).toBe(true);

  const row = await sessionRow(sessionId);
  expect(row.state).toBe("published");
  expect(row.judging_outcome).toBe("no_consensus");
  expect(row.consensus_recorded_at).toBeNull();
  // The evidence is kept — a refused submission would lose a real judgement.
  expect(
    (await sql<{ n: string }[]>`SELECT count(*) AS n FROM swarm_session_judgements WHERE session_id = ${sessionId}`)[0].n,
  ).toBe("1");
  expect((await judge.pendingJudgingFor(j.id)).map((p) => p.sessionId)).not.toContain(sessionId);
});

// ─────────────────────────────────────────────────────────────────────────────
// An absent judge delays nothing
// ─────────────────────────────────────────────────────────────────────────────

test("with no judge connected at all, the session still publishes no_consensus at its deadline", async () => {
  const { sessionId } = await judgingSession("js_absent");
  await expireDeadline(sessionId);
  const finalized = await epoch.finalizeEpoch(sessionId);
  expect(finalized.ok).toBe(true);
  if (!finalized.ok) return;
  expect(finalized.outcome).toBe("no_consensus");

  // Nothing invented in the judge's place, asserted over every row the
  // settlement could have written rather than over one column.
  const [judgements] = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM swarm_session_judgements WHERE session_id = ${sessionId}`;
  expect(judgements.n).toBe("0");
  const [receipts] = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM swarm_consensus_receipts WHERE session_id = ${sessionId}`;
  expect(receipts.n).toBe("0");
  const row = await sessionRow(sessionId);
  expect(row.consensus_recorded_at).toBeNull();
  expect(row.state).toBe("published");
});

test("an unconnected judge holds up no other session", async () => {
  const j = await activeJudge();
  const absent = await judgingSession("js_isolation_absent");
  const answered = await judgingSession("js_isolation_answered");
  await judge.submitJudgement(j.token, await submission(j, answered.sessionId));
  expect((await sessionRow(answered.sessionId)).state).toBe("judged");
  expect((await sessionRow(absent.sessionId)).state).toBe("judging");
});

// ─────────────────────────────────────────────────────────────────────────────
// The routes
// ─────────────────────────────────────────────────────────────────────────────

const url = (p: string) => new URL(`http://test${p}`);

test("the subscribe route authenticates the judge's bearer and streams its state", async () => {
  const j = await activeJudge();
  const { sessionId } = await judgingSession("js_route_sub");
  const res = await handleJudgeParticipant(
    new Request("http://test/api/swarm/participants/judge/subscribe", {
      headers: { Authorization: `Bearer ${j.token}` },
    }),
    url("/api/swarm/participants/judge/subscribe"),
  );
  expect(res).toBeInstanceOf(Response);
  expect((res as Response).headers.get("Content-Type")).toBe("text/event-stream");
  const frames = await readFrames(res as Response, 1);
  expect(frames[0].type).toBe("pending");
  expect(frames[0].data.pending.map((p: any) => p.sessionId)).toContain(sessionId);
});

test("the subscribe route refuses a missing or unknown bearer, and a non-judge member", async () => {
  const anon = await handleJudgeParticipant(
    new Request("http://test/api/swarm/participants/judge/subscribe"),
    url("/api/swarm/participants/judge/subscribe"),
  );
  expect((anon as { status: number }).status).toBe(401);

  const member = await activePlainMember();
  const wrongRole = await handleJudgeParticipant(
    new Request("http://test/api/swarm/participants/judge/subscribe", {
      headers: { Authorization: `Bearer ${member.token}` },
    }),
    url("/api/swarm/participants/judge/subscribe"),
  );
  expect((wrongRole as { status: number }).status).toBe(403);
});

test("the submission route posts a judgement under the judge's credential", async () => {
  const j = await activeJudge();
  const { sessionId } = await judgingSession("js_route_submit");
  const res = (await handleJudgeParticipant(
    new Request("http://test/api/swarm/participants/judgement", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${j.token}` },
      body: JSON.stringify(await submission(j, sessionId)),
    }),
    url("/api/swarm/participants/judgement"),
  )) as { status: number; body: any };
  expect(res.status).toBe(200);
  expect(res.body.sessionId).toBe(sessionId);
  expect((await sessionRow(sessionId)).state).toBe("judged");
});

test("the judge routes own only their own paths", async () => {
  expect(await handleJudgeParticipant(new Request("http://test/api/swarm/members"), url("/api/swarm/members"))).toBeNull();
});
