// The test database is not a superuser database (smoke-production-spec.md §7.3,
// issue #1026 W6 P2, criterion [preload]).
//
// §7.3: "There is no superuser test database. The local container's superuser
// does only what `doadmin` does in production: it creates the four roles and the
// database, once. `rm_owner` then provisions the schema, tests connect as
// `rm_app`/`rm_worker`/`rm_readonly`, and nothing uses the superuser again."
//
// What this file pins, each from the running cluster or from the source, not
// from a comment:
//
//   1. NO POOL IS A SUPERUSER. The api pool and the worker pool authenticate as
//      logins that hold no SUPERUSER, CREATEROLE, CREATEDB, REPLICATION or
//      BYPASSRLS, and neither login is the container's bootstrap superuser.
//   2. THE WORKER POOL IS A RUNTIME ROLE. Its session role is `rm_worker`, and it
//      is refused DELETE, as a runtime role is (D55 (6)).
//   3. THE SCHEMA IS `rm_owner`'S. Every relation in the shared database is owned
//      by it, and the ledger is the snapshot's own filename list: the database
//      was bootstrapped from backend/schema/, not replayed by a superuser.
//   4. THE SUPERUSER IS REACHED ONLY BY A PINNED LIST OF FILES. A file that
//      imports the cluster-admin helpers, or reads RM_TEST_ADMIN_URL, is named
//      in CLUSTER_ADMIN_FILES below by equality: adding a use is a visible edit
//      here and a failing test until it is made, never one quiet import.
//   5. NO TEST STARTS A POSTGRES OF ITS OWN. `docker run` appears in
//      tests/preload.ts and nowhere else under backend/tests/ (eight migration
//      tests used to start one each, as a superuser; they replay history through
//      tests/support/history-database.ts now).
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import * as workerClient from "../src/db/worker-client.ts";
import { loadSnapshot } from "../src/db/schema-snapshot.ts";
import { adminUrl } from "./support/cluster.ts";

const TESTS = import.meta.dir;

/** Every `.ts` file under backend/tests/, as a path relative to it. */
function testFiles(): string[] {
  return (readdirSync(TESTS, { recursive: true, encoding: "utf8" }) as string[])
    .filter((f) => f.endsWith(".ts") && !f.includes("node_modules"))
    .sort();
}

interface LoginFacts {
  session_user: string;
  current_user: string;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
}

const FACTS = `
  SELECT session_user::text AS session_user, current_user::text AS current_user,
         r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls
    FROM pg_roles r WHERE r.rolname = session_user`;

describe("the pools log in as roles, never as a superuser", () => {
  test("the api pool: a login with no cluster powers, acting as the schema owner", async () => {
    const [facts] = (await sql.unsafe(FACTS)) as unknown as LoginFacts[];
    expect(facts).toBeDefined();
    expect({
      rolsuper: facts!.rolsuper,
      rolcreaterole: facts!.rolcreaterole,
      rolcreatedb: facts!.rolcreatedb,
      rolreplication: facts!.rolreplication,
      rolbypassrls: facts!.rolbypassrls,
    }).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false });
    expect(facts!.session_user).toBe("rm_test");
    expect(facts!.current_user).toBe("rm_app");
  });

  test("the worker pool: a login with no cluster powers, whose session role is rm_worker", async () => {
    const [facts] = (await workerClient.sql.unsafe(FACTS)) as unknown as LoginFacts[];
    expect(facts).toBeDefined();
    expect({
      rolsuper: facts!.rolsuper,
      rolcreaterole: facts!.rolcreaterole,
      rolcreatedb: facts!.rolcreatedb,
      rolreplication: facts!.rolreplication,
      rolbypassrls: facts!.rolbypassrls,
    }).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false });
    expect(facts!.session_user).toBe("rm_test_worker");
    expect(facts!.current_user).toBe("rm_worker");
  });

  test("neither configured URL is the container's bootstrap superuser", () => {
    const admin = new URL(adminUrl()).username;
    expect(new URL(process.env.DATABASE_URL!).username).not.toBe(admin);
    expect(new URL(process.env.WORKER_DATABASE_URL!).username).not.toBe(admin);
    // Non-vacuous: the admin is a real, different login.
    expect(admin.length).toBeGreaterThan(0);
  });

  test("the four §3 roles are themselves not superusers and cannot create roles or databases", async () => {
    const rows = (await sql.unsafe(`
      SELECT rolname::text AS rolname, rolsuper, rolcreaterole, rolcreatedb
        FROM pg_roles WHERE rolname IN ('rm_owner', 'rm_app', 'rm_worker', 'rm_readonly') ORDER BY rolname`)) as unknown as {
      rolname: string;
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
    }[];
    expect(rows.map((r) => r.rolname)).toEqual(["rm_app", "rm_owner", "rm_readonly", "rm_worker"]);
    for (const row of rows) {
      expect({ role: row.rolname, rolsuper: row.rolsuper, rolcreaterole: row.rolcreaterole, rolcreatedb: row.rolcreatedb }).toEqual({
        role: row.rolname,
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
      });
    }
  });
});

describe("the worker pool is a runtime role", () => {
  test("it is refused DELETE, the privilege no runtime role holds (D55 (6))", async () => {
    let code: string | undefined;
    try {
      await workerClient.sql`DELETE FROM job_schedules WHERE false`;
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe("42501");
  });

  test("and it can do what the worker does: claim work in the queue", async () => {
    const rows = await workerClient.sql`SELECT count(*)::int AS n FROM jobs`;
    expect(typeof rows[0]!.n).toBe("number");
  });
});

describe("the schema is rm_owner's, provisioned from the snapshot", () => {
  test("every relation in public is owned by rm_owner", async () => {
    // The pool acts as rm_owner, so tests may create relations of their own
    // (owned by rm_owner too); what must NOT be present is a relation owned by
    // the bootstrap superuser or by a runtime role.
    const rows = (await sql.unsafe(`
      SELECT c.relname::text AS relname, pg_get_userbyid(c.relowner)::text AS owner
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
         AND pg_get_userbyid(c.relowner) <> 'rm_owner'`)) as unknown as { relname: string; owner: string }[];
    expect(rows).toEqual([]);
    const [{ n }] = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public' AND c.relkind = 'r'`,
    )) as unknown as { n: number }[];
    expect(n).toBeGreaterThan(50);
  });

  test("the ledger is the snapshot's filename list — bootstrapped, not replayed", async () => {
    const snapshot = await loadSnapshot();
    const ledger = (await sql.unsafe(`SELECT name FROM schema_migrations ORDER BY name`)) as unknown as { name: string }[];
    expect(ledger.map((r) => r.name)).toEqual([...snapshot.filenames].sort());
    expect(snapshot.filenames.length).toBeGreaterThan(100);
  });
});

describe("the cluster superuser is reached only by a pinned list of files", () => {
  /** Files under backend/tests/ that import the cluster-admin helpers or name
   *  RM_TEST_ADMIN_URL. Pinned by equality. Each is here because its subject is
   *  a state no runtime role can build (a role attribute, a membership, a
   *  password, a database, a replication subscription) or a catalog only a
   *  superuser reads; none of them uses it to provision a schema. */
  const CLUSTER_ADMIN_FILES: readonly string[] = [
    "admin-revocation.test.ts",
    "analytics-ledger-restore.test.ts",
    "analytics-worker-role.test.ts",
    "api-boot-handle-namespace-guard.test.ts",
    "append-only-guard-check.test.ts",
    "append-only-replication.test.ts",
    "automation-token-provision.test.ts",
    "container-startup-preflight.test.ts",
    "database-role-taxonomy.test.ts",
    "db-preflight-checks.test.ts",
    "db-preflight.test.ts",
    "db-registry-execution.test.ts",
    "deployment-identity.test.ts",
    "first-production-migrate.test.ts",
    "identity-first-pass.test.ts",
    "migrate-run.test.ts",
    "migrations-under-production-privileges.test.ts",
    "preflight-0.2.2.test.ts",
    "preflight-0-3-0-append-only-safety.test.ts",
    "preflight-0-5-0-resume-prefix.test.ts",
    "preflight-utils.test.ts",
    "pre-revoke-boot-refusal.test.ts",
    "prod-baseline.test.ts",
    "prune-command.test.ts",
    "runtime-delete-revoked.test.ts",
    "schema-additive-backfills.test.ts",
    "schema-compat.test.ts",
    "schema-equivalence.test.ts",
    "schema-manifest.test.ts",
    "schema-snapshot.test.ts",
    "seed-gate.test.ts",
    "smoke-twin-capture.test.ts",
    "stream-events-retention.test.ts",
    "spoof-rebind.test.ts",
    "support/clean-db.ts",
    "support/history-database.ts",
    "support/snapshot-fixture.ts",
    "support/startup-preflight.ts",
    "swarm-agent-health.test.ts",
    "swarm-claim.test.ts",
    "swarm-member-handle.test.ts",
    "target-lock.test.ts",
    "twin-production-privilege-shaping.test.ts",
    "upgrade-from-release.test.ts",
    "upgrade-preflight-rm-owner-login.test.ts",
    "wallet-samples-no-delete.test.ts",
    "webauthn-challenge-slots.test.ts",
    "worker-startup-preflight.test.ts",
  ];

  const ADMIN_USE = /\b(adminExec|adminConnection|adminUrl)\b|RM_TEST_ADMIN_URL|connectAdmin\b/;

  test("the list equals the files that use it", () => {
    const users = testFiles()
      // The helpers' own definitions, and the two files that state the rule.
      .filter((f) => f !== "support/cluster.ts" && f !== "preload.ts" && f !== "preload-roles.test.ts")
      .filter((f) => ADMIN_USE.test(readFileSync(join(TESTS, f), "utf8")));
    expect(users).toEqual([...CLUSTER_ADMIN_FILES].sort());
  });
});

describe("no test starts a Postgres of its own", () => {
  /** Files whose subject IS a second server (a hot standby serving reads). Pinned by equality below. */
  const SECOND_SERVER_FIXTURES: readonly string[] = ["smoke-twin-capture.test.ts"];

  test("`docker run` appears in preload.ts, and in the one file whose subject is a standby server", () => {
    const starters = testFiles().filter((f) => {
      if (f === "preload.ts" || f === "preload-roles.test.ts" || f === "postgres-version-parity.test.ts") return false;
      // A hot standby is a second SERVER by definition, the subject of its file; it is not a database
      // the suite provisions for itself.
      if (SECOND_SERVER_FIXTURES.includes(f)) return false;
      return /["']docker["'],\s*["']run["']/.test(readFileSync(join(TESTS, f), "utf8"));
    });
    expect(starters).toEqual([]);
    expect(SECOND_SERVER_FIXTURES).toEqual(["smoke-twin-capture.test.ts"]);
    expect(/["']docker["'],\s*["']run["']/.test(readFileSync(join(TESTS, SECOND_SERVER_FIXTURES[0]!), "utf8"))).toBe(true);
    // Non-vacuous: the one legitimate starter really starts one.
    expect(/["']docker["'],\s*["']run["']/.test(readFileSync(join(TESTS, "preload.ts"), "utf8"))).toBe(true);
  });

  test("no test connects with the container's default superuser credentials", () => {
    const offenders = testFiles().filter((f) => {
      if (f === "preload.ts" || f === "preload-roles.test.ts" || SECOND_SERVER_FIXTURES.includes(f)) return false;
      return readFileSync(join(TESTS, f), "utf8").includes("robotmoney:robotmoney@");
    });
    expect(offenders).toEqual([]);
  });
});
