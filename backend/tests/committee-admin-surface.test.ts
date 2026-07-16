// Committee admin surface (issue #152): migration-backed schema assertions
// plus domain-level integration coverage for topic/member/session/roster/
// lifecycle/audit mutations. Runs against the ephemeral Postgres from
// tests/preload.ts (already fully migrated, incl. 0017) — the migration test
// below additionally RE-APPLIES 0017's real SQL file against freshly-inserted
// legacy-shaped rows to prove its backfill/constraints work on preexisting
// data, not just an empty schema.
import { afterAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as admin from "../src/committee/admin.ts";
import * as ic from "../src/committee/domain.ts";
import { sql } from "../src/db/client.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function activeMember(name = "member") {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name, publicKey: publicKeyB64 });
  return { id, token: r.token!, privateKey };
}

async function activeSubject() {
  const id = rid("subj");
  await sql`INSERT INTO committee_subjects (id, status, name) VALUES (${id}, 'active', ${id})`;
  return id;
}

async function signedSubmission(m: { id: string; privateKey: CryptoKey }, date: string, subjectId: string, stance = "bullish") {
  const sub = { memberId: m.id, date, subjectId, nonce: rid("n"), stance, confidence: 0.7, body: "x" };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  return { ...sub, signature };
}

// ── AC1: migration-backed test — apply 0017 to representative legacy data ──
// Explicit generous per-test timeout: this test re-runs the full 0017 DDL
// file (a real CROSS JOIN backfill), which can be slow on a shared/loaded CI
// runner even though the query volume itself is tiny.
test("0017 (re-applied): legacy-shaped rows stay queryable, roster backfills, constraints + events/audit fields exist", async () => {
  const subjectId = rid("legsub");
  const memberId = rid("legmem");
  await sql`INSERT INTO committee_subjects (id, status, name) VALUES (${subjectId}, 'active', 'Legacy Subject')`;
  await sql`INSERT INTO committee_members (id, status, name) VALUES (${memberId}, 'active', 'Legacy Member')`;
  const appRows = await sql`INSERT INTO committee_applications (member_id, payload, status) VALUES (${memberId}, ${sql.json({ memberId } as any)}, 'approved') RETURNING id`;
  const sessionRows = await sql`
    INSERT INTO committee_sessions (date, subject_id, subject_name, state)
    VALUES (${"2020-01-01"}, ${subjectId}, 'Legacy Subject', 'window_closed')
    RETURNING id`;
  const sessionId = sessionRows[0].id as string;
  const recRows = await sql`
    INSERT INTO committee_recommendations (session_id, member_id, subject_id, date, nonce, stance, confidence, body, payload, signature, verified)
    VALUES (${sessionId}, ${memberId}, ${subjectId}, ${"2020-01-01"}, ${rid("nonce")}, 'bullish', 0.5, 'legacy take', ${sql.json({} as any)}, 'sig', true)
    RETURNING id`;
  const briefRows = await sql`INSERT INTO committee_briefs (date, subject_id, body) VALUES (${"2020-01-01"}, ${subjectId}, ${sql.json({} as any)}) RETURNING id`;
  const snapRows = await sql`INSERT INTO committee_subject_snapshots (subject_id, date, total_value_usd) VALUES (${subjectId}, ${"2020-01-01"}, 100) RETURNING id`;
  const jobRows = await sql`INSERT INTO jobs (kind, payload) VALUES ('committee.aggregate', ${sql.json({ sessionId } as any)}) RETURNING id`;

  // This LEGACY session predates any roster snapshot: no committee_session_roster
  // row exists for (sessionId, memberId) yet.
  const preBackfill = await sql`SELECT 1 FROM committee_session_roster WHERE session_id = ${sessionId} AND member_id = ${memberId}`;
  expect(preBackfill.length).toBe(0);

  // Re-apply the REAL 0017 migration file (idempotent: ADD COLUMN IF NOT
  // EXISTS / CREATE TABLE IF NOT EXISTS / ON CONFLICT DO NOTHING) so its
  // backfill INSERT runs again against this now-existing legacy session.
  const ddl = await readFile(join(migrationsDir, "0017_committee_admin_surface.sql"), "utf8");
  await sql.unsafe(ddl);

  // Existing rows across every table this issue's AC names remain queryable.
  expect((await sql`SELECT id FROM committee_subjects WHERE id = ${subjectId}`).length).toBe(1);
  expect((await sql`SELECT id FROM committee_members WHERE id = ${memberId}`).length).toBe(1);
  expect((await sql`SELECT id FROM committee_applications WHERE id = ${appRows[0].id}`).length).toBe(1);
  expect((await sql`SELECT id FROM committee_sessions WHERE id = ${sessionId}`).length).toBe(1);
  expect((await sql`SELECT id FROM committee_recommendations WHERE id = ${recRows[0].id}`).length).toBe(1);
  expect((await sql`SELECT id FROM committee_briefs WHERE id = ${briefRows[0].id}`).length).toBe(1);
  expect((await sql`SELECT id FROM committee_subject_snapshots WHERE id = ${snapRows[0].id}`).length).toBe(1);
  expect((await sql`SELECT id FROM jobs WHERE id = ${jobRows[0].id}`).length).toBe(1);

  // Required columns/defaults exist (version fields).
  const subjRow = (await sql`SELECT version FROM committee_subjects WHERE id = ${subjectId}`)[0];
  expect(Number(subjRow.version)).toBe(1);
  const memRow = (await sql`SELECT version FROM committee_members WHERE id = ${memberId}`)[0];
  expect(Number(memRow.version)).toBe(1);
  const sessRow = (await sql`SELECT version FROM committee_sessions WHERE id = ${sessionId}`)[0];
  expect(Number(sessRow.version)).toBe(1);

  // Roster backfill: the legacy session now has a snapshot row for the
  // (still-active) legacy member.
  const backfilled = await sql`SELECT status FROM committee_session_roster WHERE session_id = ${sessionId} AND member_id = ${memberId}`;
  expect(backfilled.length).toBe(1);
  expect(backfilled[0].status).toBe("active");

  // Required constraint: UNIQUE (session_id, member_id) on the roster table.
  let duplicateRosterRowRejected = false;
  try {
    await sql`INSERT INTO committee_session_roster (session_id, member_id, status) VALUES (${sessionId}, ${memberId}, 'active')`;
  } catch {
    duplicateRosterRowRejected = true;
  }
  expect(duplicateRosterRowRejected).toBe(true);

  // committee_session_events exists and is insertable (FK-constrained).
  await sql`INSERT INTO committee_session_events (session_id, from_state, to_state, actor) VALUES (${sessionId}, 'window_closed', 'aggregated', 'test')`;
  const events = await sql`SELECT to_state FROM committee_session_events WHERE session_id = ${sessionId}`;
  expect(events.some((e: any) => e.to_state === "aggregated")).toBe(true);

  // Audit fields: the pre-existing audit_log table is untouched/queryable and
  // carries the new filter indexes.
  await sql`INSERT INTO audit_log (actor, action, scope) VALUES ('test', 'legacy_check', ${sql.json({ sessionId } as any)})`;
  const idxRows = await sql<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE tablename = 'audit_log'`;
  const idxNames = idxRows.map((r) => r.indexname);
  expect(idxNames).toContain("audit_log_action_at_idx");
  expect(idxNames).toContain("audit_log_actor_at_idx");
}, 30_000);

// ── AC2: topic create/edit/deactivate — versioned, immutable id, stale_version ──
test("topics: create validates fields, edit is versioned (409 stale_version), deactivate is versioned", async () => {
  const id = rid("topic");
  const created = await admin.createSubjectAdmin({ id, name: "Topic A", thesisBlurb: "t" });
  expect(created.status).toBe(201);
  const subj = (created as any).subject;
  expect(subj.id).toBe(id);
  expect(subj.version).toBe(1);

  // duplicate id → 409
  expect((await admin.createSubjectAdmin({ id, name: "dup" })).status).toBe(409);

  // stale version → 409
  const staleEdit = await admin.updateSubjectAdmin(id, 99, { name: "renamed" });
  expect(staleEdit.status).toBe(409);
  expect((staleEdit as any).error).toBe("stale_version");

  // correct version → 200, version increments, id is immutable (not a patch field)
  const edit = await admin.updateSubjectAdmin(id, 1, { name: "Topic A renamed" });
  expect(edit.status).toBe(200);
  expect((edit as any).subject.name).toBe("Topic A renamed");
  expect((edit as any).subject.version).toBe(2);
  expect((edit as any).subject.id).toBe(id);

  // deactivate with stale version → 409; with current version → 200 + status inactive
  expect((await admin.deactivateSubjectAdmin(id, 1)).status).toBe(409);
  const deact = await admin.deactivateSubjectAdmin(id, 2);
  expect(deact.status).toBe(200);
  expect((deact as any).subject.status).toBe("inactive");

  // 404 for an unknown id
  expect((await admin.updateSubjectAdmin(rid("nope"), 1, {})).status).toBe(404);
});

// ── AC3: member activation/manual-add/reactivation/key rotation ────────────
test("members: manual add mints a one-time credential; deactivate revokes keys; reactivate + rotate mint fresh credentials", async () => {
  const memberId = rid("madd");
  const { publicKeyB64 } = await generateKeyPair();
  const added = await admin.addMemberAdmin({ memberId, name: "Manual Member", publicKey: publicKeyB64 });
  expect(added.status).toBe(201);
  const token1 = (added as any).token as string;
  expect(typeof token1).toBe("string");
  expect(await ic.memberIdForToken(token1)).toBe(memberId);

  // duplicate memberId → 409
  expect((await admin.addMemberAdmin({ memberId, name: "x", publicKey: publicKeyB64 })).status).toBe(409);

  // Reads never expose key material.
  const listed = (await admin.listMembersAdmin()).find((m: any) => m.id === memberId);
  expect(listed).toBeTruthy();
  expect(listed).not.toHaveProperty("key_hash");
  expect(listed).not.toHaveProperty("token_hash");
  expect(listed).not.toHaveProperty("public_key");
  expect(listed!.version).toBe(1);

  // Deactivate (versioned) revokes the active key transactionally.
  const deact = await admin.deactivateMemberAdmin(memberId, 1);
  expect(deact.status).toBe(200);
  expect(await ic.memberIdForToken(token1)).toBeNull();
  expect((await admin.deactivateMemberAdmin(memberId, 1)).status).toBe(409); // stale now (version bumped)

  // Reactivate mints a FRESH credential; the old token stays revoked.
  const react = await admin.reactivateMemberAdmin(memberId, 2);
  expect(react.status).toBe(200);
  const token2 = (react as any).token as string;
  expect(token2).not.toBe(token1);
  expect(await ic.memberIdForToken(token2)).toBe(memberId);
  expect(await ic.memberIdForToken(token1)).toBeNull();

  // Key rotation revokes the prior key and mints exactly one new active key.
  const rotated = await admin.rotateMemberKeyAdmin(memberId);
  expect(rotated.status).toBe(200);
  const token3 = (rotated as any).token as string;
  expect(token3).not.toBe(token2);
  expect(await ic.memberIdForToken(token3)).toBe(memberId);
  expect(await ic.memberIdForToken(token2)).toBeNull();
  const activeKeys = await sql`SELECT id FROM committee_member_keys WHERE member_id = ${memberId} AND active = true`;
  expect(activeKeys.length).toBe(1);
});

test("members: application review approve/reject", async () => {
  const memberId = rid("mapp");
  const { publicKeyB64 } = await generateKeyPair();
  await ic.applyMember({ memberId, name: "Applicant", publicKey: publicKeyB64 });

  const approve = await admin.reviewApplicationAdmin(memberId, "approve");
  expect(approve.status).toBe(200);
  expect(typeof (approve as any).token).toBe("string");

  const memberId2 = rid("mrej");
  const { publicKeyB64: pk2 } = await generateKeyPair();
  await ic.applyMember({ memberId: memberId2, name: "Applicant2", publicKey: pk2 });
  const reject = await admin.reviewApplicationAdmin(memberId2, "reject");
  expect(reject.status).toBe(200);
  const rejected = (await admin.listMembersAdmin()).find((m: any) => m.id === memberId2);
  expect(rejected!.status).toBe("rejected");
});

// ── AC4 (session creation): UTC validation, roster snapshot, 4 dedup jobs ──
test("session creation: rejects bad date, date/scheduledAt mismatch, inactive topic; snapshots the active roster; enqueues exactly 4 deduped jobs", async () => {
  const subjectId = await activeSubject();
  const m1 = await activeMember("m1");
  const m2 = await activeMember("m2");

  expect((await admin.createSessionAdmin({ date: "not-a-date", subjectId })).status).toBe(400);
  expect((await admin.createSessionAdmin({ date: "2026-08-01", subjectId, scheduledAt: "2026-08-02T00:00:00Z" })).status).toBe(400);

  const inactiveSubject = rid("inact");
  await sql`INSERT INTO committee_subjects (id, status, name) VALUES (${inactiveSubject}, 'inactive', 'Inactive')`;
  expect((await admin.createSessionAdmin({ date: "2026-08-01", subjectId: inactiveSubject })).status).toBe(409);

  const date = "2026-08-01";
  const created = await admin.createSessionAdmin({ date, subjectId });
  expect(created.status).toBe(201);
  // This suite shares one committee (no tenant isolation, by design) with
  // other test files that also register active members and never deactivate
  // them, so the roster snapshot legitimately includes more than JUST m1/m2
  // when the full suite runs together — assert containment, not exact size.
  expect((created as any).rosterSize).toBeGreaterThanOrEqual(2);
  expect((created as any).jobIds.length).toBe(4);
  const sessionId = (created as any).session.id as string;

  const roster = await admin.getSessionRoster(sessionId);
  const rosterIds = roster.map((r: any) => r.member_id);
  expect(rosterIds).toEqual(expect.arrayContaining([m1.id, m2.id]));

  const jobs = await sql<{ kind: string }[]>`SELECT kind FROM jobs WHERE payload->>'sessionId' = ${sessionId} ORDER BY kind`;
  expect(jobs.map((j) => j.kind).sort()).toEqual(
    ["committee.aggregate", "committee.close_window", "committee.publish", "committee.publish_brief"].sort(),
  );

  // Recreating the still-scheduled session is idempotent on jobs (dedupe_key).
  const again = await admin.createSessionAdmin({ date, subjectId });
  expect(again.status).toBe(200);
  const jobsAgain = await sql`SELECT id FROM jobs WHERE payload->>'sessionId' = ${sessionId}`;
  expect(jobsAgain.length).toBe(4);
});

// ── AC5: roster add/excuse/restore blocked once collection begins ──────────
test("roster: add/excuse/restore work pre-collection and are blocked after collecting starts", async () => {
  const subjectId = await activeSubject();
  const m1 = await activeMember("r1");
  const created = await admin.createSessionAdmin({ date: "2026-08-05", subjectId });
  const sessionId = (created as any).session.id as string;

  const m2 = await activeMember("r2"); // registered AFTER creation — not on the frozen snapshot
  const add = await admin.rosterAddAdmin(sessionId, m2.id);
  expect(add.status).toBe(200);
  const excuse = await admin.rosterExcuseAdmin(sessionId, m1.id);
  expect(excuse.status).toBe(200);
  const restore = await admin.rosterRestoreAdmin(sessionId, m1.id);
  expect(restore.status).toBe(200);

  // Move the session into collecting, then roster edits are locked.
  await ic.publishBrief(sessionId, 60);
  expect((await admin.rosterAddAdmin(sessionId, m2.id)).status).toBe(409);
  expect((await admin.rosterExcuseAdmin(sessionId, m1.id)).status).toBe(409);
  expect((await admin.rosterRestoreAdmin(sessionId, m1.id)).status).toBe(409);
});

// ── AC6: submission requires an expected roster row; excused is rejected ───
test("submission: a member off the frozen roster (or excused) is rejected; a roster member succeeds", async () => {
  const subjectId = await activeSubject();
  const onRoster = await activeMember("onroster");
  const created = await admin.createSessionAdmin({ date: "2026-08-06", subjectId });
  const sessionId = (created as any).session.id as string;
  const offRoster = await activeMember("offroster"); // registered after snapshot
  await ic.publishBrief(sessionId, 60);

  const okSub = await ic.submitRecommendation(onRoster.token, await signedSubmission(onRoster, "2026-08-06", subjectId));
  expect(okSub.status).toBe(201);

  const rejected = await ic.submitRecommendation(offRoster.token, await signedSubmission(offRoster, "2026-08-06", subjectId));
  expect(rejected.status).toBe(403);
});

// ── AC6: aggregate denominators use non-excused roster snapshot rows ───────
test("aggregate: quorum denominator is the frozen roster (excluding excused), not live active-member count", async () => {
  const subjectId = await activeSubject();
  const a = await activeMember("agg-a");
  const b = await activeMember("agg-b");
  const created = await admin.createSessionAdmin({ date: "2026-08-07", subjectId });
  const sessionId = (created as any).session.id as string;
  // The roster snapshot legitimately includes every OTHER globally-active
  // member too (this suite shares one committee with other test files) — the
  // invariant under test is relative: excusing b removes exactly one from
  // the denominator, and a member who joins AFTER the snapshot (or who is
  // simply never added) never inflates it.
  const rosterTotal = (await admin.getSessionRoster(sessionId)).length;

  // Excuse b BEFORE collecting; a third member joins live but is never added
  // to the roster, so it must not inflate the denominator.
  await admin.rosterExcuseAdmin(sessionId, b.id);
  await activeMember("agg-c-not-on-roster");

  await ic.publishBrief(sessionId, 60);
  await ic.submitRecommendation(a.token, await signedSubmission(a, "2026-08-07", subjectId));
  await ic.closeWindow(sessionId);
  const rollup = await ic.aggregateSession(sessionId);

  // Denominator is (rosterTotal - 1) — everyone snapshotted MINUS the one
  // excused member `b` — never the live active-member count (which would
  // additionally include the post-snapshot "agg-c-not-on-roster" member).
  expect(rollup.quorum.active).toBe(rosterTotal - 1);
  expect(rollup.quorum.submitted).toBe(1);
  expect(rollup.quorum.absent).toBe(rosterTotal - 1 - 1);
});

// ── AC4 (lifecycle): legal/illegal/terminal/stale-version/idempotent ───────
test("guarded lifecycle: legal transitions succeed with one event+audit row; illegal/terminal/stale are rejected; repeats are idempotent", async () => {
  const subjectId = await activeSubject();
  await activeMember("lc1");
  const created = await admin.createSessionAdmin({ date: "2026-08-08", subjectId });
  const sessionId = (created as any).session.id as string;

  const auditCountFor = async (action: string) =>
    Number((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'session_transition' AND scope->>'sessionId' = ${sessionId} AND scope->>'to' = ${action}`)[0].n);
  const eventCountFor = async (toState: string) =>
    Number((await sql`SELECT count(*)::int AS n FROM committee_session_events WHERE session_id = ${sessionId} AND to_state = ${toState}`)[0].n);

  // Illegal: cannot aggregate directly from 'scheduled'.
  const illegal = await admin.aggregateSessionAdmin(sessionId, 1);
  expect(illegal.status).toBe(409);
  expect((illegal as any).error).toContain("illegal_transition");

  // Stale version.
  const stale = await admin.closeSessionAdmin(sessionId, 99);
  expect(stale.status).toBe(409);
  expect((stale as any).error).toBe("stale_version");

  // Legal: scheduled -> collecting (via publishBrief's own write) then admin close.
  await ic.publishBrief(sessionId, 60);
  const close = await admin.closeSessionAdmin(sessionId, 1);
  expect(close.status).toBe(200);
  expect((close as any).session.state).toBe("window_closed");
  expect((close as any).session.version).toBe(2);
  expect(await eventCountFor("window_closed")).toBe(1);
  expect(await auditCountFor("window_closed")).toBe(1);

  // Idempotent repeat: same state again → 200, no version bump, no new event/audit row.
  const closeAgain = await admin.closeSessionAdmin(sessionId, 2);
  expect(closeAgain.status).toBe(200);
  expect((closeAgain as any).idempotent).toBe(true);
  expect((closeAgain as any).session.version).toBe(2);
  expect(await eventCountFor("window_closed")).toBe(1);

  // Legal: window_closed -> aggregated.
  const agg = await admin.aggregateSessionAdmin(sessionId, 2);
  expect(agg.status).toBe(200);
  expect((agg as any).session.state).toBe("aggregated");

  // Legal: aggregated -> published (terminal).
  const pub = await admin.publishSessionAdmin(sessionId, 3);
  expect(pub.status).toBe(200);
  expect((pub as any).session.state).toBe("published");
  const row = (await sql`SELECT published_at FROM committee_sessions WHERE id = ${sessionId}`)[0];
  expect(row.published_at).toBeTruthy();

  // Terminal-state protection: no further transition is legal from 'published'.
  const afterTerminal = await admin.cancelSessionAdmin(sessionId, 4);
  expect(afterTerminal.status).toBe(409);
  expect((afterTerminal as any).error).toContain("terminal_state");

  // 404 for an unknown session id.
  expect((await admin.closeSessionAdmin(crypto.randomUUID(), 1)).status).toBe(404);
});

test("guarded lifecycle: cancel is legal from a non-terminal state and is itself terminal", async () => {
  const subjectId = await activeSubject();
  const created = await admin.createSessionAdmin({ date: "2026-08-09", subjectId });
  const sessionId = (created as any).session.id as string;
  const cancel = await admin.cancelSessionAdmin(sessionId, 1);
  expect(cancel.status).toBe(200);
  expect((cancel as any).session.state).toBe("cancelled");
  const again = await admin.closeSessionAdmin(sessionId, 2);
  expect(again.status).toBe(409);
  expect((again as any).error).toContain("terminal_state");
});

// ── AC7: audit filtering ────────────────────────────────────────────────────
test("audit: listAuditLog filters by actor/action and redacts to non-credential fields", async () => {
  const actor = rid("auditor");
  await sql`INSERT INTO audit_log (actor, action, scope) VALUES (${actor}, 'subject_create', ${sql.json({ subjectId: "x" } as any)})`;
  const byActor = await admin.listAuditLog({ actor });
  expect(byActor.length).toBeGreaterThanOrEqual(1);
  expect(byActor.every((r: any) => r.actor === actor)).toBe(true);
  const byAction = await admin.listAuditLog({ actor, action: "subject_create" });
  expect(byAction.length).toBeGreaterThanOrEqual(1);
  // Never a credential-shaped field on an audit row.
  for (const r of byAction as any[]) {
    expect(r).not.toHaveProperty("token");
    expect(r).not.toHaveProperty("token_hash");
    expect(JSON.stringify(r.scope ?? {})).not.toMatch(/tok_/);
  }
});

afterAll(async () => {
  // No explicit cleanup: every row here uses a crypto.randomUUID-suffixed id
  // (rid()), matching the isolation convention used across this test suite.
});
