// Swarm admin surface (issue #152): domain-level integration coverage for
// topic/member/session/roster/lifecycle/audit mutations, built on top of the
// CANONICAL schema issue #150 already landed (backend/migrations/
// 0017_admin_surface.sql — swarm_session_members, swarm_session_events,
// version columns, extended audit_log). AC1's migration-backed coverage
// (applying 0017 to representative legacy data) already exists as
// backend/tests/admin-surface-migration.test.ts from #150 — this suite does
// not duplicate it, only relies on it having run.
//
// Runs against the ephemeral Postgres from tests/preload.ts (already fully
// migrated).
//
// SESSIONS ARE EPOCHS (issue #1026, D55 decision 4). There is no admin session
// create any more: `system-scheduler` opens and turns over epochs, and an epoch
// is `collecting` from its first instant with its roster seated in the same
// transaction (domain.ts insertEpoch). The session tests below build sessions
// that way. What pinned the retired create's own input validation — the
// degenerate-window test (MIN_SESSION_STEP_MS) and the UTC-date and
// instant-ordering half of the creation test — was deleted with that feature,
// which D55 decision 4 retired; the creation test keeps its roster and
// no-jobs halves against the epoch open.
import { expect, test } from "bun:test";
import * as admin from "../src/swarm/admin.ts";
import * as ic from "../src/swarm/domain.ts";
import { sql } from "../src/db/client.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { canonicalizeApplication, canonicalizeSubmission } from "@robotmoney/contract";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

// §11 R6 — sign the canonical application payload the way an rmpc-equipped
// agent would; the server mints the memberId (never the caller).
async function signedApply(name: string) {
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const application = { name, contact: `${rid("apply")}@example.test`, publicKey: publicKeyB64 };
  const signature = await signMessage(canonicalizeApplication(application), privateKey);
  const applied = await ic.applyMember({ ...application, signature });
  return { memberId: (applied as { memberId: string }).memberId, applied };
}

// Own database per TEST, cloned from the migrated template — the roster each
// test admits into is its own, with no reset of anyone else's rows. Per test,
// not per file: every epoch seats the whole active roster and SWARM_ROSTER_CAP
// bounds it, so members admitted by one test would fill the next test's seats.
useCleanDatabasePerTest(import.meta.file);

async function activeMember(name = "member") {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name, publicKey: publicKeyB64 });
  // registerMember returns {ok:false, status, error} (not a token) when the
  // roster cap is hit — fail loudly here rather than let a bogus token flow
  // downstream to a confusing auth failure far from the real cause.
  if (!("token" in r) || !r.token) throw new Error(`activeMember(): registerMember failed for ${id}: ${JSON.stringify(r)}`);
  return { id, token: r.token, privateKey };
}

async function activeSubject() {
  const id = rid("subj");
  await sql`INSERT INTO swarm_subjects (id, status, name) VALUES (${id}, 'active', ${id})`;
  return id;
}

async function signedSubmission(m: { id: string; privateKey: CryptoKey }, date: string, subjectId: string, stance = "bullish") {
  const sub = { memberId: m.id, date, subjectId, nonce: rid("n"), stance, confidence: 0.7, body: "x" };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  return { ...sub, signature };
}

/** Open an epoch — the only way a session is convened (§4.1). */
async function openedEpoch(subjectId: string) {
  const opened = await ic.openEpoch(subjectId);
  if (!opened.ok) throw new Error(`openEpoch(${subjectId}) failed: ${JSON.stringify(opened)}`);
  const [row] = await sql<{ date: Date | string }[]>`SELECT date FROM swarm_sessions WHERE id = ${opened.sessionId}`;
  const date = row!.date instanceof Date ? row!.date.toISOString().slice(0, 10) : String(row!.date).slice(0, 10);
  return { sessionId: opened.sessionId, date };
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

// ── issue #779: renaming a subject must not leave its PAST sessions behind ──
// swarm_sessions.subject_name is denormalized off swarm_subjects.name
// (migration 0001_backends.sql) and, before this fix, updateSubjectAdmin wrote
// only swarm_subjects — leaving every already-convened session showing the old
// name on member track records next to chips that read the new one.
test("topics: renaming a subject backfills subject_name onto its existing sessions", async () => {
  const id = rid("topic");
  await admin.createSubjectAdmin({ id, name: "Old Name" });

  const { sessionId } = await openedEpoch(id);

  const before = (await sql`SELECT subject_name FROM swarm_sessions WHERE id = ${sessionId}`)[0];
  expect(before.subject_name).toBe("Old Name");

  const renamed = await admin.updateSubjectAdmin(id, 1, { name: "New Name" });
  expect(renamed.status).toBe(200);

  const after = (await sql`SELECT subject_name FROM swarm_sessions WHERE id = ${sessionId}`)[0];
  expect(after.subject_name).toBe("New Name");

  // A patch that leaves `name` untouched must not rewrite session rows at all
  // — this is a rename backfill, not an unconditional resync on every edit.
  const untouched = await admin.updateSubjectAdmin(id, 2, { operator: "someone" });
  expect(untouched.status).toBe(200);
  const stillNew = (await sql`SELECT subject_name FROM swarm_sessions WHERE id = ${sessionId}`)[0];
  expect(stillNew.subject_name).toBe("New Name");
});

// ── AC3: member activation/manual-add/reactivation/key rotation ────────────
test("members: manual add mints a one-time credential; deactivate revokes keys; reactivate + rotate mint fresh credentials", async () => {
  const { publicKeyB64 } = await generateKeyPair();
  const added = await admin.addMemberAdmin({ name: "Manual Member", publicKey: publicKeyB64 });
  expect(added.status).toBe(201);
  // Issue #690: the id is minted by addMemberAdmin, so the RESPONSE is where it
  // comes from — there is no caller-chosen string to assert against any more.
  const memberId = (added as any).member.id as string;
  const token1 = (added as any).token as string;
  expect(typeof token1).toBe("string");
  expect(await ic.memberIdForToken(token1)).toBe(memberId);

  // Duplicate detection moved from the id to the public key (issue #690): the
  // id can no longer repeat, and re-submitting the same credential is what an
  // operator double-submitting the add form actually does.
  expect((await admin.addMemberAdmin({ name: "x", publicKey: publicKeyB64 })).status).toBe(409);

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
  const activeKeys = await sql`SELECT id FROM swarm_member_keys WHERE member_id = ${memberId} AND active = true`;
  expect(activeKeys.length).toBe(1);

  // Free the roster slot this test claimed: the reactivate above (version 2 ->
  // 3) left `memberId` ACTIVE, and rotate (version 3 -> 4) doesn't touch
  // status, so nothing later deactivates it. Left active, it silently eats
  // one seat of SWARM_ROSTER_CAP (10) for the rest of this file's 10
  // activeMember() admissions — see the matching comment in "members:
  // application review approve/reject" above for the full 409 story that a
  // non-null-asserted `r.token!` was masking before issue #454.
  expect((await admin.deactivateMemberAdmin(memberId, 4)).status).toBe(200);
});

// ── Issue #799: an inactive member must not hold an authenticating token ──
// deactivateMemberAdmin revokes the member's active key, but
// rotateMemberKeyAdmin (the documented remedy for CARRIED_KEY_UNREGISTRABLE
// ahead of reactivation — see the comment above it in admin.ts) has never
// checked member status and mints a fresh ACTIVE key regardless. Before this
// fix that meant a member sitting at status='inactive' could still be handed
// a token that authenticated as a live member everywhere memberIdForToken()
// is the identity check: submitRecommendation (which is also the amendment
// path — a resubmit is just a higher revision through the same gate),
// postMemo, and updateMemberProfile. The fix joins swarm_members.status =
// 'active' into memberIdForToken() itself, so the token simply does not
// resolve to an identity — the same 401 an unknown token gets everywhere.
test("security: a token minted by rotating an INACTIVE member's key does not authenticate anywhere; an active member's token is unaffected", async () => {
  const member = await activeMember("to-deactivate");
  const control = await activeMember("stays-active");

  const deact = await admin.deactivateMemberAdmin(member.id, 1);
  expect(deact.status).toBe(200);

  // Rotate while still INACTIVE. deactivateMemberAdmin already flipped the
  // prior key to active=false, so rotateMemberKeyAdmin has no on-file active
  // key to carry forward and needs an explicit fresh publicKey — exactly the
  // real remedy an admin exercises ahead of reactivation.
  const { publicKeyB64: freshKey, privateKey: freshPrivateKey } = await generateKeyPair();
  const rotated = await admin.rotateMemberKeyAdmin(member.id, { publicKey: freshKey });
  expect(rotated.status).toBe(200);
  const inactiveToken = (rotated as any).token as string;
  expect(typeof inactiveToken).toBe("string");

  // Identity does not resolve for a rotated-while-inactive token.
  expect(await ic.memberIdForToken(inactiveToken)).toBeNull();

  // Every downstream write path that authenticates off memberIdForToken()
  // refuses it identically to an unknown token (401), never reaching its
  // own authorization logic.
  const memoResult = await ic.postMemo(inactiveToken, { sessionId: crypto.randomUUID(), body: "hi" });
  expect(memoResult.status).toBe(401);

  const profileResult = await ic.updateMemberProfile(inactiveToken, member.id, { tagline: "hi" });
  expect(profileResult.status).toBe(401);

  const subjectId = await activeSubject();
  const rotatedMember = { id: member.id, token: inactiveToken, privateKey: freshPrivateKey };
  const submission = await signedSubmission(rotatedMember, "2026-08-20", subjectId);
  const submitResult = await ic.submitRecommendation(inactiveToken, submission);
  expect(submitResult.status).toBe(401);

  // Control: an ACTIVE member's token is completely unaffected by this
  // change — identity still resolves, and a real write (profile edit, which
  // has no session/FK dependency to complicate the assertion) still succeeds.
  expect(await ic.memberIdForToken(control.token)).toBe(control.id);
  const controlProfile = await ic.updateMemberProfile(control.token, control.id, { tagline: "unaffected" });
  expect(controlProfile.status).toBe(200);

  // Free the roster slot `control` claimed (see the matching comment above).
  expect((await admin.deactivateMemberAdmin(control.id, 1)).status).toBe(200);
});

test("members: application review approve/reject", async () => {
  const { memberId, applied } = await signedApply("Applicant");
  expect(applied.status).toBe(201);

  const approve = await admin.reviewApplicationAdmin(memberId, "approve");
  expect(approve.status).toBe(200);
  expect(approve).not.toHaveProperty("token");
  expect((approve as any).claimRequired).toBe(true);

  const { memberId: memberId2, applied: applied2 } = await signedApply("Applicant2");
  expect(applied2.status).toBe(201);
  const reject = await admin.reviewApplicationAdmin(memberId2, "reject");
  expect(reject.status).toBe(200);
  // swarm_members.status has no 'rejected' value (CHECK constraint from
  // #150's migration) — the member folds to 'inactive' and the REJECTION
  // itself is recorded on the application row.
  const rejectedMember = (await admin.listMembersAdmin()).find((m: any) => m.id === memberId2);
  expect(rejectedMember!.status).toBe("inactive");
  const apps = await admin.listApplicationsAdmin("rejected");
  expect(apps.some((a: any) => a.member_id === memberId2)).toBe(true);

  // Free the roster slot this test claimed: `memberId` is left ACTIVE by the
  // approve above (version bumped 1 -> 2 by activateMember) with nothing later
  // depending on it staying active. Left active, it silently eats one seat of
  // SWARM_ROSTER_CAP (10) for the rest of this file's 10 activeMember()
  // admissions — exactly enough to 409 the very last one. That 409 was masked
  // for a long time by `activeMember()`'s non-null-asserted `r.token!`
  // (undefined, not thrown) until the typecheck widening (issue #454) forced a
  // real `"token" in r` narrowing that fails loudly instead.
  expect((await admin.deactivateMemberAdmin(memberId, 2)).status).toBe(200);
});

// ── AC4 (session creation): the epoch opens, snapshots the roster, enqueues nothing ──
test("epoch open: refuses an inactive or unknown subject; snapshots the active roster; enqueues NOTHING", async () => {
  const subjectId = await activeSubject();
  const m1 = await activeMember("m1");
  const m2 = await activeMember("m2");

  const inactiveSubject = rid("inact");
  await sql`INSERT INTO swarm_subjects (id, status, name) VALUES (${inactiveSubject}, 'inactive', 'Inactive')`;
  expect(await ic.openEpoch(inactiveSubject)).toMatchObject({ ok: false, status: 409, error: "subject_not_active" });
  expect(await ic.openEpoch(rid("nope"))).toMatchObject({ ok: false, status: 404, error: "subject_not_found" });

  const opened = await ic.openEpoch(subjectId);
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  expect(opened.status).toBe(201);
  const sessionId = opened.sessionId;
  expect((await sql`SELECT state FROM swarm_sessions WHERE id = ${sessionId}`)[0]!.state).toBe("collecting");

  // This test has a database of its own, so the snapshot is exactly the two
  // active members, each `expected`.
  const roster = await admin.getSessionRoster(sessionId);
  expect(roster.map((r: any) => [r.member_id, r.status]).sort())
    .toEqual([[m1.id, "expected"], [m2.id, "expected"]].sort());

  // NO LIFECYCLE JOBS (issue #1026 W4). Session creation used to enqueue five
  // session-scoped rows — publish_brief, close_window, aggregate, judge,
  // publish — each with its own `run_after`. Scheduler spec §4.4 removes the
  // scheduled lifecycle entirely: a session is `collecting` from its first
  // instant, the boundary is a timer `system-scheduler` holds, and settlement
  // is "a chain the scheduler drives through the API, each step as soon as the
  // previous one returns". The assertion is kept inverted, because "no swarm
  // job is enqueued here" is the property that has to keep holding.
  const swarmJobs = await sql<{ kind: string }[]>`
    SELECT kind FROM jobs WHERE payload->>'sessionId' = ${sessionId}`;
  expect(swarmJobs.map((j) => j.kind)).toEqual([]);

  // Opening again returns the open epoch (§4.1) and still enqueues nothing.
  const again = await ic.openEpoch(subjectId);
  expect(again).toMatchObject({ ok: true, status: 200, sessionId, created: false });
  expect((await sql`SELECT id FROM jobs WHERE payload->>'sessionId' = ${sessionId}`).length).toBe(0);
});

// REMOVED WITH THE FIVE-JOB ENQUEUE (issue #1026 W4).
//
// Two tests stood here. One pinned that re-creating a still-`scheduled` session
// RE-ARMED its five lifecycle jobs to the new timeline (issue #1019); the other
// pinned that a pre-#767 session missing its `swarm.judge` row was repaired by
// re-creating it. Both are statements about `createSessionAdmin` enqueuing
// the five lifecycle steps,
// and it no longer does: scheduler spec §4.4 makes settlement "not scheduled",
// so there is no run_after to re-arm and no missing job to repair. They are
// deleted rather than weakened — a test asserting a behaviour that has been
// deliberately removed has nothing left to protect.
//
// What replaces them is backend/tests/epoch-turnover.test.ts and
// epoch-settlement.test.ts, which pin the same underlying property — a
// transition fired twice does not happen twice — against the epoch path.

// ── AC5: roster add/excuse/restore blocked once collection begins ──────────
test("roster: add/excuse/restore work pre-collection and are blocked after collecting starts", async () => {
  const subjectId = await activeSubject();
  const m1 = await activeMember("r1");

  // PRE-COLLECTION. No path convenes a `scheduled` session any more (an epoch
  // is born `collecting`), but the roster edits still answer for one, and a
  // legacy row of that shape can exist in a migrated database. The row is
  // written here directly for that reason, with m1 seated as the retired
  // create would have seated it.
  const [legacy] = await sql<{ id: string }[]>`
    INSERT INTO swarm_sessions (subject_id, subject_name, state) VALUES (${subjectId}, ${subjectId}, 'scheduled')
    RETURNING id`;
  const legacyId = String(legacy!.id);
  await sql`INSERT INTO swarm_session_members (session_id, member_id, member_name, status)
            VALUES (${legacyId}, ${m1.id}, 'r1', 'expected')`;
  const m2 = await activeMember("r2"); // not on the legacy snapshot
  expect((await admin.rosterAddAdmin(legacyId, m2.id)).status).toBe(200);
  expect((await admin.rosterExcuseAdmin(legacyId, m1.id)).status).toBe(200);
  expect((await admin.rosterRestoreAdmin(legacyId, m1.id)).status).toBe(200);

  // COLLECTING: an epoch's roster is locked from its first instant.
  const subjectB = await activeSubject();
  const { sessionId } = await openedEpoch(subjectB);
  expect((await admin.rosterAddAdmin(sessionId, m2.id)).status).toBe(409);
  expect((await admin.rosterExcuseAdmin(sessionId, m1.id)).status).toBe(409);
  expect((await admin.rosterRestoreAdmin(sessionId, m1.id)).status).toBe(409);
  // RED CONTROL for the lock: the audited forced excusal is the one edit a
  // collecting roster takes, so the 409s above are the lock, not a bad id.
  expect((await admin.rosterExcuseAdmin(sessionId, m1.id, admin.ADMIN_ACTOR, { force: true })).status).toBe(200);
});

// ── AC6: submission requires an expected roster row; excused is rejected ───
test("submission: a member off the frozen roster (or excused) is rejected; a roster member succeeds", async () => {
  const subjectId = await activeSubject();
  const onRoster = await activeMember("onroster");
  const excused = await activeMember("excused");
  // OFF THE ROSTER. Every admission path seats a member in the epochs still
  // collecting (domain.ts seatInCollectingEpochsTx), so no API path produces
  // an active member missing from a collecting epoch's roster; the roster gate
  // is defence in depth. The state is planted: a member that held the judge
  // role when the epoch opened (judges hold no seat) and whose role was then
  // changed underneath the admin path that would have seated it.
  const offRoster = await activeMember("offroster");
  await sql`UPDATE swarm_members SET role = 'judge' WHERE id = ${offRoster.id}`;
  const { sessionId, date } = await openedEpoch(subjectId);
  await sql`UPDATE swarm_members SET role = 'member' WHERE id = ${offRoster.id}`;
  expect((await admin.rosterExcuseAdmin(sessionId, excused.id, admin.ADMIN_ACTOR, { force: true })).status).toBe(200);

  const okSub = await ic.submitRecommendation(onRoster.token, await signedSubmission(onRoster, date, subjectId));
  expect(okSub.status).toBe(201);

  const rejected = await ic.submitRecommendation(offRoster.token, await signedSubmission(offRoster, date, subjectId));
  expect(rejected.status).toBe(403);
  expect((rejected as { error: string }).error).toContain("not on this session's expected roster");
  const refusedExcused = await ic.submitRecommendation(excused.token, await signedSubmission(excused, date, subjectId));
  expect(refusedExcused.status).toBe(403);
  expect((refusedExcused as { error: string }).error).toContain("excused");
});

// ── AC6: aggregate denominators use non-excused roster snapshot rows ───────
test("aggregate: quorum denominator is the frozen roster (excluding excused), not live active-member count", async () => {
  const subjectId = await activeSubject();
  const a = await activeMember("agg-a");
  const b = await activeMember("agg-b");
  const { sessionId, date } = await openedEpoch(subjectId);
  // The roster snapshot legitimately includes every OTHER active member of this
  // file too — the invariant under test is relative: excusing b removes exactly
  // one from the denominator, and a member who joins AFTER the epoch closed
  // never inflates it.
  const rosterTotal = (await admin.getSessionRoster(sessionId)).length;

  await admin.rosterExcuseAdmin(sessionId, b.id, admin.ADMIN_ACTOR, { force: true });
  await ic.submitRecommendation(a.token, await signedSubmission(a, date, subjectId));
  const turned = await ic.turnOverEpoch(subjectId, sessionId);
  expect(turned.ok).toBe(true);

  // A member activated after the close is seated in the SUCCESSOR, which is
  // still collecting — never in the closed epoch being aggregated.
  const late = await activeMember("agg-c-after-close");
  if (turned.ok) {
    const successorRoster = (await admin.getSessionRoster(turned.openedSessionId)).map((r: any) => r.member_id);
    expect(successorRoster).toContain(late.id);
  }
  expect((await admin.getSessionRoster(sessionId)).map((r: any) => r.member_id)).not.toContain(late.id);

  const rollup = await ic.aggregateSession(sessionId);

  // Denominator is (rosterTotal - 1) — everyone snapshotted MINUS the one
  // excused member `b` — never the live active-member count (which would
  // additionally include the post-close member).
  expect(rollup.quorum.active).toBe(rosterTotal - 1);
  expect(rollup.quorum.submitted).toBe(1);
  expect(rollup.quorum.absent).toBe(rosterTotal - 1 - 1);
});

// ── AC4 (lifecycle): legal/illegal/terminal/stale-version/idempotent ───────
test("guarded lifecycle: legal transitions succeed with one event+audit row; illegal/terminal/stale are rejected; repeats are idempotent", async () => {
  const subjectId = await activeSubject();
  await activeMember("lc1");
  const { sessionId } = await openedEpoch(subjectId);

  const auditCountFor = async (toState: string) =>
    Number((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'session_transition' AND scope->>'sessionId' = ${sessionId} AND scope->>'to' = ${toState}`)[0].n);
  const eventCountFor = async (toState: string) =>
    Number((await sql`SELECT count(*)::int AS n FROM swarm_session_events WHERE session_id = ${sessionId} AND to_state = ${toState}`)[0].n);

  // Illegal: cannot aggregate directly from 'collecting'.
  const illegal = await admin.aggregateSessionAdmin(sessionId, 1);
  expect(illegal.status).toBe(409);
  expect((illegal as any).error).toContain("illegal_transition");

  // Stale version.
  const stale = await admin.closeSessionAdmin(sessionId, 99);
  expect(stale.status).toBe(409);
  expect((stale as any).error).toBe("stale_version");

  // Legal: collecting -> window_closed (the epoch is born collecting, §4.1).
  const close = await admin.closeSessionAdmin(sessionId, 1);
  expect(close.status).toBe(200);
  expect((close as any).session.state).toBe("window_closed");
  expect((close as any).session.version).toBe(2);
  expect(await eventCountFor("window_closed")).toBe(1);
  expect(await auditCountFor("window_closed")).toBe(1);

  // Every real transition's event row carries the canonical action verb
  // (docs §4 US-C4), not just the target state.
  const eventRow = (await sql`SELECT action FROM swarm_session_events WHERE session_id = ${sessionId} AND to_state = 'window_closed'`)[0];
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
  const row = (await sql`SELECT published_at FROM swarm_sessions WHERE id = ${sessionId}`)[0];
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
  const { sessionId } = await openedEpoch(subjectId);
  const cancel = await admin.cancelSessionAdmin(sessionId, 1, admin.ADMIN_ACTOR, "operator error");
  expect(cancel.status).toBe(200);
  expect((cancel as any).session.state).toBe("cancelled");
  const eventRow = (await sql`SELECT action, reason FROM swarm_session_events WHERE session_id = ${sessionId} AND to_state = 'cancelled'`)[0];
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
