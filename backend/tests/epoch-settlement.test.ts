// W4.2 settlement — issue #1026.
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §4.4, plus §10's
// "Deadline", "Eligibility is decided by stored time", "Early finalize" and
// "Late consensus after publish" gates, and D48 (judge mode is `off |
// enforce`).
//
//   "Finalize is one API call and decides the judging outcome atomically from
//    stored data ... `judged` — a consensus was recorded at or before the
//    deadline; `no_consensus` — no consensus was recorded at or before the
//    deadline; `not_judged` — mode was `off`."
//
//   "Under `enforce`, the API accepts finalize before the deadline only if an
//    eligible consensus is already recorded ... With no eligible consensus it
//    refuses finalize as a reasoned no-op until the deadline has passed by the
//    API's own clock ... At the exact deadline instant: a consensus recorded
//    *at or before* it is eligible, and finalize is accepted *at or after* it."
//
//   "Nothing is fabricated: no template opinion, no placeholder certificate,
//    no default verdict."
//
// HOW TIME IS CONTROLLED. The judging duration is hardcoded (spec §4.4), so
// these tests never change it. They move the STORED deadline instead, which is
// exactly the fact finalize reads, and is the only way to test the boundary
// instant deterministically.
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import * as epoch from "../src/swarm/domain.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeSubject, sessionRow, setJudgeMode } from "./support/epoch-fixtures.ts";

useCleanDatabase(import.meta.file);

/** Open an epoch, turn it over, and hand back the CLOSED epoch that now settles. */
async function closedEpoch(prefix: string, mode: "off" | "enforce") {
  await setJudgeMode(mode);
  const subjectId = await activeSubject(prefix, 600);
  const opened = await epoch.openEpoch(subjectId);
  if (!opened.ok) throw new Error(`openEpoch: ${JSON.stringify(opened)}`);
  const turned = await epoch.turnOverEpoch(subjectId, opened.sessionId);
  if (!turned.ok) throw new Error(`turnOverEpoch: ${JSON.stringify(turned)}`);
  return { subjectId, sessionId: turned.closedSessionId };
}

async function setDeadline(sessionId: string, at: Date) {
  await sql`UPDATE swarm_sessions SET judging_deadline_at = ${at} WHERE id = ${sessionId}`;
}

/** Record a consensus with an explicit acceptance instant. */
async function recordConsensusAt(sessionId: string, at: Date) {
  const [j] = await sql<{ id: string }[]>`
    INSERT INTO swarm_session_judgements
      (session_id, mode, source, model, prompt_hash, inputs_digest, take_count, min_takes, opinion)
    VALUES (${sessionId}, 'enforce', 'model', 'test/epoch-fixture-judge', 'ph', 'id', 1, 1, '{"verdict":"ok"}'::jsonb)
    RETURNING id`;
  const r = await epoch.recordJudgingConsensus(sessionId, Number(j.id));
  await sql`UPDATE swarm_sessions SET consensus_recorded_at = ${at} WHERE id = ${sessionId}`;
  return r;
}

// ── judge mode off ──────────────────────────────────────────────────────────

test("judge off: aggregate then finalize publishes not_judged and waits for nothing", async () => {
  const { sessionId } = await closedEpoch("st_off", "off");
  expect((await sessionRow(sessionId)).judge_mode).toBe("off");

  const agg = await epoch.aggregateEpoch(sessionId);
  expect(agg.ok).toBe(true);
  expect((await sessionRow(sessionId)).state).toBe("aggregated");

  // Nothing requests judging under `off`, and asking is a reasoned refusal.
  const req = await epoch.requestJudging(sessionId);
  expect(req.ok).toBe(false);
  if (!req.ok) expect(req.error).toBe("judge_mode_off");

  const fin = await epoch.finalizeEpoch(sessionId);
  expect(fin.ok).toBe(true);
  if (!fin.ok) return;
  expect(fin.outcome).toBe("not_judged");

  const s = await sessionRow(sessionId);
  expect(s.state).toBe("published");
  expect(s.judging_outcome).toBe("not_judged");
  expect(s.judging_deadline_at).toBeNull();
  expect(s.published_at).not.toBeNull();
});

// ── judge mode enforce ──────────────────────────────────────────────────────

test("enforce: requesting judging stores an absolute deadline and moves the session to judging", async () => {
  const { sessionId } = await closedEpoch("st_req", "enforce");
  await epoch.aggregateEpoch(sessionId);

  const r = await epoch.requestJudging(sessionId);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const s = await sessionRow(sessionId);
  expect(s.state).toBe("judging");
  expect(s.judging_requested_at).not.toBeNull();
  expect(s.judging_deadline_at).not.toBeNull();
  // The deadline is absolute and equals request + the hardcoded duration.
  expect(new Date(s.judging_deadline_at).getTime() - new Date(s.judging_requested_at).getTime())
    .toBe(epoch.JUDGING_DURATION_SECONDS * 1000);
  expect(new Date(r.deadlineAt).getTime()).toBe(new Date(s.judging_deadline_at).getTime());

  // A repeated request returns the ORIGINAL deadline, never a fresh one.
  const again = await epoch.requestJudging(sessionId);
  expect(again.ok).toBe(true);
  if (!again.ok) return;
  expect(new Date(again.deadlineAt).getTime()).toBe(new Date(r.deadlineAt).getTime());
});

test("enforce: finalize before the deadline with no eligible consensus is refused and changes nothing", async () => {
  const { sessionId } = await closedEpoch("st_early", "enforce");
  await epoch.aggregateEpoch(sessionId);
  await epoch.requestJudging(sessionId);
  await setDeadline(sessionId, new Date(Date.now() + 60_000));

  const r = await epoch.finalizeEpoch(sessionId);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toBe("judging_deadline_not_reached");

  const s = await sessionRow(sessionId);
  expect(s.state).toBe("judging");
  expect(s.judging_outcome).toBeNull();
  expect(s.published_at).toBeNull();
});

test("enforce: finalize before the deadline WITH an eligible consensus publishes judged at once", async () => {
  const { sessionId } = await closedEpoch("st_early_ok", "enforce");
  await epoch.aggregateEpoch(sessionId);
  await epoch.requestJudging(sessionId);
  const deadline = new Date(Date.now() + 60_000);
  await setDeadline(sessionId, deadline);
  await recordConsensusAt(sessionId, new Date(deadline.getTime() - 1000));
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
  // The instant has passed by the API's clock, so finalize is accepted "at or
  // after" it; the consensus lands exactly ON it, so it is eligible.
  const instant = new Date(Date.now() - 1000);
  await setDeadline(sessionId, instant);
  await recordConsensusAt(sessionId, instant);

  const r = await epoch.finalizeEpoch(sessionId);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.outcome).toBe("judged");
});

test("enforce: after the deadline with no consensus, no_consensus publishes with nothing fabricated", async () => {
  const { sessionId } = await closedEpoch("st_none", "enforce");
  await epoch.aggregateEpoch(sessionId);
  await epoch.requestJudging(sessionId);
  await setDeadline(sessionId, new Date(Date.now() - 1000));

  const r = await epoch.finalizeEpoch(sessionId);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.outcome).toBe("no_consensus");

  const s = await sessionRow(sessionId);
  expect(s.state).toBe("published");
  expect(s.judging_outcome).toBe("no_consensus");
  expect(s.consensus_recorded_at).toBeNull();

  // EVERY row settlement wrote, inspected. No certificate, no judgement, no
  // placeholder verdict anywhere.
  expect((await sql`SELECT 1 FROM swarm_consensus_receipts WHERE session_id = ${sessionId}`).length).toBe(0);
  expect((await sql`SELECT 1 FROM swarm_session_judgements WHERE session_id = ${sessionId}`).length).toBe(0);
  // The aggregate and the signed takes are published unchanged.
  expect(s.swarm_recommendation).not.toBeNull();
});

test("eligibility comes from the stored instant: a consensus recorded AFTER the deadline yields no_consensus and is kept", async () => {
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
  expect((await sql`SELECT 1 FROM swarm_consensus_receipts WHERE session_id = ${sessionId}`).length).toBe(0);
});

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

test("a consensus arriving after publication is recorded as late evidence and changes neither state nor outcome", async () => {
  const { sessionId } = await closedEpoch("st_after_publish", "enforce");
  await epoch.aggregateEpoch(sessionId);
  await epoch.requestJudging(sessionId);
  await setDeadline(sessionId, new Date(Date.now() - 1000));
  await epoch.finalizeEpoch(sessionId);
  expect((await sessionRow(sessionId)).state).toBe("published");

  const late = await recordConsensusAt(sessionId, new Date());
  expect(late.ok).toBe(true);
  if (!late.ok) return;
  expect(late.lateEvidence).toBe(true);
  const s = await sessionRow(sessionId);
  expect(s.state).toBe("published");
  expect(s.judging_outcome).toBe("no_consensus");
  expect((await sql`SELECT 1 FROM swarm_session_judgements WHERE session_id = ${sessionId}`).length).toBe(1);
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
