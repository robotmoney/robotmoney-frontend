// A subject page pages its own history (issue #991), and a brief's recent
// sessions name each session by id (issue #965).
//
// #991: GET /api/swarm/sessions takes `subject` and `search`, applied before
// the keyset page is cut, and each light row carries how many members filed
// and the target that session's own brief carried.
// #965: a subject may convene more than once a day, so a brief's recent refs
// carry the session id and come back newest first within a day.
import { test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import * as ic from "../src/swarm/domain.ts";
import { sql } from "../src/db/client.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { ROUTES } from "@robotmoney/contract";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { ensureProseSubject } from "./support/prose-subject.ts";

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

// `convened_at` (so `date` and `generatedAt`) is when the row was created in `scheduled`. A session can wait days for
// its brief (2026-09-28: four rows created at 00:11 to 00:40 UTC were briefed on 09-29 and 09-30). `openedAt` is when
// the brief went out and the window began, read from the first brief revision, with no column of its own.
test("openedAt is the first brief revision's time, not the row's creation time, on the list, the detail and the full list", async () => {
  const subj = rid("waits");
  await ensureProseSubject(subj, "Waits");
  const session = await ic.openSession(subj);
  // The row sat in `scheduled` for two days before its brief.
  await sql`UPDATE swarm_sessions SET convened_at = now() - interval '2 days', generated_at = now() - interval '2 days' WHERE id = ${session.id}`;

  const before = (await ic.listSessions({ subject: subj })).sessions.find((s: any) => s.id === session.id) as any;
  expect(before.openedAt).toBeNull();

  const t0 = Date.now();
  await ic.publishBrief(session.id, 60);
  const [first] = await sql`SELECT min(created_at) AS at FROM swarm_brief_revisions WHERE session_id = ${session.id}`;
  expect(new Date(first.at).getTime()).toBeGreaterThanOrEqual(t0 - 1000);

  const paged = (await ic.listSessions({ subject: subj })).sessions.find((s: any) => s.id === session.id) as any;
  const full = (await ic.listSessions({ full: true })).sessions.find((s: any) => s.id === session.id) as any;
  const detail = (await ic.getSession(sessionDate(paged), subj))!.session as any;
  for (const s of [paged, full, detail]) {
    expect(new Date(s.openedAt).toISOString()).toBe(new Date(first.at).toISOString());
    // Two days after the row's creation: the page must not print that creation as the session's moment.
    expect(new Date(s.openedAt).getTime() - new Date(s.generatedAt).getTime()).toBeGreaterThan(47 * 3600 * 1000);
  }

  // A republished brief adds a revision; the opening time does not move.
  await ic.publishBrief(session.id, 60).catch(() => null);
  const again = (await ic.listSessions({ subject: subj })).sessions.find((s: any) => s.id === session.id) as any;
  expect(again.openedAt).toBe(paged.openedAt);
});

// ── The allocation column (issue 1581) ──────────────────────────────────────
// Each brief body is about 240 KB on production, so reading
// `body->'allocation'` per row detoasted the whole body to return a few
// weights. Migration 0130 stores `allocation` in a column its trigger keeps
// equal to the body (0131 fills the older rows), and the page reads it. The old read is kept here as the reference the new one must
// equal, row for row.
const OLD_PAGE_SQL = (registeredPageProbe: string) =>
  registeredPageProbe.replace("(SELECT b.allocation FROM swarm_briefs b", "(SELECT b.body->'allocation' FROM swarm_briefs b");

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  Output?: string[];
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
}
const flatten = (n: PlanNode, out: PlanNode[] = []): PlanNode[] => {
  out.push(n);
  for (const c of n.Plans ?? []) flatten(c, out);
  return out;
};

/** A published session whose brief carries a ~240 KB body beside its allocation, as production's do. */
async function heavyBrief(subject: string, minutesAgo: number) {
  const s = await published(subject, `heavy ${minutesAgo}`, minutesAgo, null);
  // Random text, so compression cannot shrink it below the TOAST threshold.
  const prose = randomBytes(180_000).toString("base64");
  await sql`INSERT INTO swarm_briefs (session_id, date, subject_id, body)
            VALUES (${s.id}, ${s.date}, ${subject}, ${sql.json(JSON.parse(JSON.stringify({ allocation: TARGETS, prose })))})`;
  return s;
}

async function pageProbe(): Promise<string> {
  const { registeredSites } = await import("../src/db/registry.ts");
  const site = registeredSites().find((d) => d.site === "src/swarm/domain:listSessions.page.briefs");
  if (!site?.probe) throw new Error("no registered probe for the sessions page briefs read");
  return site.probe.statement;
}

test("every brief's allocation column equals body->'allocation', for a body with one, without one, and with none", async () => {
  const subject = rid("alloccol");
  await ic.ensureSubject(subject, "Allocation");
  await published(subject, "with targets", 3);
  const bare = await published(subject, "bare brief", 2, null);
  await sql`INSERT INTO swarm_briefs (session_id, date, subject_id, body) VALUES (${bare.id}, ${bare.date}, ${subject}, ${sql.json({ prose: "no targets" })})`;
  const nullBody = await published(subject, "null body", 1, null);
  await sql`INSERT INTO swarm_briefs (session_id, date, subject_id, body) VALUES (${nullBody.id}, ${nullBody.date}, ${subject}, NULL)`;
  const [{ mismatched, total }] = await sql<{ mismatched: number; total: number }[]>`
    SELECT count(*) FILTER (WHERE allocation IS DISTINCT FROM body->'allocation')::int AS mismatched, count(*)::int AS total FROM swarm_briefs`;
  expect({ mismatched, total: total >= 3 }).toEqual({ mismatched: 0, total: true });
  // A rewrite of the body moves the column with it: no writer can disagree.
  await sql`UPDATE swarm_briefs SET body = jsonb_set(body, '{allocation,asof}', '"2026-07-01"') WHERE session_id = (SELECT id FROM swarm_sessions WHERE subject_id = ${subject} AND swarm_recommendation->>'rationale' = 'with targets')`;
  const [{ asof }] = await sql<{ asof: string }[]>`
    SELECT b.allocation->>'asof' AS asof FROM swarm_briefs b JOIN swarm_sessions s ON s.id = b.session_id
     WHERE s.subject_id = ${subject} AND s.swarm_recommendation->>'rationale' = 'with targets'`;
  expect(asof).toBe("2026-07-01");
});

test("the page reads swarm_briefs.allocation, never the 240 KB body, and answers exactly as the body read did", async () => {
  const subject = rid("heavy");
  await ic.ensureSubject(subject, "Allocation");
  for (let i = 0; i < 6; i++) await heavyBrief(subject, 60 - i);
  await sql.unsafe("ANALYZE swarm_briefs");
  const probe = await pageProbe();
  expect(probe).toContain("SELECT b.allocation FROM swarm_briefs b");
  const old = OLD_PAGE_SQL(probe);
  expect(old).not.toBe(probe);
  const params = [null, null, subject, subject, null, null, null, null, null, null, 7];

  // The response: the rows the new read returns equal the old read's, column
  // for column, so the page built from them is byte-identical.
  const rowsNew = await sql.unsafe(probe, params as never[]);
  const rowsOld = await sql.unsafe(old, params as never[]);
  expect(rowsNew.length).toBe(6);
  expect(JSON.stringify(rowsNew)).toBe(JSON.stringify(rowsOld));
  const page = await ic.listSessions({ subject, limit: 6 });
  expect(page.sessions.every((s: any) => s.referenceAllocation?.asof === "2026-06-02")).toBe(true);

  // The plan: EXPLAIN (ANALYZE, BUFFERS) of the page query. The brief read
  // outputs the column, never the body, and reads a few pages where the old
  // read pulled every body's TOAST chunks.
  const plan = async (text: string) => {
    const [row] = (await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${text}`, params as never[])) as unknown as {
      "QUERY PLAN": { Plan: PlanNode }[];
    }[];
    const nodes = flatten(row!["QUERY PLAN"][0]!.Plan);
    const briefs = nodes.filter((n) => n["Relation Name"] === "swarm_briefs");
    const blocks = (n: PlanNode) => (n["Shared Hit Blocks"] ?? 0) + (n["Shared Read Blocks"] ?? 0);
    return { outputs: briefs.flatMap((n) => n.Output ?? []), briefBlocks: briefs.reduce((t, n) => t + blocks(n), 0), root: blocks(nodes[0]!) };
  };
  const now = await plan(probe);
  const before = await plan(old);
  expect(now.outputs.length).toBeGreaterThan(0);
  expect(now.outputs.some((o) => /\bb\.allocation\b/.test(o))).toBe(true);
  expect(now.outputs.some((o) => /\bb\.body\b/.test(o))).toBe(false);
  // Red control: the old read names the body and reads its TOAST pages, so
  // the same measure would have caught it. Six ~240 KB bodies are well over
  // a hundred 8 KB pages; the column read stays a handful.
  expect(before.outputs.some((o) => /\bb\.body\b/.test(o))).toBe(true);
  expect(before.root - now.root).toBeGreaterThan(100);
});
