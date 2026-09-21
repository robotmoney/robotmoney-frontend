// Read-only preflight for the v0.5.0 -> v0.5.1 rollout.
//
// WHAT IS DIFFERENT ABOUT THIS ONE. v0.5.1's application delta is code-only;
// its single migration (0062) is a GATE REPAIR that has nothing to do with the
// release's features. So this preflight asks two questions at once: the target
// must ALREADY be at the full v0.5.0 schema (there is no earlier work for this
// release to do), and the only thing pending may be 0062 itself.
//
// The `readonly-sequence-access` record below is the unusual one, and it is
// deliberately a WARN rather than a FAIL on a target that still has the
// defect: it reports the very condition this release exists to repair, so
// failing preflight on it would refuse to deploy the fix. It becomes a FAIL
// only once 0062 is recorded and the sequences are STILL unreadable, which
// would mean the repair did not take.
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

  // (2) The pending set must be EXACTLY this release's migration. v0.5.1
  // carries one (0062, the rm_readonly sequence-grant repair), so a clean
  // target shows that one pending and nothing else. Anything extra came from
  // another branch -- releases-0.6.x collides with this line at 0056-0061 --
  // and a boot would apply it as a side effect of the deploy.
  const onDisk = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  const pending = onDisk.filter((name) => !applied.has(name));
  const expected = new Set<string>(RELEASE_MIGRATIONS);
  const unexpectedPending = pending.filter((name) => !expected.has(name));
  const orphans = rows.map((row) => row.name).filter((name) => !onDisk.includes(name));
  record(
    "pending-is-this-release-only",
    unexpectedPending.length || orphans.length ? "FAIL" : "PASS",
    unexpectedPending.length || orphans.length
      ? [
          ...(unexpectedPending.length ? [`pending migration(s) this release does not ship: ${unexpectedPending.join(", ")}`] : []),
          ...(orphans.length ? [`recorded but absent from checkout: ${orphans.join(", ")}`] : []),
        ]
      : pending.length
        ? `ledger matches the checkout aside from this release's own ${pending.length} migration(s): ${pending.join(", ")}`
        : "nothing pending — this release's migration is already applied (a resume, not drift)",
    "Identify the extra migration before deploying. Do not let a boot apply it as a side effect.",
  );

  // (3) THE REASON 0062 EXISTS, checked directly rather than inferred from the
  // ledger. pg_dump reads every sequence's last_value, and rm_readonly is the
  // role the backup runs as, so a sequence it cannot read breaks P3.backup --
  // which is exactly how this release acquired a migration at all. Reported as
  // a WARN, not a FAIL: it is the condition 0062 is here to REPAIR, so failing
  // preflight on it would refuse to deploy the fix for the problem.
  const seqRows = (await db`
    WITH s AS MATERIALIZED (
      SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'S'
    )
    SELECT relname FROM s WHERE NOT has_sequence_privilege('rm_readonly', oid, 'SELECT') ORDER BY relname
  `) as unknown as { relname: string }[];
  const alreadyApplied = applied.has("0062_rm_readonly_sequence_select.sql");
  record(
    "readonly-sequence-access",
    seqRows.length === 0 ? "PASS" : alreadyApplied ? "FAIL" : "WARN",
    seqRows.length === 0
      ? "rm_readonly can read every sequence in public — pg_dump (P3.backup) will not be refused"
      : [
          `${seqRows.length} sequence(s) deny rm_readonly a read, so pg_dump fails: ${seqRows.slice(0, 15).join(", ")}`,
          alreadyApplied
            ? "0062 is ALREADY RECORDED and they are still unreadable — the repair did not take."
            : "This is the condition 0062 repairs. Deploying this release is the fix.",
        ],
    alreadyApplied
      ? "0062 ran but left sequences unreadable. Check whether a later migration re-revoked them (backend/tests/migration-readonly-sequence-grant.test.ts guards this)."
      : "No action needed before the deploy — 0062 grants these on boot. Postflight asserts the count reaches zero.",
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
