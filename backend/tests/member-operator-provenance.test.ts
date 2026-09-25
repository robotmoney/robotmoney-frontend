// Forged member operators are cleared by a self-healing forward migration —
// issue #1026, decision D55 (2), migration 0083.
//
// D55 (2): "A self-healing forward migration clears `operator` on every member
// row where the member set it through the self-write path that issue #925
// closed. It runs on every deploy and changes nothing once no forged row
// remains." The judge's third-party gate is keyed on `operator`, so a value a
// member wrote for itself is a standing forgery.
//
// EVERY ROW HERE IS WRITTEN BY THE PATH IT STANDS FOR, where that path still
// exists: the member's own profile route (`updateMemberProfile`), the admin
// edit (`updateMemberAdmin`) and the in-house roster seed (`seedLiveRoster`).
// The one exception is the pre-#925 forgery itself, which today's code refuses
// to write: it is planted exactly as that code left it — the value on the row
// and an `update_profile` audit row holding only `{ memberId }` (ce2c4427).
//
// The migration was applied when the template was built; each case plants its
// state in this file's own database (useCleanDatabase) and then runs 0083's
// own text again, which is what "runs on every deploy" means for it.
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import * as admin from "../src/swarm/admin.ts";
import { updateMemberProfile } from "../src/swarm/domain.ts";
import { LIVE_ROSTER, seedLiveRoster } from "../src/swarm/roster-seed.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeMember } from "./support/epoch-fixtures.ts";

useCleanDatabase(import.meta.file);

const MIGRATION = readFileSync(
  join(import.meta.dir, "..", "migrations", "0083_clear_forged_member_operator.sql"),
  "utf8",
);

const operatorOf = async (id: string): Promise<string | null> =>
  ((await sql`SELECT operator FROM swarm_members WHERE id = ${id}`) as unknown as { operator: string | null }[])[0]!
    .operator;
const versionOf = async (id: string): Promise<number> =>
  Number(((await sql`SELECT version FROM swarm_members WHERE id = ${id}`) as unknown as { version: number }[])[0]!.version);
const clearedIds = async (): Promise<string[]> =>
  ((await sql`
    SELECT target_id FROM audit_log WHERE actor = 'migration 0083' AND action = 'member_operator_cleared'
     ORDER BY target_id`) as unknown as { target_id: string }[]).map((r) => r.target_id);

/** The pre-#925 forgery, exactly as that code left it. */
async function forgePre925(id: string, operator: string): Promise<void> {
  await sql`UPDATE swarm_members SET operator = ${operator} WHERE id = ${id}`;
  await sql`INSERT INTO audit_log (actor, action, scope) VALUES (${id}, 'update_profile', ${sql.json({ memberId: id } as never)})`;
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  await seedLiveRoster();

  // 1. The #925 forgery: a third-party member wrote the in-house value.
  const forged = await activeMember();
  await forgePre925(forged.id, "robotmoney");
  ids.forged = forged.id;

  // 2. A post-#925 self-write that names `operator` (any value but the
  //    reserved one gets past today's route): still a self-written operator.
  const selfNamed = await activeMember();
  const written = await updateMemberProfile(selfNamed.token, selfNamed.id, { operator: "acme-labs" });
  expect(written.ok).toBe(true);
  ids.selfNamed = selfNamed.id;

  // 3. An admin wrote the operator; the member later edited only its tagline.
  const adminWritten = await activeMember();
  expect((await admin.updateMemberAdmin(adminWritten.id, await versionOf(adminWritten.id), { operator: "peaq" })).status)
    .toBe(200);
  expect((await updateMemberProfile(adminWritten.token, adminWritten.id, { tagline: "still here" })).ok).toBe(true);
  ids.adminWritten = adminWritten.id;

  // 4. A forgery an admin then corrected by writing the operator itself.
  const corrected = await activeMember();
  await forgePre925(corrected.id, "robotmoney");
  expect((await admin.updateMemberAdmin(corrected.id, await versionOf(corrected.id), { operator: "partner-co" })).status)
    .toBe(200);
  ids.corrected = corrected.id;

  // 5. An admin write, then the member overwrote it through the self-write path.
  const overwritten = await activeMember();
  expect((await admin.updateMemberAdmin(overwritten.id, await versionOf(overwritten.id), { operator: "first-co" })).status)
    .toBe(200);
  await forgePre925(overwritten.id, "robotmoney");
  ids.overwritten = overwritten.id;

  // 6. An operator nobody but a backfill wrote: no audit row at all, as the v0
  //    archive backfill (scripts/v0-seed-bootstrap.ts) leaves Woon's `peaq`.
  const archived = await activeMember();
  await sql`UPDATE swarm_members SET operator = 'peaq' WHERE id = ${archived.id}`;
  ids.archived = archived.id;

  // 7. The in-house judge, seeded with the manifest's `robotmoney`, with a
  //    self-write row of its own on file.
  const themis = (await sql`SELECT id FROM swarm_members WHERE handle = 'themis'`)[0] as { id: string };
  await sql`INSERT INTO audit_log (actor, action, scope) VALUES (${themis.id}, 'update_profile', ${sql.json({ memberId: themis.id } as never)})`;
  ids.themis = themis.id;
});

test("0083 is additive, and its roster list is LIVE_ROSTER's in-house members", () => {
  expect(MIGRATION.split("\n").slice(0, 2)).toEqual(["-- compat: additive", "-- metadata_version: 1"]);
  const handles = /roster_handles text\[\] := ARRAY\[([^\]]*)\]/.exec(MIGRATION)![1]!;
  expect([...handles.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort()).toEqual(
    LIVE_ROSTER.filter((m) => m.operator === "robotmoney").map((m) => m.handle).sort(),
  );
  expect(new Set(LIVE_ROSTER.map((m) => m.operator))).toEqual(new Set(["robotmoney"]));
});

test("the migration clears every self-written operator and keeps every other, recording each id it cleared", async () => {
  // Red control: every planted value is really there before the run.
  expect({
    forged: await operatorOf(ids.forged!),
    selfNamed: await operatorOf(ids.selfNamed!),
    overwritten: await operatorOf(ids.overwritten!),
  }).toEqual({ forged: "robotmoney", selfNamed: "acme-labs", overwritten: "robotmoney" });
  const versionBefore = await versionOf(ids.forged!);
  const before = await clearedIds();

  await sql.unsafe(MIGRATION);

  expect({
    forged: await operatorOf(ids.forged!),
    selfNamed: await operatorOf(ids.selfNamed!),
    overwritten: await operatorOf(ids.overwritten!),
    adminWritten: await operatorOf(ids.adminWritten!),
    corrected: await operatorOf(ids.corrected!),
    archived: await operatorOf(ids.archived!),
    themis: await operatorOf(ids.themis!),
  }).toEqual({
    forged: null,
    selfNamed: null,
    overwritten: null,
    adminWritten: "peaq",
    corrected: "partner-co",
    archived: "peaq",
    themis: "robotmoney",
  });
  // A cleared row is an edit: its version moves, so a stale admin form cannot
  // write the forged value back.
  expect(await versionOf(ids.forged!)).toBe(versionBefore + 1);

  const recorded = (await clearedIds()).filter((id) => !before.includes(id));
  expect(recorded.sort()).toEqual([ids.forged!, ids.selfNamed!, ids.overwritten!].sort());
  const [row] = (await sql`
    SELECT before_state, after_state, scope FROM audit_log
     WHERE actor = 'migration 0083' AND target_id = ${ids.selfNamed!}`) as unknown as {
    before_state: unknown;
    after_state: unknown;
    scope: unknown;
  }[];
  expect(row).toEqual({
    before_state: { operator: "acme-labs" },
    after_state: { operator: null },
    scope: { memberId: ids.selfNamed!, fields: ["operator"] },
  });
});

test("a rerun changes nothing, and records nothing", async () => {
  const snapshot = async () =>
    (await sql`SELECT id, operator, version FROM swarm_members ORDER BY id`) as unknown as unknown[];
  const members = await snapshot();
  const recorded = await clearedIds();
  await sql.unsafe(MIGRATION);
  expect(await snapshot()).toEqual(members);
  expect(await clearedIds()).toEqual(recorded);
});

test("the judge of record keeps the in-house operator the third-party gate needs", async () => {
  // Clearing themis would make the real judge third-party to D52's gate, and
  // with third-party judging off its judgements would be refused.
  const [judge] = (await sql`SELECT role, status, operator FROM swarm_members WHERE id = ${ids.themis!}`) as unknown as {
    role: string;
    status: string;
    operator: string;
  }[];
  expect(judge).toEqual({ role: "judge", status: "active", operator: "robotmoney" });
});
