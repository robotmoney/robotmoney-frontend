// Agent-health surface (issue #208; resolved design scout #214): a roster
// member that misses its expected submission window, and a rejected/tampered
// submission signature, were previously visible only in an agent's own
// stdout. Both are now recorded on a durable, queryable, append-only event
// log (committee_agent_health_events) and exposed admin-only via
// GET /api/committee/admin/agent-health.
import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as ic from "../src/committee/domain.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { handleCommitteeAdmin } from "../src/api/routes/committee-admin.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

async function activeMember() {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  return { id, token: r.token, privateKey };
}

async function getAgentHealth(query: string) {
  const req = new Request(`http://test/api/committee/admin/agent-health${query}`);
  return handleCommitteeAdmin(req, new URL(req.url));
}

test("closeWindow records exactly one absent event per missing expected roster member; queryable by session/member and counted", async () => {
  const subj = rid("s");
  await ic.ensureSubject(subj, "S");
  const date = "2026-07-10";
  const present = await activeMember();
  const absent = await activeMember();
  const session = await ic.openSession(date, subj);
  for (const m of [present, absent]) {
    await sql`INSERT INTO committee_session_members (session_id, member_id, member_name, status)
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
    SELECT event_type, session_id, member_id, detail FROM committee_agent_health_events
    WHERE session_id = ${session.id}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.event_type).toBe("absent");
  expect(rows[0]!.member_id).toBe(absent.id);
  expect(rows[0]!.detail).toEqual({ reason: "missed submission window" });

  // Idempotent / restart-safe: a retried close_window job on the same session
  // (e.g. after a worker restart) never doubles the absence event.
  await ic.closeWindow(session.id);
  const afterRetry = await sql`SELECT id FROM committee_agent_health_events WHERE session_id = ${session.id}`;
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

test("a wrong-key/tampered submission is rejected 400 and recorded to the durable rejected-signature surface", async () => {
  const subj = rid("s2");
  await ic.ensureSubject(subj, "S2");
  const date = "2026-07-11";
  const m = await activeMember();
  const session = await ic.openSession(date, subj);
  await sql`INSERT INTO committee_session_members (session_id, member_id, member_name, status)
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
    SELECT event_type, session_id, member_id, detail FROM committee_agent_health_events
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
  const rows2 = await sql`SELECT id FROM committee_agent_health_events WHERE session_id = ${session.id} AND member_id = ${m.id} AND event_type = 'rejected_signature'`;
  expect(rows2.length).toBe(2);
});

test("rejects an invalid eventType query parameter (400, no query executed)", async () => {
  const result = await getAgentHealth("?eventType=bogus");
  expect(result?.status).toBe(400);
});

test("0020 migration is idempotent when executed repeatedly against real Postgres", async () => {
  const ddl = await readFile(join(process.cwd(), "migrations/0020_committee_agent_health.sql"), "utf8");
  await sql.unsafe(ddl);
  await sql.unsafe(ddl);
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'committee_agent_health_events'`;
  expect(tables.map((row) => row.table_name)).toEqual(["committee_agent_health_events"]);

  const indexes = await sql<{ indexname: string }[]>`
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
});
