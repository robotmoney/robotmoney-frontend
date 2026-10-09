// GET /api/swarm/open-sessions lists EVERY collecting session; GET
// /api/swarm/open-session is unchanged (post-mortem 2026-10-09, finding 5).
//
// open-session answers the newest collecting session by generated_at. Under the
// old rotation one subject collected at a time, so that was the whole truth.
// With several subjects collecting at once it showed one of them, and mostly the
// same one: treasury 91.6% of 10-09 00:00 to 17:00 UTC, woon 0.4%. ShodAI's
// agent acts only on the session open-session returns, so it never reached a
// subject that takes a take without a weight vector.
import { expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import * as ic from "../src/swarm/domain.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { activeSubject } from "./support/epoch-fixtures.ts";

useCleanDatabase(import.meta.file);

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await handleSwarm(new Request(`http://localhost${path}`), new URL(`http://localhost${path}`));
  if (!res || res instanceof Response) throw new Error(`${path} was not handled`);
  return { status: res.status, body: res.body };
}

test("with nothing collecting: open-session is null and open-sessions is an empty list", async () => {
  expect((await get(ROUTES.swarm.openSession)).body).toBeNull();
  const list = await get(ROUTES.swarm.openSessions);
  expect(list.status).toBe(200);
  expect(list.body).toEqual({ sessions: [] });
});

test("with three subjects collecting: all three are listed, soonest close first, in open-session's shape", async () => {
  const late = await activeSubject("os-late", 7200);
  const soon = await activeSubject("os-soon", 7200);
  const mid = await activeSubject("os-mid", 7200);
  for (const s of [late, soon, mid]) {
    const opened = await ic.openEpoch(s);
    if (!opened.ok) throw new Error(`openEpoch: ${JSON.stringify(opened)}`);
  }
  await fixtureDb`UPDATE swarm_sessions SET window_closes_at = now() + interval '1 hour' WHERE subject_id = ${soon}`;
  await fixtureDb`UPDATE swarm_sessions SET window_closes_at = now() + interval '2 hours' WHERE subject_id = ${mid}`;
  await fixtureDb`UPDATE swarm_sessions SET window_closes_at = now() + interval '3 hours' WHERE subject_id = ${late}`;

  const list = (await get(ROUTES.swarm.openSessions)).body.sessions as { subjectId: string; id: string; windowClosesAt: string }[];
  expect(list.map((s) => s.subjectId)).toEqual([soon, mid, late]);

  const single = (await get(ROUTES.swarm.openSession)).body as { subjectId: string; id: string };
  expect(Object.keys(single).sort()).toEqual(Object.keys(list[0]!).sort());
  expect(list.map((s) => s.id)).toContain(single.id);
});

test("red control: the single-session route still answers exactly one session", async () => {
  const one = (await get(ROUTES.swarm.openSession)).body;
  expect(Array.isArray(one)).toBe(false);
  expect(typeof one.id).toBe("string");
});

test("a session that closed is not listed", async () => {
  const closing = await activeSubject("os-closing", 7200);
  const opened = await ic.openEpoch(closing);
  if (!opened.ok) throw new Error(`openEpoch: ${JSON.stringify(opened)}`);
  await fixtureDb`UPDATE swarm_sessions SET window_closes_at = clock_timestamp() - interval '1 second' WHERE id = ${opened.sessionId}`;
  const turned = await ic.turnOverEpoch(closing, opened.sessionId);
  if (!turned.ok) throw new Error(`turnOverEpoch: ${JSON.stringify(turned)}`);
  const ids = ((await get(ROUTES.swarm.openSessions)).body.sessions as { id: string }[]).map((s) => s.id);
  expect(ids).not.toContain(opened.sessionId);
  expect(ids).toContain(turned.openedSessionId!);
});
