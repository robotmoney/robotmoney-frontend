// Migration 0114 seats a roster on every session v0.5.x convened and left open —
// runbook blocker B20 (docs/runbooks/v0-6-0-rollout.md section 0).
//
// v0.5.x convened epochs with no swarm_session_members rows and no brief_opens_at,
// and its submit path let any member file into them. 0.6 keys the roster bypass on
// brief_opens_at, so such a session offered itself to nobody: on the stage-2 twin of
// 2026-10-07 the in-flight vault session published under min_takes with no receipt.
// Production's behavior wins (owner rule, 2026-10-03), so the open session must take
// takes from the members production would have. Each planted session is written the
// way v0.5.x left it; the migration's own text is then applied as the migrate step
// applies it: one transaction, as rm_owner.
import { beforeAll, expect, test } from "bun:test";
import { RECEIPT_CANONICAL_BUCKET_ORDER } from "@robotmoney/contract";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import { pendingTakesFor } from "../src/swarm/domain.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeMember, activeSubject, rid, type TestMember } from "./support/epoch-fixtures.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

const MIGRATION = readFileSync(join(import.meta.dir, "..", "migrations", "0114_seat_in_flight_unrostered_sessions.sql"), "utf8");

const sessions: Record<string, string> = {};
let alpha: TestMember;
let beta: TestMember;
let lapsed: TestMember;
let judgeId: string;
let weightlessFiler: TestMember;
let weightedFiler: TestMember;
let threeBucketFiler: TestMember;
let amendedFiler: TestMember;

/** 0114's text, as the migrate step applies it. */
async function applyMigration(): Promise<void> {
  const { default: postgres } = await import("postgres");
  const db = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx.unsafe(MIGRATION);
    });
  } finally {
    await db.end({ timeout: 5 });
  }
}

/** A session as v0.5.x's openSession left it: no roster rows, no brief_opens_at. */
async function v05Session(
  state: string,
  windowClosesAt: string,
  extra: { briefOpensAt?: string; recommendationType?: "bucket_weights" | "position_actions" } = {},
): Promise<string> {
  const subject = await activeSubject("b20");
  if (extra.recommendationType) {
    await fixtureDb`UPDATE swarm_subjects SET recommendation_type = ${extra.recommendationType} WHERE id = ${subject}`;
  }
  const [row] = (await fixtureDb`
    INSERT INTO swarm_sessions (subject_id, subject_name, state, window_closes_at, brief_opens_at)
    VALUES (${subject}, ${subject}, ${state}, ${windowClosesAt}::timestamptz, ${extra.briefOpensAt ?? null}::timestamptz)
    RETURNING id`) as unknown as { id: string }[];
  return row!.id;
}

/** A take as v0.5.x accepted it, written straight to the table; no `weights` is a prose-only take. */
async function v05Take(sessionId: string, memberId: string, weights?: { bucket: string; weight: number }[], revision = 1): Promise<void> {
  const payload = { stance: "neutral", confidence: 0.5, body: "v0.5.x take", ...(weights === undefined ? {} : { weights }) };
  await fixtureDb`
    INSERT INTO swarm_recommendations (session_id, member_id, subject_id, date, nonce, stance, payload, signature, verified, revision)
    SELECT id, ${memberId}, subject_id, date, ${rid("n")}, 'neutral', ${fixtureDb.json(payload)}, 'sig', true, ${revision}
      FROM swarm_sessions WHERE id = ${sessionId}`;
}

const canonicalFour = [...RECEIPT_CANONICAL_BUCKET_ORDER].map((bucket, i) => ({ bucket, weight: i + 1 }));

const roster = async (sessionId: string): Promise<{ member_id: string; status: string }[]> =>
  (await sql`
    SELECT member_id, status FROM swarm_session_members
     WHERE session_id = ${sessionId} ORDER BY member_id`) as unknown as { member_id: string; status: string }[];

/** Every active `member` at migrate time: the set insertEpoch seats. */
const activeMembers = async (): Promise<string[]> =>
  ((await sql`SELECT id FROM swarm_members WHERE status = 'active' AND role = 'member' ORDER BY id`) as unknown as { id: string }[]).map(
    (r) => r.id,
  );

const future = new Date(Date.now() + 6 * 3600_000).toISOString();
const past = new Date(Date.now() - 3600_000).toISOString();

beforeAll(async () => {
  alpha = await activeMember();
  beta = await activeMember();
  lapsed = await activeMember();
  judgeId = rid("judge");
  await fixtureDb`INSERT INTO swarm_members (id, status, name, handle, role) VALUES (${judgeId}, 'active', ${judgeId}, ${judgeId}, 'judge')`;

  sessions.inFlight = await v05Session("collecting", future);
  // A take v0.5.x accepted from a member who is no longer active still counts.
  await fixtureDb`
    INSERT INTO swarm_recommendations (session_id, member_id, subject_id, date, nonce, stance, payload, signature, verified)
    SELECT id, ${lapsed.id}, subject_id, date, ${rid("n")}, 'neutral', '{}'::jsonb, 'sig', true FROM swarm_sessions WHERE id = ${sessions.inFlight}`;
  await fixtureDb`UPDATE swarm_members SET status = 'inactive' WHERE id = ${lapsed.id}`;

  // A bucket_weights session v0.5.4 left open (blocker B20, owner decision
  // 2026-10-08): a prose-only take, a canonical-four take, a three-bucket take,
  // and a member whose FINAL take is weighted after a prose-only first revision.
  weightlessFiler = await activeMember();
  weightedFiler = await activeMember();
  threeBucketFiler = await activeMember();
  amendedFiler = await activeMember();
  sessions.vault = await v05Session("collecting", future, { recommendationType: "bucket_weights" });
  await v05Take(sessions.vault, weightlessFiler.id);
  await v05Take(sessions.vault, weightedFiler.id, canonicalFour);
  await v05Take(sessions.vault, threeBucketFiler.id, canonicalFour.slice(0, 3));
  await v05Take(sessions.vault, amendedFiler.id);
  await v05Take(sessions.vault, amendedFiler.id, canonicalFour, 2);
  // A position_actions session: a prose-only take is what it asks for.
  sessions.positions = await v05Session("collecting", future, { recommendationType: "position_actions" });
  await v05Take(sessions.positions, weightlessFiler.id);

  sessions.rostered = await v05Session("collecting", future);
  await fixtureDb`INSERT INTO swarm_session_members (session_id, member_id, member_name) VALUES (${sessions.rostered}, ${alpha.id}, ${alpha.id})`;
  sessions.closedWindow = await v05Session("collecting", past);
  sessions.legacyBrief = await v05Session("collecting", future, { briefOpensAt: past });
  sessions.finished = await v05Session("window_closed", future);

  await applyMigration();
});

test("the in-flight session seats every active member, plus the lapsed member whose take it holds; the judge holds no seat", async () => {
  const expected = [...(await activeMembers()), lapsed.id].sort();
  expect(expected).toContain(alpha.id);
  expect(expected).not.toContain(judgeId);
  expect(await roster(sessions.inFlight!)).toEqual(expected.map((member_id) => ({ member_id, status: "expected" })));
});

test("the take queue now offers the in-flight session to an active member, as v0.5.x accepted their take", async () => {
  expect((await pendingTakesFor(beta.id)).map((p) => p.sessionId)).toContain(sessions.inFlight!);
});

test("a rostered session, a closed window, a legacy brief session and a finished session are left as they were", async () => {
  expect(await roster(sessions.rostered!)).toEqual([{ member_id: alpha.id, status: "expected" }]);
  expect(await roster(sessions.closedWindow!)).toEqual([]);
  expect(await roster(sessions.legacyBrief!)).toEqual([]);
  expect(await roster(sessions.finished!)).toEqual([]);
});

test("in a bucket_weights session the weightless filer is seated excused; a weighted filer and a non-filer are expected", async () => {
  const seats = (await sql`
    SELECT member_id, status, excused_at, reason FROM swarm_session_members
     WHERE session_id = ${sessions.vault!}`) as unknown as
    { member_id: string; status: string; excused_at: Date | null; reason: string | null }[];
  const seat = (id: string) => seats.find((s) => s.member_id === id);
  expect(seat(weightlessFiler.id)?.status).toBe("excused");
  expect(seat(weightlessFiler.id)?.excused_at).not.toBeNull();
  expect(seat(weightlessFiler.id)?.reason).toContain("no canonical-four weight vector");
  // Gate 5b's predicate: three buckets is not the canonical four.
  expect(seat(threeBucketFiler.id)?.status).toBe("excused");
  // The FINAL take decides: a weighted amendment over a prose-only first revision.
  expect(seat(amendedFiler.id)?.status).toBe("expected");
  expect(seat(weightedFiler.id)).toMatchObject({ status: "expected", excused_at: null, reason: null });
  expect(seat(beta.id)).toMatchObject({ status: "expected", excused_at: null, reason: null });
  // Nobody else is excused: the excuse is only for weightless filers.
  const excused = seats.filter((s) => s.status === "excused").map((s) => s.member_id).sort();
  expect(excused).toEqual([weightlessFiler.id, threeBucketFiler.id].sort());
});

test("each excuse is audited as the forced excuse is, with actor migration 0114", async () => {
  const rows = (await fixtureDb`
    SELECT actor, scope FROM audit_log
     WHERE action = 'roster_excuse_forced' AND scope->>'sessionId' = ${sessions.vault!}`) as unknown as
    { actor: string; scope: { memberId: string; state: string; reason: string } }[];
  expect(rows.map((r) => r.scope.memberId).sort()).toEqual([weightlessFiler.id, threeBucketFiler.id].sort());
  for (const r of rows) {
    expect(r.actor).toBe("migration 0114");
    expect(r.scope.state).toBe("collecting");
    expect(r.scope.reason).toContain("no canonical-four weight vector");
  }
});

test("in a position_actions session a weightless filer stays expected", async () => {
  const seats = await roster(sessions.positions!);
  expect(seats.find((s) => s.member_id === weightlessFiler.id)?.status).toBe("expected");
  expect(seats.every((s) => s.status === "expected")).toBe(true);
});

test("a second run changes nothing", async () => {
  const before = await roster(sessions.inFlight!);
  const vaultBefore = await roster(sessions.vault!);
  const audits = async () => (await fixtureDb`SELECT count(*)::int AS n FROM audit_log WHERE actor = 'migration 0114'`)[0];
  const auditBefore = await audits();
  await applyMigration();
  expect(await roster(sessions.inFlight!)).toEqual(before);
  expect(await roster(sessions.vault!)).toEqual(vaultBefore);
  expect(await audits()).toEqual(auditBefore);
});
