// Preflight — the six read-only checks that decide whether this database may be
// served, run identically by smoke, by every database-holding container, and by
// CI.
//
// Governed by smoke-production-spec.md §7 (the six checks, §7.1 the registry,
// §7.2 the three callers, §7.3 CI isomorphism), with §8.3/§8.4 supplying
// check 3. Issue #1026, W2.
//
// Every check is implemented and exercised against a real Postgres by
// backend/tests/db-preflight-checks.test.ts. NO RUNTIME CALLER YET: smoke, `api`
// and the worker lanes do not call `runPreflight` until #1026's wiring wave
// lands (criterion 44). Until then backend/scripts/db-preflight.ts and
// backend/scripts/schema-current.ts keep running exactly as they do today, and
// this module is meant to absorb both (plan row W2.4).
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
//   * DATABASE-HOLDING CONTAINERS — `api` and the worker lanes — run
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
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import type postgresTypes from "postgres";
import {
  APPEND_ONLY_MIGRATIONS,
  APPEND_ONLY_TABLES,
  APPEND_ONLY_TABLE_MIGRATION,
  LEDGER_IMMUTABLE_FAMILIES,
  ledgerTriggerNames,
  triggerNames,
} from "./append-only-guard.ts";
import { registeredSites, requiredPrivileges } from "./registry.ts";
import type { RmRole, TablePrivilege } from "./registry.ts";
import { MANIFEST_TABLE, compareCatalog, detectManifestState, parseDeclaration, readManifest } from "./schema-manifest.ts";
import type { SchemaManifest } from "./schema-manifest.ts";
import { checkCompatibility } from "./schema-compat.ts";

export type PreflightDb = postgresTypes.Sql<{}> | postgresTypes.TransactionSql<{}>;

/** The six checks of spec §7, with 3 split into its two questions. */
export type PreflightCheckId =
  | "roles_authenticate"
  | "privileges"
  | "schema_integrity"
  | "schema_compatibility"
  | "env_credentials"
  | "env_identity"
  | "subject_scheduling";

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
  /** Path to the `~/.env` check 4 reads. Every runtime caller passes
   *  `homeEnvPath()` — the deploying user's home-directory file (§3); tests
   *  pass a fixture path. Required rather than defaulted, so no caller reads
   *  some other file by forgetting to say which. */
  readonly envFilePath: string;
}

/**
 * `$HOME/.env`, the one file §3 names: "the deploying user's home-directory
 * file, outside every checkout".
 *
 * The same rule as `homeEnvFilePath()` in scripts/lib/env-role.ts, which every
 * host-side tool reads through. It is restated rather than imported because
 * this module runs inside the backend image, and backend/Dockerfile copies
 * `backend/` and nothing from `scripts/lib/` — an import across that boundary
 * would type-check here and fail to resolve in the container.
 * backend/tests/db-preflight-checks.test.ts pins the two to the same answer.
 */
export function homeEnvPath(home: string = homedir()): string {
  return join(home, ".env");
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
 * Check 1 — "Every role password smoke will hand to a container
 * authenticates."
 *
 * Inputs: the handle the rest of preflight reads through, the context, and one
 * token (the role's password) per role in `context.roles`. Output: findings,
 * one per role that cannot log in.
 *
 * It opens a throwaway connection per role and closes it. That is the one place
 * preflight connects as anything other than its own credential, and it is
 * unavoidable: authentication is the one property no catalog query can answer
 * about a password held by the caller.
 *
 * THE PROBE GOES WHERE THE HANDLE GOES. Host, port (or socket path), database
 * and TLS mode are read from `db`'s own parsed options (`probeTarget`), never
 * from `config.databaseUrl`. A host-side smoke preflight holds a handle to the
 * remote it is about to serve while its own process environment names some
 * other database; a password proven against that other database proves nothing
 * about the one the containers will meet.
 *
 * Refusals: any role whose token fails authentication. A role in
 * `context.roles` with no token supplied is also a refusal — an absent token is
 * how a container ends up falling back to some other credential. A handle that
 * does not expose its server refuses every role rather than guessing a target.
 * Only a top-level `postgres(...)` pool exposes it: neither a `sql.begin`
 * transaction handle nor a `sql.reserve()` connection carries the parsed
 * options, so a caller must pass the pool itself.
 *
 * Serves spec §10 W2 "Test database off superuser" and "Unattended CI boot
 * `--local blank --migrate --seed`" — both require that the runtime roles
 * actually work before anything starts.
 */
export async function checkRoleTokens(
  db: PreflightDb,
  context: PreflightContext,
  tokens: ReadonlyMap<RmRole, string>,
): Promise<PreflightCheckResult> {
  const findings: PreflightFinding[] = [];
  const target = probeTarget(db);

  for (const role of context.roles) {
    const token = tokens.get(role);
    // An absent token is not "nothing to test": it is how a container ends up
    // falling back to whatever credential the connection string carries.
    if (token === undefined || token === "") {
      findings.push({
        check: "roles_authenticate",
        severity: "refuse",
        message: `no token supplied for ${role}: a container started without its own credential falls back to another one`,
      });
      continue;
    }

    if (target === null) {
      findings.push({
        check: "roles_authenticate",
        severity: "refuse",
        message:
          `${role} could not be tested: the handle does not expose which server it points at (only a top-level ` +
          "postgres() pool does, not a transaction or a reserved connection), and a password proven against any " +
          "other server proves nothing about this one",
      });
      continue;
    }

    // The one place preflight connects as anything but its own credential.
    // Authentication is the single property no catalog query can answer about a
    // password the CALLER holds, so it is tested by using it — and by nothing
    // else: the connection issues `SELECT 1` and is closed.
    const probeOptions: postgresTypes.Options<{}> = {
      // `host:port[,host:port…]` — the one form postgres.js's typed options
      // accept for a multi-host target; its parser splits it back into the
      // same host and port lists the handle carries.
      host: target.host.map((host, index) => `${host}:${target.port[index] ?? target.port[0]}`).join(","),
      ...(target.path ? { path: target.path } : {}),
      database: target.database,
      ssl: target.ssl,
      ...(target.targetSessionAttrs ? { target_session_attrs: target.targetSessionAttrs } : {}),
      max: 1,
      user: role,
      username: role,
      password: token,
      connect_timeout: 10,
      onnotice: () => {},
    };
    const probe = postgres(probeOptions);
    try {
      await probe`SELECT 1`;
    } catch (error) {
      // The role's name and where it was tried, never the token, and never the
      // driver's echo of the connection string.
      findings.push({
        check: "roles_authenticate",
        severity: "refuse",
        message:
          `${role} could not authenticate against ${target.label}: ` +
          `${(error as { code?: string }).code ?? "authentication failed"}`,
      });
    } finally {
      await probe.end({ timeout: 5 }).catch(() => undefined);
    }
  }

  return { check: "roles_authenticate", findings };
}

/** Where check 1's probes connect: the server and database `db` itself uses. */
interface ProbeTarget {
  readonly host: string[];
  readonly port: number[];
  readonly path: string | null;
  readonly database: string;
  readonly ssl: postgresTypes.Options<{}>["ssl"];
  readonly targetSessionAttrs: postgresTypes.Options<{}>["target_session_attrs"];
  /** `host:port/database`, for the finding. No user, no password. */
  readonly label: string;
}

/**
 * The server a handle points at, from the options postgres.js parsed when the
 * pool was built. Only the top-level pool (`postgres(...)`) carries them:
 * postgres.js attaches `options` to the pool object alone, and both a
 * `sql.begin` transaction handle and a `sql.reserve()` connection are bare
 * query functions without it. `null` makes check 1 refuse rather than fall
 * back to some other database.
 */
function probeTarget(db: PreflightDb): ProbeTarget | null {
  const options = (db as { options?: postgresTypes.ParsedOptions<{}> }).options;
  if (!options || !Array.isArray(options.host) || !options.database) return null;
  const path = typeof options.path === "string" && options.path !== "" ? options.path : null;
  const where = path ?? options.host.map((host, index) => `${host}:${options.port[index] ?? options.port[0]}`).join(",");
  return {
    host: [...options.host],
    port: [...options.port],
    path,
    database: options.database,
    ssl: options.ssl,
    targetSessionAttrs: options.target_session_attrs ?? undefined,
    label: `${where}/${options.database}`,
  };
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
 *
 * "DDL" is three rules below, not one, because a grant can open it three
 * separate ways and an operator fixing a boot needs to know which: CREATE on a
 * schema (`ddl`), CREATE on the database, which is how a new schema appears
 * (`database_create`), and the TRIGGER privilege, which lets a role attach code
 * that runs inside every other role's writes (`trigger_privilege`).
 *
 * "Application object" means any object in a non-system schema — every
 * namespace except `information_schema` and the reserved `pg_*` ones — and
 * covers relations, functions, types and the schemas themselves. Extension
 * members belong to the extension, not the application, and are skipped.
 */
export type DenylistRule =
  /** `pg_roles.rolsuper`. */
  | "superuser"
  /** `pg_roles.rolcreaterole`. Migration 0053 creates all four roles
   *  `NOCREATEROLE` and pins it again with `ALTER ROLE`; this checks the
   *  cluster still agrees. */
  | "createrole"
  /** `pg_has_role(role, 'rm_owner', 'MEMBER')`. 0053 grants `rm_owner` to
   *  `current_user` — the bootstrap/migration login — and its own comment says
   *  "This is intentionally the current role, never either runtime role." A
   *  runtime role that has acquired it is the single most direct way every
   *  other guard in this file becomes decorative. */
  | "rm_owner_membership"
  /** A runtime role owns an application object: a relation
   *  (`pg_class.relowner`), a function (`pg_proc.proowner`), a type
   *  (`pg_type.typowner`) or a schema (`pg_namespace.nspowner`). Ownership is
   *  what 0053's sweeps moved to `rm_owner` precisely so a grantee "cannot
   *  alter/drop tables or triggers"; an owner can also re-grant itself anything
   *  this list forbids. */
  | "object_ownership"
  /** CREATE on a non-system schema, `public` included. 0053 revokes ALL on
   *  `public` from PUBLIC and grants the runtime roles USAGE only. */
  | "ddl"
  /** CREATE on the current database — the privilege `CREATE SCHEMA` needs.
   *  PUBLIC does not hold it by default; a runtime role that does can build a
   *  schema of its own and own everything in it. */
  | "database_create"
  /** The TRIGGER privilege on any relation in a non-system schema. A trigger
   *  runs inside other roles' statements, so a runtime role able to create one
   *  can rewrite writes it could never issue itself. */
  | "trigger_privilege"
  /** `DELETE` or `TRUNCATE` on any table in `APPEND_ONLY_TABLES` or in
   *  `LEDGER_IMMUTABLE_FAMILIES` (./append-only-guard.ts), or in
   *  `RUNTIME_DELETE_REVOKED_TABLES` below. The ledger families count per
   *  decision D53 (6): losing a ledger row is the same harm as losing a
   *  history row. The grant-only tables count per D53 (2).
   *
   *  Migration 0065 is spec §9.1 step 2, the transition that revokes 0053's
   *  `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO
   *  rm_app` on the append-only set; 0072 does the same for the two scheduler
   *  logs. Before them this rule refuses every boot, which is what §9.1 means
   *  by "Check 2 fails until it lands". db-preflight-checks.test.ts replays that
   *  transition and proves both halves. */
  | "append_only_write";

/** One denylist hit, resolved to the exact role and object. */
export interface DenylistViolation {
  readonly rule: DenylistRule;
  readonly role: RmRole;
  /** What the rule names: a relation (as `regclass` prints it), a schema, the
   *  database, `function <regprocedure>` / `type <regtype>` / `schema <name>`
   *  for non-relation ownership, or the `rm_owner` role. `null` for the two
   *  role attributes. */
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
 *   `pg_roles`, `pg_has_role`, the owner columns of `pg_class`, `pg_proc`,
 *   `pg_type` and `pg_namespace`, and `has_schema_privilege` /
 *   `has_database_privilege` / `has_table_privilege`.
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
export async function checkPrivileges(db: PreflightDb, context: PreflightContext): Promise<PreflightCheckResult> {
  const findings: PreflightFinding[] = [];
  const required = requiredPrivileges();
  const sites = registeredSites();

  // REQUIRED — what the registry says this role's programs need.
  for (const role of context.roles) {
    const byObject = required.get(role);
    if (!byObject) continue;
    for (const [object, privileges] of byObject) {
      let missing: readonly TablePrivilege[];
      try {
        missing = await missingPrivileges(db, role, object, [...privileges]);
      } catch (error) {
        // A declaration naming a relation that does not exist is a registry
        // bug, and reporting it as "privilege missing" sends the reader to the
        // wrong file.
        findings.push({
          check: "privileges",
          severity: "refuse",
          message: `${declarantsFor(sites, role, object)}: ${(error as Error).message}`,
        });
        continue;
      }
      if (missing.length === 0) continue;
      findings.push({
        check: "privileges",
        severity: "refuse",
        message:
          `${role} is missing ${missing.join(", ")} on ${object}, required by ${declarantsFor(sites, role, object)}`,
      });
    }
  }

  // DENYLIST — fixed, and refused at `refuse` severity in every environment. A
  // denylist that only arms in production is first exercised in production.
  for (const violation of await findDenylistViolations(db, context.roles)) {
    findings.push({
      check: "privileges",
      severity: "refuse",
      message: denylistMessage(violation),
    });
  }

  return { check: "privileges", findings };
}

/** The call sites that asked for a privilege, so a check-2 failure is
 *  actionable: `<module>:<function>`, never "something is missing somewhere". */
function declarantsFor(
  sites: readonly { role: RmRole; object: string; site: string }[],
  role: RmRole,
  object: string,
): string {
  const named = sites.filter((site) => site.role === role && site.object === object).map((site) => site.site);
  return named.length > 0 ? named.join(", ") : `${role}:${object}`;
}

/** One denylist hit as an operator sentence. The role and the object are both
 *  named because a rule without its object is not actionable. */
function denylistMessage(violation: DenylistViolation): string {
  switch (violation.rule) {
    case "superuser":
      return `${violation.role} is a SUPERUSER: a runtime role may hold none of the denylist (§7 check 2)`;
    case "createrole":
      return `${violation.role} holds CREATEROLE: 0053 pins NOCREATEROLE on all four roles`;
    case "rm_owner_membership":
      return `${violation.role} holds membership in ${violation.object}: every other guard becomes decorative`;
    case "object_ownership":
      return `${violation.role} owns the application object ${violation.object}: ownership belongs to rm_owner`;
    case "ddl":
      return `${violation.role} holds CREATE on schema ${violation.object}: DDL is not a runtime privilege`;
    case "database_create":
      return (
        `${violation.role} holds CREATE on database ${violation.object}: it can create a schema of its own, ` +
        "and DDL is not a runtime privilege"
      );
    case "trigger_privilege":
      return (
        `${violation.role} holds TRIGGER on ${violation.object}: a trigger runs inside other roles' writes, ` +
        "and DDL is not a runtime privilege"
      );
    case "append_only_write":
      if (violation.object !== null && isGrantOnlyProtected(violation.object)) {
        return (
          `${violation.role} holds DELETE/TRUNCATE on ${violation.object}, which D53 (2) keeps revoked from the ` +
          "runtime roles: only rm_owner prunes it, past the oldest servable cursor"
        );
      }
      return (
        `${violation.role} holds DELETE/TRUNCATE on the append-only table ${violation.object}: ` +
        "spec §9.1 step 2's grant transition has not landed on this database, or a grant re-widened it"
      );
  }
}

/**
 * Tables whose DELETE and TRUNCATE stay revoked from the runtime roles although
 * they are not append-only. Decision D53 (2): `swarm_stream_events` loses its
 * DELETE/TRUNCATE triggers so rm_owner can prune rows older than the oldest
 * servable cursor (D52 retention), and it leaves `APPEND_ONLY_TABLES` — but
 * "DELETE/TRUNCATE stay revoked from rm_app and rm_worker".
 *
 * Listed here, independently of ./append-only-guard.ts, on purpose: if check 2
 * derived its protected set from `APPEND_ONLY_TABLES` alone, taking the table
 * out of that list would silently stop check 2 refusing a runtime-role DELETE
 * grant on it. A table leaves this list only by a decision that says so.
 */
export const RUNTIME_DELETE_REVOKED_TABLES: readonly string[] = Object.freeze(["swarm_stream_events"]);

/** Every table the `append_only_write` rule protects: the append-only set, the
 *  immutable ledger families (D53 (6)) and the grant-only tables (D53 (2)),
 *  deduplicated, in a stable order. */
export function protectedFromDeletion(): string[] {
  const tables = new Set<string>(APPEND_ONLY_TABLES);
  for (const family of LEDGER_IMMUTABLE_FAMILIES) {
    for (const table of family.tables) tables.add(table);
  }
  for (const table of RUNTIME_DELETE_REVOKED_TABLES) tables.add(table);
  return [...tables].sort();
}

/** True when `table` is protected only by D53 (2)'s grant rule — neither
 *  append-only nor an immutable ledger — so its refusal must not call it
 *  append-only. */
function isGrantOnlyProtected(table: string): boolean {
  if (!RUNTIME_DELETE_REVOKED_TABLES.includes(table)) return false;
  if ((APPEND_ONLY_TABLES as readonly string[]).includes(table)) return false;
  return !LEDGER_IMMUTABLE_FAMILIES.some((family) => (family.tables as readonly string[]).includes(table));
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
export async function findDenylistViolations(
  db: PreflightDb,
  roles: readonly RmRole[],
): Promise<readonly DenylistViolation[]> {
  const violations: DenylistViolation[] = [];
  if (roles.length === 0) return violations;

  const names = [...roles];

  // Role ATTRIBUTES and role MEMBERSHIP — pg_roles and pg_has_role, never an
  // attempted `SET ROLE`. CREATE on the database rides along: it is a property
  // of (role, current database), one row per role.
  const attributes = (await db`
    SELECT rolname                                                    AS role,
           rolsuper                                                   AS superuser,
           rolcreaterole                                              AS createrole,
           pg_has_role(rolname, 'rm_owner', 'MEMBER')                 AS owner_member,
           has_database_privilege(rolname, current_database(), 'CREATE') AS database_create,
           current_database()                                         AS database
    FROM pg_roles
    WHERE rolname = ANY(${names})`) as unknown as {
    role: RmRole;
    superuser: boolean;
    createrole: boolean;
    owner_member: boolean;
    database_create: boolean;
    database: string;
  }[];
  const byRole = new Map(attributes.map((row) => [row.role, row]));

  // Every catalog query below reads only APPLICATION namespaces: everything but
  // `information_schema` and the `pg_*` names Postgres reserves for itself
  // (pg_catalog, pg_toast, each session's pg_temp_N). A temp table a runtime
  // role creates for one session is not an application object.

  // OWNERSHIP of application objects — relations, functions, types, schemas.
  // 0053's sweeps moved every relation and function to rm_owner precisely so a
  // grantee "cannot alter/drop tables or triggers"; an object that has moved
  // back is the denylist's `object_ownership`. Relations are named as
  // `regclass` prints them (bare in `public`), the rest with their kind.
  //
  // Types skip what Postgres creates implicitly alongside another object —
  // a relation's row type, an array type, a range's multirange — so one owned
  // table is reported once, as the table.
  const owned = (await db`
    SELECT r.rolname AS role, o.object
    FROM (
      SELECT c.relowner AS owner, c.oid::regclass::text AS object
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d
                         WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
      UNION ALL
      SELECT p.proowner, 'function ' || p.oid::regprocedure::text
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d
                         WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
      UNION ALL
      SELECT t.typowner, 'type ' || t.oid::regtype::text
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      LEFT JOIN pg_class rc ON rc.oid = t.typrelid
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND t.typtype <> 'm'
        AND (t.typrelid = 0 OR rc.relkind = 'c')
        AND NOT EXISTS (SELECT 1 FROM pg_type e WHERE e.typarray = t.oid)
        AND NOT EXISTS (SELECT 1 FROM pg_depend d
                         WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
      UNION ALL
      SELECT n.nspowner, 'schema ' || n.nspname
      FROM pg_namespace n
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
    ) o
    JOIN pg_roles r ON r.oid = o.owner
    WHERE r.rolname = ANY(${names})
    ORDER BY r.rolname, o.object`) as unknown as { role: RmRole; object: string }[];

  // DDL through CREATE on any application schema, `public` included.
  const schemaCreate = (await db`
    SELECT r.rolname AS role, n.nspname AS object
    FROM pg_roles r
    CROSS JOIN pg_namespace n
    WHERE r.rolname = ANY(${names})
      AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
      AND has_schema_privilege(r.rolname, n.oid, 'CREATE')
    ORDER BY r.rolname, n.nspname`) as unknown as { role: RmRole; object: string }[];

  // DDL through the TRIGGER privilege on any application relation that can
  // carry a trigger.
  const triggerable = (await db`
    SELECT r.rolname AS role, c.oid::regclass::text AS object
    FROM pg_roles r
    CROSS JOIN pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE r.rolname = ANY(${names})
      AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
      AND c.relkind IN ('r', 'p', 'v', 'f')
      AND has_table_privilege(r.rolname, c.oid, 'TRIGGER')
    ORDER BY r.rolname, c.oid::regclass::text`) as unknown as { role: RmRole; object: string }[];

  // APPEND-ONLY WRITE. The protected set is APPEND_ONLY_TABLES plus every
  // LEDGER_IMMUTABLE_FAMILIES table (D53 (6)) plus RUNTIME_DELETE_REVOKED_TABLES
  // (D53 (2)), resolved through `to_regclass`
  // so a table this database has not reached yet is skipped rather than
  // raising.
  const appendOnly = (await db`
    SELECT r.rolname AS role,
           t.name    AS object,
           has_table_privilege(r.rolname, to_regclass('public.' || t.name), 'DELETE')   AS may_delete,
           has_table_privilege(r.rolname, to_regclass('public.' || t.name), 'TRUNCATE') AS may_truncate
    FROM pg_roles r
    CROSS JOIN unnest(${protectedFromDeletion()}::text[]) AS t(name)
    WHERE r.rolname = ANY(${names})
      AND to_regclass('public.' || t.name) IS NOT NULL
    ORDER BY r.rolname, t.name`) as unknown as {
    role: RmRole;
    object: string;
    may_delete: boolean;
    may_truncate: boolean;
  }[];

  // Reported per role, every rule, every hit — not the first.
  for (const role of roles) {
    const row = byRole.get(role);
    if (row?.superuser) violations.push({ rule: "superuser", role, object: null });
    if (row?.createrole) violations.push({ rule: "createrole", role, object: null });
    if (row?.owner_member) violations.push({ rule: "rm_owner_membership", role, object: "rm_owner" });
    for (const entry of owned.filter((o) => o.role === role)) {
      violations.push({ rule: "object_ownership", role, object: entry.object });
    }
    for (const entry of schemaCreate.filter((s) => s.role === role)) {
      violations.push({ rule: "ddl", role, object: entry.object });
    }
    if (row?.database_create) violations.push({ rule: "database_create", role, object: row.database });
    for (const entry of triggerable.filter((t) => t.role === role)) {
      violations.push({ rule: "trigger_privilege", role, object: entry.object });
    }
    for (const entry of appendOnly.filter((a) => a.role === role)) {
      // ONE violation per table, whichever of the two privileges is held:
      // absent privilege is one protection, and a table is either protected or
      // it is not.
      if (entry.may_delete || entry.may_truncate) {
        violations.push({ rule: "append_only_write", role, object: entry.object });
      }
    }
  }

  return violations;
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
export async function missingPrivileges(
  db: PreflightDb,
  role: RmRole,
  object: string,
  privileges: readonly TablePrivilege[],
): Promise<readonly TablePrivilege[]> {
  const [resolved] = (await db`SELECT to_regclass(${`public.${object}`}) IS NOT NULL AS present`) as unknown as {
    present: boolean;
  }[];
  if (!resolved?.present) {
    throw new Error(
      `${object} does not resolve to a relation in public: a registry declaration names a relation that does not ` +
        "exist, which is a registry bug and not a missing grant",
    );
  }

  if (privileges.length === 0) return [];

  // One `has_table_privilege` call per privilege, and never the statement the
  // privilege would permit: a check that proves rm_app cannot DELETE by
  // attempting a DELETE is a check that deletes when it is wrong.
  const held = (await db`
    SELECT p.name AS privilege,
           has_table_privilege(${role}, to_regclass(${`public.${object}`}), p.name) AS granted
    FROM unnest(${[...privileges]}::text[]) WITH ORDINALITY AS p(name, ord)
    ORDER BY p.ord`) as unknown as { privilege: TablePrivilege; granted: boolean }[];

  return held.filter((row) => !row.granted).map((row) => row.privilege);
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
 * WHAT IS COMPARED. Every object class §8.1 names — tables and their columns
 * (type, nullability, default), indexes, constraints, functions, triggers
 * (definition and enabled state), policies, ownership and default privileges —
 * through the catalog fingerprint the manifest carries (`compareCatalog` in
 * ./schema-manifest.ts). In both directions: a declared object that is absent
 * or different, and a live object the manifest does not declare.
 *
 * Refusals:
 *   - Any live object differs from the manifest, or the live catalog holds an
 *     object the manifest does not declare — excluding the provider list the
 *     manifest itself carries (members of its listed extensions; undeclared
 *     objects owned by its listed provider roles).
 *   - The manifest's declaration cannot be read as a fingerprinted
 *     declaration (`parseDeclaration`).
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
export async function checkSchemaIntegrity(
  db: PreflightDb,
  context: PreflightContext,
): Promise<PreflightCheckResult> {
  // `context` is deliberately unread. 3a asks a question about the DATABASE and
  // must answer it identically "whatever code is booting" (§7 check 3a), so
  // reading `codeFilenames` here would make an ordinary version difference look
  // like drift — which is 3b's question, and a different one.
  void context;
  const findings: PreflightFinding[] = [];
  const refuse = (message: string): void => {
    findings.push({ check: "schema_integrity", severity: "refuse", message });
  };

  // ── The comparison TARGET: the manifest stored in this database (§8.3).
  let manifest: SchemaManifest | null = null;
  try {
    manifest = await readManifest(db);
  } catch (error) {
    refuse((error as Error).message);
  }

  if (manifest === null && findings.length === 0) {
    refuse(
      `no ${MANIFEST_TABLE} row: this database declares no schema to be verified against, and "nothing to compare" ` +
        "is not a reason to serve it",
    );
  }

  if (manifest !== null) {
    const state = await detectManifestState(db);
    if (state.kind === "unknown_format") {
      refuse(`${MANIFEST_TABLE} format version ${state.formatVersion} is unknown to this code (§8.3)`);
    }
    if (state.kind === "inconsistent") {
      refuse(`${MANIFEST_TABLE} disagrees with the ledger: ${state.reasons.join("; ")}`);
    }

    // LEDGER AHEAD OF MANIFEST is §8.3's *in progress*, and an application boot
    // refuses it: the schema is mid-change and nothing has verified where it
    // got to. Computed here rather than taken from the classifier's verdict,
    // because a manifest can be BOTH in progress and internally inconsistent
    // and the operator needs to be told both.
    const ahead = await ledgerAhead(db, manifest.filenames);
    if (ahead.length > 0) {
      refuse(
        `the database is in progress — the ledger records ${ahead.length} migration(s) the manifest does not ` +
          `embody (${ahead.join(", ")}); nothing has verified where the schema got to`,
      );
    }

    // THE COMPARISON, only against a manifest that describes this database.
    // In progress, the manifest describes the version BEFORE the committed
    // migrations, so their objects would read as drift and bury the one
    // sentence the operator needs; inconsistent or unknown, it describes
    // nothing that can be trusted. Each of those is already a refusal above.
    if (state.kind === "published") {
      let declared;
      try {
        declared = parseDeclaration(manifest.declaration);
      } catch (error) {
        refuse(
          `${MANIFEST_TABLE}'s declaration cannot be compared with the live catalog — ${(error as Error).message}`,
        );
      }
      if (declared) for (const problem of await compareCatalog(db, declared)) refuse(problem);
    }
  }

  // ── The live half, which does not depend on a manifest existing.
  //
  // A trigger is the object class a partial `pg_restore` silently omits (it
  // lives in the post-data section) while the ledger keeps claiming the
  // migration that installs it ran — the exact shape of issue #602. Genuine
  // drift has to fail here whatever the manifest says, including when there is
  // no manifest at all.
  for (const problem of await missingGuardTriggers(db)) refuse(problem);

  return { check: "schema_integrity", findings };
}

/** Ledger rows the manifest does not embody, in apply order. */
async function ledgerAhead(db: PreflightDb, embodied: readonly string[]): Promise<string[]> {
  const rows = (await db`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[];
  const known = new Set(embodied);
  return rows.map((row) => row.name).filter((name) => !known.has(name));
}

/** The append-only and ledger-immutable triggers each guard migration installs,
 *  checked against the catalog. A table the database has not reached yet is
 *  skipped: its absence is a version difference, not drift. */
async function missingGuardTriggers(db: PreflightDb): Promise<string[]> {
  const applied = new Set(
    ((await db`SELECT name FROM schema_migrations`) as unknown as { name: string }[]).map((row) => row.name),
  );
  const tables = new Set(
    (
      (await db`
        SELECT c.relname AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`) as unknown as { name: string }[]
    ).map((row) => row.name),
  );
  const installed = new Set(
    (
      (await db`
        SELECT c.relname AS table_name, t.tgname AS trigger_name
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND NOT t.tgisinternal`) as unknown as {
        table_name: string;
        trigger_name: string;
      }[]
    ).map((row) => `${row.table_name}.${row.trigger_name}`),
  );

  const problems: string[] = [];
  const require = (table: string, trigger: string, migration: string): void => {
    if (!tables.has(table)) return;
    if (installed.has(`${table}.${trigger}`)) return;
    problems.push(
      `${table} is missing the trigger ${trigger} that ${migration} installs: the ledger records that migration, ` +
        "so this is drift, not a version difference",
    );
  };

  for (const migration of APPEND_ONLY_MIGRATIONS) {
    if (!applied.has(migration)) continue;
    for (const table of APPEND_ONLY_TABLES) {
      if (APPEND_ONLY_TABLE_MIGRATION[table] !== migration) continue;
      const names = triggerNames(table);
      require(table, names.statement, migration);
      require(table, names.row, migration);
    }
  }
  for (const family of LEDGER_IMMUTABLE_FAMILIES) {
    if (!applied.has(family.migration)) continue;
    for (const table of family.tables) {
      const names = ledgerTriggerNames(family, table);
      require(table, names.statement, family.migration);
      require(table, names.row, family.migration);
    }
  }

  return problems;
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
export async function checkSchemaCompatibility(
  db: PreflightDb,
  context: PreflightContext,
): Promise<PreflightCheckResult> {
  const findings: PreflightFinding[] = [];
  const ledger = (
    (await db`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[]
  ).map((row) => row.name);

  const recorded = new Set(ledger);
  const shipped = new Set(context.codeFilenames);
  const ahead = context.codeFilenames.filter((name) => !recorded.has(name));
  const surplus = ledger.filter((name) => !shipped.has(name));

  // The code is AHEAD of the database. Not a compatibility question — a pending
  // migration — but still a refusal, and it is reported here rather than
  // allowed to escape as an exception, because an operator gets every failure
  // in one pass or none of them.
  if (ahead.length > 0) {
    findings.push({
      check: "schema_compatibility",
      severity: "refuse",
      message:
        `this image ships migrations the ledger does not record (${ahead.join(", ")}): the database is BEHIND the ` +
        "code, which is a pending migration, not a compatibility question",
    });
  }

  if (surplus.length === 0) return { check: "schema_compatibility", findings };

  let verdict;
  try {
    verdict = await checkCompatibility(db, [...shipped].filter((name) => recorded.has(name)), ledger);
  } catch (error) {
    // The surplus is named HERE. A database that predates §8.2's columns
    // refuses through `readLedgerCompat`, whose message is about the column —
    // true, and not enough: the operator also has to be told which migrations
    // could not be evaluated.
    findings.push({
      check: "schema_compatibility",
      severity: "refuse",
      message:
        `the ledger records ${surplus.length} migration(s) this image does not ship (${surplus.join(", ")}) and ` +
        `their compatibility cannot be read: ${(error as Error).message}`,
    });
    return { check: "schema_compatibility", findings };
  }

  if (verdict.kind === "refused") {
    for (const reason of verdict.reasons) {
      findings.push({ check: "schema_compatibility", severity: "refuse", message: reason });
    }
  }

  return { check: "schema_compatibility", findings };
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
 * The keys §3 allows in `~/.env`, and nothing else: "the remote connection
 * (host, port, dbname); the runtime role passwords `rm_app`, `rm_worker` and
 * `rm_readonly`; `RM_ENV`; and `RM_CREDENTIALS`."
 *
 * The connection keys are spelled the way scripts/lib/env-role.ts's
 * `CONNECTION_TOKENS` reads them — the DigitalOcean panel's `host`, `port`,
 * `database`, `sslmode` — because that module is the one resolver every
 * host-side tool uses, and a key it cannot read is a key nothing uses. §3
 * writes the database key as `dbname`; BOTH spellings are accepted, so a file
 * written from the spec and a file pasted from the panel both pass. `sslmode`
 * is part of "the remote connection" even though §3's parenthesis does not list
 * it: a managed cluster refuses a connection without it.
 *
 * Exact spelling, case included: `HOST` is not `host` to env-role.ts, so it is
 * a key nothing reads, and an unread key in the credential file is precisely
 * what this check exists to find. db-preflight-checks.test.ts pins this set
 * against env-role.ts's `CONNECTION_TOKENS` and `ROLES`.
 */
export const ENV_FILE_ALLOWED_KEYS: readonly string[] = Object.freeze([
  "host",
  "port",
  "database",
  "dbname",
  "sslmode",
  "rm_app",
  "rm_worker",
  "rm_readonly",
  "RM_ENV",
  "RM_CREDENTIALS",
]);

/**
 * Check 4 — `~/.env` holds only the keys §3 lists.
 *
 * Input: the context (for `envFilePath`, `env` and `connection`). Output:
 * findings, one per offending line.
 *
 * AN ALLOWLIST, NOT A DENYLIST. Spec §7 check 4: "`~/.env` holds only the keys
 * §3 lists. Any other key warns on `stage` and refuses on `prod`; an
 * `rm_owner`, `doadmin` or superuser credential is named in the message." §3
 * lists what else it "must not contain": "`rm_owner`, `doadmin`, a superuser
 * token, a service token, a signing key or a model key". Those are open-ended
 * categories — `OPENCODE_API_KEY`, `ADMIN_TOKEN`, a participant's signing key
 * pasted in by mistake — and a denylist of names would pass each new one until
 * someone thought to add it. So every key outside `ENV_FILE_ALLOWED_KEYS` is a
 * finding, and the dangerous ones are additionally NAMED as what they are
 * (`dangerousKeyReason`).
 *
 * The point is that every credential lives in exactly one place (§3, "Why this
 * shape"): `rm_owner`'s password is "typed at the terminal for the one run that
 * needs it and never stored", participant keys live in `credential.json`, and
 * service tokens are files the boot places per instance. A copy in `~/.env`
 * turns each of those boundaries into a formality, silently.
 *
 * THE FILE is `context.envFilePath`, which every runtime caller sets to
 * `homeEnvPath()` — the deploying user's `$HOME/.env`; tests pass a fixture.
 * A missing or unreadable file is silence,
 * not a refusal: it holds no stray key because it holds nothing, and whether
 * the file is REQUIRED is configuration validation's question, earlier in the
 * boot order.
 *
 * Reads only the KEY NAMES. It never logs, hashes or compares a value, and a
 * finding names the offending key and nothing else — the same posture
 * `redactedTarget` takes in backend/scripts/db-preflight.ts. A non-blank,
 * non-comment line that is not `KEY = VALUE` at all (a bare pasted secret), or
 * whose key is not a plain name, is reported by line number, never by content.
 * The key is the text before the first `=`, exactly as env-role.ts's
 * `parseEnvFile` reads it (`envLines`).
 *
 * Refusals: on `prod`, any key outside the allowlist. On `stage` the same
 * finding is severity `warn` and the boot proceeds (§7 check 4). When `env` is
 * `null` the finding is a refusal against a remote connection and a warning
 * under `--local`, following §4.3's unset row.
 *
 * Serves spec §10 W2 (plan row W2.4's "`.env` dangerous-credential refusal on
 * `prod`") as amended by D52: "check 4 an allowlist".
 */
export async function checkEnvCredentials(context: PreflightContext): Promise<PreflightCheckResult> {
  const findings: PreflightFinding[] = [];
  const path = context.envFilePath;

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { check: "env_credentials", findings };
  }

  // §7 check 4: warn on stage, refuse on prod. With RM_ENV unset, §4.3's unset
  // row decides: refuse against a remote, warn under `--local`.
  const severity: PreflightFinding["severity"] =
    context.env === "prod" ? "refuse" : context.env === "stage" ? "warn" : context.connection === "remote" ? "refuse" : "warn";
  const allowed = new Set(ENV_FILE_ALLOWED_KEYS);

  for (const line of envLines(text)) {
    // The KEY and nothing else. The value is never read, logged, hashed or
    // compared.
    if (line.key === null) {
      findings.push({
        check: "env_credentials",
        severity,
        message:
          `${path} line ${line.number} is not a KEY = VALUE line (it has no \`=\`): §3 allows only the connection values, the three ` +
          "runtime role passwords, RM_ENV and RM_CREDENTIALS, and a bare value is none of them",
      });
      continue;
    }
    if (allowed.has(line.key)) continue;
    if (!line.plain) {
      // Not printed: a key holding `:`, spaces or quotes may be half a secret.
      const reason = dangerousTokenReason(line.key);
      findings.push({
        check: "env_credentials",
        severity,
        message:
          `${path} line ${line.number} has a key that is not a plain name, ` +
          `${reason === null ? "so it is none of the keys §3 lists" : `and it names ${reason}`} — §3 allows only the connection values ` +
          "(host, port, database/dbname, sslmode), the rm_app, rm_worker and rm_readonly passwords, RM_ENV and " +
          "RM_CREDENTIALS",
      });
      continue;
    }
    const reason = dangerousKeyReason(line.key);
    findings.push({
      check: "env_credentials",
      severity,
      message:
        `${path} holds ${line.key}, ${reason ?? "a key §3 does not list"} — §3 allows only the connection values ` +
        "(host, port, database/dbname, sslmode), the rm_app, rm_worker and rm_readonly passwords, RM_ENV and " +
        "RM_CREDENTIALS",
    });
  }

  return { check: "env_credentials", findings };
}

/** One meaningful line of an env file: its 1-based number and its KEY, or
 *  `null` when the line has no `=` at all. `plain` says whether the key is a
 *  bare name that is safe to print; a key that is not (it holds `:`, spaces or
 *  anything a pasted secret might) is reported by line number instead. Values
 *  are never returned, so nothing downstream can print one by accident. */
interface EnvLine {
  readonly number: number;
  readonly key: string | null;
  readonly plain: boolean;
}

/** A key that is safe to name in a finding. */
const PLAIN_ENV_KEY = /^[A-Za-z0-9_.-]+$/;

/**
 * The meaningful lines of an env file, in file order. Blank lines and `#`
 * comments are skipped.
 *
 * The KEY is derived exactly as env-role.ts's `parseEnvFile` derives it — the
 * text before the FIRST `=`, an `export ` prefix stripped, trimmed — and the
 * whole of it is what the allowlist tests. Anything looser lets a line pass as
 * one key while the reader stores it as another: with a `[=:]` separator,
 * `host:OPENCODE_API_KEY=sk-…` read as the allowed `host`, while parseEnvFile
 * stores the disallowed key `host:OPENCODE_API_KEY`.
 *
 * A line with no `=` is not something parseEnvFile reads, but a secret stored
 * that way (a bare paste, or `rm_owner: …`) is still stored, so it is a finding
 * by line number.
 */
function envLines(text: string): EnvLine[] {
  const lines: EnvLine[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) {
      lines.push({ number: index + 1, key: null, plain: false });
      continue;
    }
    const key = trimmed.slice(0, eq).replace(/^export\s+/, "").trim();
    lines.push({ number: index + 1, key, plain: PLAIN_ENV_KEY.test(key) });
  }
  return lines;
}

/** The first dangerous credential named anywhere in a non-plain key, split on
 *  anything that is not a name character, so `rm_worker: rm_owner` is still
 *  called the migration credential without printing the key itself. */
function dangerousTokenReason(key: string): string | null {
  for (const token of key.split(/[^A-Za-z0-9_.-]+/)) {
    if (token === "") continue;
    const reason = dangerousKeyReason(token);
    if (reason !== null) return reason;
  }
  return null;
}

/** What a disallowed key IS, when it is one of the credentials §7 check 4 says
 *  must be named in the message: `rm_owner`, `doadmin`, a superuser, or the
 *  cluster's `postgres` login. `null` for any other disallowed key, which is
 *  still a finding — only its wording is generic. */
function dangerousKeyReason(key: string): string | null {
  const name = key.toLowerCase();
  if (name === "rm_owner") return "the migration credential (§3: typed for one run, never stored)";
  if (name === "doadmin") return "the cluster provisioning credential (§3: doadmin is provisioning only)";
  if (name.includes("superuser")) return "a superuser credential";
  if (name === "postgres" || /(^|_)postgres_(user|password|url|superuser)/.test(name)) {
    return "a cluster superuser credential";
  }
  return null;
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
export async function checkEnvIdentity(
  db: PreflightDb,
  context: PreflightContext,
): Promise<PreflightCheckResult> {
  const findings: PreflightFinding[] = [];
  const refuse = (message: string): PreflightCheckResult => {
    findings.push({ check: "env_identity", severity: "refuse", message });
    return { check: "env_identity", findings };
  };

  // The row first: every matrix cell reads it, and "absence of evidence is not
  // evidence of rehearsal".
  const [present] = (await db`SELECT to_regclass('public.deployment_identity') IS NOT NULL AS present`) as unknown as {
    present: boolean;
  }[];
  if (!present?.present) {
    return refuse("no deployment_identity table: this target is not enrolled (§4.2), and an unenrolled target is not a rehearsal one");
  }
  // The enrollment column is `kind` (§4.2, migration 0063_deployment_identity).
  // Resolved from the catalog rather than assumed, because this check also runs
  // against databases restored or hand-built before that migration, and a
  // column error there would read as "the check is broken" rather than "this
  // target is not enrolled".
  const [column] = (await db`
    SELECT column_name AS name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'deployment_identity'
      AND column_name IN ('kind', 'identity')
    ORDER BY CASE column_name WHEN 'kind' THEN 0 ELSE 1 END
    LIMIT 1`) as unknown as { name: string }[];
  if (!column?.name) {
    return refuse(
      "deployment_identity carries no enrollment column (§4.2 expects `kind`): this target is not enrolled",
    );
  }
  const rows = (await db.unsafe(
    `SELECT ${column.name} AS identity FROM deployment_identity`,
  )) as unknown as { identity: string }[];
  if (rows.length === 0) {
    return refuse("no deployment_identity row: absence of evidence is not evidence of rehearsal (§4.2)");
  }
  if (rows.length > 1) {
    return refuse(
      `deployment_identity holds ${rows.length} rows: it is a one-row table (§4.2) and no choice between them is defensible`,
    );
  }
  const identity = rows[0]?.identity ?? "";

  // §4.3's matrix, row by row, ONE finding each: an operator fixing a boot
  // needs the cell they are in, not every cell they are not in.
  if (context.env === null) {
    if (context.connection === "remote") {
      return refuse("RM_ENV is not set and the target is a remote connection: §4.3 refuses rather than guessing a policy");
    }
    findings.push({
      check: "env_identity",
      severity: "warn",
      message: "RM_ENV not set, running as stage",
    });
    return { check: "env_identity", findings };
  }

  if (context.env === "prod") {
    if (context.connection === "local") {
      return refuse("RM_ENV=prod with a --local mode: §4.3 refuses every prod + --local combination");
    }
    if (identity !== "production") {
      return refuse(
        `RM_ENV=prod against deployment_identity = ${identity}: production guards may only arm on a target enrolled as production`,
      );
    }
    return { check: "env_identity", findings };
  }

  // stage — remote and local alike. "A reattached volume gets no weaker policy
  // than a remote", and stage policy never touches production data.
  if (identity !== "rehearsal") {
    return refuse(
      `RM_ENV=stage against deployment_identity = ${identity}: stage policy, --allow-insecure included, never touches production data`,
    );
  }
  return { check: "env_identity", findings };
}

/**
 * The three columns a subject is scheduled by (scheduler spec §2.2/§2.3): the
 * epoch length, the grid's anchor instant, and the judging window after close.
 * Nothing else about a subject's schedule is stored — spec §2.4: "There is no
 * on/off state for scheduling."
 */
export const SUBJECT_SCHEDULING_COLUMNS: readonly string[] = Object.freeze([
  "epoch_duration_seconds",
  "epoch_anchor",
  "judging_duration_seconds",
]);

/**
 * Check 6 — the scheduling check. Spec §7 check 6, verbatim: "Every active
 * subject has its epoch duration, epoch anchor and judging duration. (Whether
 * it has an open epoch is a readiness check, not a preflight one — §6.3.)"
 *
 * Inputs: a handle and the context. Output: findings — one per active subject
 * per missing column, each naming the subject and the column, or one per column
 * the table lacks altogether.
 *
 * WHAT THIS REPLACED (issue #1026 W4). Check 6 used to ask whether "the five
 * `swarm.*` schedule rows are enabled and their cron strings parse". The same
 * change that gives a subject its schedule retires those rows, so the old body
 * would have refused every production boot for the absence of rows the design
 * forbids.
 *
 * NO ENVIRONMENT QUALIFIER. The old check returned an empty result off `prod`,
 * because stage legitimately ran with the rows disabled. Nothing about a
 * subject's schedule is environment-specific: the same image runs everywhere
 * and "only the subjects' epoch durations differ" (scheduler spec §8). A stage
 * subject with no anchor is exactly as broken as a production one.
 *
 * WHY IT CAN STILL FIND ANYTHING. Migrations 0067 and 0073 make all three
 * columns NOT NULL with defaults, so on a database they have reached this passes
 * by construction. That is the point of a preflight: it measures rather than
 * assumes, and the case it exists for is a column that is absent or was relaxed
 * — a partially applied migration, a restore that stopped early, a hand-run
 * `ALTER TABLE`, an older image against a newer database.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK. Whether a subject has an open epoch.
 * That is READINESS (`smoke-production-spec.md` §6.3): preflight runs before
 * the scheduler exists, so requiring its output would refuse every first boot.
 * A non-positive duration is the columns' own CHECK constraints' business, and
 * check 3a refuses a database that lost one.
 */
export async function checkSubjectScheduling(
  db: PreflightDb,
  _context: PreflightContext,
): Promise<PreflightCheckResult> {
  const findings: PreflightFinding[] = [];
  const refuse = (message: string): void => {
    findings.push({ check: "subject_scheduling", severity: "refuse", message });
  };

  // `pg_attribute`, not `information_schema.columns`: the view is
  // privilege-filtered, and a role with no grant on the table would read every
  // column as absent.
  const present = new Set(
    (
      (await db`
        SELECT a.attname AS name
          FROM pg_attribute a
         WHERE a.attrelid = to_regclass('public.swarm_subjects')
           AND a.attnum > 0 AND NOT a.attisdropped`) as unknown as { name: string }[]
    ).map((row) => row.name),
  );
  const absent = SUBJECT_SCHEDULING_COLUMNS.filter((column) => !present.has(column));
  for (const column of absent) {
    refuse(
      `swarm_subjects has no ${column} column: the migration that adds it has not reached this database, so no ` +
        "subject can be scheduled (scheduler spec §2.3)",
    );
  }
  if (absent.length > 0) return { check: "subject_scheduling", findings };

  const rows = (await db`
    SELECT id,
           epoch_duration_seconds IS NULL   AS no_epoch_duration_seconds,
           epoch_anchor IS NULL             AS no_epoch_anchor,
           judging_duration_seconds IS NULL AS no_judging_duration_seconds
      FROM swarm_subjects
     WHERE status = 'active'
       AND (epoch_duration_seconds IS NULL OR epoch_anchor IS NULL OR judging_duration_seconds IS NULL)
     ORDER BY id`) as unknown as ({ id: string } & Record<string, boolean>)[];

  for (const row of rows) {
    for (const column of SUBJECT_SCHEDULING_COLUMNS) {
      if (row[`no_${column}`] !== true) continue;
      refuse(
        `active subject ${row.id} has no ${column}: a subject is scheduled by its epoch duration, epoch anchor and ` +
          "judging duration (scheduler spec §2.2), all three set through the admin subject route",
      );
    }
  }

  return { check: "subject_scheduling", findings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/** Which checks to run — §7.2's three callers in one union. */
export type PreflightScope =
  /** Smoke: checks 1-6, refuses the cluster. */
  | "full"
  /** `api` / a worker lane at startup: checks 1-3 against their own
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
export async function runPreflight(
  db: PreflightDb,
  context: PreflightContext,
  scope: PreflightScope,
  tokens: ReadonlyMap<RmRole, string>,
): Promise<PreflightReport> {
  // "Unreachable" is never reported as "check failed". The probe runs first and
  // its error propagates, so a database nobody can query throws here instead of
  // being rendered as six refusals an operator would try to fix.
  await db`SELECT 1`;

  const results: PreflightCheckResult[] = [
    await checkRoleTokens(db, context, tokens),
    await checkPrivileges(db, context),
    await checkSchemaIntegrity(db, context),
    await checkSchemaCompatibility(db, context),
  ];

  // Checks 4-6 are the operator's environment, which a container is not
  // positioned to judge (§7.2). Every check runs before anything is decided:
  // a database failing 2, 3 and 5 says so in one boot.
  if (scope === "full") {
    results.push(await checkEnvCredentials(context));
    results.push(await checkEnvIdentity(db, context));
    results.push(await checkSubjectScheduling(db, context));
  }

  const passed = !results.some((result) => result.findings.some((finding) => finding.severity === "refuse"));
  return { results, passed };
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
  const lines: string[] = [];
  for (const result of report.results) {
    for (const finding of result.findings) {
      lines.push(`[preflight] ${finding.severity.toUpperCase()} ${finding.check}: ${finding.message}`);
    }
  }
  return lines;
}
