// THE JUDGE DRAW (issue #1336, decisions.md D71, investment-swarm.md §9.7).
//
// Every eligible judge judges every session. An answer records evidence only.
// After the judging deadline, finalize lists the on-time answers (one per
// judge), draws one at random, applies it to the session, writes the same facts
// to the audit log and publishes, all in one transaction.
//
// Every answer here arrives the way it does in production: a seated judge signs
// its model's answer and `submitJudgement` files it (tests/support/stub-judge.ts).
// The random value is FIXED through the draw seam, which only the armed test
// harness may use. The database is real Postgres, so the clock, the row locks
// and the append-only judgement table are the real ones.
import { expect, test } from "bun:test";
import { canonicalizeSubmission } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import * as ic from "../src/swarm/domain.ts";
import { DRAW_RULE, drawIndex, recomputeDrawnIndex, rejectionLimit, setJudgeDrawSourceForTests } from "../src/swarm/judge-draw.ts";
import { replaySessionJudge, verifyStoredDraw } from "../src/swarm/judge-replay.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { ensureProseSubject } from "./support/prose-subject.ts";
import { drawNow, enforceJudging, requestJudgingFor, seatJudge, submitSigned, type TestJudge } from "./support/stub-judge.ts";

useCleanDatabasePerTest(import.meta.file);

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

async function voter(prefix: string) {
  const id = rid(prefix);
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) throw new Error(`registerMember failed: ${JSON.stringify(r)}`);
  return { id, token: r.token, privateKey };
}

/** A prose session with two signed takes, closed, aggregated and in `judging`. */
async function judging(prefix: string) {
  const subjectId = rid(prefix);
  await ensureProseSubject(subjectId, subjectId);
  const session = await ic.openSession(subjectId);
  await ic.publishBrief(session.id, 60);
  const date = session.date instanceof Date ? session.date.toISOString().slice(0, 10) : String(session.date).slice(0, 10);
  for (const m of [await voter("voter_a"), await voter("voter_b")]) {
    const payload = { memberId: m.id, date, subjectId, nonce: rid("n"), stance: "neutral", confidence: 0.5, body: "a signed take" };
    const signature = await signMessage(canonicalizeSubmission(payload), m.privateKey);
    const res = await ic.submitRecommendation(m.token, { ...payload, signature });
    if (res.status !== 201) throw new Error(`submit failed: ${JSON.stringify(res)}`);
  }
  await enforceJudging();
  await ic.closeWindow(session.id);
  await ic.aggregateSession(session.id);
  await requestJudgingFor(String(session.id));
  return { subjectId, sessionId: String(session.id) };
}

const answer = (rationale: string) =>
  JSON.stringify({ rationale, disagreements: [], release_safety: { release: "safe", concerns: [] } });

async function answerAs(judge: TestJudge, sessionId: string, rationale = `View of ${judge.id}`) {
  const r = await submitSigned(judge, sessionId, answer(rationale));
  if (!r.ok) throw new Error(`submitJudgement refused: ${JSON.stringify(r)}`);
  return r;
}

const sessionRow = async (id: string): Promise<Record<string, any>> =>
  (await sql`SELECT * FROM swarm_sessions WHERE id = ${id}`)[0] as Record<string, any>;
const judgeBlock = async (id: string) => (await sessionRow(id)).swarm_recommendation?.judge as Record<string, any> | undefined;
const rowsOf = async (sessionId: string) =>
  (await sql`SELECT to_jsonb(j) AS row FROM swarm_session_judgements j WHERE session_id = ${sessionId} ORDER BY id`).map((r: any) => r.row);

// ── who is asked, and what an answer does ───────────────────────────────────

test("a judge that never answers does not stop a session from being judged when another judge answered on time", async () => {
  const silentA = await seatJudge({ prefix: "judge_silent_a" });
  const silentB = await seatJudge({ prefix: "judge_silent_b" });
  const answering = await seatJudge({ prefix: "judge_answers" });
  const s = await judging("one_answers");
  await answerAs(answering, s.sessionId);
  // Every eligible judge is asked until it answers: the silent ones still are, the answering one is not.
  const asked = async (j: TestJudge) => (await ic.pendingJudgingFor(j.id)).map((p) => p.sessionId);
  expect(await asked(silentA)).toEqual([s.sessionId]);
  expect(await asked(silentB)).toEqual([s.sessionId]);
  expect(await asked(answering)).toEqual([]);

  const done = await drawNow(s.sessionId, { random: 5 });
  expect(done).toMatchObject({ ok: true, state: "published", outcome: "judged" });
  const block = await judgeBlock(s.sessionId);
  expect(block!.judged_by_member_id).toBe(answering.id);
  expect(block!.draw.candidate_member_ids).toEqual([answering.id]);
});

test("an answer is judged on time against the judging deadline, never against the take window", async () => {
  const judge = await seatJudge({ prefix: "judge_clock" });
  const onTime = await judging("clock_ontime");
  // The take window closed long ago. Judges have only the judging deadline.
  await sql`UPDATE swarm_sessions SET window_closes_at = now() - interval '1 day' WHERE id = ${onTime.sessionId}`;
  await sql`UPDATE swarm_sessions SET judging_deadline_at = now() + interval '10 minutes' WHERE id = ${onTime.sessionId}`;
  const filed = await answerAs(judge, onTime.sessionId);
  const [row] = await sql`SELECT applied, applied_skipped_reason FROM swarm_session_judgements WHERE id = ${filed.judgementId}`;
  expect(row).toMatchObject({ applied: false, applied_skipped_reason: "awaiting_draw" });

  // The reverse: the take window is still open, the judging deadline has just passed.
  const other = await seatJudge({ prefix: "judge_clock_late" });
  const late = await judging("clock_late");
  await sql`UPDATE swarm_sessions SET window_closes_at = now() + interval '1 day' WHERE id = ${late.sessionId}`;
  await sql`UPDATE swarm_sessions SET judging_deadline_at = clock_timestamp() WHERE id = ${late.sessionId}`;
  const tooLate = await answerAs(other, late.sessionId);
  const [lateRow] = await sql`SELECT applied, applied_skipped_reason FROM swarm_session_judgements WHERE id = ${tooLate.judgementId}`;
  expect(lateRow).toMatchObject({ applied: false, applied_skipped_reason: "after_deadline" });
  // Accepted a moment after the deadline, so it cannot win.
  expect(await drawNow(late.sessionId)).toMatchObject({ ok: true, outcome: "no_consensus" });
});

// ── the draw ────────────────────────────────────────────────────────────────

test("for each fixed random value, the winner is the answer at that position in the stored list", async () => {
  const judges = [await seatJudge({ prefix: "judge_p0" }), await seatJudge({ prefix: "judge_p1" }), await seatJudge({ prefix: "judge_p2" })];
  for (const random of [0, 1, 2, 3, 4, 5]) {
    const s = await judging(`position_${random}`);
    const filed: number[] = [];
    for (const j of judges) filed.push((await answerAs(j, s.sessionId)).judgementId);

    expect(await drawNow(s.sessionId, { random })).toMatchObject({ ok: true, outcome: "judged" });
    const block = (await judgeBlock(s.sessionId))!;
    // The list is in ascending judgement id: the order the answers were filed.
    expect(block.draw.candidate_judgement_ids).toEqual(filed);
    expect(block.draw.drawn_index).toBe(random % 3);
    expect(block.judgement_id).toBe(filed[random % 3]);
    expect(block.judged_by_member_id).toBe(judges[random % 3]!.id);
  }
});

test("the production random source reaches every position with no bias at the edge values", () => {
  for (let n = 1; n <= 12; n++) {
    const limit = rejectionLimit(n);
    // The last accepted value is the last position of a full cycle, and the first rejected one is out.
    expect(recomputeDrawnIndex(limit - 1, n)).toBe(n - 1);
    expect(recomputeDrawnIndex(limit, n)).toBeNull();
    expect(recomputeDrawnIndex(2 ** 32 - 1, n)).toBe(limit === 2 ** 32 ? n - 1 : null);
    // Every position is reachable, and each exactly once per cycle.
    const reached = new Set<number>();
    for (let v = 0; v < n; v++) reached.add(recomputeDrawnIndex(v, n)!);
    expect(reached.size).toBe(n);
  }
  expect(recomputeDrawnIndex(-1, 3)).toBeNull();
  expect(recomputeDrawnIndex(2 ** 32, 3)).toBeNull();
  expect(recomputeDrawnIndex(0, 0)).toBeNull();

  // A rejected value is redrawn, never folded in: the accepted value is the one stored.
  const limit = rejectionLimit(3);
  const values = [limit, limit + 1, 7];
  let reads = 0;
  setJudgeDrawSourceForTests(() => values[reads++]!);
  try {
    expect(drawIndex(3)).toEqual({ randomValue: 7, drawnIndex: 1 });
    expect(reads).toBe(3);
  } finally {
    setJudgeDrawSourceForTests(null);
  }

  // The default source is the secure random source, and it reaches every position.
  const seen = new Set<number>();
  for (let i = 0; i < 400; i++) seen.add(drawIndex(3).drawnIndex);
  expect([...seen].sort()).toEqual([0, 1, 2]);
});

test("the stored random value and list always recompute to the stored winner", async () => {
  const judges = [await seatJudge({ prefix: "judge_r0" }), await seatJudge({ prefix: "judge_r1" }), await seatJudge({ prefix: "judge_r2" })];
  const s = await judging("recompute");
  for (const j of judges) await answerAs(j, s.sessionId);
  expect(await drawNow(s.sessionId, { random: 4 })).toMatchObject({ ok: true });

  const block = (await judgeBlock(s.sessionId))!;
  const draw = block.draw;
  expect(draw.draw_rule).toBe(DRAW_RULE);
  expect(draw.random_value).toBe(4);
  expect(recomputeDrawnIndex(draw.random_value, draw.candidate_judgement_ids.length)).toBe(draw.drawn_index);
  expect(draw.candidate_judgement_ids[draw.drawn_index]).toBe(block.judgement_id);
  expect(Date.parse(draw.drawn_at)).toBeGreaterThanOrEqual(Date.parse((await sessionRow(s.sessionId)).judging_deadline_at));
  expect(verifyStoredDraw(block, await timelyRows(s.sessionId))).toEqual({ verdict: "verified", problems: [] });
});

async function timelyRows(sessionId: string) {
  return (await sql`SELECT id, judged_by_member_id FROM swarm_session_judgements
    WHERE session_id = ${sessionId} AND applied_skipped_reason = 'awaiting_draw' ORDER BY id`) as unknown as { id: string; judged_by_member_id: string | null }[];
}

test("the session's consensus time equals the winning answer's accepted time, to the microsecond", async () => {
  const judges = [await seatJudge({ prefix: "judge_c0" }), await seatJudge({ prefix: "judge_c1" })];
  const s = await judging("consensus_time");
  for (const j of judges) await answerAs(j, s.sessionId);
  await drawNow(s.sessionId, { random: 1 });
  const [row] = await sql`
    SELECT s.consensus_recorded_at = j.created_at AS same, s.consensus_recorded_at <= s.judging_deadline_at AS before_deadline,
           s.published_at >= s.judging_deadline_at AS published_after
      FROM swarm_sessions s JOIN swarm_session_judgements j ON j.id = (s.swarm_recommendation->'judge'->>'judgement_id')::bigint
     WHERE s.id = ${s.sessionId}`;
  expect(row).toEqual({ same: true, before_deadline: true, published_after: true });
});

test("the draw in the session record matches the audit log entry", async () => {
  const judges = [await seatJudge({ prefix: "judge_a0" }), await seatJudge({ prefix: "judge_a1" })];
  const s = await judging("audit");
  for (const j of judges) await answerAs(j, s.sessionId);
  await drawNow(s.sessionId, { random: 0 });

  const rows = await sql`SELECT actor, action, target_type, target_id, outcome, after_state FROM audit_log WHERE action = 'judge_draw'`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actor: "system-scheduler", target_type: "swarm_session", target_id: s.sessionId, outcome: "succeeded" });
  expect(rows[0]!.after_state).toEqual((await judgeBlock(s.sessionId))!.draw);
});

test("no saved answer is ever modified during a full session", async () => {
  const judges = [await seatJudge({ prefix: "judge_m0" }), await seatJudge({ prefix: "judge_m1" })];
  const s = await judging("append_only");
  await answerAs(judges[0]!, s.sessionId);
  const afterFirst = await rowsOf(s.sessionId);
  await answerAs(judges[1]!, s.sessionId);
  const beforeDraw = await rowsOf(s.sessionId);
  expect(beforeDraw[0]).toEqual(afterFirst[0]);

  await drawNow(s.sessionId, { random: 1 });
  const late = await seatJudge({ prefix: "judge_m2" });
  await answerAs(late, s.sessionId);
  const finished = await rowsOf(s.sessionId);
  // Every row that existed before the draw is byte-identical afterwards, the winner included.
  expect(finished.slice(0, 2)).toEqual(beforeDraw);
  expect(finished).toHaveLength(3);
  expect(finished[2].applied_skipped_reason).toBe("late_evidence");
});

test("a judge removed before the draw cannot win", async () => {
  const judges = [await seatJudge({ prefix: "judge_x0" }), await seatJudge({ prefix: "judge_x1" }), await seatJudge({ prefix: "judge_x2" })];
  const s = await judging("removed");
  const filed: number[] = [];
  for (const j of judges) filed.push((await answerAs(j, s.sessionId)).judgementId);
  // The judge the random value would have picked is switched off after it answered.
  await sql`UPDATE swarm_members SET status = 'inactive' WHERE id = ${judges[2]!.id}`;

  await drawNow(s.sessionId, { random: 2 });
  const block = (await judgeBlock(s.sessionId))!;
  expect(block.draw.candidate_member_ids).toEqual([judges[0]!.id, judges[1]!.id]);
  expect(block.draw.candidate_judgement_ids).toEqual(filed.slice(0, 2));
  expect(block.judged_by_member_id).not.toBe(judges[2]!.id);
  expect(block.draw.drawn_index).toBe(0);
});

test("an answer filed by a judge twice counts once: the first on-time answer is the candidate", async () => {
  const judge = await seatJudge({ prefix: "judge_dup" });
  const s = await judging("one_per_judge");
  const first = await answerAs(judge, s.sessionId);
  const again = await submitSigned(judge, s.sessionId, answer("A second try"));
  expect(again).toMatchObject({ ok: true, duplicate: true, judgementId: first.judgementId });
  await drawNow(s.sessionId);
  expect((await judgeBlock(s.sessionId))!.draw.candidate_judgement_ids).toEqual([first.judgementId]);
});

// ── the replay check ────────────────────────────────────────────────────────

test("the judge replay check confirms the stored draw, and reports a tampered one", async () => {
  const judges = [await seatJudge({ prefix: "judge_v0" }), await seatJudge({ prefix: "judge_v1" })];
  const s = await judging("replay");
  for (const j of judges) await answerAs(j, s.sessionId);
  await drawNow(s.sessionId, { random: 1 });

  const ok = await replaySessionJudge(s.sessionId);
  expect(ok).toMatchObject({ drawVerdict: "verified", drawProblems: [], digestVerdict: "reproduced" });
  // The replay reads the judgement the session NAMES, not the newest row.
  expect(ok!.judgementModel).not.toBeNull();

  // Tamper with the stored position: the stored random value no longer recomputes to it.
  await fixtureDb`UPDATE swarm_sessions
    SET swarm_recommendation = jsonb_set(swarm_recommendation, '{judge,draw,drawn_index}', '0'::jsonb) WHERE id = ${s.sessionId}`;
  const bad = await replaySessionJudge(s.sessionId);
  expect(bad!.drawVerdict).toBe("mismatch");
  expect(bad!.drawProblems.join(" ")).toContain("random value picks position 1");

  // A session with no draw is not applicable.
  const none = await judging("replay_none");
  expect((await replaySessionJudge(none.sessionId))!.drawVerdict).toBe("not_applicable");
});

// ── the test-only seam ──────────────────────────────────────────────────────

test("the test-only draw setter is refused outside the test harness", async () => {
  // A process that never armed the seam: the refusal is the module's own.
  const proc = Bun.spawn(
    ["bun", "-e", `
      const { setJudgeDrawSourceForTests } = await import("./src/swarm/judge-draw.ts");
      try { setJudgeDrawSourceForTests(() => 0); console.log("ACCEPTED"); }
      catch (e) { console.log("REFUSED:" + (e as Error).message); }
    `],
    { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  expect(out).toContain("REFUSED:");
  expect(out).toContain("test-only seam");
  expect(out).not.toContain("ACCEPTED");
  // And this process, which IS the armed harness, may use it.
  expect(() => setJudgeDrawSourceForTests(null)).not.toThrow();
});
