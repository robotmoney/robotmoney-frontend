// The registered query interface — the ONE place a database statement may be
// issued from, and the reason preflight check 2 can be trusted.
//
// Implemented (issue #1026 W2): registration, enumeration and the fold check 2
// reads are all live, and application modules register their call sites here
// at module level and issue them through `on(...)` below. Governed by
// smoke-production-spec.md §7.1, with §7 check 2 as its main consumer; a
// declaration's `callers` are also read by the tests that pin who may reach a
// write (smoke-production-spec.md §6.2: "nothing but the admin route writes
// `swarm_judge_config`").
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────────────────────
//
// Spec §7 check 2 asks a question that sounds simple — "does each role hold
// every privilege its programs need, and nothing from the denylist?" — and the
// first half of it is unanswerable without a list of what the programs need.
// The obvious way to produce that list is to write one down. That list is wrong
// within a week: somebody adds a route that writes a new table, the grant is
// already there because 0053 line 129 handed `rm_app` `DELETE` on ALL tables,
// nothing fails, and the hand-maintained list never learns about the new call
// site. Preflight then passes on a database where the role's real privilege set
// and its declared one have nothing to do with each other, which is worse than
// no check at all — it is a check that reports green while measuring nothing.
//
// So the list is not written down. It is DERIVED from the call sites, because
// every call site has to declare `(role, object, privilege)` to issue a
// statement in the first place. Spec §7.1: "All database access goes through
// one registered query interface that declares `(role, object, privilege)` at
// the call site. CI forbids raw `sql` outside it, so the registry cannot drift
// into a hand-maintained list. It is the input to check 2."
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT IS NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// Spec §7.1, verbatim: "It is not a runtime proof: execution under each role
// against a disposable database is a separate CI test." A declaration is a
// claim about what a call site needs, made by the person who wrote the call
// site. It can be wrong in both directions — over-declared (the check demands a
// privilege nobody uses) and under-declared (a statement runs that the registry
// never mentioned). Only executing the statements under the real role catches
// the second kind, and that test is tests/db-registry-execution.test.ts, not
// this module. What this module adds for it is the `probe` a declaration
// carries (see `QueryProbe`): a runnable statement that exercises exactly the
// declared privileges on the declared object, so the test can run every site
// as its declared LOGIN role without calling the application function around
// it.
//
// The registry is also NOT an allowlist of grants. Spec §7 check 2: "A grant
// absent from the registry is not forbidden by that fact alone." See
// `checkPrivileges` in ./preflight.ts for the full statement of that rule and
// why it has to hold.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW CI READS IT
// ─────────────────────────────────────────────────────────────────────────────
//
// Two enforcement halves, both W2.3's gate ("registry structurally enforced"):
//
//   1. tests/db-registry.test.ts parses every module under `src/` and treats
//      every tagged template as a statement, whatever its handle is called and
//      whether or not it carries a type argument, unless its tag is a call of
//      `on(...)` imported from this module; every `.unsafe(...)` call counts
//      too. A raw statement outside the db layer's named infrastructure files
//      (pools, this module, migrate, target lock, preflight, schema-*, the two
//      append-only boot guards) and outside the dated allowlist fails the build. The
//      allowlist is a ratchet that only shrinks. This is what makes the
//      registry complete rather than merely populated, and it is complete only
//      once that allowlist is empty.
//   2. `registeredSites()` below enumerates every declaration the process has
//      made, so the same test can assert that each one names a §3 role, an
//      object the schema snapshot (§8.1) creates, and callers that are real
//      modules — and so `requiredPrivileges()` can fold them into the
//      (role → object → privileges) map preflight check 2 compares against
//      `has_table_privilege`.
//
// Enumeration is only as complete as the module graph that has been imported.
// The test therefore does not read "whatever is registered so far": it finds
// every module whose source calls `registerQuery`, imports each one itself,
// and reads back the sites that module owns, so its answer does not depend on
// which test file ran first. A registration made lazily inside a function body
// would be invisible to that enumeration and to preflight; registrations are
// module-level by convention, and the test pins that from the source too.
import type postgresTypes from "postgres";

/**
 * The four roles of spec §3. There is no `rm_migrator` — spec §3 says so in
 * those words, and D46/D47 record the removal. `doadmin` is absent on purpose:
 * it is cluster provisioning only (§3, §9.1), never a role any application
 * statement runs as, so no call site may declare it.
 */
export type RmRole = "rm_owner" | "rm_app" | "rm_worker" | "rm_readonly";

/**
 * Table-level privileges as `has_table_privilege` spells them. Check 2 is
 * catalog-only, so the vocabulary here has to be exactly the catalog's — a
 * synonym that Postgres does not recognise turns into a silently failing
 * privilege test rather than an error.
 */
export type TablePrivilege =
  | "SELECT"
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "TRUNCATE"
  | "REFERENCES"
  | "TRIGGER";

/** Same handle shape the rest of `src/db` accepts, so a registered site can be
 *  run on the pool or inside a transaction (a fenced mutation per spec §2 runs
 *  inside one by definition). */
export type RegistryDb = postgresTypes.Sql<{}> | postgresTypes.TransactionSql<{}>;

/**
 * One call site's declaration — the (role, object, privilege) triple of §7.1
 * plus enough provenance for a refusal to name the offender.
 */
export interface QueryDeclaration {
  /** The role the program issuing this statement authenticates as. */
  readonly role: RmRole;
  /** The relation in `public` this statement touches, unqualified, exactly as
   *  `pg_class.relname` spells it. One declaration per relation: a statement
   *  that joins three tables registers three declarations, because check 2
   *  tests privileges per relation. */
  readonly object: string;
  /** Every privilege this statement needs on that relation. A read that also
   *  advances a cursor column is `["SELECT", "UPDATE"]`, not `["SELECT"]`. */
  readonly privileges: readonly TablePrivilege[];
  /** Stable identifier for the call site, conventionally
   *  `<module>:<function>`. It is what a check-2 failure prints, and what the
   *  lint test uses to assert declarations are unique. */
  readonly site: string;
  /** One sentence on what the statement is for. Read by humans reviewing a new
   *  privilege, which is the only review a grant widening ever gets. */
  readonly purpose: string;
  /**
   * The ENTRY modules through which this statement may be reached, as module
   * ids relative to `backend/` with no extension (`src/api/routes/swarm-admin`,
   * or `scripts/<cli>` for an operator command).
   * An entry module is the outermost application module on the path — the
   * route that receives the request, or the job handler that claims the job —
   * not every helper the call passes through.
   *
   * WHY IT IS DECLARED HERE AND NOT GREPPED. "Only the admin route writes
   * `swarm_judge_config`" (smoke-production-spec.md §6.2) is a statement about
   * a call site, and a grep for the import proves only what the grep happened
   * to match. The declaration sits next to the statement it governs, is
   * reviewed with it, and is enumerable through `registeredSites()`, so a test
   * can assert the property from the registry itself.
   */
  readonly callers: readonly string[];
  /**
   * The statement tests/db-registry-execution.test.ts runs, as `role`, in a
   * transaction it rolls back, on a disposable database bootstrapped from the
   * real snapshot (spec §7.1: "execution under each role against a disposable
   * database is a separate CI test").
   *
   * Optional in the TYPE only. The execution test refuses a registered site
   * with no probe unless the site is on its dated, shrink-only PROBE_PENDING
   * list, so an omission is a visible backlog entry, never a silent gap.
   */
  readonly probe?: QueryProbe;
}

/** A probe parameter: JSON-safe, because the execution test reads the probes
 *  out of a child process (the registry is process-global) as JSON. A value
 *  Postgres needs typed (a jsonb, a timestamp) is passed as text and cast in
 *  the statement. */
export type ProbeParam = string | number | boolean | null;

/**
 * A runnable stand-in for one call site's statement.
 *
 * WHY NOT RUN THE CALL SITE ITSELF. The real statement is a template built at
 * the call site from runtime values, inside an application function that
 * needs a request, a job or a chain read to reach it. The probe is the same
 * statement's shape — the same relation, the same kind of access, the same
 * columns where they matter — written once, next to the declaration it
 * proves, with sample parameters.
 *
 * WHAT "EXACTLY" MEANS. The execution test holds every probe to two things
 * beyond running as the declared role: it succeeds for a scratch role holding
 * ONLY the declared privileges on ONLY the declared object, and it fails with
 * 42501 for that role once any single declared privilege is taken away. So a
 * probe cannot be `SELECT 1` (which needs nothing), cannot touch a second
 * relation (a join's other relations have declarations and probes of their
 * own), and a declaration cannot list a privilege its probe does not use.
 */
export interface QueryProbe {
  /** One DML statement, `$1`-style placeholders, no trailing semicolon. It
   *  may write: the test rolls every probe back. */
  readonly statement: string;
  /** One value per placeholder, in order. */
  readonly params?: readonly ProbeParam[];
}

/**
 * What `registerQuery` hands back: a tagged template that issues the statement
 * and nothing else. There is no escape hatch to the underlying client, because
 * an escape hatch is how the registry stops being complete.
 */
export interface RegisteredQuery {
  /** The declaration this site registered, for error messages and tests. */
  readonly declaration: QueryDeclaration;
  /** Issue the statement. Values are interpolated by postgres.js exactly as a
   *  bare tagged template would, so registration costs a call site nothing but
   *  the declaration. */
  run<T = unknown>(
    db: RegistryDb,
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<T[]>;
}

/**
 * Register one call site and return its query runner.
 *
 * Inputs: the full declaration. Output: a `RegisteredQuery` bound to it.
 *
 * Refusals (all of them throw at registration, i.e. at module load, so a bad
 * declaration cannot reach production as a runtime surprise):
 *   - `site` already registered with a different declaration — duplicate ids
 *     make a check-2 failure unattributable.
 *   - `privileges` empty — a statement that needs no privilege is a statement
 *     that does not touch the object it named.
 *   - `object` not an unqualified relation name (contains a schema qualifier,
 *     quoting, or whitespace) — check 2 resolves it through `to_regclass` in
 *     `public` and a qualified name silently resolves elsewhere.
 *   - `callers` empty, repeated, or not a module id under `src/` or
 *     `scripts/` — a declaration that names no caller says nothing about who
 *     may reach the statement, and a misspelled one says something false.
 *   - `probe` present but not one DML statement that names the declared
 *     object, or with a placeholder count that does not match its params —
 *     a probe the execution test cannot run faithfully is a false proof.
 *
 * Serves spec §10 W2 "Registry structurally enforced; execution under each role
 * on a disposable database" — this half is the structural one.
 */
/** Registration order, which is the order `registeredSites()` reports. */
const order: QueryDeclaration[] = [];
/** Site id → its runner, so a re-registration is resolved rather than duplicated. */
const bySite = new Map<string, RegisteredQuery>();

export function registerQuery(declaration: QueryDeclaration): RegisteredQuery {
  assertValidObject(declaration);
  assertValidCallers(declaration);
  assertValidProbe(declaration);
  if (declaration.privileges.length === 0) {
    throw new Error(
      `registry: call site ${declaration.site} declared an empty privileges list on ${declaration.object} — ` +
        "a statement that needs no privilege is a statement that does not touch the object it named (spec §7.1).",
    );
  }

  const frozen = freezeDeclaration(declaration);
  const existing = bySite.get(frozen.site);
  if (existing) {
    if (!sameDeclaration(existing.declaration, frozen)) {
      throw new Error(
        `registry: site id ${frozen.site} is already registered with a different declaration ` +
          `(${describe(existing.declaration)} vs ${describe(frozen)}) — duplicate ids make a check-2 failure ` +
          "unattributable (spec §7.1).",
      );
    }
    return existing;
  }

  const query: RegisteredQuery = {
    declaration: frozen,
    run<T = unknown>(db: RegistryDb, strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<T[]> {
      // postgres.js's tagged template, called with the caller's own strings and
      // values, so a registered site costs nothing but the declaration. The
      // handle is never exposed back to the call site.
      return (db as unknown as (s: TemplateStringsArray, ...v: readonly unknown[]) => Promise<T[]>)(
        strings,
        ...values,
      );
    },
  };

  bySite.set(frozen.site, query);
  order.push(frozen);
  return query;
}

/**
 * A registered site as a tag, so a statement reads as SQL rather than as a call:
 *
 *   const rows = await on(sql, readConfig)<{ mode: string }>`SELECT mode FROM swarm_judge_config`;
 *
 * Inputs: the handle to run on (the pool or a transaction), the registered
 * site, and — for a statement that touches more than one relation — the
 * declarations for the others. Output: a tagged template that forwards to
 * `query.run`. `T` is the ROW type, not the row-array type a bare postgres.js
 * tag takes.
 *
 * A JOIN IS SEVERAL DECLARATIONS. `QueryDeclaration.object` is one relation,
 * because check 2 tests privileges per relation, so a statement reading
 * `agent_activity_log` joined to `openclaw_agents` needs a declaration for
 * each. The statement runs through the first; the rest are named here so the
 * call site shows every relation it is covered for:
 *
 *   on(sql, activityRows, activityAgents)<Row>`SELECT ... FROM agent_activity_log LEFT JOIN openclaw_agents ...`
 *
 * ONE STATEMENT, SEVERAL ROLES, is the same shape. A declaration's `role` is
 * the role of the program that issues the statement, so a statement reached
 * from programs that connect as different roles (the api on `rm_app`, an
 * operator CLI on `rm_owner`, a worker handler on `rm_worker`) declares once
 * per role and names the others here. The runner does not know which role the
 * handle holds; check 2 needs every role's requirement recorded.
 *
 * WHY IT LIVES HERE. The structural lint (tests/db-registry.test.ts) treats
 * every tagged template outside the db layer as a raw statement unless its tag
 * is a call of THIS function, imported from this module. That is what lets the
 * lint match on the permitted shape instead of on a list of handle names: a
 * handle can be called anything (`sql`, `tx`, `h`, `handle`), but the one way
 * to issue a statement without declaring it is to tag a template with
 * something other than `on(...)`.
 */
export function on(db: RegistryDb, query: RegisteredQuery, ...joined: readonly RegisteredQuery[]) {
  // IDENTITY, NOT A SITE NAME. The structural lint accepts any tag that is a
  // call of this function, so this function is the only thing standing between
  // `on(...)` and an undeclared statement. A caller can hand it an object
  // literal shaped like a RegisteredQuery — `{ declaration: { site: 'x' }, run }`
  // — whose `run` issues whatever it likes. Checking that the site id is known
  // would not stop that either: a forgery can copy a real site id and still
  // carry its own `run` or a different object. So every query handed in, the
  // primary one included, must be the exact runner `registerQuery` returned for
  // that site, or nothing runs.
  for (const candidate of [query, ...joined]) assertRegistered(candidate, query);
  return <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<T[]> =>
    query.run<T>(db, strings, ...values);
}

/** Refuse anything but the runner `registerQuery` handed back for its site. */
function assertRegistered(candidate: RegisteredQuery, primary: RegisteredQuery): void {
  const site = (candidate as Partial<RegisteredQuery> | undefined)?.declaration?.site;
  if (typeof site === "string" && bySite.get(site) === candidate) return;
  const named = (primary as Partial<RegisteredQuery> | undefined)?.declaration?.site;
  throw new Error(
    `registry: on() was handed an unregistered site (${JSON.stringify(site)}) for ${JSON.stringify(named)} — ` +
      "only the runner registerQuery returned may issue a statement (spec §7.1).",
  );
}

/** An unqualified relation name exactly as `pg_class.relname` spells it: no
 *  schema qualifier, no quoting, no whitespace. Check 2 resolves the name
 *  through `to_regclass` in `public`, where anything else silently resolves
 *  elsewhere or not at all. */
const UNQUALIFIED_RELATION = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function assertValidObject(declaration: QueryDeclaration): void {
  if (UNQUALIFIED_RELATION.test(declaration.object)) return;
  throw new Error(
    `registry: call site ${declaration.site} declared object ${JSON.stringify(declaration.object)} ` +
      `(${declaration.object}) — an object must be an unqualified relation name in \`public\`, with no schema ` +
      "qualifier, quoting or whitespace (spec §7.1).",
  );
}

/** A module id relative to `backend/`, no extension: `src/api/routes/swarm-admin`, or an
 *  operator CLI under `scripts/`, which is an entry module in its own right. */
const MODULE_ID = /^(?:src|scripts)\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/;

function assertValidCallers(declaration: QueryDeclaration): void {
  const callers = declaration.callers as readonly unknown[] | undefined;
  if (!Array.isArray(callers) || callers.length === 0) {
    throw new Error(
      `registry: call site ${declaration.site} declared no callers — a declaration must name the entry ` +
        "module(s) through which its statement is reached, or it says nothing about who may issue it.",
    );
  }
  for (const caller of callers) {
    if (typeof caller !== "string" || !MODULE_ID.test(caller)) {
      throw new Error(
        `registry: call site ${declaration.site} declared caller ${JSON.stringify(caller)} — a caller is a module ` +
          "id under `src/` or `scripts/`, relative to `backend/` and without an extension (e.g. `src/api/routes/swarm-admin`).",
      );
    }
  }
  if (new Set(callers).size !== callers.length) {
    throw new Error(`registry: call site ${declaration.site} declared the same caller twice.`);
  }
}

/** The statements a probe may be: DML (TRUNCATE included, which Postgres rolls
 *  back like any other), because the execution test wraps it in a transaction
 *  of its own and rolls that back. A probe that opened, ended or re-roled the
 *  transaction would escape the rollback or run as somebody other than the
 *  declared role. */
const PROBE_STATEMENT = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE|WITH)\b/i;
const PROBE_PARAM_TYPES = new Set(["string", "number", "boolean"]);

function assertValidProbe(declaration: QueryDeclaration): void {
  const probe = declaration.probe as Partial<QueryProbe> | undefined;
  if (probe === undefined) return;
  const refuse = (why: string): never => {
    throw new Error(`registry: call site ${declaration.site} declared an unusable probe — ${why} (spec §7.1).`);
  };
  const statement = probe.statement;
  if (typeof statement !== "string" || !PROBE_STATEMENT.test(statement)) {
    refuse("a probe is one SELECT, INSERT, UPDATE, DELETE, TRUNCATE or WITH statement");
  }
  const text = statement as string;
  if (text.includes(";")) refuse("a probe is ONE statement with no semicolon");
  if (!new RegExp(`\\b${declaration.object.replace(/\$/g, "\\$")}\\b`, "i").test(text)) {
    refuse(`its statement never names the declared object ${declaration.object}`);
  }
  const params = probe.params ?? [];
  if (!Array.isArray(params)) refuse("params must be an array");
  for (const value of params) {
    if (value !== null && !PROBE_PARAM_TYPES.has(typeof value)) {
      refuse(`param ${JSON.stringify(value)} is not a string, number, boolean or null`);
    }
  }
  const highest = Math.max(0, ...[...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  if (highest !== params.length) {
    refuse(`its statement uses ${highest} placeholder(s) but supplies ${params.length} param(s)`);
  }
}

function freezeDeclaration(declaration: QueryDeclaration): QueryDeclaration {
  const frozen: QueryDeclaration = {
    role: declaration.role,
    object: declaration.object,
    privileges: Object.freeze([...declaration.privileges]),
    site: declaration.site,
    purpose: declaration.purpose,
    callers: Object.freeze([...declaration.callers]),
    ...(declaration.probe
      ? {
          probe: Object.freeze({
            statement: declaration.probe.statement,
            params: Object.freeze([...(declaration.probe.params ?? [])]),
          }),
        }
      : {}),
  };
  return Object.freeze(frozen);
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((entry, index) => entry === b[index]);

function sameDeclaration(a: QueryDeclaration, b: QueryDeclaration): boolean {
  return (
    a.role === b.role &&
    a.object === b.object &&
    a.site === b.site &&
    a.purpose === b.purpose &&
    sameList(a.privileges, b.privileges) &&
    sameList(a.callers, b.callers) &&
    a.probe?.statement === b.probe?.statement &&
    JSON.stringify(a.probe?.params ?? []) === JSON.stringify(b.probe?.params ?? [])
  );
}

function describe(declaration: QueryDeclaration): string {
  return `${declaration.role} ${declaration.privileges.join(",")} ON ${declaration.object}`;
}

/**
 * Every declaration registered in this process, in registration order.
 *
 * This is the accessor the CI lint reads. It returns the declarations, never
 * the runners, so a test cannot accidentally execute a call site while
 * enumerating it.
 *
 * Output: a frozen array. Completeness is bounded by which modules have been
 * imported — see the module header — and the lint test is responsible for
 * importing the three application entry points first.
 *
 * Serves spec §10 W2 "Registry structurally enforced".
 */
export function registeredSites(): readonly QueryDeclaration[] {
  // A frozen COPY: the array the module appends to must not be reachable from a
  // caller, or the evidence check 2 reads could be edited by the code it judges.
  return Object.freeze([...order]);
}

/**
 * Fold `registeredSites()` into the shape preflight check 2 consumes:
 * role → relation → the union of privileges every call site for that role
 * declares on that relation.
 *
 * Output: nested read-only maps. Empty inner sets are impossible (see
 * `registerQuery`'s empty-privileges refusal), so a relation present in the map
 * always carries at least one privilege to test.
 *
 * This is the "required" half of check 2 only. The denylist half is a fixed set
 * of conditions (spec §7 check 2) and does not come from here — nothing a call
 * site declares can ever add to or subtract from the denylist.
 *
 * Serves spec §10 W2 "Denylist: runtime role with `rm_owner` membership, object
 * ownership, or DELETE on an append-only table fails preflight" by supplying
 * the required-privileges side that failure is reported against.
 */
export function requiredPrivileges(): ReadonlyMap<RmRole, ReadonlyMap<string, ReadonlySet<TablePrivilege>>> {
  const byRole = new Map<RmRole, Map<string, Set<TablePrivilege>>>();
  for (const declaration of order) {
    let byObject = byRole.get(declaration.role);
    if (!byObject) {
      byObject = new Map<string, Set<TablePrivilege>>();
      byRole.set(declaration.role, byObject);
    }
    let privileges = byObject.get(declaration.object);
    if (!privileges) {
      privileges = new Set<TablePrivilege>();
      byObject.set(declaration.object, privileges);
    }
    // A UNION, never last-writer-wins: the site that only reads and the site
    // that writes are both real requirements on the same relation.
    for (const privilege of declaration.privileges) privileges.add(privilege);
  }
  return byRole;
}
