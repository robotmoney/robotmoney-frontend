// The suite's cluster, as tests/preload.ts provisions it (smoke-production-spec.md
// §7.3).
//
// Two kinds of login exist there, and this module is the only sanctioned way for
// a test to reach either by name:
//
//   * the ROLE logins — `rm_owner`, `rm_app`, `rm_worker`, `rm_readonly`, one
//     shared password — which are what the code under test connects with. None is
//     a superuser. `roleUrl` builds a URL for one of them on any database.
//   * the CLUSTER ADMIN — the container's bootstrap superuser, this harness's
//     `doadmin`. It creates roles and databases and does nothing else: the
//     schema and the seed are `rm_owner`'s. A test reaches it through
//     `adminConnection`, and only to build a state no runtime role can reach
//     (`ALTER ROLE ... SUPERUSER` for a denylist check, a role membership), to
//     create or drop a database, or to read a catalog only a superuser may.
//
// Both come from the environment tests/preload.ts sets. A missing variable is a
// loud failure, never a fallback to some other credential.
import { afterAll } from "bun:test";
import postgres from "postgres";

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`tests/support/cluster.ts requires ${key} (set by tests/preload.ts)`);
  return value;
}

/** The shared password of the four role logins. */
export const ROLE_PASSWORD = (): string => required("RM_TEST_ROLE_PASSWORD");

/** A URL for `role` on `database`, on the suite's cluster. */
export function roleUrl(role: string, database: string = "robotmoney"): string {
  const url = new URL(required("RM_TEST_ADMIN_URL"));
  url.username = role;
  url.password = ROLE_PASSWORD();
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * A URL for the cluster's superuser. `database` names the database; omitted, it
 * is the one the suite's api pool is on right now (`process.env.DATABASE_URL`,
 * which tests/support/clean-db.ts moves per file), which is what a test means by
 * "the database this file runs in" when it builds a URL from the pool's.
 */
export function adminUrl(database?: string): string {
  const url = new URL(required("RM_TEST_ADMIN_URL"));
  url.pathname = database ? `/${database}` : new URL(required("DATABASE_URL")).pathname;
  return url.toString();
}

/** A one-connection handle for the cluster's superuser. The caller ends it. */
export function adminConnection(database: string = "postgres"): postgres.Sql<{}> {
  return postgres(adminUrl(database), { max: 1, onnotice: () => {} });
}

/**
 * Run one statement as the cluster admin on a throw-away connection, and return
 * its rows. For cluster state only a superuser may change: `ALTER ROLE`,
 * `CREATE ROLE`, `DROP ROLE`, `CREATE DATABASE`, `DROP DATABASE`, a role
 * membership. `database` defaults to the maintenance database; pass the test's
 * own for a statement that acts inside one (`CREATE EXTENSION`).
 */
export async function adminExec(
  statement: string,
  database: string = "postgres",
): Promise<postgres.Row[]> {
  const db = adminConnection(database);
  try {
    return [...(await db.unsafe(statement))];
  } finally {
    await db.end({ timeout: 5 });
  }
}

/**
 * A URL for the suite's fixture login on `database`: `rm_test_owner`, not a
 * superuser (the api pool's `rm_test` acts as rm_app), whose session role is `rm_owner` (tests/preload.ts). It is the
 * schema owner's authority under a login of its own, so a test that changes
 * rm_owner's password or LOGIN attribute does not lock it out. Provisioning a
 * database's schema goes through it.
 */
export function harnessUrl(database: string = "robotmoney"): string {
  return roleUrl("rm_test_owner", database);
}

/** A one-connection handle for the harness login on `database`. The caller ends it. */
export function harnessConnection(database: string = "robotmoney"): postgres.Sql<{}> {
  return postgres(harnessUrl(database), { max: 1, onnotice: () => {} });
}

/** A one-connection handle for `role` on `database`. The caller ends it. */
export function roleConnection(role: string, database: string = "robotmoney"): postgres.Sql<{}> {
  return postgres(roleUrl(role, database), { max: 1, onnotice: () => {} });
}

/**
 * Put the four §3 roles back on the suite's baseline: LOGIN with the shared
 * password and no cluster power (tests/preload.ts). Role state is cluster state
 * and every file runs in one process, so a file that gives a role a password of
 * its own calls this from `afterAll`, or a later file that logs in with the
 * shared password is refused. (Cluster admin: ALTER ROLE is superuser-only.)
 */
export async function restoreRoleBaseline(): Promise<void> {
  for (const role of ["rm_owner", "rm_app", "rm_worker", "rm_readonly"]) {
    await adminExec(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD '${ROLE_PASSWORD()}'`);
  }
}

/** Register `restoreRoleBaseline` to run when the calling file's tests are done. */
export function restoreRoleBaselineAfterAll(): void {
  afterAll(restoreRoleBaseline);
}
