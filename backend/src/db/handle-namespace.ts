// The handle/id namespace invariant's DETECTION half, in one place, plus the
// boot guards that run it.
//
// THE INVARIANT. A handle is a public URL segment, and /swarm/members/:ref
// resolves both handles and ids — so one member's handle must never be another
// member's id, or that one URL addresses two members. Migration 0031 installs a
// BEFORE INSERT OR UPDATE trigger (`ENABLE ALWAYS`, so even a
// `session_replication_role = replica` write is refused) that keeps any WRITE
// from creating the pair.
//
// WHY DETECTION STILL HAS TO EXIST. A trigger only sees rows written after it
// exists. Two population paths get in behind it:
//   - a `pg_dump`/`pg_restore` emits CREATE TRIGGER in the post-data section,
//     so the COPY that loads the rows runs before the trigger exists;
//   - a dump taken from a post-0031 database already carries
//     `0031_swarm_member_handle_namespace.sql` in `schema_migrations`, so
//     src/db/migrate.ts skips the file and 0031's own install-time DO block —
//     the only thing that inspects data already present — never re-runs.
// Restored data is therefore the one population path the schema cannot stand in
// front of, and a boot-time re-check is the only thing that catches it.
//
// WHY IT LIVES HERE. It used to live in backend/scripts/db-preflight.ts, which
// is invoked from exactly one place: the `--external-pg` demo boot
// (scripts/lib/demo-external-pg.ts). Nothing in backend/src/** called it, so the
// documented production bring-up — `docker compose up -d`, whose api service
// runs `bun run src/api/index.ts` and neither migrates nor preflights — reached
// serving traffic with a restored violation completely unchecked (issue #602).
// Putting the query in src/db/ is what lets the api entrypoint call it.
//
// CALLERS (all three, so a future reader can check this list against `grep`):
//   - backend/src/api/index.ts — assertHandleNamespaceClean(), before
//     Bun.serve binds a port. This is the `docker compose up -d` path.
//   - backend/scripts/prod-bootstrap.ts — its first step, before migrate().
//   - backend/scripts/db-preflight.ts — the `--external-pg` demo boot.
import postgres from "postgres";
import type postgresTypes from "postgres";
import { config } from "../config.ts";
import { sql } from "./client.ts";

/** The subset of postgres.js's client these functions need. A TRANSACTION is
 *  accepted too, so a test can build a forbidden pair and roll it back without
 *  the shared suite database ever holding one. Every function here issues plain
 *  queries and nothing else, which is all a transaction handle offers. */
export type NamespaceDb = postgresTypes.Sql<{}> | postgresTypes.TransactionSql<{}>;

/**
 * The relation that DEFINES a handle/id namespace violation — the single source
 * for the runtime check.
 *
 * It must stay in agreement with migration 0031's install-time DO block
 * (`backend/migrations/0031_swarm_member_handle_namespace.sql`), which cannot
 * import this constant: an applied migration is a frozen artefact and its SQL
 * has to be self-contained. The agreement is therefore held by an executed
 * test, not by prose — `backend/tests/handle-namespace-predicate-parity.test.ts`
 * extracts the migration's relation from the .sql file and asserts it both
 * matches this string textually and returns the same pairs when both are run
 * against the same rows. A narrowing edit to either one turns that test red.
 *
 * It iterates all ordered pairs, so it reports both directions of a mutual
 * collision — the same coverage the trigger's two-clause predicate has.
 */
export const HANDLE_NAMESPACE_CONFLICT_RELATION =
  "FROM swarm_members a JOIN swarm_members b ON b.id = a.handle AND b.id <> a.id";

/**
 * Violations present in the data right now, one operator-readable sentence each.
 *
 * Returns `[]` — not an error — when swarm_members or its `handle` column does
 * not exist yet. That is load-bearing for every caller: this runs on a boot that
 * may be pointed at a brand-new database, or at one whose schema predates 0030,
 * and "the table is not there yet" is a migration's business, not an integrity
 * violation. A guard that refused those would take down an ordinary first boot.
 */
export async function handleNamespaceConflicts(db: NamespaceDb = sql): Promise<string[]> {
  const [{ ready }] = (await db`
    SELECT (
      to_regclass('public.swarm_members') IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'swarm_members' AND column_name = 'handle'
      )
    ) AS ready
  `) as unknown as { ready: boolean }[];
  if (!ready) return [];
  // .unsafe() carries no interpolation: the only non-literal part is the
  // module-level constant above, which is what makes the parity test possible.
  const rows = (await db.unsafe(
    `SELECT a.id AS holder, a.handle AS handle, b.id AS shadowed
     ${HANDLE_NAMESPACE_CONFLICT_RELATION}
     ORDER BY a.id`,
  )) as unknown as { holder: string; handle: string; shadowed: string }[];
  return rows.map(
    (r) =>
      `member '${r.holder}' has handle '${r.handle}', which is member '${r.shadowed}'s id` +
      ` — repair: UPDATE swarm_members SET handle = '<a name nobody else holds>' WHERE id = ${literal(r.holder)};`,
  );
}

/** A single-quoted SQL literal, for a statement an operator PASTES. Ids are
 *  operator-chosen text, so doubling the quote is not optional. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The operator-facing refusal block, shared by every caller so all three say the
 * same thing. The caller supplies its own log prefix and appends its own closing
 * line (what it did NOT do), because that part differs: the preflight has
 * written nothing, the api is serving nothing.
 *
 * THE REPAIR INSTRUCTION IS EXACT, AND IT HAS TO BE. It used to say "change one
 * of the two public names", which is wrong in two ways — both executed against
 * a real Postgres 17 carrying 0031's trigger, not reasoned about:
 *   - Updating the SHADOWED member's handle (`UPDATE ... WHERE id = '<shadowed>'`)
 *     reports `UPDATE 1`, raises no trigger error, and leaves the violation in
 *     place. Only the HOLDER — the member named FIRST in each line, the one
 *     whose handle IS the offending value — is a valid `SET handle` target.
 *   - A mutual collision (A.handle = B.id and B.handle = A.id) prints TWO lines
 *     and needs TWO updates; after the first, one violation remains and the
 *     boot is still refused.
 * So each line above already carries its own ready-to-paste statement, and the
 * closing line says "one per line printed" rather than "one of the two rows".
 * An operator reading this during an outage gets a statement, not a choice.
 */
export function handleNamespaceRefusalLines(conflicts: readonly string[], prefix: string): string[] {
  return [
    `${prefix} REFUSING the boot: ${conflicts.length} swarm_members row(s) violate the handle/id namespace invariant.`,
    `${prefix} One member's handle is another member's id, so /swarm/members/<that name> addresses two members:`,
    ...conflicts.map((c) => `${prefix}   ${c}`),
    `${prefix} Migration 0031 refuses to INSTALL over this, but it is already recorded in`,
    `${prefix} schema_migrations here, so restored data reached this database unchecked.`,
    `${prefix} Run the repair statement printed on EACH line above — one per line, all of them —`,
    `${prefix} and re-boot. Each moves the HOLDER's handle (the member named first on that line);`,
    `${prefix} changing the shadowed member's handle instead succeeds and fixes nothing.`,
  ];
}

export type NamespaceCheckStatus = "clean" | "violation" | "unavailable";

export interface NamespaceCheck {
  status: NamespaceCheckStatus;
  /** Non-empty only when status is "violation". */
  conflicts: string[];
  /** Why the check could not run. Set only when status is "unavailable". */
  detail?: string;
}

/** The env var that overrides the guard's wall-clock budget, in MILLISECONDS. */
export const NAMESPACE_GUARD_BUDGET_ENV = "PG_NAMESPACE_GUARD_TIMEOUT_MS";

/** The budget used when the env var is unset — or set to something this module
 *  refuses to trust. */
export const NAMESPACE_GUARD_DEFAULT_BUDGET_MS = 8_000;

/**
 * Turn the operator's `PG_NAMESPACE_GUARD_TIMEOUT_MS` into a budget the guard
 * can actually be bounded by.
 *
 * WHY THIS IS NOT `Number(env ?? 8_000)`. This value is the ONLY bound standing
 * in front of `Bun.serve`, and `Number("8s")` is `NaN`. Every deadline
 * comparison downstream is then a comparison against `NaN`, which is `false` —
 * so `remaining <= 0` never fires, `Date.now() >= deadline` never fires, and
 * `setTimeout(NaN)` degrades to 1ms: the retry loop spins forever, no port is
 * bound and nothing is logged. That is precisely the silent total outage this
 * guard was written to prevent, reachable through the guard's own knob, and
 * `"8s"` is the literal string the runbook used to print for it. A bad value
 * must degrade to the default, loudly — never to an unbounded boot.
 *
 * It also must not become a NEW way to fail the boot, so this never throws: an
 * unparseable budget is an operator typo, and refusing to start over a typo
 * trades one outage for another.
 *
 * The sibling idiom in src/db/worker-client.ts:28 can stay `Number(...)` because
 * a `NaN` there reaches Postgres as a startup parameter and fails loudly at
 * connect. Here nothing downstream ever notices.
 */
export function parseGuardBudgetMs(
  raw: string | undefined,
  warn: (line: string) => void = (line) => console.error(line),
): number {
  if (raw === undefined || raw.trim() === "") return NAMESPACE_GUARD_DEFAULT_BUDGET_MS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  warn(
    `[api] ${NAMESPACE_GUARD_BUDGET_ENV}=${JSON.stringify(raw)} is not a positive number of ` +
      `MILLISECONDS — IGNORING it and using ${NAMESPACE_GUARD_DEFAULT_BUDGET_MS}ms. Write it as ` +
      `a plain integer count of milliseconds ("8000"), not as a duration ("8s").`,
  );
  return NAMESPACE_GUARD_DEFAULT_BUDGET_MS;
}

/** The api guard's WALL-CLOCK budget: the most time the whole check may add to
 *  the boot, whatever the database does. Overridable per deployment via
 *  PG_NAMESPACE_GUARD_TIMEOUT_MS — validated, see parseGuardBudgetMs. */
export const NAMESPACE_GUARD_BUDGET_MS = parseGuardBudgetMs(
  process.env[NAMESPACE_GUARD_BUDGET_ENV],
);

/** Thrown when the wall-clock budget expires with a query still in flight. It
 *  is a distinct type so the loop can tell "the database said no" (retry, and
 *  report that message) from "the database said nothing" (stop). */
class NamespaceGuardBudgetExpired extends Error {}

/** A promise that rejects after `ms`, plus the cancel that stops its timer from
 *  outliving the attempt it bounds. */
function expireAfter(ms: number): { expiry: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new NamespaceGuardBudgetExpired(`no answer within ${ms}ms`)),
      ms,
    );
  });
  return { expiry, cancel: () => clearTimeout(timer!) };
}

/**
 * A connection for the boot guard ALONE, whose queries the SERVER gives up on.
 *
 * WHY A SEPARATE CLIENT. src/db/client.ts's shared pool sets no
 * `statement_timeout` and no `lock_timeout` (`SHOW statement_timeout` on it is
 * `0`), and postgres.js's `connect_timeout` defaults to 30s. That is fine for
 * a request handler — a slow query answers a slow request — but this one query
 * sits in front of `Bun.serve`, so an unbounded one is an unbounded outage:
 * an ordinary `LOCK TABLE swarm_members IN ACCESS EXCLUSIVE MODE` (a migration
 * replay, a REINDEX, a VACUUM FULL, an ALTER queued behind one
 * idle-in-transaction session) blocks the detection SELECT while the readiness
 * probe above sails through, because catalog reads take no lock on the table.
 * Verified on Postgres 17: the probe returned immediately, the SELECT was still
 * blocked at 12s. The process would then bind no port, log nothing, and never
 * exit — so `restart: unless-stopped` would not restart it, and this process
 * also serves the entire static frontend.
 *
 * The mechanism is the one src/db/worker-client.ts:31-38 already uses for the
 * same class of hazard: server-side timeouts as startup parameters, so every
 * statement on the connection inherits them. `lock_timeout` is added because
 * blocking on a LOCK is the specific shape here, and `connect_timeout` because
 * a black-holed TCP path (a firewall-rule mismatch, a managed-Postgres
 * failover) otherwise hangs 30s before the first rejection ever reaches the
 * retry loop.
 *
 * Each bound is half the wall-clock budget, so a blocked attempt fails with the
 * precise Postgres error ("canceling statement due to lock timeout") in time
 * for one retry, and the budget below is the hard cap regardless.
 */
export function createNamespaceGuardClient(
  budgetMs = NAMESPACE_GUARD_BUDGET_MS,
): postgresTypes.Sql<{}> {
  const perQueryMs = Math.max(1_000, Math.floor(budgetMs / 2));
  return postgres(config.databaseUrl, {
    max: 1,
    onnotice: () => {},
    connect_timeout: Math.max(1, Math.round(perQueryMs / 1000)),
    connection: {
      statement_timeout: perQueryMs,
      lock_timeout: perQueryMs,
    },
  });
}

/**
 * Run the re-check, waiting out a database that is not accepting connections
 * yet — and giving up, in bounded time, on one that accepts them and then says
 * nothing.
 *
 * The wait exists because of a REAL race, not defensiveness: compose gates the
 * api on `postgres: condition: service_healthy`, and that healthcheck is
 * `pg_isready`, which reports ready during the postgres image's init/temp-server
 * phase — before the server accepts client connections. Without the retry the
 * guard's most common outcome on a cold `docker compose up -d` would be
 * "could not run", i.e. no guard at all. Same race src/db/migrate.ts's
 * waitForDb() exists for.
 *
 * `timeoutMs` IS THE WHOLE BUDGET, not a retry budget. Each attempt races the
 * time remaining, so a query that BLOCKS — rather than rejecting — lands in the
 * "unavailable" branch on schedule instead of hanging its caller forever. That
 * distinction is the whole point: the previous version consulted the deadline
 * only inside `catch`, which bounds a database that rejects and bounds nothing
 * at all about one that holds the connection open. createNamespaceGuardClient()
 * above stops the abandoned query at the server too, so a raced-out attempt
 * does not leave work running.
 *
 * The budget is SHORTER than waitForDb's 30s on purpose: this one sits in front
 * of `Bun.serve`, so every second of it is a second the api is not answering.
 * The window being waited out is the postgres image's init phase (seconds), not
 * an outage — an api pointed at a database that is genuinely down should start
 * and report `db: "down"` on /health, which is what it has always done, not
 * hang for half a minute first.
 *
 * "unavailable" is returned rather than thrown: whether an unqueryable database
 * should stop a process is the caller's decision, and the two callers answer it
 * differently.
 */
export async function checkHandleNamespace(
  db: NamespaceDb = sql,
  timeoutMs = NAMESPACE_GUARD_BUDGET_MS,
): Promise<NamespaceCheck> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  /** The last message the DATABASE produced, which is more useful to an
   *  operator than "the budget expired" when both happened. */
  let lastDbError: string | undefined;
  const unavailable = (message: string): NamespaceCheck => ({
    status: "unavailable",
    conflicts: [],
    detail: lastDbError
      ? `${lastDbError} (still failing ${Date.now() - start}ms in, budget ${timeoutMs}ms)`
      : `${message} (budget ${timeoutMs}ms)`,
  });

  for (let attempt = 1; ; attempt++) {
    const remaining = deadline - Date.now();
    // Negated-positive rather than `remaining <= 0`: a NaN budget (a
    // misconfigured PG_NAMESPACE_GUARD_TIMEOUT_MS, or any future caller passing
    // one) makes EVERY ordinary comparison false, and this loop is in front of
    // Bun.serve. parseGuardBudgetMs already rejects such a value; this keeps the
    // loop structurally unable to spin even if something else supplies one.
    if (!(remaining > 0)) return unavailable("budget exhausted before the check could answer");
    const bound = expireAfter(remaining);
    try {
      // Promise.race attaches a handler to BOTH, so an attempt abandoned at the
      // deadline can never surface as an unhandled rejection later.
      const conflicts = await Promise.race([handleNamespaceConflicts(db), bound.expiry]);
      return { status: conflicts.length > 0 ? "violation" : "clean", conflicts };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof NamespaceGuardBudgetExpired)) lastDbError = message;
      // Same negated-positive shape, same reason: `>=` against a NaN deadline is
      // false, which would retry forever instead of giving up.
      if (!(Date.now() < deadline)) return unavailable(message);
      await new Promise((r) => setTimeout(r, Math.min(1000, 100 * attempt)));
    } finally {
      bound.cancel();
    }
  }
}

/** The env var that turns the api's fail-closed refusal into a loud warning.
 *  `RM_ALLOW_*` is the repo's existing shape for a deliberate, operator-set
 *  relaxation of a fail-closed default (RM_ALLOW_INSECURE, config.ts:470). */
export const HANDLE_NAMESPACE_OVERRIDE_ENV = "RM_ALLOW_HANDLE_NAMESPACE_VIOLATION";

/**
 * What the boot guard actually concluded — the thing `/health` reports.
 *
 * "unchecked" is the initial value on purpose: before assertHandleNamespaceClean
 * has returned, nothing has been verified, and a reader of this must never be
 * told "clean" by default. ("violation" is not a value here because that path
 * exits the process — nothing is left to ask.)
 */
export type HandleNamespaceGuardOutcome = "clean" | "unchecked" | "overridden";
let guardOutcome: HandleNamespaceGuardOutcome = "unchecked";

/** The boot guard's outcome, for `/health`. See OBSERVABILITY below. */
export function handleNamespaceGuardOutcome(): HandleNamespaceGuardOutcome {
  return guardOutcome;
}

/**
 * The api's boot guard: refuse to serve a database that holds the pair.
 *
 * Exits the process rather than throwing so the refusal is the LAST thing in
 * the log, with no stack trace between the operator and the two member names.
 * Called before Bun.serve, so a refused boot has bound no port and answered no
 * request.
 *
 * BOUNDED. With no `db` argument it runs on its own short-lived client
 * (createNamespaceGuardClient) whose statement, lock and connect timeouts are
 * set at the server, and the check as a whole is capped at
 * NAMESPACE_GUARD_BUDGET_MS of wall clock. So the worst case this adds to a
 * boot is that budget — 8000ms by default, and the default is what a malformed
 * PG_NAMESPACE_GUARD_TIMEOUT_MS falls back to — for ANY database state: down, slow,
 * black-holed, or holding swarm_members under ACCESS EXCLUSIVE. Asserted, not
 * claimed: tests/api-boot-handle-namespace-guard.test.ts boots the real
 * entrypoint against a locked table and against an unreachable host.
 *
 * OBSERVABILITY. The outcome is readable at `/health`
 * (`handle_namespace: "clean" | "unchecked" | "overridden"`) as well as logged,
 * because a log line is not a detection path: nothing in this deployment
 * scrapes container logs, and the api's json-file buffer rotates. The status
 * CODE is deliberately unchanged — `/health` still answers 200 when the guard
 * could not run, because failing the compose healthcheck on a slow database
 * would trade this outage for a bigger one.
 *
 * WHAT IT DOES NOT GUARANTEE — all of it, because an incomplete list here is
 * the exact defect this issue was filed about:
 *   1. AN UNQUERYABLE DATABASE IS NOT REFUSED. If the database stays
 *      unqueryable (down, still starting, blocked, unreachable) for the whole
 *      budget, the check cannot run and the api boots anyway with a loud error
 *      line and `handle_namespace: "unchecked"` — the api has always started
 *      against an unreachable database (`/health` answers `db: "down"`), and
 *      turning a slow database into a crash-loop would be a worse failure than
 *      the one this guards. So "the api is up" does not by itself prove the
 *      check ran; the log line and the /health field do.
 *   2. IT IS A BOOT-TIME SNAPSHOT, NOT A STANDING GUARANTEE. This runs ONCE, at
 *      module evaluation. There is no periodic re-check and no request-path
 *      re-entry (three call sites, listed at the top of this file, none of
 *      them either). A `pg_restore` into a LIVE database — the very population
 *      path this exists for — does not restart the process, and postgres.js
 *      reconnects transparently, so a violation loaded underneath a running api
 *      is served indefinitely with no refusal and no log line. After any
 *      restore into a running stack, restart the api (`docker compose restart
 *      api`); docs/runbooks/deployment.md says so too.
 *   3. IT CAN BE TURNED OFF. With RM_ALLOW_HANDLE_NAMESPACE_VIOLATION=1 a
 *      violating database serves anyway, loudly (see below).
 */
export async function assertHandleNamespaceClean(db?: NamespaceDb): Promise<void> {
  // A caller that supplies its own handle (tests, and any future in-process
  // caller) keeps it; the boot path gets the bounded client.
  const own = db === undefined ? createNamespaceGuardClient() : undefined;
  try {
    const result = await checkHandleNamespace(own ?? db!);
    if (result.status === "violation") {
      // The pair is printed either way — under an override it is the only
      // record of what is being served wrong.
      for (const line of handleNamespaceRefusalLines(result.conflicts, "[api]")) console.error(line);
      if (process.env[HANDLE_NAMESPACE_OVERRIDE_ENV] === "1") {
        // The escape hatch, for the case this guard is the thing standing
        // between an operator and a running site — e.g. a repair that needs the
        // api up, or a guard that misfires. Loud, never silent, and visible at
        // /health for the whole life of the process, because an override left
        // on by accident is indistinguishable from a healthy boot otherwise.
        console.error(
          `[api] ${HANDLE_NAMESPACE_OVERRIDE_ENV}=1 — OVERRIDE: serving ANYWAY with ` +
            `${result.conflicts.length} violation(s) in place. /swarm/members/<that name> is ` +
            `addressing two members right now, and signed content is being attributed to the ` +
            `wrong member. Repair the rows above and unset ${HANDLE_NAMESPACE_OVERRIDE_ENV}.`,
        );
        guardOutcome = "overridden";
        return;
      }
      console.error(`[api] The api will NOT start: nothing is being served from this database.`);
      console.error(
        `[api] To start anyway (accepting the wrong-member attribution above), set ` +
          `${HANDLE_NAMESPACE_OVERRIDE_ENV}=1 — see docs/runbooks/deployment.md.`,
      );
      process.exit(1);
    }
    if (result.status === "unavailable") {
      console.error(
        `[api] handle/id namespace guard could NOT run — database not queryable: ${result.detail}. ` +
          `Serving anyway (an unreachable database is not a namespace violation), but this boot is UNCHECKED.`,
      );
      guardOutcome = "unchecked";
      return;
    }
    guardOutcome = "clean";
  } finally {
    // Closing must never become the delay the timeouts above just removed: the
    // guard's queries are bounded at the server, so an abandoned one dies there
    // whether or not this wait finishes first.
    if (own) void own.end({ timeout: 0 }).catch(() => {});
  }
}
