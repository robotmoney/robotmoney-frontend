// Issue #563 — flag members that activate and never submit a take, and
// established members that go quiet after an initial one. Both are computed
// on read by admin.getMemberSilenceFlags() from swarm_session_members
// (eligibility) and swarm_recommendations (submission), never persisted.
//
// Runs against the ephemeral Postgres from tests/preload.ts (already fully
// migrated).
import { expect, test } from "bun:test";
import * as admin from "../src/swarm/admin.ts";
import * as ic from "../src/swarm/domain.ts";
import { sql } from "../src/db/client.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";
import { handleSwarmAdmin } from "../src/api/routes/swarm-admin.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

const INSECURE = { adminToken: null, allowInsecure: true } as const;

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const N = admin.SWARM_SILENCE_THRESHOLD_SESSIONS;

useCleanDatabasePerTest(import.meta.file);

// addMemberAdmin, not registerMember: it sets activated_at = now() at
// creation (registerMember, the demo/e2e shortcut most other swarm tests use,
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
  const id = rid("subj");
  await sql`INSERT INTO swarm_subjects (id, status, name) VALUES (${id}, 'active', ${id})`;
  return id;
}

function sessionTimes(date: string) {
  return {
    date,
    briefOpensAt: `${date}T09:00:00Z`,
    windowClosesAt: `${date}T10:00:00Z`,
    publishAt: `${date}T10:05:00Z`,
  };
}

async function createSession(subjectId: string, date: string) {
  const created = await admin.createSessionAdmin({ ...sessionTimes(date), subjectId });
  if (created.status !== 201 && created.status !== 200) throw new Error(`createSession(${date}) failed: ${JSON.stringify(created)}`);
  return (created as any).session.id as string;
}

async function submit(m: { id: string; token: string; privateKey: CryptoKey }, date: string, subjectId: string) {
  const sub = { memberId: m.id, date, subjectId, nonce: rid("n"), stance: "bullish", confidence: 0.7, body: "x" };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  const r = await ic.submitRecommendation(m.token, { ...sub, signature });
  if (r.status !== 201) throw new Error(`submit(${m.id}, ${date}) failed: ${JSON.stringify(r)}`);
  return r;
}

// Sequential UTC dates from 2026-09-01, far enough past "now" (the suite runs
// in 2026-08) that briefOpensAt/windowClosesAt are always in the future
// relative to the real clock submitRecommendation checks, and always after
// activated_at (set to real now() by addMemberAdmin above).
function datesFrom(startDay: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `2026-09-${String(startDay + i).padStart(2, "0")}`);
}

test("never fires on a single missed session — the issue's explicit constraint", async () => {
  const subjectId = await activeSubject();
  const quiet = await activeMember("quiet-once");
  await createSession(subjectId, "2026-09-01");

  const flags = await admin.getMemberSilenceFlags();
  expect(flags[quiet.id]).toBeUndefined();
});

test("never_submitted: fires only once an active member has been eligible for >= N sessions with zero takes", async () => {
  const subjectId = await activeSubject();
  const neverSubmits = await activeMember("never-submits");
  const dates = datesFrom(1, N);

  // One short of the threshold: not flagged yet.
  for (const date of dates.slice(0, N - 1)) await createSession(subjectId, date);
  expect((await admin.getMemberSilenceFlags())[neverSubmits.id]).toBeUndefined();

  // The Nth eligible session tips it over.
  await createSession(subjectId, dates[N - 1]!);
  const flags = await admin.getMemberSilenceFlags();
  expect(flags[neverSubmits.id]).toEqual({ type: "never_submitted", sessionsSinceReference: N });
});

test("never_submitted: a single take anywhere clears the flag, even after N eligible sessions", async () => {
  const subjectId = await activeSubject();
  const m = await activeMember("submits-once");
  const dates = datesFrom(1, N);
  for (const date of dates) await createSession(subjectId, date);
  await submit(m, dates[dates.length - 1]!, subjectId);

  expect((await admin.getMemberSilenceFlags())[m.id]).toBeUndefined();
});

test("never_submitted: a session the member was never seated in does not count toward N", async () => {
  const subjectId = await activeSubject();
  const dates = datesFrom(1, N);
  // Seat the member for only N-1 of the N sessions by creating it AFTER the
  // first session's roster is already frozen — createSessionAdmin snapshots
  // whoever is active at creation time, so this member is absent from
  // session 1's swarm_session_members entirely (not merely non-submitting).
  await createSession(subjectId, dates[0]!);
  const lateJoiner = await activeMember("late-joiner");
  for (const date of dates.slice(1)) await createSession(subjectId, date);

  expect((await admin.getMemberSilenceFlags())[lateJoiner.id]).toBeUndefined();
});

test("never_submitted: an excused session does not count toward N — silence is not exclusion", async () => {
  const subjectId = await activeSubject();
  const m = await activeMember("excused-member");
  const dates = datesFrom(1, N + 1);
  for (const date of dates) {
    const sessionId = await createSession(subjectId, date);
    if (date !== dates[dates.length - 1]) {
      expect((await admin.rosterExcuseAdmin(sessionId, m.id)).status).toBe(200);
    }
  }
  // N sessions ran, but all but one were excused — only one eligible session
  // on file, nowhere near the threshold.
  expect((await admin.getMemberSilenceFlags())[m.id]).toBeUndefined();
});

test("gone_quiet: an established member with N silent sessions since its own last take is flagged, distinctly from never_submitted", async () => {
  const subjectId = await activeSubject();
  const wentQuiet = await activeMember("went-quiet");
  await createSession(subjectId, "2026-09-01");
  await submit(wentQuiet, "2026-09-01", subjectId);

  const silentDates = datesFrom(2, N);
  for (const date of silentDates.slice(0, N - 1)) await createSession(subjectId, date);
  expect((await admin.getMemberSilenceFlags())[wentQuiet.id]).toBeUndefined();

  await createSession(subjectId, silentDates[N - 1]!);
  const flags = await admin.getMemberSilenceFlags();
  expect(flags[wentQuiet.id]).toEqual({ type: "gone_quiet", sessionsSinceReference: N });
});

test("gone_quiet: a fresh take on the most recent eligible session resets the silence window", async () => {
  const subjectId = await activeSubject();
  const m = await activeMember("resumes-late");
  const dates = datesFrom(1, N + 1);
  await createSession(subjectId, dates[0]!);
  await submit(m, dates[0]!, subjectId);
  for (const date of dates.slice(1, dates.length - 1)) await createSession(subjectId, date);
  // One more session, and THIS TIME the member submits again — the reference
  // point for "since" moves to here, so it is no longer silent.
  await createSession(subjectId, dates[dates.length - 1]!);
  await submit(m, dates[dates.length - 1]!, subjectId);

  expect((await admin.getMemberSilenceFlags())[m.id]).toBeUndefined();
});

test("an inactive (deactivated) member is never flagged, regardless of session history", async () => {
  const subjectId = await activeSubject();
  const m = await activeMember("deactivated-quiet");
  for (const date of datesFrom(1, N)) await createSession(subjectId, date);
  expect((await admin.getMemberSilenceFlags())[m.id]).toEqual({ type: "never_submitted", sessionsSinceReference: N });

  const deact = await admin.deactivateMemberAdmin(m.id, 1);
  expect(deact.status).toBe(200);
  expect((await admin.getMemberSilenceFlags())[m.id]).toBeUndefined();
});

test("the admin members-list route serves silenceFlags alongside members, keyed by member id", async () => {
  const subjectId = await activeSubject();
  const flagged = await activeMember("route-flagged");
  for (const date of datesFrom(1, N)) await createSession(subjectId, date);

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
