// Pre-upgrade dry run for v0.2.1 -> v0.2.2, specifically. The release-neutral
// mechanics (env loading, read-only connect + gate, verdict printing) live in
// ../../lib/preflight-utils.ts; this file only knows about the four
// migrations THIS release ships (0029-0031) and the checks specific to them.
// A future release gets its own backend/scripts/upgrades/<from>-to-<to>/
// directory, not an edit to this one — so what a past release's preflight
// actually checked stays reconstructable from git history instead of being
// overwritten in place.
//
// Usage (from anywhere in the checkout — the .env.readonly path resolves off
// preflight-utils.ts's own location, not the cwd):
//   Create <repo root>/.env.readonly with the read-only role's connection
//   details as discrete keys (see .env.readonly.example), then:
//     bun scripts/upgrades/0.2.1-to-0.2.2/preflight.ts
//
// Exit codes: 0 = SAFE TO UPGRADE, 1 = BLOCKED, 2 = could not run the check.

import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { columnExists, tableExists } from "../../lib/checks.ts";
import type { Checker } from "../../lib/checks.ts";
import { type Db, runPreflightMain } from "../../lib/preflight-utils.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
// backend/scripts/upgrades/0.2.1-to-0.2.2/ -> backend/migrations/
const migrationsDir = join(scriptDir, "..", "..", "..", "migrations");
// backend/scripts/upgrades/0.2.1-to-0.2.2/ -> <repo root>/.env.readonly
const envPath = join(scriptDir, "..", "..", "..", "..", ".env.readonly");

const THIS_RELEASE_MIGRATIONS = [
  "0029_admin_auth_recovery.sql",
  "0029_admin_passkey.sql",
  "0030_swarm_member_handle.sql",
  "0031_swarm_member_handle_namespace.sql",
] as const;

/** Lock duration on swarm_members is proportional to row count: 0030 runs
 *  ADD COLUMN + full-table UPDATE + SET NOT NULL + CREATE UNIQUE INDEX inside
 *  ONE transaction (src/db/migrate.ts:50-53), holding ACCESS EXCLUSIVE the
 *  whole time. Above this, warn that the API will see a stall, not a blip. */
const SWARM_MEMBERS_WARN_ROWS = 50_000;

/** A transaction older than this on the target database will queue in front of
 *  0030's ACCESS EXCLUSIVE lock — and every reader that arrives after the
 *  lock request queues behind BOTH. */
const BLOCKING_XACT_SECONDS = 60;

/** backend/src/api/validation.ts:446 (MEMBER_HANDLE_RE), as a POSIX regex.
 *  Length bound from validation.ts:482 (`requiredString(body, "handle", 80)`). */
const HANDLE_RE_SQL = "^[a-z0-9]+(-[a-z0-9]+)*$";
const HANDLE_MAX_LEN = 80;

/**
 * BYTE-IDENTICAL COPY of HANDLE_NAMESPACE_CONFLICT_RELATION
 * (backend/src/db/handle-namespace.ts:62-63), and of the relation migration
 * 0031's install-time DO block spells at
 * 0031_swarm_member_handle_namespace.sql:91-92.
 *
 * Not imported — see preflight-utils.ts's header. The canonical module
 * reaches src/config.ts (`required("DATABASE_URL")` at module load) and
 * src/db/client.ts's shared pool through its own imports, and this script
 * must open exactly one connection, on the read-only role, assembled from
 * .env.readonly.
 *
 * backend/tests/handle-namespace-predicate-parity.test.ts holds the OTHER two
 * in agreement mechanically. Nothing holds this third one, so if that test ever
 * goes red, change this string in the same commit.
 */
const HANDLE_NAMESPACE_CONFLICT_RELATION =
  "FROM swarm_members a JOIN swarm_members b ON b.id = a.handle AND b.id <> a.id";

async function checkServerVersion(db: Db, { record }: Checker): Promise<void> {
  const [v] = (await db`
    SELECT current_setting('server_version')      AS version,
           current_setting('server_version_num')::int AS num
  `) as unknown as { version: string; num: number }[];
  if (v.num < 110000) {
    record(
      "server-version",
      "FAIL",
      `PostgreSQL ${v.version} — 0030's ADD COLUMN is not an instant catalog-only operation before 11`,
      "Upgrade the cluster to 11+ (the suite targets 17) before applying 0030; on <11 the ADD COLUMN rewrites swarm_members under ACCESS EXCLUSIVE.",
    );
    return;
  }
  const major = Math.floor(v.num / 10000);
  // Production runs 18 (DigitalOcean managed, confirmed 2026-08-17); CI/local
  // (docker-compose.yml:141) still pins 17. Both are known-good — anything
  // else is genuinely untested.
  if (major !== 17 && major !== 18) {
    record(
      "server-version",
      "WARN",
      `PostgreSQL ${v.version} — CI runs 17 and production runs 18; behaviour is untested here`,
      "Match the client pg_dump major version to this server when taking the pre-upgrade dump.",
    );
    return;
  }
  record("server-version", "PASS", `PostgreSQL ${v.version}`);
}

/** 0001_backends.sql:4 requires pgcrypto for gen_random_uuid(). A cluster
 *  rebuilt from a dump has the extension recreated, but a role without CREATE
 *  on the database cannot install it, so verify rather than assume. */
async function checkExtensions(db: Db, { record }: Checker): Promise<void> {
  const [{ present }] = (await db`
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') AS present
  `) as unknown as { present: boolean }[];
  if (present) {
    record("extensions", "PASS", "pgcrypto installed (gen_random_uuid)");
    return;
  }
  record(
    "extensions",
    "FAIL",
    "pgcrypto is NOT installed — 0001_backends.sql:4 needs it for gen_random_uuid() defaults",
    "CREATE EXTENSION IF NOT EXISTS pgcrypto; (needs a role with CREATE on the database, e.g. doadmin).",
  );
}

async function checkPendingMigrations(db: Db, { record }: Checker): Promise<string[]> {
  if (!(await tableExists(db, "schema_migrations"))) {
    record(
      "schema-migrations",
      "FAIL",
      "no public.schema_migrations — this database was never migrated by src/db/migrate.ts",
      "Confirm .env.readonly points at the production database, not an empty/wrong one.",
    );
    return [];
  }

  // Same ordering the runner uses: readdir + JS default sort (src/db/migrate.ts:39-41).
  const onDisk = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const rows = (await db`SELECT name FROM schema_migrations`) as unknown as { name: string }[];
  // Sorted in JS, not SQL: the runner's ordering is JS default sort
  // (src/db/migrate.ts:41), and a database collation can order differently.
  const applied = rows.map((r) => r.name).sort();
  const appliedSet = new Set(applied);
  const diskSet = new Set(onDisk);

  const pending = onDisk.filter((f) => !appliedSet.has(f));
  const orphans = applied.filter((f) => !diskSet.has(f));

  if (orphans.length > 0) {
    record(
      "schema-migrations",
      "FAIL",
      [
        `${orphans.length} migration(s) recorded in schema_migrations but ABSENT from backend/migrations/:`,
        ...orphans.map((o) => `  ${o}`),
        "The database is AHEAD of the checkout — this working tree is not the tag production is upgrading to.",
      ],
      "Check out the exact tag being deployed and re-run; do not migrate a database ahead of the code.",
    );
    return pending;
  }

  if (pending.length === 0) {
    record("schema-migrations", "PASS", `all ${onDisk.length} migration(s) already applied — nothing pending`);
    return pending;
  }

  // A pending file that sorts BEFORE the newest applied one still gets applied
  // (the runner is a set difference, not a high-water mark) but runs AFTER DDL
  // that a fresh database would have seen it before. Worth naming.
  const newestApplied = applied.length > 0 ? applied[applied.length - 1]! : "";
  const outOfOrder = pending.filter((p) => p < newestApplied);

  const detail = [`${pending.length} migration(s) will be applied on the next boot:`, ...pending.map((p) => `  ${p}`)];
  if (outOfOrder.length > 0) {
    detail.push(
      `NOTE: ${outOfOrder.length} of these sort BEFORE the newest applied file (${newestApplied}):`,
      ...outOfOrder.map((p) => `  ${p}`),
      "They will still run, but after DDL a fresh database applies them before.",
    );
    record(
      "schema-migrations",
      "WARN",
      detail,
      "Confirm each out-of-order file is order-independent, or apply it manually in the intended position.",
    );
    return pending;
  }
  record("schema-migrations", "PASS", detail);
  return pending;
}

/**
 * 0029_admin_passkey.sql:26-28 ends with three unconditional
 * `REVOKE ALL ON ... FROM rm_worker` statements. REVOKE against a role that
 * does not exist raises 42704, and src/db/migrate.ts:50-53 wraps each file in
 * ONE transaction — so a missing rm_worker aborts the entire migration and the
 * boot fails at 0029.
 *
 * This is NOT hypothetical on a restored database: pg_dump does not dump ROLES
 * (only pg_dumpall --globals-only does), so a cluster rebuilt from a plain dump
 * has schema_migrations claiming 0016_worker_role.sql is applied while the role
 * it created does not exist.
 */
async function checkWorkerRole(db: Db, { record }: Checker, pending: string[]): Promise<void> {
  const [row] = (await db`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rm_worker') AS present`) as unknown as
    { present: boolean }[];
  const needed = pending.includes("0029_admin_passkey.sql");
  if (row.present) {
    record("rm-worker-role", "PASS", "role rm_worker exists — 0029_admin_passkey's REVOKEs will resolve");
    return;
  }
  record(
    "rm-worker-role",
    needed ? "FAIL" : "WARN",
    [
      "role rm_worker does NOT exist in this cluster.",
      needed
        ? "0029_admin_passkey.sql:26-28 REVOKEs from it unconditionally; REVOKE on a missing role raises 42704"
        : "0029_admin_passkey.sql is already applied, so nothing pending needs it — but 0016's grants are gone",
      "and src/db/migrate.ts wraps each migration in one transaction, so the whole file aborts.",
    ],
    "Recreate it before upgrading: CREATE ROLE rm_worker LOGIN; then re-apply 0016's grants (see 0016_worker_role.sql:25-42). Roles are not carried by pg_dump.",
  );
}

/**
 * The handle/id namespace invariant — the predicate 0031's DO block
 * (0031_swarm_member_handle_namespace.sql:91-92) aborts the migration on, and
 * the same relation the runtime guards refuse a boot for
 * (HANDLE_NAMESPACE_CONFLICT_RELATION, src/db/handle-namespace.ts:62-63).
 *
 * On a pre-0030 database there is no `handle` column, so the pair is not
 * expressible yet AND 0030 backfills `handle = id` for every row
 * (0030_swarm_member_handle.sql:28) — after which `b.id = a.handle` collapses
 * to `b.id = a.id`, which `b.id <> a.id` excludes. So a straight
 * v0.2.1 -> 0031 upgrade cannot trip it; it is checked anyway because a
 * partially-upgraded or restored database CAN already hold the pair.
 */
async function checkHandleNamespace(db: Db, { record }: Checker): Promise<void> {
  const ready = (await tableExists(db, "swarm_members")) && (await columnExists(db, "swarm_members", "handle"));

  if (!ready) {
    record(
      "handle-namespace",
      "PASS",
      "no swarm_members.handle yet (pre-0030) — 0030 backfills handle = id, so 0031's abort predicate cannot match",
    );
    return;
  }

  const rows = (await db.unsafe(
    `SELECT a.id AS holder, a.handle AS handle, b.id AS shadowed
     ${HANDLE_NAMESPACE_CONFLICT_RELATION}
     ORDER BY a.id`,
  )) as unknown as { holder: string; handle: string; shadowed: string }[];

  if (rows.length === 0) {
    record("handle-namespace", "PASS", "no swarm_members row's handle is another member's id");
    return;
  }
  record(
    "handle-namespace",
    "FAIL",
    [
      `${rows.length} row(s) violate the handle/id namespace invariant — migration 0031 will RAISE and abort the boot:`,
      ...rows.map((r) => `  member '${r.holder}' has handle '${r.handle}', which is member '${r.shadowed}'s id`),
    ],
    "Run ONE statement per line printed above, all of them, before upgrading: UPDATE swarm_members SET handle = '<a name nobody else holds>' WHERE id = '<holder>'; — the HOLDER is the member named FIRST on the line (the one whose handle is the offending value). Updating the SHADOWED member instead reports UPDATE 1, raises nothing, and fixes nothing (src/db/handle-namespace.ts:113-123). A mutual collision prints two lines and needs two updates. Each repoints a published URL, so pick deliberately.",
  );
}

/**
 * 0029_admin_auth_recovery.sql:4 is a bare
 * `ALTER TABLE admin_credential ADD COLUMN recovery_hash text` — no
 * IF NOT EXISTS. If the column is somehow already there while the file is not
 * recorded, the migration raises 42701 and the boot fails.
 *
 * Separately, the admin-lockout gate: 0028_admin_credential.sql:13 documents
 * that recovery from a lost password is `DELETE FROM admin_credential`, and
 * 0029's comment says existing rows keep recovery_hash NULL deliberately.
 */
async function checkAdminCredential(db: Db, { record }: Checker, pending: string[]): Promise<void> {
  if (!(await tableExists(db, "admin_credential"))) {
    record("admin-credential", "WARN", "admin_credential does not exist yet — 0028 will create it, nothing to lose");
    return;
  }

  const has_recovery = await columnExists(db, "admin_credential", "recovery_hash");

  if (has_recovery && pending.includes("0029_admin_auth_recovery.sql")) {
    record(
      "admin-credential",
      "FAIL",
      [
        "admin_credential.recovery_hash already EXISTS but 0029_admin_auth_recovery.sql is not recorded as applied.",
        "That file's ALTER TABLE ... ADD COLUMN has no IF NOT EXISTS (0029_admin_auth_recovery.sql:4) and will raise 42701.",
      ],
      "Insert the row by hand so the runner skips the file: INSERT INTO schema_migrations (name) VALUES ('0029_admin_auth_recovery.sql');",
    );
    return;
  }

  const counts = (await (has_recovery
    ? db`SELECT count(*)::int AS total, count(*) FILTER (WHERE recovery_hash IS NULL)::int AS no_recovery FROM admin_credential`
    : db`SELECT count(*)::int AS total, count(*)::int AS no_recovery FROM admin_credential`)) as unknown as
    { total: number; no_recovery: number }[];
  const { total, no_recovery } = counts[0]!;

  if (total === 0) {
    record(
      "admin-credential",
      "WARN",
      "0 rows — the one-time admin claim is UNCLAIMED; whoever reaches the admin surface first after the upgrade takes it",
      "Claim the credential immediately after the upgrade, or keep the admin surface unreachable until you do.",
    );
    return;
  }
  if (no_recovery > 0) {
    record(
      "admin-credential",
      "WARN",
      [
        `${total} claimed credential(s), ${no_recovery} with recovery_hash NULL.`,
        "0029 deliberately leaves existing rows NULL; only the authenticated password-change route initializes one.",
        "Until then a lost password is recoverable ONLY by direct SQL.",
      ],
      "After the upgrade, sign in and change the password once to mint the recovery code. Emergency reset: DELETE FROM admin_credential; (re-arms the one-time claim).",
    );
    return;
  }
  record("admin-credential", "PASS", `${total} claimed credential(s), all with a recovery hash`);
}

/**
 * 0030 holds ACCESS EXCLUSIVE on swarm_members for the whole file: ADD COLUMN
 * (0030:24), a full-table UPDATE (0030:28), SET NOT NULL (0030:30, which scans
 * every row), and a non-CONCURRENT CREATE UNIQUE INDEX (0030:53) — all inside
 * the single transaction src/db/migrate.ts:50-53 opens. Duration scales with
 * the table.
 */
async function checkSwarmMembersSize(db: Db, { record }: Checker): Promise<void> {
  if (!(await tableExists(db, "swarm_members"))) {
    record("swarm-members-size", "WARN", "swarm_members does not exist — is this the right database?");
    return;
  }
  const [row] = (await db`
    SELECT (SELECT count(*)::int FROM swarm_members) AS rows,
           pg_size_pretty(pg_total_relation_size('public.swarm_members')) AS size
  `) as unknown as { rows: number; size: string }[];
  const detail = `${row.rows} row(s), ${row.size} total — 0030 holds ACCESS EXCLUSIVE for ADD COLUMN + UPDATE + SET NOT NULL + CREATE UNIQUE INDEX in one transaction`;
  if (row.rows > SWARM_MEMBERS_WARN_ROWS) {
    record(
      "swarm-members-size",
      "WARN",
      detail,
      `Above ${SWARM_MEMBERS_WARN_ROWS} rows the API will see a real stall, not a blip. Take the maintenance window.`,
    );
    return;
  }
  record("swarm-members-size", "PASS", detail);
}

/**
 * An ACCESS EXCLUSIVE lock request queues behind any existing lock on the
 * table — and every reader arriving afterwards queues behind the REQUEST. One
 * forgotten `idle in transaction` session therefore stalls the whole API for
 * the duration of the upgrade, not just the migration.
 */
async function checkBlockingActivity(db: Db, { record }: Checker): Promise<void> {
  const rows = (await db`
    SELECT pid,
           coalesce(state, '?')                                   AS state,
           round(extract(epoch FROM (now() - xact_start)))::int   AS xact_age_s,
           coalesce(usename::text, '?')                           AS usename,
           coalesce(application_name, '')                         AS app,
           coalesce(left(query, 100), '(query text not visible to this role)') AS query
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND xact_start IS NOT NULL
      AND extract(epoch FROM (now() - xact_start)) > ${BLOCKING_XACT_SECONDS}
    ORDER BY xact_start
  `) as unknown as { pid: number; state: string; xact_age_s: number; usename: string; app: string; query: string }[];

  if (rows.length === 0) {
    record("blocking-xacts", "PASS", `no transaction older than ${BLOCKING_XACT_SECONDS}s on this database`);
    return;
  }
  record(
    "blocking-xacts",
    "FAIL",
    [
      `${rows.length} transaction(s) older than ${BLOCKING_XACT_SECONDS}s would queue in front of 0030's ACCESS EXCLUSIVE lock:`,
      ...rows.map((r) => `  pid=${r.pid} ${r.state} ${r.xact_age_s}s user=${r.usename} app=${r.app || "-"} :: ${r.query}`),
    ],
    "Drain or terminate them first (SELECT pg_terminate_backend(<pid>)), then re-run. Stop the worker before migrating.",
  );
}

/**
 * 0030:28 backfills `handle = id` for every existing member, and installs no
 * CHECK on the shape. So an id that is not a valid handle becomes a handle the
 * admin surface can never save again: any later edit is validated against
 * MEMBER_HANDLE_RE (backend/src/api/validation.ts:446) and an 80-char bound
 * (validation.ts:482), and is rejected with "handle already taken"-adjacent
 * wording that points at the wrong problem. Not an abort — a post-upgrade trap.
 */
async function checkHandleShape(db: Db, { record }: Checker): Promise<void> {
  if (!(await tableExists(db, "swarm_members"))) {
    record("handle-shape", "WARN", "swarm_members does not exist — shape audit skipped");
    return;
  }
  const rows = (await db`
    SELECT id::text AS id, length(id) AS len, (id ~ ${HANDLE_RE_SQL}) AS shape_ok
    FROM swarm_members
    WHERE id !~ ${HANDLE_RE_SQL} OR length(id) > ${HANDLE_MAX_LEN}
    ORDER BY id
  `) as unknown as { id: string; len: number; shape_ok: boolean }[];

  if (rows.length === 0) {
    record("handle-shape", "PASS", `all swarm_members ids are valid handles (${HANDLE_RE_SQL}, <= ${HANDLE_MAX_LEN} chars)`);
    return;
  }
  record(
    "handle-shape",
    "WARN",
    [
      `${rows.length} member id(s) are not valid handles; 0030 backfills handle = id anyway (no CHECK), so they become unsaveable:`,
      ...rows.slice(0, 10).map((r) => `  '${r.id}' (${r.len} chars${r.shape_ok ? "" : ", bad shape"})`),
      ...(rows.length > 10 ? [`  …and ${rows.length - 10} more`] : []),
    ],
    "After the upgrade, set a conforming handle for each: UPDATE swarm_members SET handle = '<kebab-case>' WHERE id = '<id>'; the id itself must not move.",
  );
}

/**
 * Exported so restore-check.ts can run the SAME release-specific checks
 * against a locally restored dump, before this file's main() ever touches
 * a live database (docs/runbooks/*.md §4/§5: the dump is checked first, the
 * live replica second). blocking-xacts is included for both targets even
 * though it is only meaningful live — against a freshly restored local
 * container with no concurrent connections it trivially PASSes, which is
 * correct, just uninteresting there.
 */
export async function runChecks(db: Db, checker: Checker): Promise<void> {
  await checkServerVersion(db, checker);
  await checkExtensions(db, checker);
  const pending = await checkPendingMigrations(db, checker);
  await checkWorkerRole(db, checker, pending);
  await checkHandleNamespace(db, checker);
  await checkAdminCredential(db, checker, pending);
  await checkSwarmMembersSize(db, checker);
  await checkBlockingActivity(db, checker);
  await checkHandleShape(db, checker);
}

export async function main(overrideEnvPath?: string): Promise<number> {
  return runPreflightMain({
    envPath: overrideEnvPath ?? envPath,
    name: "preflight-0.2.2",
    allowPrivilegedEnvVar: "PREFLIGHT_ALLOW_PRIVILEGED",
    runChecks,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`[preflight-0.2.2] fatal: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 2;
    });
}

export { THIS_RELEASE_MIGRATIONS };
