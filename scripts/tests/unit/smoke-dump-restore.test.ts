// The two defects the first real `bun smoke --local dump` boot met (issue
// #1026, criteria 13 and 76), pinned at the unit level. Each boot-level proof
// is scripts/tests/integration/smoke-dump-lifecycle.test.ts, which restores a
// real gpg-encrypted backup; these are the checkout-only controls that fail on
// the old code without Docker.
//
//   1. scripts/lib/restore-container.ts ran the HOST's pg_restore. A real
//      backup is written by a pg_dump at least as new as production's server
//      (smoke:capture refuses an older client), and a host pg_restore 16
//      refused the 18 archive: "unsupported version (1.16) in file header".
//      The restore now runs the restore container's own client.
//   2. scripts/lib/smoke-database.ts dumpOwnershipSql handed ownership to
//      rm_owner and granted nothing, but a backup carries no privileges
//      (`--no-privileges` at capture and at restore), so the target lock's
//      read as rm_readonly refused: "deployment_identity carries neither a
//      `kind` nor an `identity` column".
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { restoreDumpArgv, teardownArgv } from "../../lib/restore-container.ts";
import { dumpOwnershipSql, TARGET_STATE_TABLES } from "../../lib/smoke-database.ts";

const PASSWORDS = { rm_owner: "o_pw", rm_app: "a_pw", rm_worker: "w_pw", rm_readonly: "r_pw" };

describe("restore-container: the archive is read by the restore container's own pg_restore", () => {
  test("pg_restore runs INSIDE the container (docker exec -i), never as a host binary", () => {
    const argv = restoreDumpArgv("rm-restore-20260925T000000Z-abc123");
    expect(argv.slice(0, 5)).toEqual(["docker", "exec", "-i", "rm-restore-20260925T000000Z-abc123", "pg_restore"]);
    // The old code's first word was the host's `pg_restore`.
    expect(argv[0]).not.toBe("pg_restore");
  });

  test("it still restores without owners or privileges and stops on the first error", () => {
    const argv = restoreDumpArgv("c");
    for (const flag of ["--no-owner", "--no-privileges", "--exit-on-error"]) expect(argv).toContain(flag);
    // Over the container's local socket: no host, port or password travels in argv.
    expect(argv.some((a) => a.startsWith("--host") || a.startsWith("--port") || a.includes("PGPASSWORD"))).toBe(false);
  });

  test("teardown removes the container's anonymous data volume with it (-v)", () => {
    expect(teardownArgv("c")).toEqual(["docker", "rm", "-f", "-v", "c"]);
  });
});

describe("dumpOwnershipSql: the runtime roles read the target state the lock reads, and nothing more", () => {
  const sql = dumpOwnershipSql(PASSWORDS, "rm_restore_check");

  test("TARGET_STATE_TABLES is exactly what backend/src/db/target-lock.ts readTargetState reads", () => {
    const source = readFileSync(join(import.meta.dir, "..", "..", "..", "backend", "src", "db", "target-lock.ts"), "utf8");
    const body = source.slice(source.indexOf("async function readIdentity"), source.indexOf("export async function readTargetState("));
    const read = [...body.matchAll(/to_regclass\('(?:public\.)?([a-z_]+)'\)/g)].map((m) => m[1]).sort();
    expect(read).toEqual([...TARGET_STATE_TABLES].sort());
  });

  test("grants SELECT on each target-state table the restored version has, to the three runtime roles", () => {
    for (const table of TARGET_STATE_TABLES) expect(sql).toContain(`'${table}'`);
    expect(sql).toContain("IF to_regclass('public.' || t) IS NOT NULL THEN");
    expect(sql).toContain("GRANT SELECT ON public.%I TO rm_app, rm_worker, rm_readonly");
    expect(sql).toContain("GRANT USAGE ON SCHEMA public TO rm_app, rm_worker, rm_readonly;");
  });

  test("grants no write, DELETE or TRUNCATE to any runtime role (D55 (6)); every other grant is --migrate's reconciliation", () => {
    const grants = sql.split("\n").filter((l) => /\bGRANT\b/.test(l) && !/^\s*--/.test(l));
    expect(grants.length).toBe(2);
    for (const line of grants) expect(line).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL|CREATE|TRIGGER|REFERENCES)\b/);
  });

  test("still hands every application object to rm_owner, after the four roles exist", () => {
    expect(sql.indexOf("CREATE ROLE rm_readonly")).toBeGreaterThan(-1);
    expect(sql.indexOf("ALTER SCHEMA public OWNER TO rm_owner")).toBeGreaterThan(sql.indexOf("CREATE ROLE rm_readonly"));
    expect(sql.indexOf("GRANT SELECT ON public.%I")).toBeGreaterThan(sql.indexOf("ALTER SCHEMA public OWNER TO rm_owner"));
  });
});
