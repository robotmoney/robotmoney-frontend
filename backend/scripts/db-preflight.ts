// Classify the target database before the boot's first write: fresh bootstrap,
// or adopted production data.
//
// WHY THIS EXISTS. A `--external-pg` boot points the demo at a real managed
// server, and its migrate one-shot does not only migrate: it seeds job
// schedules, enqueues cold-start sampler jobs, backfills wallet samples and
// writes the allocation framework. This step runs BEFORE any of that and states
// which of the two legitimate situations the boot is in:
//
//   EMPTY     — a genuinely fresh database (no BASE TABLEs in `public`, checked
//               before the migrate step that would create them). The boot
//               bootstraps it: migrate, seed, archive restore.
//   POPULATED — a working production database. It got that way either through
//               a manual restore (pg_restore of a .dump) or because a local
//               postgres container kept its prior volume. An ARCHIVE
//               (production-shaped) boot ADOPTS it: the same migrate + seed
//               path runs, and every writer on that path is idempotent and
//               deduplicated — it fills in what is missing (new migrations,
//               missing schedule rows, absent archive rows) and never
//               overwrites rows that already exist. Where an existing row
//               differs from what the seed would have written, the existing
//               row WINS and the difference is reported as drift, not an
//               error (see v0-seed-bootstrap.ts).
//
// This used to refuse the POPULATED case outright, on the assumption that a
// populated remote could only mean a mistakenly-targeted production server.
// Now that the remote IS production — populated deliberately, by restore — the
// refusal would refuse every ordinary boot. What made the refusal necessary was
// that the seed path clobbered; the guard against clobbering now lives in the
// writers themselves (ON CONFLICT DO NOTHING, insert-or-report-drift), where it
// also protects the resumed-volume case the old refusal never covered.
//
// THE REFUSAL THAT REMAINS. A SIMULATION boot (plain `bun demo`) against a
// populated database is still refused: its demo fixtures overwrite by design
// (ON CONFLICT DO UPDATE is how corrected demo copy reaches a demo stack), so
// "idempotent and deduplicated" does not hold on that path. The initializer
// arrives as --initializer=archive|simulation; when the flag is missing we
// assume simulation, so the strict branch is the one a forgotten parameter
// lands in — the same fail-closed shape session.ts uses for the same reason.
//
// WHAT ELSE THIS STEP HAS TO ANSWER. Adopting a restored database means
// trusting data no migration in this repo wrote. Migration 0031 refuses to
// INSTALL over a swarm_members pair that violates the handle/id namespace
// invariant, but that DO block runs exactly once: a dump taken from a
// post-0031 database already carries `0031_swarm_member_handle_namespace.sql`
// in `schema_migrations`, so src/db/migrate.ts skips the file and nothing
// re-validates. A plain pg_dump also emits CREATE TRIGGER in the post-data
// section, so the COPY that loads the rows runs before the trigger exists.
// Restored data is therefore the one population path 0031's trigger cannot
// stand in front of, and the re-check below is what catches it. See #597.
//
// WHERE THAT RE-CHECK ACTUALLY RUNS — not only here. This file used to claim
// the detection query ran "HERE, on every boot". It did not: this script is a
// step of the `--external-pg` demo boot (scripts/lib/demo-external-pg.ts) and
// nothing else invoked it, so on the documented production bring-up
// (`docker compose up -d`, which runs neither migrate nor this script) a
// restored violation reached serving traffic unchecked. That was issue #602.
// The query now lives in src/db/handle-namespace.ts and has three callers:
//   - this script, before an `--external-pg` boot's first write;
//   - src/api/index.ts, before Bun.serve binds a port;
//   - scripts/prod-bootstrap.ts, as its first step, before migrate().
// The api guard is the one that covers the compose path, and it is deliberately
// not absolute: a database that stays unqueryable through its wait is logged
// loudly and served anyway, it is a boot-time snapshot rather than a standing
// guarantee, and it can be overridden (all three stated in full at
// assertHandleNamespaceClean). "The api is up" therefore does not by itself
// prove the check ran — its log line and /health's `handle_namespace` do.
//
// Read-only by construction: it issues SELECTs against the catalog and against
// swarm_members, and nothing else. Exit 0 = classified (either mode); non-zero
// when the database cannot be reached or queried at all, when a simulation boot
// meets a populated database, or when the adopted data violates an invariant
// the schema is supposed to guarantee.
//
// Usage: DATABASE_URL=... bun run scripts/db-preflight.ts
import { sql, closeDb } from "../src/db/client.ts";
import {
  handleNamespaceConflicts,
  handleNamespaceRefusalLines,
  type NamespaceDb,
} from "../src/db/handle-namespace.ts";

export { handleNamespaceConflicts };

/** The subset of postgres.js's client classifyDatabase/censusSample/
 *  handleNamespaceConflicts need — narrow enough that a test can pass a
 *  throwaway-database connection instead of the process-wide singleton, so the
 *  EMPTY branch is exercised for real (see backend/tests/db-preflight.test.ts)
 *  without perturbing the shared, already-migrated suite database every other
 *  test runs against. A TRANSACTION is accepted for the same reason: the
 *  restored-violation case is built and rolled back inside one, so the suite
 *  database never actually holds a pair the schema forbids. Every function here
 *  issues plain tagged-template queries and nothing else, which is all a
 *  transaction handle offers. */
export type PreflightDb = NamespaceDb;

/** Password-redacted target, the only form safe to print. */
function redactedTarget(raw: string | undefined): string {
  if (!raw) return "(DATABASE_URL unset)";
  try {
    const u = new URL(raw);
    if (u.password) u.password = "***";
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

export interface TableCensus {
  table: string;
  rows: number;
}

export type BootInitializer = "archive" | "simulation";

export interface PreflightResult {
  mode: "bootstrap" | "adopt" | "refuse";
  tables: number;
  census: TableCensus[];
  /** Violations of the handle/id namespace invariant found in the data being
   *  adopted, one operator-readable sentence each. Empty on a clean database
   *  and on one whose schema predates the `handle` column. */
  handleNamespaceConflicts: string[];
}

/** Parse --initializer=… out of argv. Missing or unrecognised ⇒ simulation —
 *  fail-closed, so only an explicit archive boot can adopt a populated DB. */
export function parseInitializer(argv: readonly string[]): BootInitializer {
  for (const a of argv) {
    if (a === "--initializer=archive") return "archive";
  }
  return "simulation";
}

/** The biggest tables by live-row estimate — enough to recognise WHAT this is. */
async function censusSample(db: PreflightDb, limit = 8): Promise<TableCensus[]> {
  const rows = (await db`
    SELECT relname AS table, n_live_tup AS rows
    FROM pg_stat_user_tables
    WHERE schemaname = 'public'
    ORDER BY n_live_tup DESC, relname ASC
    LIMIT ${limit}
  `) as unknown as { table: string; rows: number }[];
  return rows.map((r) => ({ table: r.table, rows: Number(r.rows) }));
}

/** Classify the database. Throws only when it cannot be queried at all.
 *  `db` defaults to the process-wide pool; a test may pass a throwaway
 *  connection to exercise the EMPTY branch without touching shared state. */
export async function classifyDatabase(initializer: BootInitializer, db: PreflightDb = sql): Promise<PreflightResult> {
  const [{ count }] = (await db`
    SELECT count(*)::int AS count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `) as unknown as { count: number }[];
  if (count === 0) return { mode: "bootstrap", tables: 0, census: [], handleNamespaceConflicts: [] };
  return {
    mode: initializer === "archive" ? "adopt" : "refuse",
    tables: count,
    census: await censusSample(db),
    handleNamespaceConflicts: await handleNamespaceConflicts(db),
  };
}

/**
 * The operator-facing report, as lines. Pure so the exact wording is
 * executable by tests — this text is what lands in the boot log, and it is the
 * one place that says whether existing data is at risk (it is not).
 */
export function reportLines(target: string, r: PreflightResult): string[] {
  if (r.mode === "bootstrap") {
    return [`[db-preflight] ${target}: empty (no tables in public) — bootstrapping (migrate + seed + archive restore)`];
  }
  const lines =
    r.mode === "adopt"
      ? [
          `[db-preflight] ${target}: populated (${r.tables} table(s) in public) — adopting as existing production data.`,
          `[db-preflight] The same migrate + seed path runs, and it is idempotent and deduplicated:`,
          `[db-preflight] it fills in what is missing and never overwrites existing rows — on any`,
          `[db-preflight] difference the existing row wins and is reported as drift.`,
        ]
      : [
          `[db-preflight] REFUSING a simulation boot: ${target} already has ${r.tables} table(s) in public.`,
          `[db-preflight] Demo/simulation fixtures overwrite by design, so a populated database`,
          `[db-preflight] can only be adopted by a production-shaped (archive) boot: bun smoke.`,
          `[db-preflight] Nothing has been written.`,
        ];
  const populated = r.census.filter((s) => s.rows > 0);
  if (populated.length > 0) {
    lines.push(`[db-preflight] largest tables by row estimate:`);
    for (const s of populated) lines.push(`[db-preflight]   ${s.table} ~${s.rows} rows`);
  } else {
    lines.push(`[db-preflight] all ${r.tables} table(s) are empty — schema present, no rows.`);
  }
  // LAST, and it is a block: demo-failure.ts anchors on the first refusal line
  // and reads FORWARD, so the header has to precede the pairs it names.
  if (r.handleNamespaceConflicts.length > 0) {
    // Shared with the api and prod-bootstrap guards (src/db/handle-namespace.ts)
    // so all three refusals read identically; only the closing line, which says
    // what THIS caller did not do, is local.
    lines.push(...handleNamespaceRefusalLines(r.handleNamespaceConflicts, "[db-preflight]"));
    lines.push(`[db-preflight] Nothing has been written.`);
  }
  return lines;
}

export async function main(): Promise<void> {
  const target = redactedTarget(process.env.DATABASE_URL);
  const result = await classifyDatabase(parseInitializer(process.argv.slice(2)));
  // An adopted database that already violates the invariant is refused too: the
  // boot's next step is migrate + seed, and every writer past this point would
  // be writing on top of a public reference that addresses two members.
  const refused = result.mode === "refuse" || result.handleNamespaceConflicts.length > 0;
  const emit = refused ? console.error : console.log;
  for (const line of reportLines(target, result)) emit(line);
  if (refused) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(closeDb)
    .catch((err) => {
      console.error(`[db-preflight] check failed: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
      return closeDb();
    });
}
