// The submission window is the TIMESTAMP, not the state (issue #570).
//
// WHAT THIS PROTECTS, and why it did not exist before. `submitRecommendation`
// carried three timing gates: a `session.state !== 'collecting'` refusal
// returning `submission window not open (state=…)`, a `window_closes_at`
// comparison against the api process's clock, and a `state = 'collecting' AND
// window_closes_at > now()` predicate on the INSERT. Only the last two were
// about the deadline an agent was actually given. The state gate was the dead
// zone: an agent that polls on its own schedule — which is what every external
// operator's agent does — was refused whenever it arrived between one session
// closing and the next one's brief being published, for a reason that had
// nothing to do with the time it had been told.
//
// Every existing assertion about the window was of the form "after I close it,
// a submit 409s", which is a tautology with respect to that defect: the driver
// closed the window 1-3 minutes into an advertised hour, and no test asked
// whether that close was legitimate. `submission window not open` appeared in
// exactly three places in the tree — domain.ts and two PUBLISHED docs pages —
// and in no backend test at all, so the contract could be changed with nothing
// going red. These are the tests that were missing.
//
// THE EPOCH MODEL (issue #1026, system-scheduler-spec.md §4.2-§4.3) removed the
// gap itself rather than tolerating takes across it: turnover opens N+1
// `collecting`, with its brief and its deadline, in the transaction that
// closes N, and a take lands only "while a session is `collecting` and now is
// before its `window_closes_at`". The two tests that drove the gap through the
// retired `openSession` → `closeWindow` path now drive turnover instead, and
// still prove what they were written for: no take is ever refused as `not
// open`, and a take that arrives between two epochs is filed on the right one.
import { test, expect } from "bun:test";
import * as ic from "../src/swarm/domain.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { ensureProseSubject } from "./support/prose-subject.ts";
import { activeSubject, sessionRow } from "./support/epoch-fixtures.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

// A session's date is whatever the DATABASE derived from convened_at
// (migration 0022). Tests read it; they never choose it.
const sessionDate = (s: Record<string, unknown>): string =>
  s.date instanceof Date ? s.date.toISOString().slice(0, 10) : String(s.date).slice(0, 10);

// Own database per file, cloned from the migrated template — the roster this
// file admits into is its own, with no reset of anyone else's rows.
useCleanDatabase(import.meta.file);

async function activeMember() {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) {
    throw new Error(`activeMember(): registerMember failed for ${id}: ${JSON.stringify(r)}`);
  }
  return { id, token: r.token, privateKey };
}

async function submit(
  m: { id: string; token: string; privateKey: CryptoKey },
  date: string,
  subjectId: string,
  overrides: Partial<{ stance: string; confidence: number; nonce: string }> = {},
) {
  const sub = {
    memberId: m.id,
    date,
    subjectId,
    nonce: overrides.nonce ?? rid("n"),
    stance: overrides.stance ?? "neutral",
    confidence: overrides.confidence ?? 0.5,
    body: "a take authored between sittings",
  };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  return await ic.submitRecommendation(m.token, { ...sub, signature });
}

/** Drive a session all the way to `published` with its window genuinely elapsed. */
async function runLifecycle(sessionId: string) {
  // The suite has no fake clock and cannot get one: `window_closes_at` is
  // written from the api process's `Date.now()` while the INSERT predicate
  // compares it against Postgres `now()`, so patching Date.now moves the stored
  // value and not the comparison. Rewriting the stored deadline in raw SQL is
  // the honest lever — it is exactly the state the clock would have reached.
  await sql`UPDATE swarm_sessions SET window_closes_at = now() WHERE id = ${sessionId}`;
  await ic.closeWindow(sessionId);
  await ic.aggregateSession(sessionId);
  await ic.publishSession(sessionId);
}

test("a take submitted BETWEEN sessions is accepted and routed to the session it belongs to", async () => {
  const subj = await activeSubject("gap", 600);

  // Epoch A opens and its advertised deadline passes. Turnover then runs, as
  // the scheduler's boundary timer does.
  const opened = await ic.openEpoch(subj);
  if (!opened.ok) throw new Error(`openEpoch: ${JSON.stringify(opened)}`);
  const a = opened.sessionId;
  await sql`UPDATE swarm_sessions SET window_closes_at = clock_timestamp() - interval '1 second' WHERE id = ${a}`;
  const turned = await ic.turnOverEpoch(subj, a);
  if (!turned.ok) throw new Error(`turnOverEpoch: ${JSON.stringify(turned)}`);
  const b = turned.openedSessionId;
  expect(b).not.toBe(a);

  // THE GAP IS GONE. B was born `collecting` with a future deadline in the
  // same transaction that closed A — there is no `scheduled`, deadline-less
  // instant for the old state gate's `submission window not open` to fire in.
  const bRow = await sessionRow(b);
  expect(bRow.state).toBe("collecting");
  const [{ future }] = await sql<{ future: boolean }[]>`
    SELECT window_closes_at > clock_timestamp() AS future FROM swarm_sessions WHERE id = ${b}`;
  expect(future).toBe(true);
  expect((await sessionRow(a)).state).toBe("window_closed");

  const m = await activeMember();
  const res = await submit(m, sessionDate(bRow), subj);
  expect(res.status).toBe(201);
  if (!("recommendationId" in res)) throw new Error(`submission failed: ${JSON.stringify(res)}`);

  // ROUTED TO B, not to the epoch that already closed. This is the half that
  // "accepted" alone would not prove: a take filed against a closed epoch
  // would post-date its absences and its aggregation.
  const stored = (await sql`SELECT session_id FROM swarm_recommendations WHERE id = ${res.recommendationId}`)[0];
  expect(String(stored.session_id)).toBe(String(b));
  expect((await sql`SELECT id FROM swarm_recommendations WHERE session_id = ${a}`).length).toBe(0);

  // …and it survives into B's own frozen take set once B turns over and
  // aggregates.
  await sql`UPDATE swarm_sessions SET window_closes_at = clock_timestamp() - interval '1 second' WHERE id = ${b}`;
  const turnedB = await ic.turnOverEpoch(subj, b);
  expect(turnedB.ok).toBe(true);
  const aggregated = await ic.aggregateEpoch(b);
  expect(aggregated.ok, JSON.stringify(aggregated)).toBe(true);
  const frozen = await ic.loadFrozenTakeSet(b);
  expect(frozen!.takes.map((t) => String(t.member_id ?? t.memberId))).toContain(m.id);
});

test("the same take is still accepted once the brief IS published — the deadline never regressed", async () => {
  const subj = rid("open");
  await ensureProseSubject(subj, "Open Subject");
  const s = await ic.openSession(subj);
  await ic.publishBrief(s.id, 60);
  const m = await activeMember();
  expect((await submit(m, sessionDate(s), subj)).status).toBe(201);
});

test("an ELAPSED window still refuses, and that is now the only timing refusal", async () => {
  const subj = rid("late");
  await ensureProseSubject(subj, "Late Subject");
  const s = await ic.openSession(subj);
  await ic.publishBrief(s.id, 60);
  // Elapse the advertised deadline while the session is still `collecting` —
  // state says open, the timestamp says closed, and the timestamp is what an
  // agent was given.
  await sql`UPDATE swarm_sessions SET window_closes_at = now() - interval '1 second' WHERE id = ${s.id}`;
  const m = await activeMember();
  const late = await submit(m, sessionDate(s), subj);
  expect(late.status).toBe(409);
  expect((late as { error: string }).error).toBe("submission window closed");
  expect((late as { error: string }).error).not.toContain("not open");
});

test("a turnover that commits AHEAD of the stored close rejects no take — the next take lands in the successor, whose window is open", async () => {
  // The behaviour #570 stated as a test, restated for the epoch model. D55
  // removed the operator's early turnover: only `system-scheduler` turns an
  // epoch over. Its timer still runs on its own clock, not the database's
  // (§4.2), so the API can see a turnover commit before N's stored close. The
  // closed epoch refuses further takes — they would post-date its absences —
  // but the successor opened in the same transaction is collecting, so a
  // member arriving after that close is never told `not open` and never loses
  // its take.
  const subj = await activeSubject("early", 600);
  const opened = await ic.openEpoch(subj);
  if (!opened.ok) throw new Error(`openEpoch: ${JSON.stringify(opened)}`);
  const a = opened.sessionId;
  const turned = await ic.turnOverEpoch(subj, a);
  if (!turned.ok) throw new Error(`turnOverEpoch: ${JSON.stringify(turned)}`);
  const [closed] = await sql<{ state: string; still_future: boolean }[]>`
    SELECT state, window_closes_at > clock_timestamp() AS still_future FROM swarm_sessions WHERE id = ${a}`;
  expect(closed).toEqual({ state: "window_closed", still_future: true });

  const m = await activeMember();
  const res = await submit(m, sessionDate(await sessionRow(turned.openedSessionId)), subj);
  expect(res.status).toBe(201);
  if (!("recommendationId" in res)) throw new Error(`submission failed: ${JSON.stringify(res)}`);
  const stored = (await sql`SELECT session_id FROM swarm_recommendations WHERE id = ${res.recommendationId}`)[0];
  expect(String(stored.session_id)).toBe(String(turned.openedSessionId));
  expect((await sql`SELECT id FROM swarm_recommendations WHERE session_id = ${a}`).length).toBe(0);
});

test("a fresh nonce from the same member is an AMENDMENT, not a duplicate — and the schema says so", async () => {
  // WHAT THIS TEST USED TO ASSERT, and why it changed. It read "one take per
  // member per session is STILL enforced, by the schema, with no migration",
  // and it pinned `UNIQUE (session_id, member_id)` from 0004_committee.sql by
  // grepping pg_indexes. Issue #573 relaxes that constraint on purpose: a
  // member may amend inside the open window, and a fresh nonce is exactly how
  // an amendment is expressed. Keeping the old assertion would pin the feature
  // shut, so it is rewritten to assert the replacement rather than deleted.
  const subj = rid("dup");
  await ensureProseSubject(subj, "Dup Subject");
  const s = await ic.openSession(subj);
  await ic.publishBrief(s.id, 60);
  const m = await activeMember();
  const nonce = rid("first");
  expect((await submit(m, sessionDate(s), subj, { nonce })).status).toBe(201);
  // Fresh nonce → accepted as revision 2.
  const second = await submit(m, sessionDate(s), subj, { nonce: rid("second") });
  expect(second.status).toBe(201);
  expect((second as { revision?: number }).revision).toBe(2);
  // Reused nonce → still refused. This is the constraint that did NOT move,
  // and it is what makes a naive worker retry idempotent.
  const replayed = await submit(m, sessionDate(s), subj, { nonce });
  expect(replayed.status).toBe(409);
  expect((replayed as { error: string }).error).toContain("nonce already used");

  // …and the SCHEMA says both of those things, so neither can pass on a
  // coincidence of ordering. The old blanket (session_id, member_id) unique is
  // gone; (session_id, member_id, revision) is what replaced it, and it is
  // what makes "two rows claiming to be the same revision" impossible.
  const idx = (await sql<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes WHERE tablename = 'swarm_recommendations'`)
    .map((r) => r.indexdef).join("\n");
  expect(idx).toMatch(/UNIQUE.*\(session_id, member_id, revision\)/);
  expect(idx).toMatch(/UNIQUE.*\(member_id, nonce\)/);
  // D51 (migration 0075) adds ONE (session_id, member_id) uniqueness, and it is
  // partial: `WHERE final`, so it bounds which take counts and never refuses an
  // amendment. Any other UNIQUE on exactly that pair is the old blanket one.
  const pairUniques = idx.split("\n").filter((line) => /UNIQUE.*\(session_id, member_id\)/.test(line));
  expect(pairUniques.filter((line) => !/\(session_id, member_id\) WHERE final$/.test(line))).toEqual([]);
  expect(pairUniques).toHaveLength(1);
});

test("published_at >= window_closes_at — the invariant that was false by -59.9 min for a month", async () => {
  // Cheap, pure comparison of two columns already on the public projection.
  // `goldens/api-goldens.json` carries three rows captured from a real stack on
  // 2026-07-09 with `publishedAt` ~59.9 minutes BEFORE `windowClosesAt`, and
  // scripts/tests/unit/goldens-drift.test.ts asserts route-set membership and
  // coarse shape but never a RELATION between two fields — so the evidence sat
  // committed in the tree for a month with nothing pointed at it.
  const subj = rid("inv");
  await ensureProseSubject(subj, "Invariant Subject");
  const s = await ic.openSession(subj);
  await ic.publishBrief(s.id, 60);
  const m = await activeMember();
  expect((await submit(m, sessionDate(s), subj)).status).toBe(201);
  await runLifecycle(s.id);

  const row = (await sql`
    SELECT window_closes_at, published_at FROM swarm_sessions WHERE id = ${s.id}`)[0];
  expect(row.published_at).not.toBeNull();
  expect(new Date(row.published_at).getTime())
    .toBeGreaterThanOrEqual(new Date(row.window_closes_at).getTime());

  // Same assertion through the PUBLIC projection an outside observer reads —
  // which is the surface the defect was originally spotted on.
  const detail = await ic.getSession(sessionDate(s), subj);
  const pub = detail!.session;
  expect(pub.publishedAt).not.toBeNull();
  expect(Date.parse(pub.publishedAt!)).toBeGreaterThanOrEqual(Date.parse(pub.windowClosesAt!));
});

test("RED CONTROL: the invariant assertion catches a session published before its own deadline", async () => {
  // Proves the check above is not vacuous. This reproduces the committed
  // goldens' shape exactly — a 60-minute brief published minutes later — which
  // is what the driver produced on every session before it waited out the
  // window. Nothing in the driver can reach this any more; a direct caller can.
  const subj = rid("red");
  await ensureProseSubject(subj, "Red Control Subject");
  const s = await ic.openSession(subj);
  await ic.publishBrief(s.id, 60);
  await ic.closeWindow(s.id);
  await ic.aggregateSession(s.id);
  await ic.publishSession(s.id);

  const row = (await sql`
    SELECT window_closes_at, published_at FROM swarm_sessions WHERE id = ${s.id}`)[0];
  const gapMin = (new Date(row.published_at).getTime() - new Date(row.window_closes_at).getTime()) / 60_000;
  expect(gapMin).toBeLessThan(0);
  expect(gapMin).toBeGreaterThan(-61); // ~ -59.9, the goldens' own figure
});
