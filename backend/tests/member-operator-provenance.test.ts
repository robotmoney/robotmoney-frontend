// Forged `robotmoney` member operators are cleared by a forward migration —
// issue #1026, decision D55 (2), migration 0101.
//
// D55 (2): the owner "approved clearing one forged value: a self-written
// `operator` of `robotmoney`", only where a member self-write could have set
// it, no later admin write named the operator, and the member is not seeded
// from the roster. "It applies once per database, as every migration does."
// The judge's third-party gate passes `robotmoney`, so that value written by a
// member for itself is a standing forgery; any other self-written value passes
// no gate and is kept. tests/operator-self-write-migration.test.ts proves the
// value predicate (case and spaces) and the once-per-database rule; this file
// proves the provenance rule with every row written by its real writer path.
//
// EVERY ROW HERE IS WRITTEN BY THE PATH IT STANDS FOR, where that path still
// exists: the member's own profile route (`updateMemberProfile`), the admin
// edit (`updateMemberAdmin`) and the in-house roster seed (`seedLiveRoster`).
// The one exception is the pre-#925 forgery itself, which today's code refuses
// to write: it is planted exactly as that code left it — the value on the row
// and an `update_profile` audit row holding only `{ memberId }` (ce2c4427).
//
// The migration was applied when the template was built; each case plants its
// state in this file's own database (useCleanDatabase) and then runs 0101's
// own text again, as rm_owner, the way the migrate step applies it.
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
  join(import.meta.dir, "..", "migrations", "0101_clear_forged_member_operator.sql"),
  "utf8",
);

const operatorOf = async (id: string): Promise<string | null> =>
  ((await sql`SELECT operator FROM swarm_members WHERE id = ${id}`) as unknown as { operator: string | null }[])[0]!
    .operator;
const versionOf = async (id: string): Promise<number> =>
  Number(((await sql`SELECT version FROM swarm_members WHERE id = ${id}`) as unknown as { version: number }[])[0]!.version);
const clearedIds = async (): Promise<string[]> =>
  ((await sql`
    SELECT target_id FROM audit_log WHERE actor = 'migration 0101' AND action = 'member_operator_cleared'
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
  //    reserved one gets past today's route): self-written, but not the value
  //    the gate trusts, so D55 (2) keeps it.
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

  // 8. Production-shaped: noop-analyst is seated, holds the manifest's
  //    `robotmoney`, is NOT in LIVE_ROSTER, and wrote its profile through the
  //    self-write route (issue #1120). Its audit row is the pre-#925 shape.
  const noop = await activeMember();
  await sql`UPDATE swarm_members SET handle = 'noop-analyst' WHERE id = ${noop.id}`;
  await forgePre925(noop.id, "robotmoney");
  ids.noop = noop.id;
});

test("0101 is additive, and its exempt list is every in-house seat: LIVE_ROSTER plus noop-analyst", () => {
  expect(MIGRATION.split("\n").slice(0, 2)).toEqual(["-- compat: additive", "-- metadata_version: 1"]);
  const handles = /roster_handles text\[\] := ARRAY\[([^\]]*)\]/.exec(MIGRATION)![1]!;
  expect([...handles.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort()).toEqual(
    [...LIVE_ROSTER.filter((m) => m.operator === "robotmoney").map((m) => m.handle), "noop-analyst"].sort(),
  );
  // noop-analyst is in-house by its manifest, though production seats it without the seed.
  const manifest = JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "..", "frontend", "public", "data", "swarm", "manifests", "members", "noop-analyst.json"),
      "utf8",
    ),
  ) as { operator: string };
  expect(manifest.operator).toBe("robotmoney");
  expect(new Set(LIVE_ROSTER.map((m) => m.operator))).toEqual(new Set(["robotmoney"]));
});

/** 0101's text as the migrate step applies it: one transaction, as rm_owner. */
async function applyMigration(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    await tx.unsafe(MIGRATION);
  });
}

test("the migration clears every self-written robotmoney operator and keeps every other, recording each id it cleared", async () => {
  // Red control: every planted value is really there before the run.
  expect({
    forged: await operatorOf(ids.forged!),
    selfNamed: await operatorOf(ids.selfNamed!),
    overwritten: await operatorOf(ids.overwritten!),
  }).toEqual({ forged: "robotmoney", selfNamed: "acme-labs", overwritten: "robotmoney" });
  const versionBefore = await versionOf(ids.forged!);
  const selfNamedVersion = await versionOf(ids.selfNamed!);
  const before = await clearedIds();

  await applyMigration();

  expect({
    forged: await operatorOf(ids.forged!),
    selfNamed: await operatorOf(ids.selfNamed!),
    overwritten: await operatorOf(ids.overwritten!),
    adminWritten: await operatorOf(ids.adminWritten!),
    corrected: await operatorOf(ids.corrected!),
    archived: await operatorOf(ids.archived!),
    themis: await operatorOf(ids.themis!),
    noop: await operatorOf(ids.noop!),
  }).toEqual({
    forged: null,
    selfNamed: "acme-labs",
    overwritten: null,
    adminWritten: "peaq",
    corrected: "partner-co",
    archived: "peaq",
    themis: "robotmoney",
    noop: "robotmoney",
  });
  // A cleared row is an edit: its version moves, so a stale admin form cannot
  // write the forged value back.
  expect(await versionOf(ids.forged!)).toBe(versionBefore + 1);
  // A kept row is not touched at all.
  expect(await versionOf(ids.selfNamed!)).toBe(selfNamedVersion);

  const recorded = (await clearedIds()).filter((id) => !before.includes(id));
  expect(recorded.sort()).toEqual([ids.forged!, ids.overwritten!].sort());
  const [row] = (await sql`
    SELECT before_state, after_state, scope FROM audit_log
     WHERE actor = 'migration 0101' AND target_id = ${ids.forged!}`) as unknown as {
    before_state: unknown;
    after_state: unknown;
    scope: unknown;
  }[];
  expect(row).toEqual({
    before_state: { operator: "robotmoney" },
    after_state: { operator: null },
    scope: { memberId: ids.forged!, fields: ["operator"] },
  });
});

test("a rerun changes nothing, and records nothing", async () => {
  const snapshot = async () =>
    (await sql`SELECT id, operator, version FROM swarm_members ORDER BY id`) as unknown as unknown[];
  const members = await snapshot();
  const recorded = await clearedIds();
  await applyMigration();
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
