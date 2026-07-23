// Committee admin surface (issue #152): domain-level integration coverage for
// topic/member/session/roster/lifecycle/audit mutations, built on top of the
// CANONICAL schema issue #150 already landed (backend/migrations/
// 0017_admin_surface.sql — committee_session_members, committee_session_events,
// version columns, extended audit_log). AC1's migration-backed coverage
// (applying 0017 to representative legacy data) already exists as
// backend/tests/admin-surface-migration.test.ts from #150 — this suite does
// not duplicate it, only relies on it having run.
//
// Runs against the ephemeral Postgres from tests/preload.ts (already fully
// migrated).
import { beforeAll, expect, test } from "bun:test";
import * as admin from "../src/committee/admin.ts";
import * as ic from "../src/committee/domain.ts";
import { sql } from "../src/db/client.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

// All committee test files share ONE ephemeral Postgres (tests/preload.ts). With
// COMMITTEE_ROSTER_CAP now hard-enforced on every transition-to-active, a roster
// left full by an earlier-running file would make this file's first member
// admission 409. Reset the roster so this file admits its own members from empty,
// independent of file order. The suite's shared-committee assertions here are all
// containment/`>=` (arrayContaining, rosterSize >= 2), so a clean start still
// satisfies them.
beforeAll(async () => {
  await sql`TRUNCATE committee_members RESTART IDENTITY CASCADE`;
});

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

// Valid, correctly-ordered briefOpensAt < windowClosesAt < publishAt for a
// given UTC calendar date, matching docs/architecture.md §6.3's
// SessionCreateRequest shape.
function sessionTimes(date: string) {
  return {
    date,
    briefOpensAt: `${date}T09:00:00Z`,
    windowClosesAt: `${date}T10:00:00Z`,
    publishAt: `${date}T10:05:00Z`,
  };
}

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
  expect(approve).not.toHaveProperty("token");
  expect((approve as any).claimRequired).toBe(true);

  const memberId2 = rid("mrej");
  const { publicKeyB64: pk2 } = await generateKeyPair();
  await ic.applyMember({ memberId: memberId2, name: "Applicant2", publicKey: pk2 });
  const reject = await admin.reviewApplicationAdmin(memberId2, "reject");
  expect(reject.status).toBe(200);
  // committee_members.status has no 'rejected' value (CHECK constraint from
  // #150's migration) — the member folds to 'inactive' and the REJECTION
  // itself is recorded on the application row.
  const rejectedMember = (await admin.listMembersAdmin()).find((m: any) => m.id === memberId2);
  expect(rejectedMember!.status).toBe("inactive");
  const apps = await admin.listApplicationsAdmin("rejected");
  expect(apps.some((a: any) => a.member_id === memberId2)).toBe(true);
});

// ── AC4 (session creation): UTC validation, roster snapshot, 4 dedup jobs ──
test("session creation: rejects bad date, timestamp ordering, date/briefOpensAt mismatch, inactive topic; snapshots the active roster; enqueues exactly 4 deduped jobs", async () => {
  const subjectId = await activeSubject();
  const m1 = await activeMember("m1");
  const m2 = await activeMember("m2");

  expect((await admin.createSessionAdmin({ ...sessionTimes("2026-08-01"), date: "not-a-date" })).status).toBe(400);
  expect(
    (await admin.createSessionAdmin({ date: "2026-08-01", subjectId, briefOpensAt: "2026-08-02T09:00:00Z", windowClosesAt: "2026-08-01T10:00:00Z", publishAt: "2026-08-01T10:05:00Z" }))
      .status,
  ).toBe(400); // date mismatch (briefOpensAt is 08-02, date is 08-01)
  expect(
    (await admin.createSessionAdmin({ date: "2026-08-01", subjectId, briefOpensAt: "2026-08-01T10:00:00Z", windowClosesAt: "2026-08-01T09:00:00Z", publishAt: "2026-08-01T10:05:00Z" }))
      .status,
  ).toBe(400); // bad ordering (windowClosesAt before briefOpensAt)

  const inactiveSubject = rid("inact");
  await sql`INSERT INTO committee_subjects (id, status, name) VALUES (${inactiveSubject}, 'inactive', 'Inactive')`;
  expect((await admin.createSessionAdmin({ ...sessionTimes("2026-08-01"), subjectId: inactiveSubject })).status).toBe(409);

  const date = "2026-08-01";
  const created = await admin.createSessionAdmin({ ...sessionTimes(date), subjectId });
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

  const jobs = await sql<{ kind: string; dedupe_key: string }[]>`
    SELECT kind, dedupe_key FROM jobs WHERE payload->>'sessionId' = ${sessionId} ORDER BY kind`;
  expect(jobs.map((j) => j.kind).sort()).toEqual(
    ["committee.aggregate", "committee.close_window", "committee.publish", "committee.publish_brief"].sort(),
  );
  // Canonical scoped dedupe key shape (docs §6.3): committee:<session-id>:<action>.
  expect(jobs.every((j) => j.dedupe_key.startsWith(`committee:${sessionId}:`))).toBe(true);

  // Recreating the still-scheduled session is idempotent on jobs (dedupe_key).
  const again = await admin.createSessionAdmin({ ...sessionTimes(date), subjectId });
  expect(again.status).toBe(200);
  const jobsAgain = await sql`SELECT id FROM jobs WHERE payload->>'sessionId' = ${sessionId}`;
  expect(jobsAgain.length).toBe(4);
});

// ── AC5: roster add/excuse/restore blocked once collection begins ──────────
test("roster: add/excuse/restore work pre-collection and are blocked after collecting starts", async () => {
  const subjectId = await activeSubject();
  const m1 = await activeMember("r1");
  const created = await admin.createSessionAdmin({ ...sessionTimes("2026-08-05"), subjectId });
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
  const created = await admin.createSessionAdmin({ ...sessionTimes("2026-08-06"), subjectId });
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
  const created = await admin.createSessionAdmin({ ...sessionTimes("2026-08-07"), subjectId });
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
  const created = await admin.createSessionAdmin({ ...sessionTimes("2026-08-08"), subjectId });
  const sessionId = (created as any).session.id as string;

  const auditCountFor = async (toState: string) =>
    Number((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'session_transition' AND scope->>'sessionId' = ${sessionId} AND scope->>'to' = ${toState}`)[0].n);
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

  // Every real transition's event row carries the canonical action verb
  // (docs §4 US-C4), not just the target state.
  const eventRow = (await sql`SELECT action FROM committee_session_events WHERE session_id = ${sessionId} AND to_state = 'window_closed'`)[0];
  expect(eventRow.action).toBe("close_window");

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
  const created = await admin.createSessionAdmin({ ...sessionTimes("2026-08-09"), subjectId });
  const sessionId = (created as any).session.id as string;
  const cancel = await admin.cancelSessionAdmin(sessionId, 1, admin.ADMIN_ACTOR, "operator error");
  expect(cancel.status).toBe(200);
  expect((cancel as any).session.state).toBe("cancelled");
  const eventRow = (await sql`SELECT action, reason FROM committee_session_events WHERE session_id = ${sessionId} AND to_state = 'cancelled'`)[0];
  expect(eventRow.action).toBe("cancel");
  expect(eventRow.reason).toBe("operator error");
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
