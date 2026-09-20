// Read-only preflight for the v0.4.0 -> v0.5.0 rollout. This release carries
// eighteen additive migration files (0045-0061); the checks prove production is
// a clean v0.4.0 baseline with none of them applied yet, so the candidate's
// migration run at boot has nothing surprising to reconcile.
//
// The release ALSO carries the database role taxonomy (0053) and the worker
// allow-list (0054), whose cutover is a HUMAN-RUN pre-step, not something a
// boot can recover from: migrations >= 0054 execute `SET LOCAL ROLE rm_owner`
// (backend/src/db/migrate.ts:58), which fails with "permission denied" unless
// the operator has provisioned the taxonomy and pointed the deployment at it
// first. The `role-readiness` record below is the read-only proof of that
// cutover against the LIVE target (runbook §4.4); restore-check.ts (Gate C)
// deliberately runs runChecks() without it, because the smoke-twin restores
// only rm_readonly/rm_worker from the globals dump and migrates as a container
// superuser — role/credential readiness is a live-target property.

import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tableExists } from "../../lib/checks.ts";
import type { Checker } from "../../lib/checks.ts";
import { homeEnvFilePath, runPreflightMain, type Db } from "../../lib/preflight-utils.ts";
import { deriveHostRole } from "../../lib/rollout-receipt.ts";
import { NEW_RELEASE_TABLES_BY_MIGRATION, PRIOR_RELEASE_MIGRATIONS, RELEASE_MIGRATIONS, TAG_GLOB } from "./release.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");
const migrationsDir = join(dir, "..", "..", "..", "migrations");

/** The four roles 0053_database_role_taxonomy.sql creates (issue #692). */
const TAXONOMY_ROLES = ["rm_owner", "rm_app", "rm_worker", "rm_readonly"] as const;

/** The role the API boots as, per the documented convention
 *  (docs/runbooks/deployment.md §4.3: DATABASE_URL = rm_app,
 *  WORKER_DATABASE_URL = rm_worker). config.ts resolves DATABASE_URL from the
 *  deployment's OWN process env (backend/src/config.ts:709) — the preflight
 *  deliberately connects from .env.readonly and cannot read the deployed
 *  value, so every role-level check operates on this documented derivation. */
const API_BOOT_ROLE = "rm_app";

/** 0054_rm_worker_allowlist.sql's INSERT/UPDATE/DELETE allow-list — the tables
 *  queue/sampler handlers in backend/src/worker/** actually write. */
const WORKER_WRITE_ALLOWLIST = [
  "jobs", "job_runs", "job_schedules",
  "vault_share_price_history", "vault_adapter_samples",
  "wallet_balance_samples", "wallet_sleeve_samples",
  "projects", "openclaw_agents", "lobster_coins", "tracked_wallets", "agent_vaults",
  "agent_revenue_daily", "daily_coin_snapshots", "daily_agent_snapshots",
  "daily_wallet_snapshots", "daily_tvl_snapshots",
] as const;

/**
 * THE role/credential readiness gate (the `role-readiness` record). 0053
 * creates the taxonomy and re-owns public objects under rm_owner; 0054's
 * allow-list depends on it; migrations >= 0054 run `SET LOCAL ROLE rm_owner`
 * (migrate.ts:58), which only a session HOLDING rm_owner MEMBERSHIP can run.
 * A v0.5.0 boot therefore fails unless the operator ran the cutover pre-step
 * first (scripts/ops/provision-db-role-taxonomy.sh, deployment.md
 * §4.3/§4.3.1): the API boots as rm_app, the worker as rm_worker, and the
 * migration runs with MIGRATE_DATABASE_URL set to a bootstrap login that is a
 * member of rm_owner (migrate.ts:34).
 *
 * Everything here is read-only — pg_roles / pg_auth_members /
 * has_table_privilege, no SET ROLE, no writes. Where a fact cannot be
 * verified read-only the record FAILs with the exact manual confirmation the
 * operator must perform; it never passes silently.
 */
export async function roleReadinessCheck(db: Db, { record }: Checker): Promise<void> {
  const lines: string[] = [];
  const problems: string[] = [];
  const fail = (line: string): void => {
    problems.push(line);
    lines.push(line);
  };

  const roles = (await db`
    SELECT rolname, rolcanlogin, rolsuper
      FROM pg_roles
     WHERE rolname = ANY(${[...TAXONOMY_ROLES]})
  `) as unknown as { rolname: string; rolcanlogin: boolean; rolsuper: boolean }[];
  const roleByName = new Map(roles.map((r) => [r.rolname, r]));

  // (a) Existence, and the attributes 0053 gives the taxonomy.
  const missing = TAXONOMY_ROLES.filter((n) => !roleByName.has(n));
  if (missing.length > 0) {
    fail(`role(s) absent from pg_roles: ${missing.join(", ")}`);
    fail(
      "a v0.5.0 boot cannot migrate without the taxonomy: 0045-0053 create tables/roles, and 0054+ run SET LOCAL ROLE rm_owner. Provision it FIRST (runbook §4.1): scripts/ops/provision-db-role-taxonomy.sh against the primary (docs/runbooks/deployment.md §4.3.1).",
    );
  } else {
    const owner = roleByName.get("rm_owner")!;
    if (owner.rolcanlogin) fail("rm_owner is LOGIN — 0053 creates it NOLOGIN (no process may authenticate as the owner)");
    if (owner.rolsuper) fail("rm_owner is SUPERUSER — 0053 creates it NOSUPERUSER");
    for (const name of ["rm_app", "rm_worker", "rm_readonly"] as const) {
      const r = roleByName.get(name)!;
      if (!r.rolcanlogin) fail(`${name} is NOLOGIN — 0053 creates it LOGIN`);
      if (r.rolsuper) fail(`${name} is SUPERUSER — 0053 creates it NOSUPERUSER`);
    }
  }

  // (b) rm_owner membership. migrate.ts's `SET LOCAL ROLE rm_owner` needs the
  // MIGRATION session to hold membership; the preflight cannot read which
  // login the deployment migrates with (MIGRATE_DATABASE_URL, migrate.ts:34),
  // so it proves the general property: at least one LOGIN role holds the
  // membership (the bootstrap the runbook pre-step tells the operator to use)
  // and the runtime roles do NOT (a runtime role that can SET ROLE rm_owner
  // can run DDL — the exact boundary 0053 exists to draw).
  const members = (await db`
    SELECT m.rolname AS member, m.rolcanlogin AS can_login
      FROM pg_auth_members am
      JOIN pg_roles g ON g.oid = am.roleid
      JOIN pg_roles m ON m.oid = am.member
     WHERE g.rolname = 'rm_owner'
     ORDER BY m.rolname
  `) as unknown as { member: string; can_login: boolean }[];
  const memberNames = members.map((m) => m.member);
  if (roleByName.has("rm_owner") && !members.some((m) => m.can_login)) {
    fail(`no LOGIN role is a member of rm_owner (members: ${memberNames.join(", ") || "none"})`);
    fail(
      "migrate.ts's SET LOCAL ROLE rm_owner (migrate.ts:58, migrations >= 0054) then fails with permission denied. The MIGRATE_DATABASE_URL bootstrap login must hold rm_owner membership — 0053 grants it to the role that applies it; run scripts/ops/provision-db-role-taxonomy.sh (deployment.md §4.3.1) and re-run this preflight.",
    );
  }
  if (memberNames.includes("rm_app")) {
    fail("rm_app IS a member of rm_owner — the API runtime role could SET ROLE the owner and run DDL; migrations must run with MIGRATE_DATABASE_URL, never DATABASE_URL");
  }
  if (memberNames.includes("rm_worker")) {
    fail("rm_worker IS a member of rm_owner — the worker runtime role could SET ROLE the owner and run DDL");
  }

  // (c) The grants 0054 expects rm_worker to hold. has_table_privilege() is a
  // catalog read, so the read-only preflight role can grade another role's
  // grants (verified against PostgreSQL 18). A NULL result means the fact is
  // not determinable read-only — FAIL with the manual instruction.
  if (roleByName.has("rm_worker")) {
    const [schema] = (await db`
      SELECT has_schema_privilege('rm_worker', 'public', 'USAGE') AS ok
    `) as unknown as { ok: boolean | null }[];
    if (schema?.ok !== true) {
      fail(
        schema?.ok === false
          ? "rm_worker lacks USAGE on schema public — 0054 grants it"
          : "cannot verify rm_worker's USAGE on schema public read-only",
      );
    }
    const grantRows = (await db`
      SELECT c.relname AS relname,
             has_table_privilege('rm_worker', c.oid, 'SELECT') AS sel,
             has_table_privilege('rm_worker', c.oid, 'INSERT') AS ins,
             has_table_privilege('rm_worker', c.oid, 'UPDATE') AS upd,
             has_table_privilege('rm_worker', c.oid, 'DELETE') AS del
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         AND c.relname = ANY(${[...WORKER_WRITE_ALLOWLIST]})
    `) as unknown as {
      relname: string;
      sel: boolean | null;
      ins: boolean | null;
      upd: boolean | null;
      del: boolean | null;
    }[];
    for (const table of WORKER_WRITE_ALLOWLIST) {
      const row = grantRows.find((g) => g.relname === table);
      if (!row) {
        fail(`${table} is absent from public — cannot verify rm_worker's grants on it`);
        continue;
      }
      for (const [priv, col] of [["SELECT", "sel"], ["INSERT", "ins"], ["UPDATE", "upd"], ["DELETE", "del"]] as const) {
        if (row[col] === null) {
          fail(`cannot verify rm_worker's ${priv} on ${table} read-only — confirm it manually (0054 grants ${priv} on the allow-list)`);
        } else if (row[col] !== true) {
          fail(`rm_worker lacks ${priv} on ${table} — 0054 grants it`);
        }
      }
    }
  }

  if (problems.length > 0) {
    record(
      "role-readiness",
      "FAIL",
      lines,
      "Provision the taxonomy and point the deployment at it per runbook §4.1 (scripts/ops/provision-db-role-taxonomy.sh; docs/runbooks/deployment.md §4.3/§4.3.1), then re-run this preflight.",
    );
    return;
  }

  record(
    "role-readiness",
    "PASS",
    [
      "taxonomy roles exist with 0053's attributes; a LOGIN role holds rm_owner membership and neither runtime role does; rm_worker holds the 0054 allow-list grants",
      `rm_owner members: ${memberNames.join(", ") || "none"}`,
      `API boot role derived from documented conventions (deployment.md §4.3): ${API_BOOT_ROLE} — NOT VERIFIED READ-ONLY, confirm on the cutover host before §6: DATABASE_URL names rm_app, never doadmin (config.ts:710-712 refuses doadmin at boot in prod); WORKER_DATABASE_URL names rm_worker (worker-client.ts:20-22 hard-requires it in prod); the migration run sets MIGRATE_DATABASE_URL to a login that is a member of rm_owner (migrate.ts:34).`,
    ],
  );
}

export async function runChecks(
  db: Db,
  checker: Checker,
  opts: { roleReadiness?: boolean } = {},
): Promise<void> {
  const { record } = checker;
  // The role/credential gate is a LIVE-TARGET property (runbook §4.4): the
  // smoke-twin restores only rm_readonly/rm_worker from the globals dump
  // (scripts/lib/restore-container.ts RESTORE_ROLES) and migrates as a
  // container superuser, so Gate C cannot grade it. restore-check.ts
  // therefore calls runChecks() WITHOUT the flag; only the live preflight
  // (P4.preflight-live) enables it.
  if (opts.roleReadiness) await roleReadinessCheck(db, checker);

  if (!(await tableExists(db, "schema_migrations"))) {
    record("schema-migrations", "FAIL", "public.schema_migrations is absent", "Confirm the target is the v0.4.0 production database.");
    return;
  }

  const rows = (await db`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[];
  const applied = new Set(rows.map((row) => row.name));
  const missing = PRIOR_RELEASE_MIGRATIONS.filter((name) => !applied.has(name));
  record(
    "v0.4-schema",
    missing.length ? "FAIL" : "PASS",
    missing.length ? [`missing v0.4.0 migration(s): ${missing.join(", ")}`] : `all ${PRIOR_RELEASE_MIGRATIONS.length} v0.4.0 migrations are recorded`,
    "Do not deploy v0.5.0 until the target is identified and its v0.4.0 rollout is reconciled.",
  );

  const onDisk = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  const expectedPending = new Set<string>(RELEASE_MIGRATIONS);
  const pending = onDisk.filter((name) => !applied.has(name));
  const unexpectedPending = pending.filter((name) => !expectedPending.has(name));
  const releasePending = RELEASE_MIGRATIONS.filter((name) => !applied.has(name));
  const orphans = rows.map((row) => row.name).filter((name) => !onDisk.includes(name));
  record(
    "no-schema-delta",
    unexpectedPending.length || orphans.length ? "FAIL" : "PASS",
    unexpectedPending.length || orphans.length
      ? [
          ...(unexpectedPending.length ? [`unexpected pending migration(s): ${unexpectedPending.join(", ")}`] : []),
          ...(orphans.length ? [`recorded but absent from checkout: ${orphans.join(", ")}`] : []),
        ]
      // COUNT THE PENDING ONES, not RELEASE_MIGRATIONS.length: with 0045-0048
      // already applied on production this said "18 not yet applied" in the
      // same run that clean-target reported 4 already applied — two records
      // in one verdict describing the same ledger differently.
      : `database migration ledger matches the candidate checkout aside from the ${releasePending.length} v0.5.0 migration(s) not yet applied`,
    "Stop and resolve schema/code drift before migrating.",
  );

  const absentTables: string[] = [];
  for (const table of ["swarm_judge_config", "swarm_session_judgements", "swarm_consensus_receipts"]) {
    if (!(await tableExists(db, table))) absentTables.push(table);
  }
  record(
    "v0.4-runtime-schema",
    absentTables.length ? "FAIL" : "PASS",
    absentTables.length ? `required v0.4.0 table(s) absent: ${absentTables.join(", ")}` : "v0.4.0 judge and receipt tables remain present",
    "Do not treat this as a clean v0.4.0 production baseline.",
  );

  // A PREFIX of the release set being applied is a RESUME, not drift.
  //
  // This check used to fail on any recorded v0.5.0 migration, on the premise
  // that production sat at a clean 0044. It does not: 0045-0048 were applied
  // 2026-09-08T14:43:24Z, in one boot, by an ordinary deploy that carried
  // them — verified against the replica's schema_migrations.applied_at. The
  // guard's real job is catching a WRONG TARGET (a 0.6.x database, a stale
  // replica), and a gap-free prefix cannot be one: migrate.ts applies pending
  // migrations in order, so any target it has touched shows a prefix. A GAP
  // (0045 and 0049 recorded, 0046 not) is something migrate.ts cannot
  // produce, so that still fails — as does anything applied out of order.
  const appliedIdx = RELEASE_MIGRATIONS.map((name, i) => (applied.has(name) ? i : -1)).filter((i) => i >= 0);
  const prefixLen = appliedIdx.length;
  const isPrefix = appliedIdx.every((idx, i) => idx === i);
  record(
    "clean-target",
    isPrefix ? "PASS" : "FAIL",
    !prefixLen
      ? "no v0.5.0 migration recorded yet"
      : isPrefix
        ? [
            `RESUMING: ${prefixLen} of ${RELEASE_MIGRATIONS.length} v0.5.0 migration(s) already applied, as a gap-free prefix`,
            `already applied: ${RELEASE_MIGRATIONS.slice(0, prefixLen).join(", ")}`,
            `still pending: ${releasePending.join(", ")}`,
          ]
        : [
            `v0.5.0 migrations are applied OUT OF ORDER — migrate.ts cannot produce this, so the target is wrong or was hand-edited`,
            `applied: ${RELEASE_MIGRATIONS.filter((n) => applied.has(n)).join(", ")}`,
            `pending: ${releasePending.join(", ")}`,
          ],
    "The recorded v0.5.0 migrations are not a gap-free prefix — identify the target before migrating, and do not hand-edit schema_migrations.",
  );

  // Absence is only required of a table whose migration is still PENDING.
  // 0045/0046 are applied on production, so chain_address_floors,
  // asset_prices and asset_price_floors SHOULD exist — grading them as
  // "already exist" was the flat list failing to distinguish a landed
  // migration from a wrong target. The applied side is checked in the
  // opposite direction: its tables missing IS drift.
  const shouldBeAbsent: string[] = [];
  const shouldBePresent: string[] = [];
  for (const [migration, tables] of Object.entries(NEW_RELEASE_TABLES_BY_MIGRATION)) {
    (applied.has(migration) ? shouldBePresent : shouldBeAbsent).push(...tables);
  }
  const unexpectedlyPresent: string[] = [];
  for (const table of shouldBeAbsent) if (await tableExists(db, table)) unexpectedlyPresent.push(table);
  const unexpectedlyAbsent: string[] = [];
  for (const table of shouldBePresent) if (!(await tableExists(db, table))) unexpectedlyAbsent.push(table);
  record(
    "clean-target-tables",
    unexpectedlyPresent.length || unexpectedlyAbsent.length ? "FAIL" : "PASS",
    unexpectedlyPresent.length || unexpectedlyAbsent.length
      ? [
          ...(unexpectedlyPresent.length ? [`a pending migration's table(s) already exist: ${unexpectedlyPresent.join(", ")}`] : []),
          ...(unexpectedlyAbsent.length ? [`an APPLIED migration's table(s) are missing: ${unexpectedlyAbsent.join(", ")}`] : []),
        ]
      : shouldBePresent.length
        ? `${shouldBeAbsent.length} pending-migration table(s) absent; ${shouldBePresent.length} already-applied table(s) present`
        : "v0.5.0's new tables are absent before migration",
    "Resolve the table/migration mismatch before migrating — the target's schema does not match its own migration ledger.",
  );
}

// Run directly: `bun backend/scripts/upgrades/0.4.0-to-0.5.0/preflight.ts`.
// Guarded like 0.3.0's preflight (import.meta.url): restore-check.ts imports
// runChecks from this module, and the module body must NOT connect to the
// live replica — an unguarded body silently ran the whole live preflight
// (and emitted a P4 receipt) whenever restore-check ran with --emit-receipt.
if (import.meta.url === `file://${process.argv[1]}`) {
  const emit = process.argv.includes("--emit-receipt");
  const code = await runPreflightMain({
    envPath: homeEnvFilePath(),
    name: "preflight-0.5.0",
    allowPrivilegedEnvVar: "PREFLIGHT_ALLOW_PRIVILEGED",
    runChecks: (db, checker) => runChecks(db, checker, { roleReadiness: true }),
    receipt: emit ? { step: "P4.preflight-live", repoRoot, tagGlob: TAG_GLOB, hostRole: deriveHostRole(repoRoot).role } : undefined,
  });
  process.exitCode = code;
}
