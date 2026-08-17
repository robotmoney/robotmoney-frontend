// Give a test file a clean database of its own, instead of cleaning a shared one.
//
// WHY. `bun test` runs every backend test file in ONE process sharing one
// module cache, and src/db/client.ts builds its pool at import time. So all
// ~129 files used to share one pool against the one database tests/preload.ts
// migrated — a dirty-database-reuse harness, in which the only isolation a
// fixture could get was to DELETE or TRUNCATE what the previous file left
// behind. Migration 0032 refuses exactly that on the append-only historical
// tables, and it is right to: a fixture that can erase `swarm_members` is the
// same statement a hand-run psql would use at 3am. The fixtures were never the
// real problem — sharing the database was.
//
// HOW. preload.ts snapshots the migrated schema into a TEMPLATE database once.
// `CREATE DATABASE x TEMPLATE y` is a file-level copy of an already-built
// database, so a file gets its own clean, fully-migrated, fully-seeded database
// in tens of milliseconds rather than re-running 32 migrations.
//
// GRANULARITY is per FILE, not per test: a CREATE DATABASE per test would
// dominate the suite's runtime. Within a file, unique ids remain the right tool.
//
// Teardown is deliberately just "point the pool back at the shared database":
// preload.ts's afterAll `docker rm -f`s the whole container, so dropping the
// per-file databases would be work with no observable effect. Restoring the
// pool is not optional though — a file that does NOT opt in must still see the
// shared database it has always seen.
import { afterAll, beforeAll, beforeEach } from "bun:test";
// Both long-lived pools have to move together, or the API side and the queue
// side of a test end up in different databases. Held as namespaces, not
// destructured: `sql` is a live binding that setDatabase() reassigns, and
// destructuring freezes the view at the old pool.
import * as client from "../../src/db/client.ts";
import * as workerClient from "../../src/db/worker-client.ts";
import postgres from "postgres";

// Captured at import, before any file has swapped the pool.
const baseUrl = required("DATABASE_URL");
const template = required("RM_TEST_TEMPLATE_DB");

function required(key: string): string {
  const value = process.env[key];
  // Loud, never a silent skip: without preload.ts having run there is no
  // ephemeral Postgres, and a test file that asked for a clean database must
  // fail rather than quietly share whatever pool happens to exist.
  if (!value) throw new Error(`tests/support/clean-db.ts requires ${key} (set by tests/preload.ts)`);
  return value;
}

function urlFor(database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

// A valid, attributable Postgres identifier: lowercase, ≤63 bytes, no dots or
// dashes. The counter keeps two files with the same basename (tests/foo.test.ts
// and tests/api/foo.test.ts) from colliding.
let created = 0;
function databaseName(testFile: string): string {
  const slug = testFile
    .replace(/\.test\.ts$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 45);
  return `rmt_${slug}_${++created}`;
}

async function cloneAndUse(testFile: string): Promise<void> {
  const database = databaseName(testFile);
  // A throwaway maintenance connection: CREATE DATABASE cannot run on the
  // shared pool's own database, and must not run through it either.
  const admin = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  try {
    // Nothing may be connected to the template during the copy. Only preload.ts
    // ever connects to it, and it disconnected before handing the template over.
    await admin.unsafe(`CREATE DATABASE "${database}" TEMPLATE "${template}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  await client.setDatabase(urlFor(database));
  await workerClient.setDatabase(urlFor(database));
}

async function restoreSharedDatabase(): Promise<void> {
  await client.setDatabase(baseUrl);
  await workerClient.setDatabase(baseUrl);
}

/**
 * Run this file's tests against a database of its own, cloned from the migrated
 * template. Call at the top level of a test file:
 *
 *     useCleanDatabase(import.meta.file);
 *
 * The argument is only used to name the database, so a leaked or wedged one is
 * attributable to the file that made it.
 */
export function useCleanDatabase(testFile: string): void {
  beforeAll(() => cloneAndUse(testFile));
  afterAll(restoreSharedDatabase);
}

/**
 * The same, per TEST rather than per file — for a file whose tests reset shared
 * rows between themselves, not just between files. The roster-cap suites are
 * the archetype: `countActiveMembers()` is global, so members seated by test 3
 * make test 4's admission a spurious 409, and no amount of unique ids fixes
 * that.
 *
 * Measured at ~30ms per clone on this schema (a template copy is a file-level
 * copy, not a re-migration), so a 15-test file pays well under a second. Prefer
 * useCleanDatabase() anyway: reach for this only when a per-file database
 * genuinely is not enough. A file using this must not do database setup in its
 * own `beforeAll` — the next clone would discard it.
 */
export function useCleanDatabasePerTest(testFile: string): void {
  beforeEach(() => cloneAndUse(testFile));
  afterAll(restoreSharedDatabase);
}
