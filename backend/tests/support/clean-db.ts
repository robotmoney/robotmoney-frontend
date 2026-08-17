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
// TEARDOWN drops the clone as soon as nothing is pointing at it any more, and
// restores the shared pool. Both halves matter, for different reasons:
//
//  - Restoring the pool is correctness: a file that does NOT opt in must still
//    see the shared database it has always seen.
//  - Dropping is CAPACITY. An earlier version of this file argued dropping was
//    pointless because preload.ts's afterAll `docker rm -f`s the container.
//    That is true about cleanup and wrong about PEAK: the clones are never
//    released until the container dies, so the run's disk high-water mark is
//    the SUM of every clone it ever made. Measured at 174 databases / ~2.0 GB
//    for one suite run, growing linearly with every test added to a
//    useCleanDatabasePerTest file. A runner that hits a full disk gets a
//    Postgres PANIC mid-suite, attributed to whichever test was unlucky.
//    Dropping keeps at most one clone alive at a time. It is cheap because the
//    container runs with fsync=off (preload.ts): DROP DATABASE ... WITH (FORCE)
//    measures 5-30ms here, against the ~10s once observed under fsync.
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

// The clone both pools are currently pointing at, so the next swap can release
// it. Module-global because `bun test` runs every file in one process, one file
// at a time — at most one clone is ever live.
let live: string | null = null;

// A throwaway maintenance connection: CREATE/DROP DATABASE cannot run on the
// shared pool's own database, and must not run through it either.
function adminConnection() {
  return postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
}

async function drop(admin: ReturnType<typeof adminConnection>, database: string): Promise<void> {
  // WITH (FORCE) rather than a bare DROP: a handle that outlived its file (a
  // worker loop, a client built at call time) would otherwise hold the database
  // open and turn cleanup into a hard failure. Terminating it is the correct
  // outcome — the file that started it was supposed to stop it — and it is also
  // the faster form (5ms vs 30ms measured).
  await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
}

// The invariant the whole harness rests on. `cloneAndUse` moves two independent
// pools in sequence, with no transaction around the pair: if the first swap
// throws, the API side and the queue side are left in DIFFERENT databases and
// nothing downstream notices — the failure shape is a FALSE GREEN, because
// "the worker left nothing behind" assertions (worker-shutdown.test.ts,
// worker-lease.test.ts) pass trivially against a database the worker never
// wrote to. Ask both handles where they actually are.
async function assertBothPoolsAgree(expected: string): Promise<void> {
  const [api] = (await client.sql`SELECT current_database() AS db`) as unknown as { db: string }[];
  const [queue] = (await workerClient.sql`SELECT current_database() AS db`) as unknown as { db: string }[];
  if (api.db !== expected || queue.db !== expected) {
    throw new Error(
      `tests/support/clean-db.ts: pools disagree — api=${api.db} queue=${queue.db}, expected ${expected}. ` +
        "Every assertion in this file would be running against the wrong database.",
    );
  }
}

async function cloneAndUse(testFile: string): Promise<void> {
  const database = databaseName(testFile);
  const previous = live;
  const admin = adminConnection();
  try {
    // Nothing may be connected to the template during the copy. Only preload.ts
    // ever connects to it, and it disconnected before handing the template over.
    await admin.unsafe(`CREATE DATABASE "${database}" TEMPLATE "${template}"`);
    await client.setDatabase(urlFor(database));
    await workerClient.setDatabase(urlFor(database));
    live = database;
    await assertBothPoolsAgree(database);
    // Only now is the previous clone genuinely idle: both pools have just been
    // rebuilt against the new one, and setDatabase() ended the old pools.
    if (previous) await drop(admin, previous);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function restoreSharedDatabase(): Promise<void> {
  const previous = live;
  live = null;
  await client.setDatabase(baseUrl);
  await workerClient.setDatabase(baseUrl);
  if (!previous) return;
  const admin = adminConnection();
  try {
    await drop(admin, previous);
  } finally {
    await admin.end({ timeout: 5 });
  }
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
 * Measured at ~30ms per clone plus ~5ms to release the previous one on this
 * schema (a template copy is a file-level copy, not a re-migration), so a
 * 15-test file pays well under a second. Prefer
 * useCleanDatabase() anyway: reach for this only when a per-file database
 * genuinely is not enough. A file using this must not do database setup in its
 * own `beforeAll` — the next clone would discard it.
 */
export function useCleanDatabasePerTest(testFile: string): void {
  beforeEach(() => cloneAndUse(testFile));
  afterAll(restoreSharedDatabase);
}
