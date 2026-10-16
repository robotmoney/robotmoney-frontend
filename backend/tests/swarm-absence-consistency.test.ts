// Issue #501 — a seated member that does not participate must appear in the
// session's absent list, and the list must agree with the quorum counter.
//
// The observable that filed the issue was a session logging `absent: []` while
// reporting a take shortfall. Every non-participation route (a member
// container that fails or times out, and a control-line parse refusal — a live
// model answering `STANCE: cautiously constructive | CONFIDENCE: 0.65` is
// refused by the strict parser, which renders the member ABSENT rather than
// fabricating a neutral stance) ends identically HERE: no row in
// swarm_recommendations. So one server-side case covers all of them, and it is
// the case asserted below.
//
// These tests FIX THEIR OWN ROSTER (truncate, then seat exactly the members
// they register) rather than assuming the live one — which members the domain
// seats as active is exactly what other in-flight work changes, and an absent
// list is only assertable against a known roster.
//
// Runs against the ephemeral Postgres from tests/preload.ts (already fully
// migrated), so a missing database fails the run loudly instead of skipping.
import { expect, test } from "bun:test";
import * as admin from "../src/swarm/admin.ts";
import * as ic from "../src/swarm/domain.ts";
import { sql } from "../src/db/client.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { activeSubject as epochSubject, setJudgeMode, sessionRow } from "./support/epoch-fixtures.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

// A session's date is whatever the DATABASE derived from convened_at
// (migration 0022); postgres returns it as a Date. Tests read it, never choose it.
const sessionDate = (value: unknown): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

// Own database per TEST, cloned from the migrated template. Per-test, not
// per-file: countActiveMembers() is global and SWARM_ROSTER_CAP is enforced on
// every transition-to-active, so members seated by one test would make the
// next test's admission a spurious 409. Unique ids cannot fix that; a clean
// database can.
useCleanDatabasePerTest(import.meta.file);

async function activeMember(name: string) {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) throw new Error(`activeMember(): registerMember failed for ${id}: ${JSON.stringify(r)}`);
  return { id, token: r.token, privateKey };
}

async function activeSubject() {
  const id = rid("subj");
  await sql`INSERT INTO swarm_subjects (id, status, name) VALUES (${id}, 'active', ${id})`;
  return id;
}

async function submit(m: { id: string; token: string; privateKey: CryptoKey }, date: string, subjectId: string) {
  const sub = { memberId: m.id, date, subjectId, nonce: rid("n"), stance: "bullish", confidence: 0.7, body: "**REGIME**\n- x" };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  const r = await ic.submitRecommendation(m.token, { ...sub, signature });
  if (r.status !== 201) throw new Error(`submit(${m.id}) failed: ${JSON.stringify(r)}`);
  return r;
}

/**
 * Open an epoch for the subject — the frozen-roster path. The epoch seats
 * every active member in the transaction that opens it (domain.ts
 * insertEpoch), so the roster is exactly the members registered before it.
 */
async function openedEpoch(subjectId: string) {
  const opened = await ic.openEpoch(subjectId);
  if (!opened.ok) throw new Error(`openEpoch(${subjectId}) failed: ${JSON.stringify(opened)}`);
  return { sessionId: opened.sessionId, date: sessionDate((await sessionRow(opened.sessionId)).date) };
}

/** Close the epoch at its boundary (§4.3) and aggregate it (§4.4 step 1). */
async function turnOverAndAggregate(subjectId: string, sessionId: string) {
  const turned = await ic.turnOverEpoch(subjectId, sessionId);
  if (!turned.ok) throw new Error(`turnOverEpoch failed: ${JSON.stringify(turned)}`);
  const aggregated = await ic.aggregateEpoch(sessionId);
  if (!aggregated.ok) throw new Error(`aggregateEpoch failed: ${JSON.stringify(aggregated)}`);
  const [row] = await sql<{ swarm_recommendation: any }[]>`SELECT swarm_recommendation FROM swarm_sessions WHERE id = ${sessionId}`;
  return row!.swarm_recommendation as { quorum: { active: number; submitted: number; absent: number }; absent: string[] };
}

const absentEvents = async (sessionId: string) =>
  (await sql<{ member_id: string }[]>`
    SELECT member_id FROM swarm_agent_health_events WHERE session_id = ${sessionId} AND event_type = 'absent'`)
    .map((r) => r.member_id).sort();

// The invariant the contract promises (contract/src/swarm.d.ts:
// SwarmRecommendation.absent + SwarmQuorum): for a seated roster the take
// shortfall IS the absent list — same denominator, same members, no drift.
function expectAttendanceConsistent(rollup: { quorum: { active: number; submitted: number; absent: number }; absent: string[] }) {
  expect(rollup.quorum.active - rollup.quorum.submitted).toBe(rollup.absent.length);
  expect(rollup.quorum.absent).toBe(rollup.absent.length);
}

// ── The frozen-roster (epoch) path ──────────────────────────────────────────
test("a seated member that submits nothing is named in `absent`, and the shortfall equals the list", async () => {
  const subjectId = await epochSubject("absence", 3600);
  const present1 = await activeMember("present-1");
  const present2 = await activeMember("present-2");
  const noShow = await activeMember("no-show"); // enrolled, seated, never submits

  const { sessionId, date } = await openedEpoch(subjectId);

  // The roster this test asserts against is exactly the three members above.
  const roster = await admin.getSessionRoster(sessionId);
  expect(roster.map((r: any) => String(r.member_id)).sort())
    .toEqual([present1.id, present2.id, noShow.id].sort());

  await submit(present1, date, subjectId);
  await submit(present2, date, subjectId);
  const rollup = await turnOverAndAggregate(subjectId, sessionId);

  // The no-show is named — not merely missing from the take count.
  expect(rollup.absent).toEqual([noShow.id]);
  expect(rollup.quorum).toMatchObject({ active: 3, submitted: 2, absent: 1 });
  expectAttendanceConsistent(rollup);
  // …and the turnover recorded the same absence, in its own transaction
  // (system-scheduler-spec.md §4.3): the telemetry and the rollup agree.
  expect(await absentEvents(sessionId)).toEqual([noShow.id]);

  // The take-derived derivation the driver used to run (issue #501): a member
  // with no submission has no take row, so filtering the takes could only ever
  // return [] — this is why the absent list must be roster-derived.
  const takeRows = await sql<{ member_id: string }[]>`SELECT member_id FROM swarm_recommendations WHERE session_id = ${sessionId}`;
  expect(takeRows.map((r) => r.member_id)).not.toContain(noShow.id);

  // Same list on the SERVED payload — this is the object the smoke driver reads
  // (scripts/lib/swarm/session.ts absenceReport) and the admin/session views
  // render, so the invariant has to survive the projection too. Finalize under
  // judge mode `off` publishes it (§4.4).
  await setJudgeMode("off");
  const finalized = await ic.finalizeEpoch(sessionId);
  expect(finalized.ok, JSON.stringify(finalized)).toBe(true);
  const served = await ic.getSessionById(sessionId);
  const rec = served!.session.swarmRecommendation!;
  expect(rec.absent).toEqual([noShow.id]);
  expectAttendanceConsistent(rec);
  expect(served!.takes.map((t) => t.memberId)).not.toContain(noShow.id);
});

test("an excused member leaves the roster entirely: not seated, not absent, not in the denominator", async () => {
  const subjectId = await epochSubject("absence-excused", 3600);
  const present = await activeMember("exc-present");
  const noShow = await activeMember("exc-no-show");
  const excused = await activeMember("exc-excused");

  const { sessionId, date } = await openedEpoch(subjectId);
  // An epoch is collecting from its first instant, so the excusal is the
  // audited forced one (admin.ts rosterExcuseAdmin).
  expect((await admin.rosterExcuseAdmin(sessionId, excused.id, admin.ADMIN_ACTOR, { force: true })).status).toBe(200);

  await submit(present, date, subjectId);
  const rollup = await turnOverAndAggregate(subjectId, sessionId);

  expect(rollup.absent).toEqual([noShow.id]);
  expect(rollup.quorum).toMatchObject({ active: 2, submitted: 1, absent: 1 });
  expectAttendanceConsistent(rollup);
  expect(await absentEvents(sessionId)).toEqual([noShow.id]);
});

// ── The smoke/e2e (openSession) path — the shape that filed #501 ────────────
// This path freezes no roster, so the denominator is the live active roster.
// The invariant must hold there too: that session is the one whose driver
// logged `absent: []` while reporting a take shortfall.
test("the smoke path (no frozen roster) names its no-show and keeps the counter consistent", async () => {
  const subjectId = await activeSubject();
  const present1 = await activeMember("smoke-present-1");
  const present2 = await activeMember("smoke-present-2");
  const noShow = await activeMember("smoke-no-show");

  const opened = await ic.openSession(subjectId);
  const sessionId = opened.id as string;
  const date = sessionDate(opened.date);
  expect((await admin.getSessionRoster(sessionId)).length).toBe(0); // no frozen roster on this path

  await ic.publishBrief(sessionId, 60);
  await submit(present1, date, subjectId);
  await submit(present2, date, subjectId);
  await ic.closeWindow(sessionId);
  const rollup = await ic.aggregateSession(sessionId);

  expect(rollup.absent).toEqual([noShow.id]);
  expect(rollup.quorum).toMatchObject({ active: 3, submitted: 2, absent: 1 });
  expectAttendanceConsistent(rollup);
});
