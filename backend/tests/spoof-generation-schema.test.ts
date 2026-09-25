// The spoof generation is recorded on the key row the rebind inserts — issue
// #1026, migration 0087, smoke-production-spec.md §6.4, criteria 146 and 147.
//
// §6.4's recovery: a rerun "finds the database ALREADY at that generation,
// skips (1) and (2), and performs only (3) and (4)"
// (scripts/lib/swarm/spoof-keys.ts `rebindSpoofedKeys`). The database must
// therefore RECORD which generation it is at. Wave 4 adds the column; wave 5
// (w5-participants-runtime) writes it from `rebindMemberKey` and reads it in
// `readInstalledGeneration`. This file proves the schema half against real
// databases:
//
//   1. `swarm_member_keys.spoof_generation_id` exists, nullable text, on the
//      blank bootstrap, the full replay and snapshot N + the real migrate run,
//      and key rows written before the migration read NULL;
//   2. the rebind's shape needs no DELETE and no UPDATE of a recorded
//      generation: retire the old key (`active = false`, what every key path
//      already does), INSERT the new key carrying the id, and the
//      installed-generation read finds it on every spoofed member's active key;
//   3. today's key INSERT (no generation) still works and leaves it NULL, and
//      the table is still append-only (its guard refuses a DELETE).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { bootstrapBlankDatabase, loadSnapshot } from "../src/db/schema-snapshot.ts";
import { ScratchDatabases } from "./support/snapshot-fixture.ts";

const suffix = crypto.randomUUID().slice(0, 8);
const dbs = new ScratchDatabases();
const PRE_MEMBER = crypto.randomUUID();

let fresh: postgres.Sql<{}>;
let migrated: postgres.Sql<{}>;
let advanced: postgres.Sql<{}>;

beforeAll(async () => {
  fresh = await dbs.blank(`rm_spoofgen_fresh_${suffix}`);
  await bootstrapBlankDatabase(fresh, await loadSnapshot());
  await fresh.unsafe("RESET ROLE");

  migrated = await dbs.migrated(`rm_spoofgen_migrated_${suffix}`);

  const name = `rm_spoofgen_advanced_${suffix}`;
  advanced = await dbs.atSnapshotN(name);
  await advanced`INSERT INTO swarm_members (id, name, status) VALUES (${PRE_MEMBER}, 'Pre-generation Member', 'active')`;
  await advanced`INSERT INTO swarm_member_keys (member_id, public_key, active, token_hash) VALUES (${PRE_MEMBER}, 'pre-key', true, 'pre-token-hash')`;
  const run = await dbs.migrate(advanced, name);
  expect(run.applied).toContain("0087_member_key_spoof_generation.sql");
  await advanced.unsafe("RESET ROLE");
}, 180_000);

afterAll(async () => {
  await dbs.dropAll();
});

/** Run `body` as `role` in a transaction that always rolls back. */
async function asRole<T>(db: postgres.Sql<{}>, role: string, body: (tx: postgres.TransactionSql<{}>) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db
    .begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      result = await body(tx);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
  return result as T;
}
class Rollback extends Error {}

async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "no-sqlstate";
  }
}

describe("swarm_member_keys.spoof_generation_id (spec §6.4)", () => {
  test("exists as nullable text with no default on every path to the current version", async () => {
    for (const db of [fresh, migrated, advanced]) {
      const [column] = (await db`
        SELECT format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
               EXISTS (SELECT 1 FROM pg_attrdef d WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum) AS has_default
        FROM pg_attribute a
        WHERE a.attrelid = 'public.swarm_member_keys'::regclass AND a.attname = 'spoof_generation_id'
          AND NOT a.attisdropped`) as unknown as { type: string; not_null: boolean; has_default: boolean }[];
      expect(column).toEqual({ type: "text", not_null: false, has_default: false });
      const [check] = (await db`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'public.swarm_member_keys'::regclass
          AND conname = 'swarm_member_keys_spoof_generation_id_check'`) as unknown as { def: string }[];
      expect(check?.def).toBe("CHECK (((spoof_generation_id IS NULL) OR (spoof_generation_id <> ''::text)))");
    }
  });

  test("a key written before the migration reads NULL, and the migration was recorded additive", async () => {
    const rows = (await advanced`
      SELECT spoof_generation_id FROM swarm_member_keys WHERE member_id = ${PRE_MEMBER}`) as unknown as {
      spoof_generation_id: string | null;
    }[];
    expect(rows).toEqual([{ spoof_generation_id: null }]);
    const [ledger] = (await advanced`
      SELECT compat FROM schema_migrations WHERE name = '0087_member_key_spoof_generation.sql'`) as unknown as {
      compat: string;
    }[];
    expect(ledger?.compat).toBe("additive");
  });

  test("today's key INSERT still works as rm_app and leaves the generation NULL", async () => {
    const member = crypto.randomUUID();
    await migrated`INSERT INTO swarm_members (id, name, status) VALUES (${member}, 'Old Code Member', 'active')`;
    const generation = await asRole(migrated, "rm_app", async (tx) => {
      // src/swarm/admin.ts, the manual add.
      await tx`INSERT INTO swarm_member_keys (member_id, public_key, active, token_hash)
               VALUES (${member}, 'old-code-key', true, ${`old-code-${member}`})`;
      return tx`SELECT spoof_generation_id FROM swarm_member_keys WHERE member_id = ${member}`;
    });
    expect([...generation]).toEqual([{ spoof_generation_id: null }]);
  });

  test("the rebind's shape: retire, INSERT with the id, and every spoofed member's active key carries it — no DELETE, no UPDATE of a generation", async () => {
    const members = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [i, member] of members.entries()) {
      await migrated`INSERT INTO swarm_members (id, name, status) VALUES (${member}, ${`Spoofed ${i}`}, 'active')`;
      await migrated`INSERT INTO swarm_member_keys (member_id, public_key, active, token_hash)
                     VALUES (${member}, ${`real-key-${i}`}, true, ${`real-token-${member}`})`;
    }
    const generationId = "gen-0123456789abcdef";
    const outcome = await asRole(migrated, "rm_app", async (tx) => {
      // readInstalledGeneration: the generation every named member's ACTIVE key
      // carries. Before the rebind: none.
      const installed = async () =>
        (await tx`
          SELECT array_agg(DISTINCT coalesce(spoof_generation_id, '<none>')) AS generations, count(*)::int AS keys
          FROM swarm_member_keys WHERE member_id = ANY(${members}) AND active`) as unknown as {
          generations: string[];
          keys: number;
        }[];
      const before = (await installed())[0];
      // The rebind, one transaction: the key paths' own retire, then the new key.
      for (const [i, member] of members.entries()) {
        await tx`UPDATE swarm_member_keys SET active = false WHERE member_id = ${member} AND active`;
        await tx`INSERT INTO swarm_member_keys (member_id, public_key, active, token_hash, spoof_generation_id)
                 VALUES (${member}, ${`spoof-key-${i}`}, true, ${`spoof-token-${member}`}, ${generationId})`;
      }
      const after = (await installed())[0];
      // History kept: the real keys are still there, retired.
      const [history] = (await tx`
        SELECT count(*)::int AS n FROM swarm_member_keys
        WHERE member_id = ANY(${members}) AND NOT active AND spoof_generation_id IS NULL`) as unknown as { n: number }[];
      return { before, after, retired: history!.n };
    });
    expect(outcome).toEqual({
      before: { generations: ["<none>"], keys: 2 },
      after: { generations: [generationId], keys: 2 },
      retired: 2,
    });
  });

  test("an empty generation id is refused, and the table's append-only guard is still armed", async () => {
    const [key] = (await migrated`SELECT member_id FROM swarm_member_keys LIMIT 1`) as unknown as { member_id: string }[];
    const member = key?.member_id ?? PRE_MEMBER;
    const empty = await sqlState(() =>
      asRole(migrated, "rm_owner", (tx) =>
        tx`INSERT INTO swarm_member_keys (member_id, public_key, active, spoof_generation_id) VALUES (${member}, 'k', false, '')`,
      ),
    );
    expect(empty).toBe("23514");
    // 0050's statement- and row-level guard triggers, still present and firing
    // always, on every path. That they refuse a removal is
    // tests/append-only-enforcement.test.ts's proof; this one pins that adding
    // the column left them in place.
    for (const db of [fresh, migrated, advanced]) {
      const triggers = (await db`
        SELECT tgname, tgenabled::text AS enabled FROM pg_trigger
        WHERE tgrelid = 'public.swarm_member_keys'::regclass AND NOT tgisinternal
        ORDER BY tgname`) as unknown as { tgname: string; enabled: string }[];
      expect(triggers).toEqual([
        { tgname: "swarm_member_keys_append_only", enabled: "A" },
        { tgname: "swarm_member_keys_append_only_row", enabled: "A" },
      ]);
    }
  });
});
