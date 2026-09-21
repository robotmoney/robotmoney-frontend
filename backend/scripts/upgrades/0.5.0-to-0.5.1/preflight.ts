// Read-only preflight for the v0.5.0 -> v0.5.1 rollout.
//
// WHAT IS DIFFERENT ABOUT THIS ONE, AND WHY EVERY CHECK BELOW INVERTS.
// v0.5.1 is code-only (release.ts: RELEASE_MIGRATIONS is empty). Every prior
// release's preflight proved "the pending set is exactly what this release
// ships, and none of it has landed yet". There is no pending set here, so the
// same question asked of this release reads: the live target must ALREADY be
// at the full v0.5.0 schema, and the migration ledger must have nothing left
// to apply. A pending migration is drift by definition, not a workload.
//
// The role/credential gate does NOT relax. v0.5.1 boots on the same taxonomy
// v0.5.0 introduced -- config.ts:710 refuses a doadmin DATABASE_URL in
// production and worker-client.ts:20 hard-requires WORKER_DATABASE_URL -- so
// `role-readiness` is carried over whole. The difference is what a failure
// MEANS: under v0.5.0 an absent rm_owner was an unstarted pre-step, because
// 0053 had not run. Under v0.5.1 it is a contradiction, because a target at
// v0.5.0 has run 0053 by definition. A FAIL here says the target is not at
// v0.5.0, which is the one thing this release's whole premise rests on.
//
// Carried over by COPY, not import. A release directory is a frozen artefact
// and `preflightCode(DIR)` globs only this directory, so importing
// 0.4.0-to-0.5.0/preflight.ts would let drift in that file escape this
// release's receipt-invalidation window entirely.

import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tableExists } from "../../lib/checks.ts";
import type { Checker } from "../../lib/checks.ts";
import { homeEnvFilePath, runPreflightMain, type Db } from "../../lib/preflight-utils.ts";
import { deriveHostRole } from "../../lib/rollout-receipt.ts";
import { PRESERVED_RELEASE_TABLES, PRIOR_RELEASE_MIGRATIONS, RELEASE_MIGRATIONS, REQUIRED_TABLES, TAG_GLOB } from "./release.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");
const migrationsDir = join(dir, "..", "..", "..", "migrations");

/** The four roles 0053_database_role_taxonomy.sql creates (issue #692). */
const TAXONOMY_ROLES = ["rm_owner", "rm_app", "rm_worker", "rm_readonly"] as const;

/** The role the API boots as (docs/runbooks/deployment.md §4.3). */
const API_BOOT_ROLE = "rm_app";

/** 0054_rm_worker_allowlist.sql's INSERT/UPDATE/DELETE allow-list. */
const WORKER_WRITE_ALLOWLIST = [
  "jobs", "job_runs", "job_schedules",
  "vault_share_price_history", "vault_adapter_samples",
  "wallet_balance_samples", "wallet_sleeve_samples",
  "projects", "openclaw_agents", "lobster_coins", "tracked_wallets", "agent_vaults",
  "agent_revenue_daily", "daily_coin_snapshots", "daily_agent_snapshots",
  "daily_wallet_snapshots", "daily_tvl_snapshots",
] as const;

/**
 * The role/credential readiness gate. Read-only throughout: pg_roles /
 * pg_auth_members / has_table_privilege, no SET ROLE, no writes.
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

  const missing = TAXONOMY_ROLES.filter((n) => !roleByName.has(n));
  if (missing.length > 0) {
    fail(`role(s) absent from pg_roles: ${missing.join(", ")}`);
    fail(
      "for v0.5.1 this is a CONTRADICTION, not a pending pre-step: 0053 creates these roles, and a target at v0.5.0 has applied 0053 by definition. An absent role means the target is NOT at v0.5.0 and v0.5.1 is the wrong release for it -- reconcile against docs/runbooks/v0-5-0-rollout.md §4.1 before going further.",
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
      "v0.5.1 applies no migration, so it does not itself need the membership — but its absence means the v0.5.0 cutover was never completed on this target, and the next release that DOES carry a migration would fail at boot. Reconcile before deploying.",
    );
  }
  if (memberNames.includes("rm_app")) {
    fail("rm_app IS a member of rm_owner — the API runtime role could SET ROLE the owner and run DDL");
  }
  if (memberNames.includes("rm_worker")) {
    fail("rm_worker IS a member of rm_owner — the worker runtime role could SET ROLE the owner and run DDL");
  }

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
      "The target is not at the v0.5.0 role taxonomy. Complete the v0.5.0 cutover (docs/runbooks/v0-5-0-rollout.md §4.1, scripts/ops/provision-db-role-taxonomy.sh) before treating this target as a v0.5.1 candidate.",
    );
    return;
  }

  record(
    "role-readiness",
    "PASS",
    [
      "taxonomy roles exist with 0053's attributes; a LOGIN role holds rm_owner membership and neither runtime role does; rm_worker holds the 0054 allow-list grants",
      `rm_owner members: ${memberNames.join(", ") || "none"}`,
      `API boot role derived from documented conventions (deployment.md §4.3): ${API_BOOT_ROLE} — NOT VERIFIED READ-ONLY, confirm on the cutover host: DATABASE_URL names rm_app, never doadmin (config.ts:710-712); WORKER_DATABASE_URL names rm_worker (worker-client.ts:20-22).`,
    ],
  );
}

export async function runChecks(
  db: Db,
  checker: Checker,
  opts: { roleReadiness?: boolean } = {},
): Promise<void> {
  const { record } = checker;
  // A LIVE-TARGET property: the smoke-twin restores only rm_readonly/rm_worker
  // from the globals dump and migrates as a container superuser, so Gate C
  // cannot grade it. restore-check.ts calls runChecks() WITHOUT the flag.
  if (opts.roleReadiness) await roleReadinessCheck(db, checker);

  if (!(await tableExists(db, "schema_migrations"))) {
    record("schema-migrations", "FAIL", "public.schema_migrations is absent", "Confirm the target is the v0.5.0 production database.");
    return;
  }

  const rows = (await db`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[];
  const applied = new Set(rows.map((row) => row.name));

  // (1) The full v0.4.0 + v0.5.0 set must already be recorded. For a code-only
  // release this replaces the old "v0.4-schema" baseline check: there is no
  // later set to apply, so the prior set IS the expected end state.
  const missingPrior = PRIOR_RELEASE_MIGRATIONS.filter((name) => !applied.has(name));
  record(
    "v0.5-schema",
    missingPrior.length ? "FAIL" : "PASS",
    missingPrior.length
      ? [
          `missing v0.5.0 migration(s): ${missingPrior.join(", ")}`,
          "v0.5.1 carries NO migration, so a boot cannot close this gap. The target has not completed the v0.5.0 rollout.",
        ]
      : `all ${PRIOR_RELEASE_MIGRATIONS.length} v0.4.0+v0.5.0 migrations are recorded`,
    "Run the v0.5.0 rollout to completion first (docs/runbooks/v0-5-0-rollout.md); v0.5.1 is a code-only patch on top of it and cannot substitute for it.",
  );

  // (2) Nothing pending, nothing orphaned. For v0.5.1 an empty pending set is
  // the pass condition rather than a size assertion about RELEASE_MIGRATIONS.
  const onDisk = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  const pending = onDisk.filter((name) => !applied.has(name));
  const orphans = rows.map((row) => row.name).filter((name) => !onDisk.includes(name));
  record(
    "no-pending-migrations",
    pending.length || orphans.length ? "FAIL" : "PASS",
    pending.length || orphans.length
      ? [
          ...(pending.length ? [`pending migration(s) on a code-only release: ${pending.join(", ")}`] : []),
          ...(orphans.length ? [`recorded but absent from checkout: ${orphans.join(", ")}`] : []),
        ]
      : `ledger matches the candidate checkout exactly — ${onDisk.length} migration(s) on disk, all recorded, none orphaned`,
    "v0.5.1 ships no migration, so anything pending here came from somewhere else. Identify it before deploying — do not let a boot apply it as a side effect.",
  );

  // (3) The release really is code-only. A guard against this manifest drifting
  // out from under its own runbook: if someone adds a migration to v0.5.1, the
  // gate above stops being the right question and this record says so.
  record(
    "code-only",
    RELEASE_MIGRATIONS.length === 0 ? "PASS" : "FAIL",
    RELEASE_MIGRATIONS.length === 0
      ? "RELEASE_MIGRATIONS is empty — v0.5.1 is code-only, as its runbook states"
      : `RELEASE_MIGRATIONS lists ${RELEASE_MIGRATIONS.length} migration(s); v0.5.1 is documented as code-only`,
    "Either the migration belongs in a numbered release of its own, or this runbook and its checks need rewriting for a schema-carrying release.",
  );

  // (4) The v0.4.0 runtime tables.
  const absentRequired: string[] = [];
  for (const table of REQUIRED_TABLES) {
    if (!(await tableExists(db, table))) absentRequired.push(table);
  }
  record(
    "v0.4-runtime-schema",
    absentRequired.length ? "FAIL" : "PASS",
    absentRequired.length ? `required v0.4.0 table(s) absent: ${absentRequired.join(", ")}` : "v0.4.0 judge and receipt tables remain present",
    "Do not treat this as a clean baseline.",
  );

  // (5) Every table v0.5.0 created must be present. The code-only inversion:
  // there is no "must be absent" set, so absence is the failure direction.
  const absentPreserved: string[] = [];
  for (const table of PRESERVED_RELEASE_TABLES) {
    if (!(await tableExists(db, table))) absentPreserved.push(table);
  }
  record(
    "v0.5-tables-present",
    absentPreserved.length ? "FAIL" : "PASS",
    absentPreserved.length
      ? [`v0.5.0 table(s) absent: ${absentPreserved.join(", ")}`, "v0.5.1 creates no table, so a boot will not produce these."]
      : `all ${PRESERVED_RELEASE_TABLES.length} v0.5.0 tables are present`,
    "The target's schema does not match its own migration ledger, or it never completed the v0.5.0 rollout.",
  );
}

// Run directly: `bun backend/scripts/upgrades/0.5.0-to-0.5.1/preflight.ts`.
// Guarded (import.meta.url) because restore-check.ts imports runChecks from
// this module: an unguarded body would silently run the whole live preflight,
// and emit a P4 receipt, whenever restore-check ran with --emit-receipt.
if (import.meta.url === `file://${process.argv[1]}`) {
  const emit = process.argv.includes("--emit-receipt");
  const code = await runPreflightMain({
    envPath: homeEnvFilePath(),
    name: "preflight-0.5.1",
    allowPrivilegedEnvVar: "PREFLIGHT_ALLOW_PRIVILEGED",
    runChecks: (db, checker) => runChecks(db, checker, { roleReadiness: true }),
    receipt: emit ? { step: "P4.preflight-live", repoRoot, tagGlob: TAG_GLOB, hostRole: deriveHostRole(repoRoot).role } : undefined,
  });
  process.exitCode = code;
}
