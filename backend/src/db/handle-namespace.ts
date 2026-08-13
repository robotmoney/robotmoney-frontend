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
import type postgresTypes from "postgres";
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
    (r) => `member '${r.holder}' has handle '${r.handle}', which is member '${r.shadowed}'s id`,
  );
}

/**
 * The operator-facing refusal block, shared by every caller so all three say the
 * same thing. The caller supplies its own log prefix and appends its own closing
 * line (what it did NOT do), because that part differs: the preflight has
 * written nothing, the api is serving nothing.
 */
export function handleNamespaceRefusalLines(conflicts: readonly string[], prefix: string): string[] {
  return [
    `${prefix} REFUSING the boot: ${conflicts.length} swarm_members row(s) violate the handle/id namespace invariant.`,
    `${prefix} One member's handle is another member's id, so /swarm/members/<that name> addresses two members:`,
    ...conflicts.map((c) => `${prefix}   ${c}`),
    `${prefix} Migration 0031 refuses to INSTALL over this, but it is already recorded in`,
    `${prefix} schema_migrations here, so restored data reached this database unchecked.`,
    `${prefix} Change one of the two public names (UPDATE swarm_members SET handle = ...) and re-boot.`,
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

/**
 * Run the re-check, waiting out a database that is not accepting connections
 * yet.
 *
 * The wait exists because of a REAL race, not defensiveness: compose gates the
 * api on `postgres: condition: service_healthy`, and that healthcheck is
 * `pg_isready`, which reports ready during the postgres image's init/temp-server
 * phase — before the server accepts client connections. Without the retry the
 * guard's most common outcome on a cold `docker compose up -d` would be
 * "could not run", i.e. no guard at all. Same race src/db/migrate.ts's
 * waitForDb() exists for.
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
  timeoutMs = 8_000,
): Promise<NamespaceCheck> {
  const start = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      const conflicts = await handleNamespaceConflicts(db);
      return { status: conflicts.length > 0 ? "violation" : "clean", conflicts };
    } catch (err) {
      if (Date.now() - start > timeoutMs) {
        return {
          status: "unavailable",
          conflicts: [],
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      await new Promise((r) => setTimeout(r, Math.min(1000, 100 * attempt)));
    }
  }
}

/**
 * The api's boot guard: refuse to serve a database that holds the pair.
 *
 * Exits the process rather than throwing so the refusal is the LAST thing in
 * the log, with no stack trace between the operator and the two member names.
 * Called before Bun.serve, so a refused boot has bound no port and answered no
 * request.
 *
 * WHAT IT DOES NOT GUARANTEE. If the database stays unqueryable for the whole
 * wait above, the check cannot run and the api boots anyway with a loud error
 * line — the api has always started against an unreachable database (`/health`
 * answers `db: "down"`), and turning a slow database into a crash-loop would be
 * a worse failure than the one this guards. So "the api is up" does not by
 * itself prove the check ran; the log line does.
 */
export async function assertHandleNamespaceClean(db: NamespaceDb = sql): Promise<void> {
  const result = await checkHandleNamespace(db);
  if (result.status === "violation") {
    for (const line of handleNamespaceRefusalLines(result.conflicts, "[api]")) console.error(line);
    console.error(`[api] The api will NOT start: nothing is being served from this database.`);
    process.exit(1);
  }
  if (result.status === "unavailable") {
    console.error(
      `[api] handle/id namespace guard could NOT run — database not queryable: ${result.detail}. ` +
        `Serving anyway (an unreachable database is not a namespace violation), but this boot is UNCHECKED.`,
    );
  }
}
