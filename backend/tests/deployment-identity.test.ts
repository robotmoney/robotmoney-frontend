// `deployment_identity` is written by rm_owner and by nobody else — issue
// #1026, docs/technical/smoke-production-spec.md §4.2 and D52.
//
// §4.2 makes the one-row enrollment "writable only by rm_owner": it is the row
// that decides whether production guards arm (§4.3), so a runtime role that
// could write it could enrol a production database as a rehearsal and switch
// every production guard off from inside the application. Migration 0063
// revokes ALL from the three runtime roles and grants SELECT back, and
// backend/schema/grants.sql re-asserts that on every reconciliation.
//
// WHAT THIS FILE PROVES, AND HOW. Each runtime role is refused INSERT, UPDATE,
// DELETE and TRUNCATE BY GRANT — SQLSTATE 42501, raised by the executor's
// privilege check before any row or trigger is looked at — over a real login
// connection AS THAT ROLE. Not a `has_table_privilege` query and not a
// TypeScript role check: the statement is attempted and the database refuses
// it. It is proved twice: on the migrated schema, and again after a run of the
// REAL roles-and-grants part of the snapshot (the file every migrate run
// applies), because the historical failure in this repository is a
// reconciliation sweep that quietly widened a table a migration had narrowed.
//
// SELECT is asserted for each role as well. Without it, a role that could not
// even connect would pass every refusal below.
//
// THE TWO WRITERS OF `rehearsal` (§4.2: "`rehearsal` is written by every
// `--local blank` bootstrap, every `--local dump` restore ..."), each driven
// through the PROCESS `bun smoke` runs for it — backend/scripts/smoke-prepare.ts,
// started exactly as scripts/lib/smoke-main.ts starts it, under a target lock
// the test holds the way the boot does:
//   - `bootstrap` on a blank database the local superuser handed to rm_owner:
//     the row reads `rehearsal`, written by rm_owner, and every runtime role is
//     still refused every write to it by grant;
//   - `enroll` on a restored, populated copy that arrived enrolled as
//     `production` (what a production dump carries): the row reads
//     `rehearsal`, written by rm_owner.
// A real `bun smoke --local blank` boot's row is asserted in
// scripts/tests/integration/smoke-lifecycle.test.ts. The `--local dump`
// RESTORE itself (gpg, pg_restore into its own container) needs an encrypted
// production backup, which no test here has; the enrollment it ends with is the
// step proved below.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { sql } from "../src/db/client.ts";
import { loadSnapshot } from "../src/db/schema-snapshot.ts";
import { acquireTargetLock, readTargetState } from "../src/db/target-lock.ts";
import { instancePaths } from "../../scripts/lib/smoke-state.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const RUNTIME_ROLES = ["rm_app", "rm_worker", "rm_readonly"] as const;
type RuntimeRole = (typeof RUNTIME_ROLES)[number];

const PASSWORD: Record<RuntimeRole, string> = {
  rm_app: "rm_app_identity_test",
  rm_worker: "rm_worker_identity_test",
  rm_readonly: "rm_readonly_identity_test",
};

/** Each write a runtime role might attempt, spelled so that the privilege
 *  check is the ONLY thing that can refuse it: the INSERT would violate the
 *  one-row key, the UPDATE and DELETE match the one row, and TRUNCATE has no
 *  WHERE at all. A 42501 therefore cannot be a constraint or an empty match. */
const WRITES = {
  INSERT: "INSERT INTO deployment_identity (kind) VALUES ('production')",
  UPDATE: "UPDATE deployment_identity SET kind = 'production'",
  DELETE: "DELETE FROM deployment_identity",
  TRUNCATE: "TRUNCATE deployment_identity",
} as const;

const connections = new Map<RuntimeRole, postgres.Sql<{}>>();

beforeAll(async () => {
  const [{ db }] = (await sql`SELECT current_database() AS db`) as unknown as { db: string }[];
  for (const role of RUNTIME_ROLES) {
    await sql.unsafe(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${PASSWORD[role]}'`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${db}`;
    url.username = role;
    url.password = PASSWORD[role];
    connections.set(role, postgres(url.toString(), { max: 1, onnotice: () => {} }));
  }
  // The enrollment a blank bootstrap writes, so every refusal below is refusing
  // a write to a real row.
  await sql`INSERT INTO deployment_identity (kind) VALUES ('rehearsal') ON CONFLICT (id) DO NOTHING`;
});

afterAll(async () => {
  for (const connection of connections.values()) await connection.end({ timeout: 5 });
});

async function sqlstate(role: RuntimeRole, statement: string): Promise<string | null> {
  try {
    await connections.get(role)!.unsafe(statement);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "no-sqlstate";
  }
}

async function assertEveryWriteRefusedByGrant(): Promise<void> {
  for (const role of RUNTIME_ROLES) {
    // The connection is real and the table is readable: a refusal below is
    // about writing, not about reaching the database.
    const [who] = (await connections.get(role)!`SELECT current_user AS role`) as unknown as { role: string }[];
    expect(who?.role).toBe(role);
    const rows = (await connections.get(role)!`SELECT kind FROM deployment_identity`) as unknown as { kind: string }[];
    expect(rows.map((r) => r.kind)).toEqual(["rehearsal"]);

    for (const [verb, statement] of Object.entries(WRITES)) {
      expect({ role, verb, sqlstate: await sqlstate(role, statement) }).toEqual({ role, verb, sqlstate: "42501" });
    }
  }
  // And nothing moved.
  const after = await sql<{ kind: string }[]>`SELECT kind FROM deployment_identity`;
  expect(after.map((r) => r.kind)).toEqual(["rehearsal"]);
}

describe("deployment_identity refuses every runtime role's write by grant (§4.2, D52)", () => {
  test("on the migrated schema: rm_app, rm_worker and rm_readonly each get 42501 for INSERT, UPDATE, DELETE and TRUNCATE", async () => {
    await assertEveryWriteRefusedByGrant();
  });

  test("after the real roles-and-grants reconciliation runs, still 42501 for every role and every write", async () => {
    // The file every migrate run applies (§8.3: "always, even with nothing
    // pending"), as the role that applies it.
    const snapshot = await loadSnapshot();
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx.unsafe(snapshot.grantsSql);
    });
    await assertEveryWriteRefusedByGrant();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The runtime writers of `rehearsal`: the smoke's own preparation process
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_PASSWORD = randomBytes(18).toString("base64url");
let ownerCanLogin = true;

function urlFor(database: string, role?: { name: string; password: string }): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role.name;
    url.password = encodeURIComponent(role.password);
  }
  return url.toString();
}

/**
 * Run one step of backend/scripts/smoke-prepare.ts against `database`, the way
 * `bun smoke` does: an instance state directory holding the role passwords,
 * the target lock held by THIS process (the child proves its parent's lock),
 * the request in RM_PREPARE_REQUEST and the result in a file.
 */
async function prepareStep(
  action: "bootstrap" | "enroll",
  database: string,
  note?: string,
): Promise<{ ok: boolean; action?: string; error?: string; detail?: Record<string, unknown> }> {
  const root = mkdtempSync(join(tmpdir(), "rm-identity-prepare-"));
  try {
    const instance = "rm_it_identity";
    const paths = instancePaths(root, instance, { create: true });
    writeFileSync(
      paths.rolePasswordsFile,
      JSON.stringify({ rm_owner: OWNER_PASSWORD, rm_app: PASSWORD.rm_app, rm_worker: PASSWORD.rm_worker, rm_readonly: PASSWORD.rm_readonly }),
    );
    chmodSync(paths.rolePasswordsFile, 0o600);
    const reader = postgres(urlFor(database), { max: 1, onnotice: () => {} });
    const expected = await readTargetState(reader);
    await reader.end({ timeout: 5 });
    const holder = { tool: "smoke", planId: "c0ffee00c0ffee00c0ffee00", instance, host: "test-host", pid: process.pid };
    const acquired = await acquireTargetLock({ databaseUrl: urlFor(database), holder, timeoutMs: 10_000, expected });
    if (!acquired.acquired) throw new Error(acquired.reason);
    try {
      const url = new URL(process.env.DATABASE_URL!);
      const resultFile = join(paths.dir, "result.json");
      const request = {
        action,
        rmEnv: "stage",
        connection: "local",
        target: { host: url.hostname, port: Number(url.port), database, sslmode: "disable" },
        credentials: { source: "instance", stateRoot: root, instance },
        lock: { backendPid: acquired.lock.backendPid, holder: acquired.lock.holder },
        stateDir: paths.dir,
        resultFile,
        nonInteractive: true,
        ...(note ? { note } : {}),
      };
      const child = Bun.spawnSync(["bun", "--no-env-file", "scripts/smoke-prepare.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? root, RM_PREPARE_REQUEST: JSON.stringify(request) },
        stdout: "pipe",
        stderr: "pipe",
      });
      const result = JSON.parse(readFileSync(resultFile, "utf8")) as { ok: boolean; error?: string };
      if (child.exitCode !== 0 && result.ok) throw new Error(`the step exited ${child.exitCode} with an ok result`);
      return result;
    } finally {
      await acquired.lock.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function enrollment(database: string): Promise<string> {
  const db = postgres(urlFor(database), { max: 1, onnotice: () => {} });
  try {
    const rows = await db<{ kind: string; written_by: string }[]>`SELECT kind, written_by FROM deployment_identity`;
    return rows.map((r) => `${r.kind}|${r.written_by}`).join(",");
  } finally {
    await db.end({ timeout: 5 });
  }
}

async function writeAs(database: string, role: RuntimeRole, statement: string): Promise<string | null> {
  const conn = postgres(urlFor(database, { name: role, password: PASSWORD[role] }), { max: 1, onnotice: () => {} });
  try {
    await conn.unsafe(statement);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "no-sqlstate";
  } finally {
    await conn.end({ timeout: 5 });
  }
}

describe("the smoke's own preparation writes `rehearsal` through rm_owner, and nothing else can (§4.2, criterion 76)", () => {
  beforeAll(async () => {
    const [row] = await sql<{ rolcanlogin: boolean }[]>`SELECT rolcanlogin FROM pg_roles WHERE rolname = 'rm_owner'`;
    ownerCanLogin = row?.rolcanlogin ?? true;
    await sql.unsafe(`ALTER ROLE rm_owner LOGIN PASSWORD '${OWNER_PASSWORD}'`);
  });

  afterAll(async () => {
    await sql.unsafe(`ALTER ROLE rm_owner ${ownerCanLogin ? "LOGIN" : "NOLOGIN"} PASSWORD NULL`);
  });

  test("`--local blank`: the bootstrap step leaves `rehearsal` written by rm_owner, and every runtime role is still refused every write by grant", async () => {
    // What the local superuser does for a blank boot and nothing more: the
    // database, owned by rm_owner, and the provider's extension (§7.3).
    const name = `rm_identity_blank_${randomBytes(4).toString("hex")}`;
    await sql.unsafe(`CREATE DATABASE ${name} OWNER rm_owner`);
    try {
      const admin = postgres(urlFor(name), { max: 1, onnotice: () => {} });
      await admin.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
      await admin.end({ timeout: 5 });
      const result = await prepareStep("bootstrap", name);
      expect({ ok: result.ok, error: result.error }).toEqual({ ok: true, error: undefined });
      expect(await enrollment(name)).toBe("rehearsal|rm_owner");
      for (const role of RUNTIME_ROLES) {
        for (const [verb, statement] of Object.entries(WRITES)) {
          expect({ role, verb, code: await writeAs(name, role, statement) }).toEqual({ role, verb, code: "42501" });
        }
      }
      expect(await enrollment(name)).toBe("rehearsal|rm_owner");
    } finally {
      await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  }, 120_000);

  test("`--local dump`: a restored copy that arrived enrolled as `production` is re-enrolled `rehearsal` by the enroll step, as rm_owner", async () => {
    // A populated, migrated copy carrying production's row — what a restored
    // production dump holds until its enrollment is overwritten.
    const name = `rm_identity_dump_${randomBytes(4).toString("hex")}`;
    await sql.unsafe(`CREATE DATABASE ${name} TEMPLATE "${process.env.RM_TEST_TEMPLATE_DB}"`);
    try {
      const admin = postgres(urlFor(name), { max: 1, onnotice: () => {} });
      await admin.unsafe("DELETE FROM deployment_identity");
      await admin.unsafe("INSERT INTO deployment_identity (kind) VALUES ('production')");
      await admin.end({ timeout: 5 });
      expect((await enrollment(name)).startsWith("production|")).toBe(true);

      const result = await prepareStep("enroll", name, "--local dump test-stamp");
      expect({ ok: result.ok, error: result.error }).toEqual({ ok: true, error: undefined });
      expect(await enrollment(name)).toBe("rehearsal|rm_owner");
    } finally {
      await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  }, 120_000);

  test("red control: a runtime role cannot perform that same re-enrollment — the grant, not the tool, is what stops it", async () => {
    const name = `rm_identity_redctl_${randomBytes(4).toString("hex")}`;
    await sql.unsafe(`CREATE DATABASE ${name} TEMPLATE "${process.env.RM_TEST_TEMPLATE_DB}"`);
    try {
      const admin = postgres(urlFor(name), { max: 1, onnotice: () => {} });
      await admin.unsafe("DELETE FROM deployment_identity");
      await admin.unsafe("INSERT INTO deployment_identity (kind) VALUES ('production')");
      await admin.end({ timeout: 5 });
      for (const role of RUNTIME_ROLES) {
        expect({ role, code: await writeAs(name, role, "UPDATE deployment_identity SET kind = 'rehearsal'") }).toEqual({ role, code: "42501" });
      }
      expect((await enrollment(name)).startsWith("production|")).toBe(true);
    } finally {
      await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  }, 60_000);
});
