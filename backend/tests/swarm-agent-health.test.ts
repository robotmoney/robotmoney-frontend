// Agent-health surface (issue #208; resolved design scout #214): a roster
// member that misses its expected submission window, and a rejected/tampered
// submission signature, were previously visible only in an agent's own
// stdout. Both are now recorded on a durable, queryable, append-only event
// log (swarm_agent_health_events) and exposed admin-only via
// GET /api/swarm/admin/agent-health.
import { test, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as ic from "../src/swarm/domain.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";
import { config } from "../src/config.ts";
import { sql } from "../src/db/client.ts";
import { handleSwarmAdmin } from "../src/api/routes/swarm-admin.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { ensureProseSubject } from "./support/prose-subject.ts";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

// A session's date is whatever the DATABASE derived from convened_at
// (migration 0022). postgres returns it as a Date; normalise to the YYYY-MM-DD
// the API and the signing payload use. Tests read this — they never choose it.
const sessionDate = (s: Record<string, unknown>): string =>
  s.date instanceof Date ? s.date.toISOString().slice(0, 10) : String(s.date).slice(0, 10);

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

// Own database per file, cloned from the migrated template — the roster this
// file admits into is its own, with no reset of anyone else's rows.
useCleanDatabase(import.meta.file);

async function activeMember() {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  // Fail LOUD, not silent: a roster-cap 409 here (r.token undefined) must
  // never quietly flow into a swarm_session_members insert for a
  // memberId that was never actually created (a confusing downstream FK
  // violation instead of a clear assertion failure at the actual cause).
  if (!("token" in r) || !r.token) throw new Error(`activeMember() setup failed for ${id}: ${JSON.stringify(r)}`);
  return { id, token: r.token, privateKey };
}

async function getAgentHealth(query: string) {
  const req = new Request(`http://test/api/swarm/admin/agent-health${query}`);
  return handleSwarmAdmin(req, new URL(req.url));
}

test("closeWindow records exactly one absent event per missing expected roster member; queryable by session/member and counted", async () => {
  const subj = rid("s");
  await ensureProseSubject(subj, "S");
  const present = await activeMember();
  const absent = await activeMember();
  const session = await ic.openSession(subj);
  // The DATABASE dates the session (migration 0022) — read it back rather
  // than asserting a date this test chose.
  const date = sessionDate(session);
  for (const m of [present, absent]) {
    await sql`INSERT INTO swarm_session_members (session_id, member_id, member_name, status)
              VALUES (${session.id}, ${m.id}, ${m.id}, 'expected')`;
  }
  await ic.publishBrief(session.id, 60);

  const sub = { memberId: present.id, date, subjectId: subj, nonce: rid("n"), stance: "neutral", confidence: 0.5, body: "present" };
  const signature = await signMessage(canonicalizeSubmission(sub), present.privateKey);
  expect((await ic.submitRecommendation(present.token, { ...sub, signature })).status).toBe(201);

  // present member never gets an absent event; the driven session's other
  // active-roster member never submits and IS recorded absent at closeWindow.
  await ic.closeWindow(session.id);

  const rows = await sql<{ event_type: string; session_id: string; member_id: string; detail: unknown }[]>`
    SELECT event_type, session_id, member_id, detail FROM swarm_agent_health_events
    WHERE session_id = ${session.id}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.event_type).toBe("absent");
  expect(rows[0]!.member_id).toBe(absent.id);
  expect(rows[0]!.detail).toEqual({ reason: "missed submission window" });

  // Idempotent / restart-safe: a retried close_window job on the same session
  // (e.g. after a worker restart) never doubles the absence event.
  await ic.closeWindow(session.id);
  const afterRetry = await sql`SELECT id FROM swarm_agent_health_events WHERE session_id = ${session.id}`;
  expect(afterRetry.length).toBe(1);

  // Queryable via the domain projection directly...
  const projection = await ic.getAgentHealthEvents({ sessionId: session.id });
  expect(projection.events).toHaveLength(1);
  expect(projection.events[0]!.eventType).toBe("absent");
  expect(projection.events[0]!.memberId).toBe(absent.id);
  expect(projection.counts.absent).toBe(1);

  // ...and via the admin-only REST projection.
  const httpResult = await getAgentHealth(`?sessionId=${session.id}`);
  expect(httpResult?.status).toBe(200);
  const body = httpResult?.body as { events: { eventType: string; memberId: string }[]; counts: Record<string, number> };
  expect(body.events).toHaveLength(1);
  expect(body.events[0]!.eventType).toBe("absent");
  expect(body.events[0]!.memberId).toBe(absent.id);
  expect(body.counts.absent).toBe(1);

  const byMember = await getAgentHealth(`?memberId=${absent.id}&eventType=absent`);
  expect((byMember?.body as { events: unknown[] }).events).toHaveLength(1);

  const excludedByPresentMember = await getAgentHealth(`?memberId=${present.id}`);
  expect((excludedByPresentMember?.body as { events: unknown[] }).events).toHaveLength(0);
});

test("closeWindow closes the window even when the absence record cannot be written (telemetry never rolls back the transition)", async () => {
  // The production incident that motivates this: closeWindow used to run the
  // state transition and the absence inserts in ONE transaction, so a failure
  // in the inserts (here: the partial unique index the ON CONFLICT clause
  // depends on is missing) rolled the transition back. The job retried and
  // settled `dead`, and the session stayed `collecting` forever — blocking
  // every later lifecycle step and every submission for its subject.
  const subj = rid("s3");
  await ic.ensureSubject(subj, "S3");
  const present = await activeMember();
  const absent = await activeMember();
  const session = await ic.openSession(subj);
  const date = sessionDate(session);
  for (const m of [present, absent]) {
    await sql`INSERT INTO swarm_session_members (session_id, member_id, member_name, status)
              VALUES (${session.id}, ${m.id}, ${m.id}, 'expected')`;
  }
  await ic.publishBrief(session.id, 60);

  const sub = { memberId: present.id, date, subjectId: subj, nonce: rid("n"), stance: "neutral", confidence: 0.5, body: "present" };
  const signature = await signMessage(canonicalizeSubmission(sub), present.privateKey);
  expect((await ic.submitRecommendation(present.token, { ...sub, signature })).status).toBe(201);

  // Break the absence-record path: drop the partial unique index that the
  // insert's ON CONFLICT (session_id, member_id) WHERE event_type='absent'
  // clause targets. Every such insert now fails.
  await sql`DROP INDEX swarm_agent_health_events_absent_once_idx`;
  try {
    const result = await ic.closeWindow(session.id);
    // The transition COMMITTED despite the telemetry failure...
    const state = (await sql<{ state: string }[]>`SELECT state FROM swarm_sessions WHERE id = ${session.id}`)[0]!.state;
    expect(state).toBe("window_closed");
    // ...and the failure is surfaced in the return value, not thrown.
    expect(result).toMatchObject({ sessionId: session.id, state: "window_closed" });
    const warnings = (result as { telemetryWarnings?: string[] }).telemetryWarnings ?? [];
    expect(warnings.some((w) => w.includes("absence event for"))).toBe(true);
    // The session closed with no absence event on the record — the honest
    // outcome of a broken telemetry path; the alternative (an open window)
    // is the incident.
    const rows = await sql`SELECT id FROM swarm_agent_health_events WHERE session_id = ${session.id}`;
    expect(rows).toHaveLength(0);

    // A re-close is still a no-op and still does not throw.
    await ic.closeWindow(session.id);
  } finally {
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS swarm_agent_health_events_absent_once_idx
        ON swarm_agent_health_events (session_id, member_id)
        WHERE event_type = 'absent'`;
  }
});

test("a wrong-key/tampered submission is rejected 400 and recorded to the durable rejected-signature surface", async () => {
  const subj = rid("s2");
  await ensureProseSubject(subj, "S2");
  const m = await activeMember();
  const session = await ic.openSession(subj);
  // The DATABASE dates the session (migration 0022) — read it back rather
  // than asserting a date this test chose.
  const date = sessionDate(session);
  await sql`INSERT INTO swarm_session_members (session_id, member_id, member_name, status)
            VALUES (${session.id}, ${m.id}, ${m.id}, 'expected')`;
  await ic.publishBrief(session.id, 60);

  const sub = { memberId: m.id, date, subjectId: subj, nonce: rid("n"), stance: "bullish", confidence: 0.7, body: "x" };
  // Sign a DIFFERENT payload than the one submitted — a tampered/wrong-key
  // proof, indistinguishable at the API from an actively misbehaving agent.
  const wrongSignature = await signMessage(canonicalizeSubmission({ ...sub, stance: "bearish" }), m.privateKey);
  const res = await ic.submitRecommendation(m.token, { ...sub, signature: wrongSignature });
  expect(res.status).toBe(400);
  expect((res as any).error).toBe("signature verification failed");

  const rows = await sql<{ event_type: string; session_id: string; member_id: string; detail: unknown }[]>`
    SELECT event_type, session_id, member_id, detail FROM swarm_agent_health_events
    WHERE session_id = ${session.id} AND member_id = ${m.id}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.event_type).toBe("rejected_signature");
  expect(rows[0]!.detail).toEqual({ reason: "signature verification failed" });
  // Bounded/redacted: the raw signature/payload is never persisted in detail.
  expect(JSON.stringify(rows[0]!.detail)).not.toContain(wrongSignature);

  const httpResult = await getAgentHealth(`?sessionId=${session.id}&eventType=rejected_signature`);
  expect(httpResult?.status).toBe(200);
  const body = httpResult?.body as { events: { eventType: string }[]; counts: Record<string, number> };
  expect(body.events).toHaveLength(1);
  expect(body.events[0]!.eventType).toBe("rejected_signature");
  expect(body.counts.rejected_signature).toBe(1);

  // A second wrong attempt is a DISTINCT event (no dedup on rejected_signature
  // — every attempt is independently forensic evidence).
  const wrongSignature2 = await signMessage(canonicalizeSubmission({ ...sub, nonce: rid("n2"), stance: "cautious" }), m.privateKey);
  const res2 = await ic.submitRecommendation(m.token, { ...sub, nonce: rid("n2"), signature: wrongSignature2 });
  expect(res2.status).toBe(400);
  const rows2 = await sql`SELECT id FROM swarm_agent_health_events WHERE session_id = ${session.id} AND member_id = ${m.id} AND event_type = 'rejected_signature'`;
  expect(rows2.length).toBe(2);
});

test("rejects an invalid eventType query parameter (400, no query executed)", async () => {
  const result = await getAgentHealth("?eventType=bogus");
  expect(result?.status).toBe(400);
});

// Issue #1019: closeWindow used to wrap the collecting->window_closed
// transition and the absence-telemetry inserts in ONE transaction, so a
// telemetry failure rolled back the transition itself — the session stayed
// `collecting` forever, the close_window job retried to exhaustion, and
// every later submission 409-rejected. Dropping the partial unique index the
// absence insert's ON CONFLICT target depends on forces exactly that insert
// to fail (Postgres: no unique/exclusion constraint matches ON CONFLICT),
// with no other write in closeWindow touched — a real telemetry failure, not
// a simulated one.
//
// This test intentionally runs LAST in this file: it permanently drops
// swarm_agent_health_events_absent_once_idx from this file's own cloned
// database, so nothing later in this file may depend on absence-event
// recording succeeding again.
test("closeWindow commits window_closed even when absence-event recording fails, and collects the failure into telemetryWarnings instead of throwing", async () => {
  const subj = rid("s3");
  await ensureProseSubject(subj, "S3");
  const present = await activeMember();
  const absent = await activeMember();
  const session = await ic.openSession(subj);
  const date = sessionDate(session);
  for (const m of [present, absent]) {
    await sql`INSERT INTO swarm_session_members (session_id, member_id, member_name, status)
              VALUES (${session.id}, ${m.id}, ${m.id}, 'expected')`;
  }
  await ic.publishBrief(session.id, 60);

  const sub = { memberId: present.id, date, subjectId: subj, nonce: rid("n"), stance: "neutral", confidence: 0.5, body: "present" };
  const signature = await signMessage(canonicalizeSubmission(sub), present.privateKey);
  expect((await ic.submitRecommendation(present.token, { ...sub, signature })).status).toBe(201);

  await sql.unsafe(`DROP INDEX swarm_agent_health_events_absent_once_idx`);

  const result = await ic.closeWindow(session.id);
  expect(result.state).toBe("window_closed");
  expect(Array.isArray(result.telemetryWarnings)).toBe(true);
  expect(result.telemetryWarnings!.length).toBeGreaterThan(0);
  expect(result.telemetryWarnings!.some((w) => w.includes("absence event for"))).toBe(true);

  // The transition itself committed and is NOT rolled back by the telemetry
  // failure — the whole point of the fix.
  const rows = await sql<{ state: string }[]>`SELECT state FROM swarm_sessions WHERE id = ${session.id}`;
  expect(rows[0]!.state).toBe("window_closed");

  // No absence event was actually persisted — the insert genuinely failed,
  // it was not silently swallowed.
  const events = await sql`SELECT id FROM swarm_agent_health_events WHERE session_id = ${session.id}`;
  expect(events.length).toBe(0);

  // A second close on the now-already-closed session is still a no-op that
  // does not throw, even with the index still gone: the UPDATE affects 0 rows
  // so recordAbsenceEvents never runs.
  const second = await ic.closeWindow(session.id);
  expect(second.state).toBe("window_closed");
  expect(second.telemetryWarnings).toBeUndefined();
});

// 0020's own DDL creates committee_agent_health_events (immutable historical
// filename and table name — issue #263's 0025 rename only touches the LIVE
// schema, never 0020's own file). The shared suite database (tests/preload.ts)
// has 0025 applied and no longer has that name, so this test provisions its
// OWN throwaway database on the same Postgres instance, migrated only through
// 0020, to genuinely re-test 0020's idempotency against the schema shape it
// was actually written for (same pattern as swarm-claim.test.ts's 0019 test).
test("0020 migration is idempotent when executed repeatedly against real Postgres", async () => {
  const base = new URL(config.databaseUrl);
  const dbName = `tmp_0020_idem_${crypto.randomUUID().slice(0, 8)}`;
  const admin = postgres(base.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const tmpUrl = new URL(base.toString());
  tmpUrl.pathname = `/${dbName}`;
  const db = postgres(tmpUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    const upTo0020 = files.filter((f) => f <= "0020_committee_agent_health.sql");
    expect(upTo0020.length).toBeGreaterThan(0);
    for (const file of upTo0020) {
      const migrationDdl = await readFile(join(migrationsDir, file), "utf8");
      await db.begin(async (tx) => { await tx.unsafe(migrationDdl); });
    }

    const ddl = await readFile(join(migrationsDir, "0020_committee_agent_health.sql"), "utf8");
    await db.unsafe(ddl);
    await db.unsafe(ddl);
    const tables = await db<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'committee_agent_health_events'`;
    expect(tables.map((row) => row.table_name)).toEqual(["committee_agent_health_events"]);

    const indexes = await db<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'committee_agent_health_events'
      ORDER BY indexname`;
    expect(indexes.map((row) => row.indexname)).toEqual(
      [
        "committee_agent_health_events_absent_once_idx",
        "committee_agent_health_events_member_idx",
        "committee_agent_health_events_pkey",
        "committee_agent_health_events_session_idx",
        "committee_agent_health_events_type_idx",
      ].sort(),
    );
  } finally {
    await db.end();
    const cleanup = postgres(base.toString(), { max: 1, onnotice: () => {} });
    await cleanup.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await cleanup.end();
  }
});
