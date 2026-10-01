// A database that holds a genuine EARLIER schema, for the tests whose subject is
// one migration ("Migration 0030 leaves child FK values unchanged", "0056's
// trigger fires on an upsert"): apply the files before it, plant rows, apply it,
// compare.
//
// WHY THIS REPLACES EIGHT PRIVATE POSTGRES CONTAINERS. Each of those tests used
// to `docker run` a Postgres of its own and connect as that container's
// superuser, because the suite's shared database (tests/preload.ts) has every
// migration applied before any file loads. That is a second harness per test,
// each with its own port, wait loop, image pin and teardown, and each one ran
// history as a superuser. smoke-production-spec.md §7.3 has no superuser test
// database: history is replayed by the PROVIDER's bootstrap login, as it was
// against production, and everything else is a role.
//
// So a history database here is a database on the suite's own cluster, owned by
// a login shaped like production's `doadmin` (NOT a superuser: CREATEROLE,
// CREATEDB, BYPASSRLS, REPLICATION, and ADMIN OPTION on the four roles, exactly
// what tests/migrations-under-production-privileges.test.ts proves every
// migration applies under). The files are applied the way `migrate()` applies
// them: from 0054 on, as `rm_owner`, through the bootstrap login's `SET ROLE`.
// The cluster admin creates the login and the database and drops them; it runs
// no migration and holds no fixture row.
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { adminConnection, ROLE_PASSWORD, roleUrl } from "./cluster.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

/** The provider's bootstrap login. Cluster-wide, created once, never dropped (a
 *  concurrent file may hold a database owned by it). */
const BOOTSTRAP_LOGIN = "rm_history_boot";

/** migrate.ts's own rule: every file from 0054 on runs as rm_owner. */
const RUNS_AS_OWNER = (file: string): boolean => file >= "0054_rm_worker_allowlist.sql";

export interface HistoryDatabase {
  /** The bootstrap login's handle. Not a superuser. */
  readonly db: postgres.Sql<{}>;
  readonly name: string;
  /** A URL for `role` (default: the bootstrap login) on this database. */
  urlFor(role?: string): string;
  /** Every migration file name on disk, sorted. */
  files(): Promise<string[]>;
  /** Apply these migration files in order, as `migrate()` does. */
  apply(files: readonly string[]): Promise<void>;
  /** Close the handle and drop the database. */
  drop(): Promise<void>;
}

async function ensureBootstrapLogin(): Promise<void> {
  // cluster admin: CREATE ROLE / GRANT of role membership are superuser-only.
  const admin = adminConnection();
  try {
    // One statement, so two files racing to create it cannot both pass an EXISTS test.
    await admin.unsafe(`
      DO $boot$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${BOOTSTRAP_LOGIN}') THEN
          BEGIN
            CREATE ROLE ${BOOTSTRAP_LOGIN} LOGIN CREATEROLE CREATEDB BYPASSRLS REPLICATION PASSWORD '${ROLE_PASSWORD()}';
          EXCEPTION WHEN duplicate_object THEN NULL;
          END;
        END IF;
      END $boot$;
      GRANT rm_owner, rm_app, rm_worker, rm_readonly TO ${BOOTSTRAP_LOGIN} WITH ADMIN OPTION;`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/**
 * A blank database owned by the provider's bootstrap login, on the suite's
 * cluster. `label` names it, so a leaked one is attributable to its file.
 */
export async function createHistoryDatabase(label: string, options: { max?: number } = {}): Promise<HistoryDatabase> {
  await ensureBootstrapLogin();
  const name = `rmh_${label.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 30)}_${crypto.randomUUID().slice(0, 8)}`;
  // cluster admin: CREATE DATABASE (and the DROP below) is the admin's job.
  const admin = adminConnection();
  try {
    await admin.unsafe(`CREATE DATABASE ${name} OWNER ${BOOTSTRAP_LOGIN}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const urlFor = (role: string = BOOTSTRAP_LOGIN): string => roleUrl(role, name);
  const db = postgres(urlFor(), { max: options.max ?? 4, onnotice: () => {} });

  const files = async (): Promise<string[]> => (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  return {
    db,
    name,
    urlFor,
    files,
    async apply(list) {
      for (const file of list) {
        const ddl = await readFile(join(MIGRATIONS_DIR, file), "utf8");
        await db.begin(async (tx) => {
          if (RUNS_AS_OWNER(file)) await tx.unsafe("SET LOCAL ROLE rm_owner");
          await tx.unsafe(ddl);
        });
      }
    },
    async drop() {
      await db.end({ timeout: 5 });
      const cleanup = adminConnection();
      try {
        await cleanup.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    },
  };
}

/**
 * A copy of a history database, owned by the bootstrap login: `CREATE DATABASE
 * ... TEMPLATE`, which only the cluster admin may run and which needs the
 * template to have NO open connection (the caller ends its handle first and
 * reopens `urlFor()` afterwards). The copy carries the template's schema, rows
 * and ledger exactly, so two databases can take the same history through two
 * different next steps.
 */
export async function cloneHistoryDatabase(templateName: string, label: string, options: { max?: number } = {}): Promise<HistoryDatabase> {
  await ensureBootstrapLogin();
  const name = `rmh_${label.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 30)}_${crypto.randomUUID().slice(0, 8)}`;
  // cluster admin: CREATE DATABASE ... TEMPLATE is the admin's job.
  const admin = adminConnection();
  try {
    await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${templateName} OWNER ${BOOTSTRAP_LOGIN}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const urlFor = (role: string = BOOTSTRAP_LOGIN): string => roleUrl(role, name);
  const db = postgres(urlFor(), { max: options.max ?? 4, onnotice: () => {} });
  const files = async (): Promise<string[]> => (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  return {
    db,
    name,
    urlFor,
    files,
    async apply(list) {
      for (const file of list) {
        const ddl = await readFile(join(MIGRATIONS_DIR, file), "utf8");
        await db.begin(async (tx) => {
          if (RUNS_AS_OWNER(file)) await tx.unsafe("SET LOCAL ROLE rm_owner");
          await tx.unsafe(ddl);
        });
      }
    },
    async drop() {
      await db.end({ timeout: 5 });
      const cleanup = adminConnection();
      try {
        await cleanup.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    },
  };
}
