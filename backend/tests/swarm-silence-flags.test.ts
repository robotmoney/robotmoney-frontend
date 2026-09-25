// Issue #563 — flag members that activate and never submit a take, and
// established members that go quiet after an initial one. Both are computed
// on read by admin.getMemberSilenceFlags() from swarm_session_members
// (eligibility) and swarm_recommendations (submission), never persisted.
//
// Runs against the ephemeral Postgres from tests/preload.ts (already fully
// migrated).
//
// SESSIONS ARE EPOCHS (issue #1026, D55 decision 4). These tests used to
// convene each session through the retired admin session create. They now
// drive a subject's epochs the way `system-scheduler` does: open the first,
// then turn each over into the next. An epoch seats every active member in the
// transaction that opens it (domain.ts insertEpoch), which is the eligibility
// record silence is counted from.
import { expect, test } from "bun:test";
import * as admin from "../src/swarm/admin.ts";
import * as ic from "../src/swarm/domain.ts";
import { sql } from "../src/db/client.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";
import { handleSwarmAdmin } from "../src/api/routes/swarm-admin.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { activeSubject as epochSubject, sessionDate, sessionRow } from "./support/epoch-fixtures.ts";

const INSECURE = { adminToken: null, allowInsecure: true } as const;

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const N = admin.SWARM_SILENCE_THRESHOLD_SESSIONS;

useCleanDatabasePerTest(import.meta.file);

// addMemberAdmin, not registerMember: it sets activated_at = now() at
// creation (registerMember, the smoke/e2e shortcut most other swarm tests use,
// deliberately does not — see roster-seed.ts's header — which would make
// every session read as "before activation" and no eligible session would
// ever accumulate).
async function activeMember(name: string) {
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const added = await admin.addMemberAdmin({ name, publicKey: publicKeyB64 });
  if (added.status !== 201) throw new Error(`activeMember(${name}) failed: ${JSON.stringify(added)}`);
  return { id: (added as any).member.id as string, token: (added as any).token as string, privateKey };
}

async function activeSubject() {
  return epochSubject("subj", 3600);
}

// The subject's current collecting epoch, per subject, so each call convenes
// the NEXT session: the first call opens an epoch, every later call turns the
// current one over (closing it, recording its absences, opening its
// successor) — exactly the scheduler's boundary.
const currentEpoch = new Map<string, string>();

async function nextSession(subjectId: string): Promise<string> {
  const current = currentEpoch.get(subjectId);
  if (!current) {
    const opened = await ic.openEpoch(subjectId);
    if (!opened.ok) throw new Error(`openEpoch(${subjectId}) failed: ${JSON.stringify(opened)}`);
    currentEpoch.set(subjectId, opened.sessionId);
    return opened.sessionId;
  }
  const turned = await ic.turnOverEpoch(subjectId, current);
  if (!turned.ok) throw new Error(`turnOverEpoch(${subjectId}) failed: ${JSON.stringify(turned)}`);
  currentEpoch.set(subjectId, turned.openedSessionId);
  return turned.openedSessionId;
}

/** Convene `count` consecutive sessions for the subject; returns their ids in order. */
async function convene(subjectId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) ids.push(await nextSession(subjectId));
  return ids;
}

async function submit(m: { id: string; token: string; privateKey: CryptoKey }, sessionId: string, subjectId: string) {
  const date = sessionDate(await sessionRow(sessionId));
  const sub = { memberId: m.id, date, subjectId, nonce: rid("n"), stance: "bullish", confidence: 0.7, body: "x" };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  const r = await ic.submitRecommendation(m.token, { ...sub, signature });
  if (r.status !== 201) throw new Error(`submit(${m.id}, ${sessionId}) failed: ${JSON.stringify(r)}`);
  return r;
}

/**
 * File one take in the subject's CURRENT epoch, which is collecting. A take
 * lands only in a collecting epoch before its close (system-scheduler-spec.md
 * §4.2); the next `nextSession` then turns it over, as the boundary would.
 */
async function submitInWindow(
  m: { id: string; token: string; privateKey: CryptoKey },
  sessionId: string,
  subjectId: string,
) {
  return submit(m, sessionId, subjectId);
}

test("never fires on a single missed session — the issue's explicit constraint", async () => {
  const subjectId = await activeSubject();
  const quiet = await activeMember("quiet-once");
  await convene(subjectId, 1);

  const flags = await admin.getMemberSilenceFlags();
  expect(flags[quiet.id]).toBeUndefined();
});

test("never_submitted: fires only once an active member has been eligible for >= N sessions with zero takes", async () => {
  const subjectId = await activeSubject();
  const neverSubmits = await activeMember("never-submits");

  // One short of the threshold: not flagged yet.
  await convene(subjectId, N - 1);
  expect((await admin.getMemberSilenceFlags())[neverSubmits.id]).toBeUndefined();

  // The Nth eligible session tips it over.
  await convene(subjectId, 1);
  const flags = await admin.getMemberSilenceFlags();
  expect(flags[neverSubmits.id]).toEqual({ type: "never_submitted", sessionsSinceReference: N });
});

test("never_submitted: a single take anywhere clears the flag, even after N eligible sessions", async () => {
  const subjectId = await activeSubject();
  const m = await activeMember("submits-once");
  const ids = await convene(subjectId, N);
  await submitInWindow(m, ids[ids.length - 1]!, subjectId);

  expect((await admin.getMemberSilenceFlags())[m.id]).toBeUndefined();
});

test("never_submitted: a session the member was never seated in does not count toward N", async () => {
  const subjectId = await activeSubject();
  // Seat the member for only N-1 of the N sessions by activating it AFTER the
  // first epoch has closed — an epoch seats whoever is active when it opens
  // (and a member activated while it is still collecting), so this member is
  // absent from session 1's swarm_session_members entirely (not merely
  // non-submitting).
  const [first] = await convene(subjectId, 2);
  const lateJoiner = await activeMember("late-joiner");
  await convene(subjectId, N - 2);
  const seatedIn = await sql<{ session_id: string }[]>`
    SELECT session_id FROM swarm_session_members WHERE member_id = ${lateJoiner.id}`;
  expect(seatedIn.map((r) => String(r.session_id))).not.toContain(String(first));

  expect((await admin.getMemberSilenceFlags())[lateJoiner.id]).toBeUndefined();
});

test("never_submitted: an excused session does not count toward N — silence is not exclusion", async () => {
  const subjectId = await activeSubject();
  const m = await activeMember("excused-member");
  for (let i = 0; i < N + 1; i += 1) {
    const sessionId = await nextSession(subjectId);
    if (i < N) {
      // An epoch is `collecting` from its first instant, so the roster is
      // already live: the excusal is the audited forced one.
      expect((await admin.rosterExcuseAdmin(sessionId, m.id, admin.ADMIN_ACTOR, { force: true })).status).toBe(200);
    }
  }
  // N sessions ran, but all but one were excused — only one eligible session
  // on file, nowhere near the threshold.
  expect((await admin.getMemberSilenceFlags())[m.id]).toBeUndefined();
});

test("gone_quiet: an established member with N silent sessions since its own last take is flagged, distinctly from never_submitted", async () => {
  const subjectId = await activeSubject();
  const wentQuiet = await activeMember("went-quiet");
  await submitInWindow(wentQuiet, await nextSession(subjectId), subjectId);

  await convene(subjectId, N - 1);
  expect((await admin.getMemberSilenceFlags())[wentQuiet.id]).toBeUndefined();

  await convene(subjectId, 1);
  const flags = await admin.getMemberSilenceFlags();
  expect(flags[wentQuiet.id]).toEqual({ type: "gone_quiet", sessionsSinceReference: N });
});

test("gone_quiet: a fresh take on the most recent eligible session resets the silence window", async () => {
  const subjectId = await activeSubject();
  const m = await activeMember("resumes-late");
  await submitInWindow(m, await nextSession(subjectId), subjectId);
  await convene(subjectId, N - 1);
  // One more session, and THIS TIME the member submits again — the reference
  // point for "since" moves to here, so it is no longer silent.
  await submitInWindow(m, await nextSession(subjectId), subjectId);

  expect((await admin.getMemberSilenceFlags())[m.id]).toBeUndefined();
});

test("an inactive (deactivated) member is never flagged, regardless of session history", async () => {
  const subjectId = await activeSubject();
  const m = await activeMember("deactivated-quiet");
  await convene(subjectId, N);
  expect((await admin.getMemberSilenceFlags())[m.id]).toEqual({ type: "never_submitted", sessionsSinceReference: N });

  const deact = await admin.deactivateMemberAdmin(m.id, 1);
  expect(deact.status).toBe(200);
  expect((await admin.getMemberSilenceFlags())[m.id]).toBeUndefined();
});

test("the admin members-list route serves silenceFlags alongside members, keyed by member id", async () => {
  const subjectId = await activeSubject();
  const flagged = await activeMember("route-flagged");
  await convene(subjectId, N);

  const res = await handleSwarmAdmin(
    new Request("http://x/api/swarm/admin/members", { method: "GET" }),
    new URL("http://x/api/swarm/admin/members"),
    INSECURE,
  );
  expect(res?.status).toBe(200);
  const body = res!.body as { members: unknown[]; silenceFlags: Record<string, unknown> };
  expect(Array.isArray(body.members)).toBe(true);
  expect(body.silenceFlags[flagged.id]).toEqual({ type: "never_submitted", sessionsSinceReference: N });
});
