// Migration 0083 clears only a self-written `robotmoney` operator, once per
// database — issue #1026 criterion 166, decision D55 (2).
//
// D55 (2): "The owner approved clearing one forged value: a self-written
// `operator` of `robotmoney`. The migration clears `operator` on a member row
// only when all of these hold: `lower(trim(operator)) = 'robotmoney'`; a member
// self-write, through the path issue #925 closed, could have set it; no later
// admin write named the operator; the member is not seeded from the roster, so
// `themis` keeps its operator. It applies once per database, as every
// migration does."
//
// Each planted row is written the way the path it stands for writes it: the
// pre-#925 self-write (the value plus an `update_profile` audit row holding
// only `{ memberId }`, which today's route refuses to write), an admin edit
// through `updateMemberAdmin`, and the roster seed. The migration's own text
// is then applied as the migrate step applies it: one transaction, as
// rm_owner. tests/member-operator-provenance.test.ts covers the provenance
// cases (a post-#925 self-write, an admin correction, an archive backfill);
// this file covers the value predicate and the once-per-database rule.
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import * as admin from "../src/swarm/admin.ts";
import { seedLiveRoster } from "../src/swarm/roster-seed.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeMember } from "./support/epoch-fixtures.ts";

useCleanDatabase(import.meta.file);

const FILE = "0083_clear_forged_member_operator.sql";
const MIGRATION = readFileSync(join(import.meta.dir, "..", "migrations", FILE), "utf8");

const ids: Record<string, string> = {};

const operatorOf = async (id: string): Promise<string | null> =>
  ((await sql`SELECT operator FROM swarm_members WHERE id = ${id}`) as unknown as { operator: string | null }[])[0]!
    .operator;
const versionOf = async (id: string): Promise<number> =>
  Number(((await sql`SELECT version FROM swarm_members WHERE id = ${id}`) as unknown as { version: number }[])[0]!.version);
const cleared = async (): Promise<{ target_id: string; before_state: unknown }[]> =>
  (await sql`
    SELECT target_id, before_state FROM audit_log
     WHERE actor = 'migration 0083' AND action = 'member_operator_cleared'
     ORDER BY id`) as unknown as { target_id: string; before_state: unknown }[];

/** A pre-#925 self-write, exactly as that code left it. */
async function selfWrite(id: string, operator: string): Promise<void> {
  await sql`UPDATE swarm_members SET operator = ${operator} WHERE id = ${id}`;
  await sql`INSERT INTO audit_log (actor, action, scope) VALUES (${id}, 'update_profile', ${sql.json({ memberId: id } as never)})`;
}

/** 0083's text, as the migrate step applies it, returning its NOTICEs. */
async function applyMigration(): Promise<string[]> {
  const notices: string[] = [];
  const url = new URL(process.env.DATABASE_URL!);
  const { default: postgres } = await import("postgres");
  const db = postgres(url.toString(), { max: 1, onnotice: (n) => notices.push(String(n.message)) });
  try {
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx.unsafe(MIGRATION);
    });
  } finally {
    await db.end({ timeout: 5 });
  }
  return notices;
}

beforeAll(async () => {
  await seedLiveRoster();

  const plain = await activeMember();
  await selfWrite(plain.id, "robotmoney");
  ids.plain = plain.id;

  const spaced = await activeMember();
  await selfWrite(spaced.id, " RobotMoney ");
  ids.spaced = spaced.id;

  const acme = await activeMember();
  await selfWrite(acme.id, "acme");
  ids.acme = acme.id;

  // An admin wrote `robotmoney` after the member's last self-write.
  const adminWritten = await activeMember();
  await selfWrite(adminWritten.id, "acme");
  const result = await admin.updateMemberAdmin(adminWritten.id, await versionOf(adminWritten.id), { operator: "robotmoney" });
  expect(result.status).toBe(200);
  ids.adminWritten = adminWritten.id;

  // The in-house judge: roster-seeded `robotmoney`, with a self-write row of
  // its own on file, which is the case the roster exception exists for.
  const themis = (await sql`SELECT id FROM swarm_members WHERE handle = 'themis'`)[0] as { id: string };
  await sql`INSERT INTO audit_log (actor, action, scope) VALUES (${themis.id}, 'update_profile', ${sql.json({ memberId: themis.id } as never)})`;
  ids.themis = themis.id;
});

test("the file's header says it applies once per database, and is additive", () => {
  expect(MIGRATION.split("\n").slice(0, 2)).toEqual(["-- compat: additive", "-- metadata_version: 1"]);
  // The header's prose, read as one line.
  const prose = MIGRATION.split("\n")
    .filter((line) => line.startsWith("--"))
    .map((line) => line.replace(/^--\s?/, ""))
    .join(" ");
  expect(prose).toContain("applies once on every database the release reaches");
  expect(prose).not.toContain("runs on every deploy");
  expect(MIGRATION).toContain("lower(trim(m.operator)) = 'robotmoney'");
});

test("a self-written robotmoney is cleared whatever its case and spacing; acme, an admin write and the roster judge are kept", async () => {
  // Red control: every planted value is really there before the run.
  expect({
    plain: await operatorOf(ids.plain!),
    spaced: await operatorOf(ids.spaced!),
    acme: await operatorOf(ids.acme!),
    adminWritten: await operatorOf(ids.adminWritten!),
    themis: await operatorOf(ids.themis!),
  }).toEqual({
    plain: "robotmoney",
    spaced: " RobotMoney ",
    acme: "acme",
    adminWritten: "robotmoney",
    themis: "robotmoney",
  });
  const before = (await cleared()).length;

  const notices = await applyMigration();

  expect({
    plain: await operatorOf(ids.plain!),
    spaced: await operatorOf(ids.spaced!),
    acme: await operatorOf(ids.acme!),
    adminWritten: await operatorOf(ids.adminWritten!),
    themis: await operatorOf(ids.themis!),
  }).toEqual({ plain: null, spaced: null, acme: "acme", adminWritten: "robotmoney", themis: "robotmoney" });

  // Each cleared member is recorded with the value removed, and NOTICEd by name.
  const recorded = (await cleared()).slice(before);
  expect(recorded.map((r) => r.target_id).sort()).toEqual([ids.plain!, ids.spaced!].sort());
  expect(recorded.find((r) => r.target_id === ids.spaced)?.before_state).toEqual({ operator: " RobotMoney " });
  expect(notices.length).toBe(2);
  const handles = (await sql`
    SELECT id, handle FROM swarm_members WHERE id IN (${ids.plain!}, ${ids.spaced!})`) as unknown as {
    id: string;
    handle: string;
  }[];
  expect(handles.length).toBe(2);
  for (const { id, handle } of handles) {
    expect(notices.filter((n) => n.includes(`on member ${id} (${handle})`)).length).toBe(1);
  }
});

test("it applies once per database: the migrate step never replays a recorded 0083", async () => {
  // A forged row planted AFTER the database recorded 0083 is not the
  // migration's to clear: the runner never re-applies a recorded file.
  const late = await activeMember();
  await selfWrite(late.id, "robotmoney");
  const recordedBefore = await cleared();
  const [ledger] = (await sql`SELECT count(*)::int AS n FROM schema_migrations WHERE name = ${FILE}`) as unknown as {
    n: number;
  }[];
  expect(ledger!.n).toBe(1);

  await migrate();

  expect(await operatorOf(late.id)).toBe("robotmoney");
  expect(await cleared()).toEqual(recordedBefore);
  const [after] = (await sql`SELECT count(*)::int AS n FROM schema_migrations WHERE name = ${FILE}`) as unknown as {
    n: number;
  }[];
  expect(after!.n).toBe(1);
});

test("replayed by hand on a database with nothing left to clear, the text changes nothing", async () => {
  // Clear the late plant first, so the only question is the no-op.
  await applyMigration();
  const snapshot = async () =>
    (await sql`SELECT id, operator, version FROM swarm_members ORDER BY id`) as unknown as unknown[];
  const members = await snapshot();
  const recorded = await cleared();
  expect(await applyMigration()).toEqual([]);
  expect(await snapshot()).toEqual(members);
  expect(await cleared()).toEqual(recorded);
});
