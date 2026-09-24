// 0053 must CREATE every role it ALTERs.
//
// WHY THIS IS A TEST AND NOT A COMMENT. 0053 creates rm_owner, rm_app and
// rm_readonly under `IF NOT EXISTS` guards, then ALTERs all FOUR roles --
// including rm_worker, which is 0016's. Inside the migration runner that is
// fine: 0016 sorts before 0053 and has always already run.
//
// It is not fine on the one path that applies 0053 ALONE.
// scripts/ops/provision-db-role-taxonomy.sh runs this file out-of-band through
// psql, because a migration cannot `SET LOCAL ROLE rm_owner` before the role
// exists -- that is the whole reason the script is the documented pre-step.
// Against a cluster where 0016 has never run (a brand-new primary, a fresh
// staging host, a twin restored into an empty database) `ALTER ROLE rm_worker`
// aborted the run with `role "rm_worker" does not exist`, under
// ON_ERROR_STOP=1, before 0062 and before the verification -- so a first
// bootstrap produced no roles at all and an error naming a role nobody had
// asked for.
//
// NOTHING IN CI COULD SEE IT. Every database-backed test clones a template
// built by running the migrations IN ORDER (tests/support/clean-db.ts), so
// rm_worker always pre-exists there. The gap is only reachable by applying
// this file first, which is exactly what production does.
//
// Read as TEXT, because the subject is what the file says -- and because the
// database that would prove it is a cluster that has never been migrated.
//
// rm_owner IS LOGIN (spec §3, D47, §9.1 step 1). It is the migration login, so
// 0053 creates it LOGIN on a fresh cluster and re-asserts LOGIN when applied.
// That half is proved twice: as text, and against the suite's own cluster,
// which tests/preload.ts built by applying every migration to an empty
// Postgres, so its rm_owner is exactly the role 0053 created.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";

const SQL = readFileSync(
  join(import.meta.dir, "..", "migrations", "0053_database_role_taxonomy.sql"),
  "utf8",
);

/** Role names in `ALTER ROLE <name> …` (never the DEFAULT PRIVILEGES form). */
function altered(): string[] {
  return [...SQL.matchAll(/^\s*ALTER ROLE\s+(\w+)/gm)].map((m) => m[1]!);
}

/** Role names in `CREATE ROLE <name> …`. */
function created(): string[] {
  return [...SQL.matchAll(/^\s*CREATE ROLE\s+(\w+)/gm)].map((m) => m[1]!);
}

describe("0053 can be applied to a cluster no migration has touched", () => {
  test("RED CONTROL: the matchers see the real statements", () => {
    // Guards both cases below from passing on an empty list.
    expect(new Set(altered())).toEqual(new Set(["rm_owner", "rm_app", "rm_worker", "rm_readonly"]));
    expect(created().length).toBeGreaterThanOrEqual(4);
  });

  test("every role it ALTERs, it also CREATEs", () => {
    const missing = altered().filter((role) => !created().includes(role));
    expect(missing).toEqual([]);
  });

  test("rm_owner is created LOGIN and re-asserted LOGIN, never NOLOGIN, and never with CREATEROLE", () => {
    const statements = [...SQL.matchAll(/^\s*(CREATE|ALTER) ROLE rm_owner\b([^;]*);/gm)];
    // RED CONTROL: one CREATE and one ALTER, or the assertions below say nothing.
    expect(statements.map((m) => m[1])).toEqual(["CREATE", "ALTER"]);
    for (const [, verb, attributes] of statements) {
      const words = (attributes ?? "").trim().split(/\s+/);
      expect({ verb, login: words.includes("LOGIN"), nologin: words.includes("NOLOGIN") }).toEqual({
        verb,
        login: true,
        nologin: false,
      });
      expect({ verb, nocreaterole: words.includes("NOCREATEROLE") }).toEqual({ verb, nocreaterole: true });
    }
  });

  test("every CREATE ROLE is guarded, so an existing role keeps its password", () => {
    // The script's header promises this: provisioning is idempotent and safe
    // to re-run, and a re-run must never drop a live credential on the floor.
    for (const role of created()) {
      const guard = new RegExp(
        `IF NOT EXISTS \\(SELECT FROM pg_roles WHERE rolname = '${role}'\\) THEN[\\s\\S]{0,400}?CREATE ROLE ${role}\\b`,
      );
      expect({ role, guarded: guard.test(SQL) }).toEqual({ role, guarded: true });
    }
  });
});

describe("0053 applied to an empty cluster — the suite's own", () => {
  test("rm_owner can log in, holds no CREATEROLE and is no superuser", async () => {
    const [owner] = await sql<{ rolcanlogin: boolean; rolcreaterole: boolean; rolsuper: boolean }[]>`
      SELECT rolcanlogin, rolcreaterole, rolsuper FROM pg_roles WHERE rolname = 'rm_owner'`;
    expect(owner).toEqual({ rolcanlogin: true, rolcreaterole: false, rolsuper: false });
  });
});
