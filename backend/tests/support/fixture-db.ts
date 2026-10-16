// The fixture handle: how a test builds and tears down state the code under test
// may not touch.
//
// The shared api pool (`sql` from src/db/client.ts) is the real runtime role,
// `rm_app`, and so is the worker pool (`rm_worker`): neither holds DELETE,
// TRUNCATE, DDL, or a write on the tables only an owner writes (issue #1026 W6 P2,
// smoke-production-spec.md §7.3). A test's fixtures need those, so they go
// through THIS handle: a login (`rm_test_owner`, tests/preload.ts) that is not a
// superuser and acts as the schema owner `rm_owner`, the role that provisions
// the schema in production.
//
//     import { fixtureDb } from "./support/fixture-db.ts";
//     beforeEach(async () => { await fixtureDb`DELETE FROM swarm_stream_events`; });
//     const rows = await sql`SELECT ...`;          // the code under test's view: rm_app
//
// The rule of thumb: what ARRANGES or CLEANS UP the database uses `fixtureDb`;
// what the code under test does, and what an assertion reads through the runtime
// role's eyes, uses `sql`. It is a drop-in for a postgres.js handle (tagged
// template, `.unsafe`, `.begin`, `.json`, `.array`), and it can be handed to any
// function that takes a `db` handle (`{ db: fixtureDb }`).
//
// It FOLLOWS THE POOL. tests/support/clean-db.ts moves the api pool to a per-file
// clone with `client.setDatabase()`, which rewrites `process.env.DATABASE_URL`;
// this handle reads that on every use and reconnects to the same database, so it
// is always on the database the file's api pool is on.
import postgres from "postgres";
import { harnessUrl } from "./cluster.ts";

let pool: postgres.Sql<{}> | null = null;
let poolDatabase: string | null = null;

function currentDatabase(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("tests/support/fixture-db.ts requires DATABASE_URL (set by tests/preload.ts)");
  return new URL(value).pathname.replace(/^\//, "");
}

function current(): postgres.Sql<{}> {
  const database = currentDatabase();
  if (pool && poolDatabase === database) return pool;
  // The database moved: release the old connections in the background. A
  // clone the previous file used is dropped WITH (FORCE), which would terminate
  // them anyway; ending politely first keeps that from being an error here.
  const previous = pool;
  if (previous) void previous.end({ timeout: 1 }).catch(() => {});
  pool = postgres(harnessUrl(database), { max: 4, onnotice: () => {} });
  poolDatabase = database;
  return pool;
}

/** Release the connections (a file that wants none left open when it finishes). */
export async function closeFixtureDb(): Promise<void> {
  const previous = pool;
  pool = null;
  poolDatabase = null;
  if (previous) await previous.end({ timeout: 5 });
}

export const fixtureDb: postgres.Sql<{}> = new Proxy(function () {} as unknown as postgres.Sql<{}>, {
  apply: (_target, _this, args) => (current() as unknown as (...a: unknown[]) => unknown)(...args),
  get: (_target, prop) => {
    const handle = current() as unknown as Record<string | symbol, unknown>;
    const value = handle[prop];
    return typeof value === "function" ? value.bind(handle) : value;
  },
});
