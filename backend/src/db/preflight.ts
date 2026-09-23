// Preflight — the six read-only checks that decide whether this database may be
// served, run identically by smoke, by every database-holding container, and by
// CI.
//
// STUB. Every function throws `NOT IMPLEMENTED`; nothing imports this module
// yet. Step 1 of issue #1026's W2 workstream. Governed by
// smoke-production-spec.md §7 (the six checks, §7.1 the registry, §7.2 the
// three callers, §7.3 CI isomorphism), with §8.3/§8.4 supplying check 3.
//
// It eventually absorbs backend/scripts/db-preflight.ts and
// backend/scripts/schema-current.ts (plan row W2.4). Neither is touched in this
// step; both keep running exactly as they do today.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE IT SITS
// ─────────────────────────────────────────────────────────────────────────────
//
// Spec §7 boot order: "config validation → plan and locks → database
// create/restore (local) → identity matrix (§4.3) → authorized preparation →
// **preflight** → containers → readiness → receipt. Preflight is read-only and
// refuses the boot on any failure."
//
// After preparation, before containers. That position is the whole design: the
// migrations and grant reconciliation an operator authorised have already run,
// so preflight judges the state the containers will actually meet, and it
// judges it while nothing is serving yet.
//
// READ-ONLY BY CONSTRUCTION, and that phrase has a specific meaning here that
// backend/scripts/db-preflight.ts states from the other side: catalog SELECTs
// and nothing else. Spec §7 check 2: privileges are "Checked through catalog
// queries (`has_table_privilege`, `pg_has_role`, `pg_class.relowner`), never by
// executing application statements." A check that proves `rm_app` cannot DELETE
// by attempting a DELETE is a check that deletes when it is wrong.
//
// (The one exception already in this repo is `checkAppendOnlyGuard`'s
// `DELETE ... WHERE false` probe, which append-only-guard.ts argues for at
// length. That probe matches no rows in any outcome and answers a question no
// catalog query can — whether the guard FUNCTION still raises. It is a trigger
// check, not a privilege check, and it does not make check 2 an execution test.)
//
// ─────────────────────────────────────────────────────────────────────────────
// THREE CALLERS, ONE LIBRARY (§7.2)
// ─────────────────────────────────────────────────────────────────────────────
//
//   * SMOKE runs the full set (1-6) and refuses the cluster.
//   * DATABASE-HOLDING CONTAINERS — `api`, `worker`, `worker-swarm` — run
//     checks 1-3 at startup "against their own credential, log, and refuse to
//     serve on failure". Their credential is one role, so they can only ask
//     about that role; checks 4-6 are the operator's environment, which a
//     container is not positioned to judge.
//   * PARTICIPANTS hold no database credential at all (§6.2), so they run none
//     of this. Their startup diagnostic is HTTP: "API reachable, token valid,
//     identity matches the roster entry." That belongs to W3, not here, and is
//     named only so nobody wires a participant into this module.
//
// One library rather than three, because §7.3's CI isomorphism is the property
// that gives any of these checks value: "CI end-to-end runs use the production
// roles and the production preflight." A separate CI-shaped check proves
// nothing about production.
import type postgresTypes from "postgres";
import type { RmRole, TablePrivilege } from "./registry.ts";
import type { SchemaManifest } from "./schema-manifest.ts";

export type PreflightDb = postgresTypes.Sql<{}> | postgresTypes.TransactionSql<{}>;

/** The six checks of spec §7, with 3 split into its two questions. */
export type PreflightCheckId =
  | "roles_authenticate"
  | "privileges"
  | "schema_integrity"
  | "schema_compatibility"
  | "env_credentials"
  | "env_identity"
  | "prod_schedules";

/** `prod` and `stage` only — spec §4.1. `stage` covers stage, test and CI,
 *  which "are isomorphic and share `stage`". `smoke` is not a value; §9.3
 *  records that today's production host runs `RM_ENV=smoke`, which is exactly
 *  why "no `prod` guard has ever been armed" there. */
export type RmEnv = "prod" | "stage";

/** Spec §4.2's one-row table. `production` is written once by production
 *  initialization (§9.1); `rehearsal` by every blank bootstrap, dump restore
 *  and documented remote-twin restore. */
export type DeploymentIdentity = "production" | "rehearsal";

/** What a caller knows that the database cannot tell it. */
export interface PreflightContext {
  /** Resolved policy, or `null` when `RM_ENV` is unset — a distinct input, not
   *  a default, because §4.3 gives unset its own row (refuse against a remote,
   *  warn and proceed under `--local`). */
  readonly env: RmEnv | null;
  /** Whether the target is a remote connection or a Postgres container smoke
   *  owns (§5). Drives three rows of the §4.3 matrix. */
  readonly connection: "remote" | "local";
  /** The roles this caller will hand to containers. Smoke passes all runtime
   *  roles; a container passes only its own (§7.2). */
  readonly roles: readonly RmRole[];
  /** The booting code's snapshot filename list, for check 3b. Filenames, not a
   *  number: `backend/migrations/` holds two files numbered 0059
   *  (`0059_analytics_output_and_report_snapshots.sql` and
   *  `0059_swarm_framework_subject_snapshot_cleanup.sql`), so a number names
   *  two different schemas. */
  readonly codeFilenames: readonly string[];
  /** Path to the `~/.env` check 4 reads, overridable for tests. */
  readonly envFilePath: string;
}

/** One finding. Checks report every problem they find rather than the first,
 *  so an operator fixes a boot in one pass instead of six. */
export interface PreflightFinding {
  readonly check: PreflightCheckId;
  /** `refuse` stops the boot. `warn` is logged and proceeds — used by check 4
   *  on `stage` only (§7 check 4: "warn on `stage`, refuse on `prod`"). */
  readonly severity: "refuse" | "warn";
  /** One operator-readable sentence, the way
   *  backend/scripts/db-preflight.ts's `reportLines` produces them: pure, so
   *  the exact wording is executable by a test. */
  readonly message: string;
}

export interface PreflightCheckResult {
  readonly check: PreflightCheckId;
  readonly findings: readonly PreflightFinding[];
}

export interface PreflightReport {
  readonly results: readonly PreflightCheckResult[];
  /** True when no finding has severity `refuse`. Warnings do not clear it and
   *  do not set it. */
  readonly passed: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 1
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check 1 — "Every role token smoke will hand to a container authenticates."
 *
 * Inputs: the connection details and one token per role in
 * `context.roles`. Output: findings, one per role that cannot log in.
 *
 * It opens a throwaway connection per role and closes it. That is the one place
 * preflight connects as anything other than its own credential, and it is
 * unavoidable: authentication is the one property no catalog query can answer
 * about a password held by the caller.
 *
 * Refusals: any role whose token fails authentication. A role in
 * `context.roles` with no token supplied is also a refusal — an absent token is
 * how a container ends up falling back to some other credential.
 *
 * Serves spec §10 W2 "Test database off superuser" and "Unattended CI boot
 * `--local blank --migrate --seed`" — both require that the runtime roles
 * actually work before anything starts.
 */
export function checkRoleTokens(
  context: PreflightContext,
  tokens: ReadonlyMap<RmRole, string>,
): Promise<PreflightCheckResult> {
  void context;
  void tokens;
  throw new Error("NOT IMPLEMENTED: verify every role token authenticates — spec §7 check 1, issue #1026 W2.4");
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 2
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The denylist of spec §7 check 2, verbatim: a runtime role may hold none of
 * "superuser; `CREATEROLE`; membership in `rm_owner`; ownership of any
 * application object; DDL; `DELETE`/`TRUNCATE` on append-only tables."
 *
 * Fixed, not derived. Nothing a call site declares in the registry can add to
 * this list or take anything off it — that is the difference between a rule and
 * a preference.
 */
export type DenylistRule =
  /** `pg_roles.rolsuper`. */
  | "superuser"
  /** `pg_roles.rolcreaterole`. 0053 pins `NOCREATEROLE` on all four roles
   *  (lines 49-52) and creates them with it (lines 10, 13, 16, 35); this checks
   *  the cluster still agrees. */
  | "createrole"
  /** `pg_has_role(role, 'rm_owner', 'USAGE'|'MEMBER')`. 0053 line 56 grants
   *  `rm_owner` to `current_user` — the bootstrap/migration login — and its own
   *  comment says "This is intentionally the current role, never either runtime
   *  role." A runtime role that has acquired it is the single most direct way
   *  every other guard in this file becomes decorative. */
  | "rm_owner_membership"
  /** `pg_class.relowner` pointing at a runtime role for any application
   *  object. Ownership is what 0053's two sweeps moved to `rm_owner` precisely
   *  so a grantee "cannot alter/drop tables or triggers" (0053 line 126). */
  | "object_ownership"
  /** CREATE on `public`, or any other route to DDL. 0053 line 117 revokes ALL
   *  on the schema from PUBLIC and line 118 grants only USAGE. */
  | "ddl"
  /** `DELETE` or `TRUNCATE` on any table in `APPEND_ONLY_TABLES` /
   *  `LEDGER_IMMUTABLE_FAMILIES` (./append-only-guard.ts).
   *
   *  THIS ONE FAILS TODAY, BY DESIGN. 0053 line 129 is
   *  `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO
   *  rm_app` — every table, append-only ones included. Spec §9.1 step 2 makes
   *  the transition migration a production-initialization step and states the
   *  consequence: "Check 2 fails until it lands." W2.2 is that migration. A
   *  preflight that passed on today's production would be measuring nothing. */
  | "append_only_write";

/** One denylist hit, resolved to the exact role and object. */
export interface DenylistViolation {
  readonly rule: DenylistRule;
  readonly role: RmRole;
  /** The relation or role name involved, where the rule names one. */
  readonly object: string | null;
}

/**
 * Check 2 — required privileges from the registry, and the denylist.
 *
 * Inputs: a handle (any read-only credential; every query below is a catalog
 * SELECT) and the context. Output: findings.
 *
 * Two independent halves:
 *
 *   REQUIRED — for each `(role, object, privilege)` the registry declares
 *   (`requiredPrivileges()` in ./registry.ts), `has_table_privilege` must say
 *   yes. A missing one is a refusal naming the call site that declared it,
 *   which is the only way the message is actionable.
 *
 *   DENYLIST — the fixed `DenylistRule` set above, checked through
 *   `pg_roles`, `pg_has_role` and `pg_class.relowner`.
 *
 * ASYMMETRY, STATED ON PURPOSE. Spec §7 check 2: "A grant absent from the
 * registry is not forbidden by that fact alone." The registry is the source of
 * what is REQUIRED; it is not an allowlist of what is permitted. A role holding
 * `SELECT` on a table no call site declares does not fail this check. The
 * denylist, and only the denylist, says what may not be held.
 *
 * That is not laxity, it is the only shape that works. 0053 line 129 grants
 * `rm_app` write access to ALL tables in one statement, and lines 136-137 give
 * `rm_readonly` SELECT on all tables plus a default privilege for future ones.
 * Treating the registry as an allowlist would make every boot fail on dozens of
 * grants that are correct, and the response to a check that always fails is to
 * turn it off. The things genuinely worth refusing are enumerated, and they are
 * refused absolutely.
 *
 * Refusals: any missing required privilege; any denylist hit. Both at `refuse`
 * severity in every environment — unlike check 4, this one does not soften on
 * `stage`, because stage is supposed to be isomorphic to production (§7.3) and
 * a denylist that only arms in production is first exercised in production.
 *
 * Serves spec §10 W2 "Denylist: runtime role with `rm_owner` membership, object
 * ownership, or DELETE on an append-only table fails preflight."
 */
export function checkPrivileges(db: PreflightDb, context: PreflightContext): Promise<PreflightCheckResult> {
  void db;
  void context;
  throw new Error("NOT IMPLEMENTED: verify required privileges and the denylist — spec §7 check 2, issue #1026 W2.4");
}

/**
 * The denylist half on its own, so a test can assert each rule independently of
 * whether the registry happens to declare anything.
 *
 * Inputs: a handle and the roles to test. Output: every violation found, not
 * the first.
 *
 * Refusals: none of its own — it reports. `checkPrivileges` turns the report
 * into findings.
 *
 * Serves the same §10 W2 denylist gate.
 */
export function findDenylistViolations(
  db: PreflightDb,
  roles: readonly RmRole[],
): Promise<readonly DenylistViolation[]> {
  void db;
  void roles;
  throw new Error("NOT IMPLEMENTED: resolve denylist violations from the catalog — spec §7 check 2, issue #1026 W2.4");
}

/**
 * The required half on its own: does `role` hold `privileges` on `object`?
 *
 * Inputs: a handle, one triple. Output: the privileges it does NOT hold.
 *
 * Catalog-only: one `has_table_privilege` call per privilege. It never issues
 * the statement the privilege would permit.
 *
 * Refusals: `object` does not resolve through `to_regclass` in `public` — a
 * declaration naming a relation that does not exist is a registry bug, and
 * reporting it as "privilege missing" would send the reader to the wrong file.
 *
 * Serves spec §10 W2 "Registry structurally enforced; execution under each role
 * on a disposable database" — the catalog side of it.
 */
export function missingPrivileges(
  db: PreflightDb,
  role: RmRole,
  object: string,
  privileges: readonly TablePrivilege[],
): Promise<readonly TablePrivilege[]> {
  void db;
  void role;
  void object;
  void privileges;
  throw new Error("NOT IMPLEMENTED: test required privileges via has_table_privilege — spec §7 check 2, issue #1026 W2.4");
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 3 — two questions, deliberately two functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check 3a, INTEGRITY — do the live definitions match the manifest for the
 * installed version M?
 *
 * Inputs: a handle and the context. Output: findings, one per object that
 * differs.
 *
 * Spec §7 check 3(a): "live definitions of every object class in §8.1 match the
 * manifest for M stored in the database (§8.3), excluding the provider list.
 * Genuine drift fails here whatever code is booting."
 *
 * "Whatever code is booting" is the load-bearing clause and the reason this is
 * separate from 3b. The comparison target is the manifest IN THE DATABASE, not
 * the snapshot this image ships. An old image meeting a newer database compares
 * against that database's own declaration, so an ordinary version difference
 * produces no findings at all — while a dropped trigger, a hand-altered column
 * or a half-restored dump still fails, on the same database, for the same image.
 *
 * Refusals:
 *   - Any live object differs from the manifest (excluding
 *     `PROVIDER_MANAGED_EXCLUSIONS` in ./schema-snapshot.ts).
 *   - The manifest is absent. A database with no manifest cannot be verified
 *     and must not be served on the grounds that there was nothing to compare.
 *   - `detectManifestState` reports `in_progress` — ledger ahead of manifest.
 *     Spec §8.3: "application boot refuses it (check 3a)". The schema is
 *     mid-change and nothing has verified where it got to.
 *   - `detectManifestState` reports `inconsistent` or `unknown_format` (§8.3:
 *     "A manifest whose hash does not match the ledger's filename list, or
 *     whose format version is unknown, refuses").
 *
 * Serves spec §10 W2 "Old code boots after an additive change to an existing
 * table while genuine drift on the same database still fails" — the drift half.
 */
export function checkSchemaIntegrity(db: PreflightDb, context: PreflightContext): Promise<PreflightCheckResult> {
  void db;
  void context;
  throw new Error("NOT IMPLEMENTED: compare live definitions against the installed manifest — spec §7 check 3a, issue #1026 W2.7");
}

/**
 * Check 3b, COMPATIBILITY — does the booting code support version M?
 *
 * Inputs: a handle and the context (whose `codeFilenames` is this image's
 * snapshot list). Output: findings.
 *
 * Delegates the rule to `checkCompatibility` in ./schema-compat.ts, which
 * applies §8.4: every ledger row outside the code's own filename list must
 * carry `compat = additive` and a known `metadata_version`.
 *
 * Why it is not merged into 3a: 3a asks a question about the DATABASE and 3b
 * asks one about the IMAGE. Spec §7 check 3 spells out the interaction: "An
 * additive change to an existing table passes: (a) compares against M's
 * manifest, which includes it; (b) reads the migration's declaration." Merged,
 * there would be no way to express "the database is fine and this image is too
 * old", which is the answer an operator needs during a rollback.
 *
 * Refusals: any surplus ledger row that is `breaking`, has a `NULL` compat, or
 * carries an unknown `metadata_version`. Also a refusal when the code's
 * filename list contains a migration the ledger does not record — the code is
 * ahead of the database, which is a pending-migration state, not a
 * compatibility one.
 *
 * Serves spec §10 W2 "Old release reads compat metadata written by a newer one
 * and refuses unknown `metadata_version`."
 */
export function checkSchemaCompatibility(db: PreflightDb, context: PreflightContext): Promise<PreflightCheckResult> {
  void db;
  void context;
  throw new Error("NOT IMPLEMENTED: apply the compatibility rule to surplus ledger rows — spec §7 check 3b, issue #1026 W2.7");
}

/** What check 3 resolved about the installed version, carried into the receipt
 *  (§1.4 "schema identity"). */
export interface SchemaIdentity {
  readonly manifest: SchemaManifest;
  /** Ledger filenames the booting code does not ship — the §8.4 surplus. */
  readonly surplus: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Checks 4-6
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check 4 — `~/.env` holds no dangerous credential.
 *
 * Input: the context (for `envFilePath` and `env`). Output: findings.
 *
 * Spec §7 check 4: "`~/.env` holds no dangerous credential (`rm_owner`,
 * `doadmin`, superuser): warn on `stage`, refuse on `prod`." Spec §3 states the
 * positive rule it enforces: "`~/.env` ... holds the remote connection
 * (host/port/dbname) and the runtime tokens only: `rm_app = …`,
 * `rm_worker = …`, `rm_readonly = …`. It must not contain `rm_owner`,
 * `doadmin`, or any superuser token."
 *
 * The point is that `rm_owner`'s password is "typed at the terminal for the one
 * run that needs it and never stored" (§3). A stored owner password turns every
 * operator-intervention gate in §9.1 into a formality, and it does so silently.
 *
 * Reads only the KEY NAMES. It never logs, hashes or compares a value, and a
 * finding names the offending line's key and nothing else — the same posture
 * `redactedTarget` takes in backend/scripts/db-preflight.ts.
 *
 * Refusals: on `prod`, any dangerous key present. On `stage` the same finding
 * is severity `warn` and the boot proceeds, because a stage host legitimately
 * holds an owner credential for `--migrate` (§8.5). When `env` is `null` the
 * finding is a refusal against a remote connection and a warning under
 * `--local`, following §4.3's unset row.
 *
 * Serves spec §10 W2 (plan row W2.4's "`.env` dangerous-credential refusal on
 * `prod`").
 */
export function checkEnvCredentials(context: PreflightContext): Promise<PreflightCheckResult> {
  void context;
  throw new Error("NOT IMPLEMENTED: refuse a dangerous credential in ~/.env — spec §7 check 4, issue #1026 W2.4");
}

/**
 * Check 5 — `RM_ENV` × `deployment_identity` resolve per the §4.3 matrix.
 *
 * Inputs: a handle (to read the one-row `deployment_identity` table) and the
 * context. Output: findings.
 *
 * The matrix is W1.1's function; this check is preflight RE-ASSERTING it after
 * preparation, which is not redundant. Spec §2 requires revalidation "After
 * acquiring, the tool re-reads `deployment_identity`, the ledger, and the schema
 * manifest and re-runs the plan against them. A mismatch refuses." The row can
 * change between the matrix call and here — a restore ran, a different database
 * answered, an operator wrote it by hand.
 *
 * Refusals, straight from the §4.3 table:
 *   - `prod` + remote + identity ≠ `production`.
 *   - `prod` + any `--local` mode.
 *   - `stage` + remote + identity ≠ `rehearsal`; stage policy, `--allow-insecure`
 *     included, "never touches production data".
 *   - `stage` + `--local volume` + identity ≠ `rehearsal` — "a reattached
 *     volume gets no weaker policy than a remote".
 *   - unset + remote.
 *   - Any other `RM_ENV` value.
 *   - No `deployment_identity` row, or more than one.
 * Unset + `--local` is a WARNING, not a refusal: "warn `RM_ENV not set, running
 * as stage`, proceed".
 *
 * Serves spec §10 W2 "`RM_ENV=stage` + typed owner password against
 * `deployment_identity = production` refuses; plain stage boot incl.
 * `--allow-insecure` against production identity refuses."
 */
export function checkEnvIdentity(db: PreflightDb, context: PreflightContext): Promise<PreflightCheckResult> {
  void db;
  void context;
  throw new Error("NOT IMPLEMENTED: resolve the RM_ENV x deployment_identity matrix — spec §7 check 5, issue #1026 W2.4");
}

/**
 * Check 6 — on `prod`, the five `swarm.*` schedule rows are enabled and their
 * cron strings parse.
 *
 * Inputs: a handle and the context. Output: findings; an empty result on
 * `stage`, where the rows are legitimately off (`--schedules-off`, §4.4).
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK. Spec §6.3: "It does not require a future
 * `next_run_at`: `NULL` and overdue rows are the scheduler's to initialize or
 * drain per `catchup_policy`, and refusing to start the worker that advances
 * them would block recovery after downtime."
 *
 * That is this repo's own scar. The wedge recorded in #614 leaves a `* * * * *`
 * schedule frozen after a long outage, and the fix is the CLAMP that drains the
 * backlog per tick — which only runs if the worker starts. A preflight that
 * refused on an overdue row would refuse exactly the boot that repairs it.
 * Readiness, after `worker` is up, is where "every enabled row has been
 * initialized or advanced per its policy" is checked (§6.3), and readiness is
 * W1.9's, not this module's.
 *
 * Refusals: on `prod`, any of the five rows missing or disabled; any cron
 * string that does not parse. Enablement is an operator action
 * (`bun run schedules:enable`, §6.3/§9.1), never a boot side-effect, so this
 * check reports the absence and never fixes it.
 *
 * Serves the §9.1 production-initialization sequence; its failure is what tells
 * an operator step 4 has not been done.
 */
export function checkProdSchedules(db: PreflightDb, context: PreflightContext): Promise<PreflightCheckResult> {
  void db;
  void context;
  throw new Error("NOT IMPLEMENTED: verify the five prod swarm schedules — spec §7 check 6, issue #1026 W2.4");
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/** Which checks to run — §7.2's three callers in one union. */
export type PreflightScope =
  /** Smoke: checks 1-6, refuses the cluster. */
  | "full"
  /** `api` / `worker` / `worker-swarm` at startup: checks 1-3 against their own
   *  credential, log, refuse to serve on failure. */
  | "container";

/**
 * Run the checks for `scope` and report.
 *
 * Inputs: a handle, the context, the scope, and the role tokens check 1 needs
 * (a container passes exactly one). Output: a `PreflightReport` carrying every
 * finding from every check that ran.
 *
 * RUNS EVERY CHECK BEFORE DECIDING. It does not stop at the first refusal: an
 * operator whose database fails checks 2, 3 and 5 should learn all three in one
 * boot, and the refusal text is the deliverable — the same reasoning
 * backend/scripts/db-preflight.ts's `reportLines` follows.
 *
 * Read-only in every outcome. It holds no lock of its own; the target lock is
 * the caller's and is held across preflight (§2: smoke "holds it from
 * acquisition through preflight, replacement, and readiness, so a standalone
 * migration cannot land between preflight and the new containers starting").
 *
 * Refusals: it returns `passed: false`; it throws only when the database cannot
 * be queried at all, so "unreachable" is never reported as "check failed".
 *
 * Serves every spec §10 W2 gate — it is the single entry point each of them
 * exercises.
 */
export function runPreflight(
  db: PreflightDb,
  context: PreflightContext,
  scope: PreflightScope,
  tokens: ReadonlyMap<RmRole, string>,
): Promise<PreflightReport> {
  void db;
  void context;
  void scope;
  void tokens;
  throw new Error("NOT IMPLEMENTED: run the preflight checks for a scope — spec §7, issue #1026 W2.4");
}

/**
 * Render a report as operator-facing lines.
 *
 * Input: the report. Output: one line per finding, prefixed `[preflight]`.
 *
 * Pure and synchronous, so the exact wording is executable by tests — this text
 * is what lands in the boot log and in the receipt (§1.4), and it is the only
 * thing an operator has when a production boot stops.
 *
 * Serves every spec §10 W2 gate: each one asserts a specific refusal, and a
 * refusal is only assertable if its wording is.
 */
export function preflightReportLines(report: PreflightReport): string[] {
  void report;
  throw new Error("NOT IMPLEMENTED: render preflight findings as operator lines — spec §7, issue #1026 W2.4");
}
