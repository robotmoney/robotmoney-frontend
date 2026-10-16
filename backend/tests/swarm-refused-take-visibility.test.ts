// A refused take leaves a trace (post-mortem 2026-10-09, "why this was hard to
// see"). Since the v0.6.0 cutover every vault and allocation take from woon and
// shodai was refused 400 and the API wrote nothing: the access log held a status
// and a byte count, and the operator's health table showed the same members as
// ordinary absences. submitRecommendation now logs one line per refusal and
// records one `rejected_take` event per (session, member, code).
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { canonicalizeSubmission } from "@robotmoney/contract";
import * as ic from "../src/swarm/domain.ts";
import { sql } from "../src/db/client.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const dayOf = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const SECRET_BODY = "a body that must never reach a log line";

let warn: ReturnType<typeof spyOn>;
beforeEach(() => { warn = spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

async function member() {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) throw new Error(`member() failed: ${JSON.stringify(r)}`);
  return { id, token: r.token, privateKey };
}

async function session(prefix: string, type: "bucket_weights" | "position_actions") {
  const subjectId = rid(prefix);
  await ic.ensureSubject(subjectId, `${prefix} subject`);
  await fixtureDb`UPDATE swarm_subjects SET recommendation_type = ${type} WHERE id = ${subjectId}`;
  const s = await ic.openSession(subjectId);
  await ic.publishBrief(s.id, 60);
  return { sessionId: s.id, subjectId, date: dayOf(s.date) };
}

async function submit(m: Awaited<ReturnType<typeof member>>, date: string, subjectId: string) {
  const sub = { memberId: m.id, date, subjectId, nonce: rid("n"), stance: "neutral", confidence: 0.5, body: SECRET_BODY };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  return { res: await ic.submitRecommendation(m.token, { ...sub, signature }), signature };
}

const events = (sessionId: string, memberId: string) =>
  sql`SELECT event_type, detail FROM swarm_agent_health_events WHERE session_id = ${sessionId} AND member_id = ${memberId} ORDER BY id` as
    unknown as Promise<{ event_type: string; detail: { code: string; status: number; subjectId: string } }[]>;

test("a weightless take on a bucket_weights subject is logged without the signature or the body, and recorded once", async () => {
  const s = await session("vis-weights", "bucket_weights");
  const m = await member();
  const { res, signature } = await submit(m, s.date, s.subjectId);
  expect(res.status).toBe(400);
  const lines = warn.mock.calls.map((c: unknown[]) => c.join(" "));
  const line = lines.find((l: string) => l.includes("take refused"));
  expect(line).toBeDefined();
  expect(line).toContain(`member=${m.id}`);
  expect(line).toContain(`subject=${s.subjectId}`);
  expect(line).toContain("status=400");
  expect(line).toContain("code=weights_required_for_bucket_weights_subject");
  expect(lines.join("\n")).not.toContain(signature);
  expect(lines.join("\n")).not.toContain(SECRET_BODY);

  const rows = await events(s.sessionId, m.id);
  expect(rows.length).toBe(1);
  expect(rows[0]!.event_type).toBe("rejected_take");
  expect(rows[0]!.detail).toEqual({ code: "weights_required_for_bucket_weights_subject", status: 400, subjectId: s.subjectId });
  expect(JSON.stringify(rows[0]!.detail)).not.toContain(SECRET_BODY);
});

test("a looping agent writes one row per code, and still one log line per attempt", async () => {
  const s = await session("vis-loop", "bucket_weights");
  const m = await member();
  for (let i = 0; i < 4; i++) expect((await submit(m, s.date, s.subjectId)).res.status).toBe(400);
  expect((await events(s.sessionId, m.id)).length).toBe(1);
  expect(warn.mock.calls.filter((c: unknown[]) => c.join(" ").includes("take refused")).length).toBe(4);
});

test("a different refusal is a different row: the window closing, on the same session and member", async () => {
  const s = await session("vis-window", "position_actions");
  const m = await member();
  await fixtureDb`UPDATE swarm_sessions SET window_closes_at = now() - interval '1 second' WHERE id = ${s.sessionId}`;
  const { res } = await submit(m, s.date, s.subjectId);
  expect(res.status).toBe(409);
  const rows = await events(s.sessionId, m.id);
  expect(rows.map((r) => r.detail.code)).toEqual(["submission_window_closed"]);
});

test("an accepted take writes no refusal, and the admin health list can filter on the new type", async () => {
  const s = await session("vis-ok", "position_actions");
  const m = await member();
  expect((await submit(m, s.date, s.subjectId)).res.status).toBe(201);
  expect((await events(s.sessionId, m.id)).length).toBe(0);
  expect(warn.mock.calls.filter((c: unknown[]) => c.join(" ").includes("take refused")).length).toBe(0);

  const w = await session("vis-admin", "bucket_weights");
  const wm = await member();
  await submit(wm, w.date, w.subjectId);
  const listed = await ic.getAgentHealthEvents({ eventType: "rejected_take", sessionId: w.sessionId });
  expect(JSON.stringify(listed)).toContain("weights_required_for_bucket_weights_subject");
});
