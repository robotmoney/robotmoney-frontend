// A subject page pages its own history (issue #991), and a brief's recent
// sessions name each session by id (issue #965).
//
// #991: GET /api/swarm/sessions takes `subject` and `search`, applied before
// the keyset page is cut, and each light row carries how many members filed
// and the target that session's own brief carried.
// #965: a subject may convene more than once a day, so a brief's recent refs
// carry the session id and come back newest first within a day.
import { test, expect } from "bun:test";
import * as ic from "../src/swarm/domain.ts";
import { sql } from "../src/db/client.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { ROUTES } from "@robotmoney/contract";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const sessionDate = (s: Record<string, unknown>): string =>
  s.date instanceof Date ? s.date.toISOString().slice(0, 10) : String(s.date).slice(0, 10);

const TARGETS = {
  asof: "2026-06-02",
  buckets: [
    { id: "conservative_defi_yield", target_weight: 0.95, items: [{ id: "aave", name: "Aave", target_weight: 0.3 }] },
    { id: "agent_tokens", target_weight: 0.05 },
    { id: "protocol_tokens", target_weight: 0 },
    { id: "real_world_assets", target_weight: 0 },
  ],
};

// A published session, convened `minutesAgo` before now so the order is fixed.
async function published(subject: string, rationale: string, minutesAgo: number, brief: typeof TARGETS | null = TARGETS) {
  const [s] = await sql`
    INSERT INTO swarm_sessions (subject_id, subject_name, state, swarm_recommendation, convened_at, generated_at)
    VALUES (${subject}, ${subject}, 'published', ${sql.json({ rationale, weights: [] })},
            now() - make_interval(mins => ${minutesAgo}), now() - make_interval(mins => ${minutesAgo}))
    RETURNING id, date`;
  if (brief) {
    await sql`INSERT INTO swarm_briefs (session_id, date, subject_id, body)
              VALUES (${s.id}, ${s.date}, ${subject}, ${sql.json(JSON.parse(JSON.stringify({ allocation: brief })))})`;
  }
  return s as { id: string; date: Date };
}

async function member(name: string) {
  const id = crypto.randomUUID();
  await sql`INSERT INTO swarm_members (id, status, name, lens) VALUES (${id}, 'active', ${name}, 'test')`;
  return id;
}

async function take(sessionId: string, subject: string, date: Date, memberId: string, revision = 1) {
  await sql`
    INSERT INTO swarm_recommendations (session_id, member_id, subject_id, date, nonce, stance, confidence, body, payload, signature, verified, revision)
    VALUES (${sessionId}, ${memberId}, ${subject}, ${date}, ${crypto.randomUUID()}, 'neutral', 0.6, 'a take',
            ${sql.json({})}, 'sig', false, ${revision})`;
}

test("subject filters before the page is cut, and every page stays on that subject", async () => {
  const subject = rid("alloc");
  const other = rid("other");
  await ic.ensureSubject(subject, "Allocation");
  await ic.ensureSubject(other, "Other");
  for (let i = 0; i < 15; i++) await published(subject, `Review ${i} liquidity`, 100 - i);
  // Interleaved rows of another subject, newer than all of the above: a filter
  // applied after the page would return a short first page.
  for (let i = 0; i < 5; i++) await published(other, `Other ${i}`, i);

  const first = await ic.listSessions({ subject, state: "published", limit: 12 });
  expect(first.sessions).toHaveLength(12);
  expect(first.sessions.every((s) => s.subjectId === subject)).toBe(true);
  expect(first.nextCursor).not.toBeNull();

  const second = await ic.listSessions({ subject, state: "published", limit: 12, cursor: first.nextCursor });
  expect(second.sessions).toHaveLength(3);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.sessions, ...second.sessions].map((s) => s.id)).size).toBe(15);
});

test("each row carries its own brief's targets, compact, and null when the brief had none", async () => {
  const subject = rid("alloc");
  await ic.ensureSubject(subject, "Allocation");
  const withTargets = await published(subject, "with targets", 20);
  const withoutBrief = await published(subject, "no brief", 10, null);

  const { sessions } = await ic.listSessions({ subject, limit: 10 });
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const ref = (byId.get(withTargets.id) as any).referenceAllocation;
  expect(ref.asof).toBe("2026-06-02");
  expect(ref.buckets).toEqual([
    { id: "conservative_defi_yield", target_weight: 0.95 },
    { id: "agent_tokens", target_weight: 0.05 },
    { id: "protocol_tokens", target_weight: 0 },
    { id: "real_world_assets", target_weight: 0 },
  ]);
  // Compact: the per-asset items stay on the brief.
  expect(ref.buckets[0].items).toBeUndefined();
  expect((byId.get(withoutBrief.id) as any).referenceAllocation).toBeNull();
});

test("takeCount counts members who filed, not revisions", async () => {
  const subject = rid("alloc");
  await ic.ensureSubject(subject, "Allocation");
  const s = await published(subject, "counted", 5);
  const a = await member("A");
  const b = await member("B");
  await take(s.id, subject, s.date, a, 1);
  await take(s.id, subject, s.date, a, 2);
  await take(s.id, subject, s.date, b, 1);
  const empty = await published(subject, "nobody filed", 1);

  const { sessions } = await ic.listSessions({ subject, limit: 10 });
  const byId = new Map(sessions.map((x) => [x.id, x]));
  expect((byId.get(s.id) as any).takeCount).toBe(2);
  expect((byId.get(empty.id) as any).takeCount).toBe(0);
});

test("search is a literal, case-insensitive phrase over date, rationale and synthesis", async () => {
  const subject = rid("alloc");
  await ic.ensureSubject(subject, "Allocation");
  const hit = await published(subject, "Trim Agent Tokens to 2%", 30);
  await published(subject, "Hold the mandate", 20);

  const byPhrase = await ic.listSessions({ subject, search: "agent tokens" });
  expect(byPhrase.sessions.map((s) => s.id)).toEqual([hit.id]);
  // `%` is a percent sign, not a wildcard: it matches the one rationale that
  // contains one, and nothing else.
  const byPercent = await ic.listSessions({ subject, search: "%" });
  expect(byPercent.sessions.map((s) => s.id)).toEqual([hit.id]);
  const byDate = await ic.listSessions({ subject, search: sessionDate(hit as any) });
  expect(byDate.sessions.length).toBe(2);
  expect((await ic.listSessions({ subject, search: "nothing like this" })).sessions).toHaveLength(0);
});

test("the route passes subject and search through, and refuses them with full=1 or an overlong search", async () => {
  const subject = rid("alloc");
  await ic.ensureSubject(subject, "Allocation");
  await published(subject, "via the route", 5);
  const get = (qs: string) => {
    const url = new URL(`http://localhost${ROUTES.swarm.sessions}?${qs}`);
    return handleSwarm(new Request(url), url);
  };

  const ok = await get(`subject=${encodeURIComponent(subject)}&search=route`);
  expect(ok?.status).toBe(200);
  expect((ok?.body as any).sessions).toHaveLength(1);

  expect((await get(`subject=${encodeURIComponent(subject)}&full=1`))?.status).toBe(400);
  expect((await get(`search=${"x".repeat(201)}`))?.status).toBe(400);
  // Unfiltered, the index is what it always was.
  const all = await get("limit=5");
  expect(all?.status).toBe(200);
});

test("a brief's recent sessions name each session by id, newest first within a day (#965)", async () => {
  const subject = rid("recent");
  await ic.ensureSubject(subject, "Twice-Published Subject");
  const publish = async () => {
    const s = await ic.openSession(subject);
    await ic.publishBrief(s.id, 60);
    await ic.closeWindow(s.id);
    await ic.aggregateSession(s.id);
    await ic.publishSession(s.id);
    return s;
  };
  const first = await publish();
  const second = await publish();
  expect(sessionDate(second)).toBe(sessionDate(first));

  const third = await ic.openSession(subject);
  await ic.publishBrief(third.id, 60);
  const recent = (await ic.getBriefBySession(third.id))?.body?.recentSessions ?? [];
  expect(recent.map((r) => r.id)).toEqual([second.id, first.id]);
  expect(recent.every((r) => typeof r.convened_at === "string" && r.subject_id === subject)).toBe(true);
});
