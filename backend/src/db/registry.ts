// The registered query interface — the ONE place a database statement may be
// issued from, and the reason preflight check 2 can be trusted.
//
// Implemented (issue #1026 W2): registration, enumeration and the fold check 2
// reads are all live, and application modules register their call sites here
// at module level — `src/swarm/judge-config.ts` is the first. Governed by
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
// the second kind, and that test is W2.8's, not this module's.
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
//   1. A lint test greps for tagged-template `sql` usage outside this module
//      and the small set of files allowed to construct a pool. A raw statement
//      anywhere else fails the build. This is what makes the registry complete
//      rather than merely populated.
//   2. `registeredSites()` below enumerates every declaration the process has
//      made, so the same test can assert that each one names a role that
//      exists, an object that exists in the snapshot (§8.1), and a privilege
//      Postgres recognises — and so `requiredPrivileges()` can fold them into
//      the (role → object → privileges) map preflight check 2 compares against
//      `has_table_privilege`.
//
// Enumeration is only as complete as the module graph that has been imported,
// which is why the lint test imports the application entry points (`api`,
// `worker`, `worker-analytics`) before calling `registeredSites()`. A registration
// that happens lazily inside a function body is therefore invisible to CI;
// registrations are module-level by convention and the lint test pins that too.
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

function freezeDeclaration(declaration: QueryDeclaration): QueryDeclaration {
  return Object.freeze({
    role: declaration.role,
    object: declaration.object,
    privileges: Object.freeze([...declaration.privileges]),
    site: declaration.site,
    purpose: declaration.purpose,
    callers: Object.freeze([...declaration.callers]),
  });
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
    sameList(a.callers, b.callers)
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
