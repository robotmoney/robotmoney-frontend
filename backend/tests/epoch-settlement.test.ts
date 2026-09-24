// W4.2 settlement — issue #1026.
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §4.4, plus §10's "Judge
// off", "Deadline", "Eligibility is decided by stored time", "Early finalize",
// "Late consensus after publish" and "Judge of record" gates, D48 (judge mode
// is `off | enforce`) and D53.
//
//   "Judge mode and judging duration are captured at turnover."
//
//   "`enforce`: … The API records the request instant and the absolute
//    deadline (request instant plus the judging duration captured at
//    turnover), moves the session to `judging`, returns the deadline".
//
//   "Finalize is one API call and decides the judging outcome atomically from
//    stored data ... `judged` — a consensus was recorded at or before the
//    deadline; `no_consensus` — no consensus was recorded at or before the
//    deadline; `not_judged` — mode was `off`."
//
//   "Under `enforce`, the API accepts finalize before the deadline only if an
//    eligible consensus is already recorded ... With no eligible consensus it
//    refuses finalize as a reasoned no-op until the deadline has passed by the
//    database clock ... At the exact deadline instant: a consensus recorded
//    *at or before* it is eligible, and finalize is accepted *at or after* it."
//
//   "An eligible judgement is signed by an active member holding the `judge`
//    role that has no take in that session, and it passes the third-party
//    gate … the judge of record is chosen deterministically by member id."
//
//   "Nothing is fabricated: no template opinion, no placeholder certificate,
//    no default verdict."
//
// HOW TIME IS CONTROLLED. The judging duration is a subject column captured on
// the session at turnover, so the capture is asserted against a value the test
// chose. The BOUNDARY cases then move the STORED deadline or acceptance
// instant, which is exactly the fact finalize reads and the only way to test
// an exact instant deterministically.
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import * as epoch from "../src/swarm/domain.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import {
  activeMember,
  activeSubject,
  refusedByDatabase,
  sessionDate,
  sessionRow,
  setJudgeMode,
  submitTake,
} from "./support/epoch-fixtures.ts";
import { inHouseJudge, seatJudge, type TestJudge } from "./support/stub-judge.ts";

// Per TEST: a judge of record is the LOWEST-id eligible judge in the whole
// database, and the eligibility cases below seat extra judges — a judge left
// behind by one test would silently become another test's judge of record.
useCleanDatabasePerTest(import.meta.file);

/** Open an epoch, turn it over, and hand back the CLOSED epoch that now settles. */
async function closedEpoch(prefix: string, mode: "off" | "enforce", judgingSeconds = 900) {
  await setJudgeMode(mode);
  const subjectId = await activeSubject(prefix, 600);
  await sql`UPDATE swarm_subjects SET judging_duration_seconds = ${judgingSeconds} WHERE id = ${subjectId}`;
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error(`openEpoch: ${JSON.stringify(opened)}`);
  const turned = await epoch.turnOverEpoch(subjectId, opened.sessionId);
  if (!turned.ok) throw new Error(`turnOverEpoch: ${JSON.stringify(turned)}`);
  return { subjectId, sessionId: turned.closedSessionId, successorId: turned.openedSessionId };
}

async function setDeadline(sessionId: string, at: Date) {
  await sql`UPDATE swarm_sessions SET judging_deadline_at = ${at} WHERE id = ${sessionId}`;
}

/** A judgement row by `judge` (the session's judge of record unless a test says otherwise). */
async function plantJudgement(sessionId: string, judge?: TestJudge): Promise<number> {
  const by = judge ?? await inHouseJudge();
  const [j] = await sql<{ id: string }[]>`
    INSERT INTO swarm_session_judgements
      (session_id, mode, source, model, prompt_hash, inputs_digest, take_count, min_takes, opinion,
       judged_by, judged_by_member_id)
    VALUES (${sessionId}, 'enforce', 'model', 'test/epoch-fixture-judge', 'ph', 'id', 1, 1, '{"verdict":"ok"}'::jsonb,
            ${by.id}, ${by.id})
    RETURNING id`;
  return Number(j.id);
}

/** Record the judge of record's consensus, then pin its acceptance instant. */
async function recordConsensusAt(sessionId: string, at: Date) {
  const r = await epoch.recordJudgingConsensus(sessionId, await plantJudgement(sessionId));
  await sql`UPDATE swarm_sessions SET consensus_recorded_at = ${at} WHERE id = ${sessionId}`;
  return r;
}

/** Rows in the queue tables — settlement must add none (§4.4: "not scheduled"). */
async function queueRows(): Promise<{ jobs: number; runs: number }> {
  const [row] = await sql<{ jobs: number; runs: number }[]>`
    SELECT (SELECT count(*)::int FROM jobs) AS jobs, (SELECT count(*)::int FROM job_runs) AS runs`;
  return row;
}

// ── judge mode off ──────────────────────────────────────────────────────────

test("judge off: aggregate then finalize publishes not_judged, waits for nothing, and writes no queue row", async () => {
  const before = await queueRows();
  const { sessionId } = await closedEpoch("st_off", "off");
  expect((await sessionRow(sessionId)).judge_mode).toBe("off");

  const agg = await epoch.aggregateEpoch(sessionId);
  expect(agg.ok).toBe(true);
  expect((await sessionRow(sessionId)).state).toBe("aggregated");

  // Nothing requests judging under `off`, and asking is a reasoned refusal.
  const req = await epoch.requestJudging(sessionId);
  expect(req.ok).toBe(false);
  if (!req.ok) expect(req.error).toBe("judge_mode_off");

  // Finalize straight after aggregate: no deadline to wait out.
  const fin = await epoch.finalizeEpoch(sessionId);
  expect(fin.ok).toBe(true);
  if (!fin.ok) return;
  expect(fin.outcome).toBe("not_judged");

  const s = await sessionRow(sessionId);
  expect(s.state).toBe("published");
  expect(s.judging_outcome).toBe("not_judged");
  expect(s.judging_requested_at).toBeNull();
  expect(s.judging_deadline_at).toBeNull();
  expect(s.published_at).not.toBeNull();
  // §4.4: settlement is "a chain the scheduler drives through the API", never
  // a queued job. Asserted on the queue tables themselves, so a zero-delay row
  // cannot smuggle the tick model back in.
  expect(await queueRows()).toEqual(before);
});

// ── judge mode enforce ──────────────────────────────────────────────────────

test("enforce: the deadline is the request instant plus the judging duration CAPTURED AT TURNOVER", async () => {
  const before = await queueRows();
  const { subjectId, sessionId } = await closedEpoch("st_req", "enforce", 240);
  expect((await sessionRow(sessionId)).judging_duration_seconds).toBe(240);
  // An admin changes the subject's judging duration AFTER the epoch closed.
  // §4.4: "affects later sessions, never one already settling."
  await sql`UPDATE swarm_subjects SET judging_duration_seconds = 30 WHERE id = ${subjectId}`;
  await epoch.aggregateEpoch(sessionId);

  const r = await epoch.requestJudging(sessionId);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  // Left in `judging` — the state a judge subscription is served on.
  const s = await sessionRow(sessionId);
  expect(s.state).toBe("judging");
  expect(s.judging_requested_at).not.toBeNull();
  const [row] = await sql<{ exact: boolean }[]>`
    SELECT judging_deadline_at = judging_requested_at + interval '240 seconds' AS exact
      FROM swarm_sessions WHERE id = ${sessionId}`;
  expect(row.exact).toBe(true);
  expect(new Date(r.deadlineAt).getTime()).toBe(new Date(s.judging_deadline_at).getTime());

  // A repeated request returns the ORIGINAL deadline, never a fresh one.
  const again = await epoch.requestJudging(sessionId);
  expect(again.ok).toBe(true);
  if (!again.ok) return;
  expect(again.transitioned).toBe(false);
  expect(again.deadlineAt).toBe(r.deadlineAt);
  expect(await queueRows()).toEqual(before);
});

test("enforce: finalize before the deadline with no eligible consensus is refused with a reason and changes nothing", async () => {
  const { sessionId } = await closedEpoch("st_early", "enforce");
  await epoch.aggregateEpoch(sessionId);
  await epoch.requestJudging(sessionId);
  const before = await sessionRow(sessionId);

  const r = await epoch.finalizeEpoch(sessionId);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toBe("judging_deadline_not_reached");

  const s = await sessionRow(sessionId);
  expect(s).toEqual(before);
});

test("enforce: finalize before the deadline WITH an eligible consensus publishes judged at once", async () => {
  const { sessionId } = await closedEpoch("st_early_ok", "enforce");
  await epoch.aggregateEpoch(sessionId);
  await epoch.requestJudging(sessionId);
  const recorded = await epoch.recordJudgingConsensus(sessionId, await plantJudgement(sessionId));
  expect(recorded.ok).toBe(true);
  expect((await sessionRow(sessionId)).state).toBe("judged");

  const r = await epoch.finalizeEpoch(sessionId);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.outcome).toBe("judged");
  expect((await sessionRow(sessionId)).state).toBe("published");
});

test("enforce: a consensus recorded at the EXACT deadline instant is eligible, and finalize is accepted at it", async () => {
  const { sessionId } = await closedEpoch("st_exact", "enforce");
  await epoch.aggregateEpoch(sessionId);
  await epoch.requestJudging(sessionId);
  // The instant has passed by the database clock, so finalize is accepted "at
  // or after" it; the consensus lands exactly ON it, so it is eligible.
  const instant = new Date(Date.now() - 1000);
  await setDeadline(sessionId, instant);
  await recordConsensusAt(sessionId, instant);

  const r = await epoch.finalizeEpoch(sessionId);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.outcome).toBe("judged");
});

test("enforce: after the deadline with no consensus, no_consensus publishes and EVERY row written is inspected", async () => {
  // §10 "Deadline": "published as `no_consensus` with no certificate and no
  // fabricated content, asserted by inspecting every row the settlement
  // wrote." The session row is diffed column by column across finalize, and
  // every table that could carry a verdict, a certificate or a queued step is
  // counted.
  const { sessionId } = await closedEpoch("st_none", "enforce");
  await epoch.aggregateEpoch(sessionId);
  await epoch.requestJudging(sessionId);
  await setDeadline(sessionId, new Date(Date.now() - 1000));

  const beforeRow = await sessionRow(sessionId);
  const counts = async () => (await sql<Record<string, number>[]>`
    SELECT (SELECT count(*)::int FROM swarm_consensus_receipts WHERE session_id = ${sessionId}) AS receipts,
           (SELECT count(*)::int FROM swarm_session_judgements WHERE session_id = ${sessionId}) AS judgements,
           (SELECT count(*)::int FROM swarm_recommendations WHERE session_id = ${sessionId}) AS takes,
           (SELECT count(*)::int FROM swarm_brief_revisions WHERE session_id = ${sessionId}) AS brief_revisions,
           (SELECT count(*)::int FROM swarm_session_events WHERE session_id = ${sessionId}) AS session_events,
           (SELECT count(*)::int FROM swarm_stream_events WHERE session_id = ${sessionId}) AS stream_events,
           (SELECT count(*)::int FROM jobs) AS jobs,
           (SELECT count(*)::int FROM job_runs) AS job_runs`)[0];
  const beforeCounts = await counts();

  const r = await epoch.finalizeEpoch(sessionId);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.outcome).toBe("no_consensus");

  // Nothing new anywhere: no certificate, no judgement, no placeholder row.
  expect(await counts()).toEqual(beforeCounts);
  expect(beforeCounts.receipts).toBe(0);
  expect(beforeCounts.judgements).toBe(0);

  // The session row: ONLY the publish columns moved. The aggregate — the
  // rollup and its prose — is published unchanged, with no judge block.
  const s = await sessionRow(sessionId);
  const changed = Object.keys(s).filter((k) => JSON.stringify(s[k]) !== JSON.stringify(beforeRow[k])).sort();
  expect(changed).toEqual(["judging_outcome", "published_at", "state", "version"]);
  expect(s.state).toBe("published");
  expect(s.judging_outcome).toBe("no_consensus");
  expect(s.consensus_recorded_at).toBeNull();
  expect(s.swarm_recommendation).not.toBeNull();
  expect((s.swarm_recommendation as Record<string, unknown>).judge).toBeUndefined();
});

test("a consensus recorded AFTER the deadline but before finalize is retained and yields no_consensus", async () => {
  const { sessionId } = await closedEpoch("st_late", "enforce");
  await epoch.aggregateEpoch(sessionId);
  await epoch.requestJudging(sessionId);
  const deadline = new Date(Date.now() - 60_000);
  await setDeadline(sessionId, deadline);
  await recordConsensusAt(sessionId, new Date(deadline.getTime() + 1000));

  const r = await epoch.finalizeEpoch(sessionId);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.outcome).toBe("no_consensus");
  // Kept as a record, and no certificate published from it.
  expect((await sessionRow(sessionId)).consensus_recorded_at).not.toBeNull();
  expect((await sql`SELECT 1 FROM swarm_session_judgements WHERE session_id = ${sessionId}`).length).toBe(1);
  expect((await sql`SELECT 1 FROM swarm_consensus_receipts WHERE session_id = ${sessionId}`).length).toBe(0);
});

test("the consensus acceptance instant is the database clock at the write, never the transaction's start", async () => {
  // §4.2: the instant compared against the deadline is `clock_timestamp()`. A
  // consensus whose transaction began before the deadline and reached the
  // write after it was ACCEPTED after it, and yields no_consensus.
  const { sessionId } = await closedEpoch("st_consensus_clock", "enforce");
  await epoch.aggregateEpoch(sessionId);
  await epoch.requestJudging(sessionId);
  await sql`UPDATE swarm_sessions SET judging_deadline_at = clock_timestamp() + interval '300 milliseconds'
             WHERE id = ${sessionId}`;
  const judgementId = await plantJudgement(sessionId);
  const recorded = await sql.begin(async (tx) => {
    await tx`SELECT 1`;
    await tx`SELECT pg_sleep(0.5)`;
    return epoch.recordJudgingConsensusTx(tx, sessionId, judgementId);
  });
  expect(recorded.ok).toBe(true);
  const [row] = await sql<{ late: boolean }[]>`
    SELECT consensus_recorded_at > judging_deadline_at AS late FROM swarm_sessions WHERE id = ${sessionId}`;
  expect(row.late).toBe(true);
  const fin = await epoch.finalizeEpoch(sessionId);
  expect(fin.ok).toBe(true);
  if (fin.ok) expect(fin.outcome).toBe("no_consensus");
});

// ── the judge of record ─────────────────────────────────────────────────────

test("only the judge of record's judgement can become the consensus: every other author is refused and changes nothing", async () => {
  // §4.4: "An eligible judgement is signed by an active member holding the
  // `judge` role that has no take in that session, and it passes the
  // third-party gate … chosen deterministically by member id." The same
  // eligibility `submitJudgement` applies, enforced where the consensus is
  // recorded, so no caller can record one the product would refuse.
  const { sessionId } = await closedEpoch("st_of_record", "enforce");
  // Two in-house judges: the judge of record is the LOWER id, whichever
  // answers first.
  const a = await seatJudge({ prefix: "judge_a" });
  const b = await seatJudge({ prefix: "judge_b" });
  const [ofRecord, other] = a.id < b.id ? [a, b] : [b, a];
  // A third-party judge (no in-house operator) while third-party judging is off.
  const thirdParty = await seatJudge({ prefix: "judge_0_third", operator: "someone-else" });
  // A judge that is NOT active.
  const inactive = await seatJudge({ prefix: "judge_0_inactive" });
  await sql`UPDATE swarm_members SET status = 'inactive' WHERE id = ${inactive.id}`;
  await epoch.aggregateEpoch(sessionId);
  await epoch.requestJudging(sessionId);

  // The non-record judge answers FIRST: recorded as evidence, never the consensus.
  for (const author of [other, thirdParty, inactive]) {
    const r = await epoch.recordJudgingConsensus(sessionId, await plantJudgement(sessionId, author));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("judgement_not_from_judge_of_record");
  }
  // A row naming no member at all (the retired in-house shape) is refused too.
  const [anonymous] = await sql<{ id: string }[]>`
    INSERT INTO swarm_session_judgements
      (session_id, mode, source, model, prompt_hash, inputs_digest, take_count, min_takes, opinion)
    VALUES (${sessionId}, 'enforce', 'model', 'test/x', 'ph', 'id', 1, 1, '{"verdict":"ok"}'::jsonb)
    RETURNING id`;
  const anon = await epoch.recordJudgingConsensus(sessionId, Number(anonymous.id));
  expect(anon.ok).toBe(false);
  let s = await sessionRow(sessionId);
  expect(s.state).toBe("judging");
  expect(s.consensus_recorded_at).toBeNull();

  // The judge of record's own judgement is the consensus.
  const r = await epoch.recordJudgingConsensus(sessionId, await plantJudgement(sessionId, ofRecord));
  expect(r.ok).toBe(true);
  s = await sessionRow(sessionId);
  expect(s.state).toBe("judged");
});

test("a judge that holds a take in the session is not eligible, and the next judge by id becomes the judge of record", async () => {
  const { subjectId, sessionId } = await closedEpoch("st_judge_take", "enforce");
  const low = await seatJudge({ prefix: "judge_a_low" });
  const high = await seatJudge({ prefix: "judge_z_high" });
  // A take on file for the low judge in THIS session (planted: the take path
  // refuses judges outright, so this is the state a role change after the take
  // leaves behind).
  const date = sessionDate(await sessionRow(sessionId));
  await sql`INSERT INTO swarm_recommendations
              (session_id, member_id, subject_id, date, nonce, stance, confidence, payload, signature, verified, revision)
            VALUES (${sessionId}, ${low.id}, ${subjectId}, ${date}, ${`n_${crypto.randomUUID()}`}, 'neutral', 0.5,
                    '{}'::jsonb, 'sig', true, 1)`;
  await epoch.aggregateEpoch(sessionId);
  await epoch.requestJudging(sessionId);

  const refused = await epoch.recordJudgingConsensus(sessionId, await plantJudgement(sessionId, low));
  expect(refused.ok).toBe(false);
  const accepted = await epoch.recordJudgingConsensus(sessionId, await plantJudgement(sessionId, high));
  expect(accepted.ok).toBe(true);
});

// ── outcomes are decided once, from stored facts ────────────────────────────

test("a repeated finalize returns the outcome already decided and never re-decides", async () => {
  const { sessionId } = await closedEpoch("st_repeat", "enforce");
  await epoch.aggregateEpoch(sessionId);
  await epoch.requestJudging(sessionId);
  await setDeadline(sessionId, new Date(Date.now() - 1000));

  const first = await epoch.finalizeEpoch(sessionId);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.outcome).toBe("no_consensus");
  const publishedAt = (await sessionRow(sessionId)).published_at;

  // A consensus arriving after publication must not change the answer.
  await recordConsensusAt(sessionId, new Date(Date.now() - 5000));
  const second = await epoch.finalizeEpoch(sessionId);
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.outcome).toBe("no_consensus");
  expect(second.replayed).toBe(true);
  const s = await sessionRow(sessionId);
  expect(s.state).toBe("published");
  expect(String(s.published_at)).toBe(String(publishedAt));
});

test("a LOST session.judged changes no outcome: finalize on the deadline alone reads the stored consensus", async () => {
  // §4.4: "A late event, a duplicate event, or a lost event changes no
  // outcome: the scheduler finalizes on the deadline instead, and finalize
  // reads the same stored facts." Nothing here reads the event: the consensus
  // was recorded before the deadline, the scheduler never heard, the deadline
  // fired, and finalize says `judged`.
  const { sessionId } = await closedEpoch("st_lost_event", "enforce");
  await epoch.aggregateEpoch(sessionId);
  await epoch.requestJudging(sessionId);
  const deadline = new Date(Date.now() - 1000);
  await setDeadline(sessionId, deadline);
  await recordConsensusAt(sessionId, new Date(deadline.getTime() - 5000));
  const r = await epoch.finalizeEpoch(sessionId);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.outcome).toBe("judged");
});

test("a DUPLICATED session.judged changes no outcome: the second finalize it triggers replays the first", async () => {
  const { sessionId } = await closedEpoch("st_dup_event", "enforce");
  await epoch.aggregateEpoch(sessionId);
  await epoch.requestJudging(sessionId);
  const recorded = await epoch.recordJudgingConsensus(sessionId, await plantJudgement(sessionId));
  expect(recorded.ok).toBe(true);
  // The same consensus delivered twice: the second is the original result,
  // and writes no second event.
  const head = await epoch.streamHeadSequence();
  const [{ id: firstJudgement }] = await sql<{ id: string }[]>`
    SELECT id FROM swarm_session_judgements WHERE session_id = ${sessionId} ORDER BY id LIMIT 1`;
  const again = await epoch.recordJudgingConsensus(sessionId, Number(firstJudgement));
  expect(again.ok).toBe(true);
  expect(await epoch.streamHeadSequence()).toBe(head);

  const [a, b] = [await epoch.finalizeEpoch(sessionId), await epoch.finalizeEpoch(sessionId)];
  expect(a.ok && b.ok).toBe(true);
  if (!a.ok || !b.ok) return;
  expect([a.outcome, b.outcome]).toEqual(["judged", "judged"]);
  expect([a.replayed, b.replayed]).toEqual([false, true]);
});

test("a consensus arriving after publication is recorded as late evidence and changes neither state nor outcome", async () => {
  const { sessionId } = await closedEpoch("st_after_publish", "enforce");
  await epoch.aggregateEpoch(sessionId);
  await epoch.requestJudging(sessionId);
  await setDeadline(sessionId, new Date(Date.now() - 1000));
  await epoch.finalizeEpoch(sessionId);
  expect((await sessionRow(sessionId)).state).toBe("published");

  const late = await epoch.recordJudgingConsensus(sessionId, await plantJudgement(sessionId));
  expect(late.ok).toBe(true);
  if (!late.ok) return;
  expect(late.lateEvidence).toBe(true);
  const s = await sessionRow(sessionId);
  expect(s.state).toBe("published");
  expect(s.judging_outcome).toBe("no_consensus");
  expect((await sql`SELECT 1 FROM swarm_session_judgements WHERE session_id = ${sessionId}`).length).toBe(1);
});

test("no_consensus and not_judged are OUTCOMES, never lifecycle states: the database refuses them as a state", async () => {
  // §4.4: "`no_consensus` and `not_judged` are outcomes only and never
  // lifecycle states." Migration 0068's state CHECK is what makes that a
  // fact rather than a convention.
  const { sessionId } = await closedEpoch("st_states", "enforce");
  for (const bad of ["no_consensus", "not_judged"]) {
    await refusedByDatabase(() => sql`UPDATE swarm_sessions SET state = ${bad} WHERE id = ${sessionId}`);
  }
  expect((await sessionRow(sessionId)).state).toBe("window_closed");
});

// ── settlement of N and the window of N+1 are independent ───────────────────

test("a take is accepted into N+1 while N is judging", async () => {
  // §4.4: "Settlement of session N and the open window of N+1 are
  // independent: nothing about N blocks submissions to N+1."
  const { subjectId, sessionId, successorId } = await closedEpoch("st_n_plus_one", "enforce");
  await epoch.aggregateEpoch(sessionId);
  await epoch.requestJudging(sessionId);
  expect((await sessionRow(sessionId)).state).toBe("judging");

  const m = await activeMember();
  const date = sessionDate(await sessionRow(successorId));
  const r = await submitTake(m, date, subjectId);
  expect(r.ok).toBe(true);
  expect((await sql`SELECT 1 FROM swarm_recommendations WHERE session_id = ${successorId}`).length).toBe(1);
  expect((await sql`SELECT 1 FROM swarm_recommendations WHERE session_id = ${sessionId}`).length).toBe(0);
  expect((await sessionRow(sessionId)).state).toBe("judging");
});

// ── the state guard ─────────────────────────────────────────────────────────

test("every settlement step refuses out of order, with a reason", async () => {
  const { sessionId } = await closedEpoch("st_guard", "enforce");

  // Judging cannot be requested before the rollup exists.
  const early = await epoch.requestJudging(sessionId);
  expect(early.ok).toBe(false);
  if (!early.ok) expect(early.error).toBe("session_not_aggregated");

  // Nor can a session be finalized before judging was requested.
  const preFinalize = await epoch.finalizeEpoch(sessionId);
  expect(preFinalize.ok).toBe(false);

  await epoch.aggregateEpoch(sessionId);
  // A repeated aggregate is idempotent, not an error.
  const again = await epoch.aggregateEpoch(sessionId);
  expect(again.ok).toBe(true);
  if (again.ok) expect(again.transitioned).toBe(false);
});
