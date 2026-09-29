// Test bootstrap: provision an ephemeral Postgres in Docker, point DATABASE_URL
// at it, and apply migrations — ONCE, before any test file imports the db client.
// Fails loudly if Docker/Postgres can't start (never a silent skip).
import net from "node:net";
import { afterAll, beforeAll, beforeEach } from "bun:test";
// The SHARED naming scheme (scripts/stack/naming.ts), reached across the
// workspace boundary on purpose: this is the fourth and only NON-compose
// container spawner in the repo, and a fourth private name shape is exactly
// what made leaked containers unattributable. It is test-only code, never
// bundled into backend/Dockerfile.
import {
  dockerLabelFlags,
  resolveStackEnvironment,
  stackLabels,
  stackProjectName,
} from "../../scripts/stack/naming.ts";
// The SHARED ephemeral-Postgres pin, owned by scripts/lib/ because the rollout
// tooling's digital smoke-twin (scripts/lib/restore-container.ts) needs the identical
// image and this file needs it too. It used to be a private literal here, one
// major behind that smoke-twin and behind production, so every migration was
// validated against a server it would never run on (issue #691). Reached over
// the same backend -> scripts edge as the naming import above — both modules are
// leaves (constants and node builtins, no side effects), which is what keeps
// that edge one-way and cheap.
import { POSTGRES_IMAGE, POSTGRES_MAJOR } from "../../scripts/lib/postgres-image.ts";
import { _resetRateLimitStateForTests } from "../src/chain/gecko-rate-limit.ts";

// SUITE-WIDE: the shared RPC token bucket is OFF unless a test asks for it.
//
// chain/base-rpc-client.ts paces every chain read from a conservative default
// (0.25 calls/s, burst 5) so a production deployment heals its wallet AUM /
// sleeve gaps without configuration — see that file, and decisions.md's PD6
// amendment. That default is correct in production and wrong here: this suite
// drives the REAL transport against a mocked `globalThis.fetch`, the bucket is
// process-global and NOT reset between files, and files routinely make dozens
// of chain reads across their tests. Left on, everything past the first burst
// waits four seconds a call and ~40 assertions blow their 5s timeout — none of
// them measuring rate.
//
// So the suite's baseline is the explicit opt-out, and the limiter's OWN
// behaviour (the default, the burst, the pacing, the 429 feedback) is covered
// where it belongs, by tests/base-rpc-block-addressing.test.ts, which sets its
// own values per test. A test that wants pacing sets the variable; nothing
// silently inherits it.
// Re-applied before EVERY test, not set once: bun runs the suite's files in one
// process, so a single file that deletes the knob in its own afterEach would
// otherwise hand the default to all 150 files after it — which is exactly what
// happened. A file that wants a budget sets one in its own beforeEach, which
// registers later than this one and therefore wins.
beforeEach(() => {
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "0";
});

// SUITE-WIDE: GeckoTerminal request spacing is OFF unless a test asks for it —
// the same shape, and the same reason, as the RPC bucket above.
//
// chain/gecko-rate-limit.ts serializes every GeckoTerminal request behind one
// process-global chain with a 6s minimum spacing (≤10 req/min, the keyless IP
// quota). That spacing wraps the REAL transport, so it sleeps around a mocked
// `globalThis.fetch` too — and the chain and its last-request stamp are shared
// by every file in the run. Left on, the first gecko call anywhere stamps the
// clock and every later call in ANY file waits up to 6s, which is how sixteen
// tests across five unrelated files blew their 5s timeouts at once.
//
// The limiter's own behaviour (spacing, Retry-After, serialization) is covered
// by the files that exercise it, each setting its own interval per test. Their
// beforeEach registers after this one and therefore wins. The state reset also
// unhooks this test from any chain entry a timed-out predecessor abandoned
// mid-sleep.
beforeEach(() => {
  process.env.GECKO_MIN_INTERVAL_MS = "0";
  _resetRateLimitStateForTests();
});

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
  });
}

const port = await freePort();
// Environment-scoped name + labels: `rm_ci_pgtest_<job hash>` under GitHub
// Actions, `rm_smoke_pgtest_<per-boot random>` locally. The host running these
// tests is also the self-hosted CI runner and the stage smoke box, so a
// container left behind by a killed test run has to say which environment made
// it — and the labels are what a reaper selects on (`docker ps --filter
// label=robotmoney.env=ci`), because name-substring matching on this host is
// how you accidentally kill the live site.
const environment = resolveStackEnvironment(process.env);
const name = stackProjectName("pgtest", environment);
// This is a raw `docker run`, NOT compose, so the labels docker-compose.yml
// applies to every other container must be passed explicitly here.
const labelFlags = dockerLabelFlags(stackLabels(environment, name));

// THE CLUSTER'S KINDS OF LOGIN (smoke-production-spec.md §7.3, "CI
// isomorphism"). The container's bootstrap superuser is this harness's
// `doadmin`: it creates the roles and the databases, and it is reached ONLY
// through RM_TEST_ADMIN_URL, by the helpers that create or drop a database
// (tests/support/cluster.ts) and by the tests that must construct a state no
// runtime role can (a superuser role, a role membership, a password change).
// Nothing the application code under test connects with is a superuser:
// WORKER_DATABASE_URL is `rm_worker`, DATABASE_URL is `HARNESS_ROLE`, and the
// schema and the seed are `rm_owner`'s, as `bun smoke --local blank` has them.
const ROLE_PASSWORD = "rm_test_role_password";
const ADMIN_URL = `postgres://robotmoney:robotmoney@localhost:${port}/postgres`;
const roleUrl = (role: string, database = "robotmoney"): string =>
  `postgres://${role}:${ROLE_PASSWORD}@localhost:${port}/${database}`;
// The login of the shared api pool: `rm_test`, NOT a superuser, a member of the
// four roles with `SET ROLE rm_owner` as its session default. It acts as the
// schema owner, which holds the DELETE, TRUNCATE and DDL that ~120 files use to
// build their fixtures and that no runtime role may hold (D55 (6)), and a test
// that must act as a runtime role does `SET ROLE rm_app`. It is a login of its
// own so that a test which changes rm_owner's password or LOGIN attribute (the
// owner-terminal tests) cannot lock the suite's own pool out.
const HARNESS_ROLE = "rm_test";
// The pipeline worker's pool, on the same footing: a login of its own whose
// session role is `rm_worker`, so it holds exactly the worker's privileges (a
// real runtime role: no DELETE, no DDL) and a test that changes rm_worker's
// password cannot lock the pool out.
const WORKER_HARNESS_ROLE = "rm_test_worker";
const baseUrl = roleUrl(HARNESS_ROLE);
// Must be set BEFORE any module reads config.databaseUrl / creates the pool.
process.env.DATABASE_URL = baseUrl;
// db/worker-client.ts requires WORKER_DATABASE_URL in every env and no longer
// falls back to DATABASE_URL (#1026 criterion 120). The pipeline worker's pool
// is the worker's real role; tests/support/clean-db.ts moves the two pools
// together, each on its own login.
process.env.WORKER_DATABASE_URL = roleUrl(WORKER_HARNESS_ROLE);
process.env.RM_TEST_ADMIN_URL = ADMIN_URL;
process.env.RM_TEST_ROLE_PASSWORD = ROLE_PASSWORD;
// The template a test file clones to get a clean database of its own; see
// tests/support/clean-db.ts. Published through the environment because preload
// and the helper are separate modules with no import edge between them.
process.env.RM_TEST_TEMPLATE_DB = "robotmoney_tmpl";
// The MIGRATION-BUILT sibling: the same schema built the way production's was,
// by replaying every migration (step 4 below). For the tests about history.
process.env.RM_TEST_MIGRATED_TEMPLATE_DB = "robotmoney_migrated_tmpl";
// The ephemeral Postgres container's own name — published the same way as
// RM_TEST_TEMPLATE_DB above, for the one test that needs a REAL pg_dump/
// pg_restore round-trip (tests/analytics-ledger-restore.test.ts, issue #979
// AC8): the container's own bundled client tools are the only ones guaranteed
// to match POSTGRES_MAJOR (the host's pg_dump may be an older major, which
// cannot dump from a newer server at all).
process.env.RM_TEST_PG_CONTAINER = name;
process.env.RM_ENV = "ephemeral";

const up = Bun.spawnSync([
  "docker", "run", "-d", "--rm", "--name", name,
  ...labelFlags,
  "-e", "POSTGRES_PASSWORD=robotmoney", "-e", "POSTGRES_USER=robotmoney", "-e", "POSTGRES_DB=robotmoney",
  "-p", `${port}:5432`, POSTGRES_IMAGE,
  // Durability off. This database exists for the length of one `bun test` and
  // is `docker rm -f -v`d afterwards, so crash recovery has nothing to recover;
  // what these buy is the checkpoint. CREATE/DROP DATABASE each force one, and
  // tests/support/clean-db.ts issues a CREATE per test file — with fsync on,
  // a single DROP DATABASE was observed taking 10s once the run had built up
  // dirty buffers, which is how a correct test starts failing on a timeout.
  "-c", "fsync=off",
  "-c", "synchronous_commit=off",
  "-c", "full_page_writes=off",
  // LOGICAL replication has to be available in this container, because one
  // behaviour of migration 0032 can only be tested through it: an apply worker
  // removes rows via ExecSimpleRelationDelete, with NO statement, so a
  // statement-level trigger is never fired and rows leave a protected table
  // silently. tests/append-only-replication.test.ts builds a real publisher and
  // subscriber database inside THIS instance and replicates a DELETE between
  // them. `wal_level` is not settable at runtime, so it belongs here or the
  // test cannot exist — and it must FAIL rather than skip if it is missing,
  // which is what that file asserts first.
  "-c", "wal_level=logical",
]);
if (up.exitCode !== 0) {
  throw new Error(`tests require Docker+Postgres but the container failed to start:\n${up.stderr.toString()}`);
}
process.on("exit", () => { try { Bun.spawnSync(["docker", "rm", "-f", "-v", name]); } catch { /* ignore */ } });

// §7.3 CI ISOMORPHISM (issue #1026 W6 P2). "There is no superuser test
// database. The local container's superuser does only what `doadmin` does in
// production: it creates the four roles and the database, once. `rm_owner` then
// provisions the schema, tests connect as `rm_app`/`rm_worker`/`rm_readonly`,
// and nothing uses the superuser again."
//
// That is the sequence below, and it is the same code `bun smoke --local blank`
// runs (scripts/lib/smoke-database.ts `localSuperuserSql`, then
// backend/src/db/schema-snapshot.ts `bootstrapBlankDatabase`):
//
//   1. the superuser creates the four roles with a password, hands the database
//      to `rm_owner`, installs pgcrypto (provider-managed) and takes its own
//      default privileges back from the runtime roles;
//   2. `rm_owner` logs in and bootstraps the REAL snapshot (backend/schema/) —
//      not the 107 migrations, which need a superuser to create the roles they
//      alter — and seeds, as it does on a smoke boot;
//   3. the superuser makes the template database the per-file clones copy
//      (tests/support/clean-db.ts) and is not used for anything else here.
//
// WHAT THE SUITE'S LOGINS ARE NOW. The api pool is `HARNESS_ROLE` (a NON-superuser)
// and the worker pool is `WORKER_HARNESS_ROLE`, acting as rm_worker. tests/preload-roles.test.ts asserts it.
// A few tests still need the cluster's superuser to build a state no runtime
// role can reach (`ALTER ROLE rm_app SUPERUSER` for the denylist checks, a
// `GRANT rm_owner TO rm_app`); they reach it through RM_TEST_ADMIN_URL
// (tests/support/cluster.ts), which is a named, pinned list, not the default.
//
// The container's readiness is a real connection, like migrate()'s was.
const { default: postgres } = await import("postgres");
const { localSuperuserSql } = await import("../../scripts/lib/smoke-database.ts");
const { bootstrapBlankDatabase, loadSnapshot } = await import("../src/db/schema-snapshot.ts");
const { seed } = await import("../src/db/seed.ts");

async function whenReady<T>(open: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await open();
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, Math.min(1000, 100 * attempt)));
    }
  }
}

// 1. The superuser's whole job: roles and databases.
{
  const superuser = await whenReady(async () => {
    const db = postgres(ADMIN_URL.replace(/\/postgres$/, "/robotmoney"), { max: 1, onnotice: () => {} });
    await db`SELECT 1`;
    return db;
  });
  try {
    await superuser.unsafe(
      localSuperuserSql(
        { rm_owner: ROLE_PASSWORD, rm_app: ROLE_PASSWORD, rm_worker: ROLE_PASSWORD, rm_readonly: ROLE_PASSWORD },
        "robotmoney",
      ),
    );
    // The harness's own login (see HARNESS_ROLE above): a role, so it is the
    // superuser's job. Not a superuser, cannot create roles or databases.
    await superuser.unsafe(`
      CREATE ROLE ${HARNESS_ROLE} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT PASSWORD '${ROLE_PASSWORD}';
      GRANT rm_owner, rm_app, rm_worker, rm_readonly TO ${HARNESS_ROLE};
      ALTER ROLE ${HARNESS_ROLE} SET role = 'rm_owner';
      CREATE ROLE ${WORKER_HARNESS_ROLE} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT PASSWORD '${ROLE_PASSWORD}';
      GRANT rm_worker TO ${WORKER_HARNESS_ROLE};
      ALTER ROLE ${WORKER_HARNESS_ROLE} SET role = 'rm_worker';
      -- Two observability powers the owner-acting harness session needs and does
      -- not get from ownership: reading other sessions' statement text (the race
      -- tests wait on a blocked statement), and the replica-role session setting
      -- the append-only guard tests run under (\`pg_restore --disable-triggers\`).
      -- Test cluster only; neither is a production grant.
      GRANT pg_read_all_stats TO rm_owner;
      GRANT SET ON PARAMETER session_replication_role TO rm_owner;`);
  } finally {
    await superuser.end({ timeout: 5 });
  }
}

// 2. rm_owner provisions the schema and seeds, as a smoke boot does.
{
  const owner = postgres(roleUrl("rm_owner"), { max: 1, onnotice: () => {} });
  try {
    await bootstrapBlankDatabase(owner, await loadSnapshot());
    await seed(owner);
    // The suite's database is the one ~290 files were written against: schema
    // and seed, and NO target enrollment and NO manifest yet — those are what a
    // boot or a migrate run writes, and the tests that exercise them write them
    // first (a `--local blank` bootstrap writes `rehearsal` and the manifest;
    // here they are cleared so a file's own enrollment is not a duplicate).
    await owner.unsafe("DELETE FROM deployment_identity");
    await owner.unsafe("DELETE FROM schema_manifest");
  } finally {
    await owner.end({ timeout: 5 });
  }
}

// 3. The template every per-file clone copies (tests/support/clean-db.ts).
// `CREATE DATABASE ... TEMPLATE x` fails while any session is connected to x,
// and nothing is: the owner's handle above is closed and the api pool has not
// connected yet. Owned by rm_owner, so a clone's `public` schema is too.
{
  const superuser = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await superuser.unsafe(`CREATE DATABASE "${process.env.RM_TEST_TEMPLATE_DB}" TEMPLATE robotmoney OWNER rm_owner`);
  } finally {
    await superuser.end({ timeout: 5 });
  }
}
const client = await import("../src/db/client.ts");

// 4. THE MIGRATION-BUILT DATABASE, for the tests whose subject is history.
//
// A database built by replaying backend/migrations/ from 0001 is what production
// is, and some tests are only meaningful against one: schema-equivalence (the
// snapshot must equal what the migrations build), the upgrade and migrate-run
// tests (a migration-built database is what they start from), the preflight
// tests that grade a database "built the way production's was". The snapshot
// database above cannot stand in for it, or those tests would compare the
// snapshot with itself.
//
// Replaying history is the provider's work, not the application's: migrations up
// to 0053 create and alter roles and 0054 on run as rm_owner through a bootstrap
// login's `SET ROLE`, exactly as `migrate()` does against production with
// `doadmin`. So this one step runs as the cluster admin, on a database of its
// own, and its result is published as a second template
// (RM_TEST_MIGRATED_TEMPLATE_DB). Nothing the shared api pool touches is built
// here.
{
  const { migrate } = await import("../src/db/migrate.ts");
  const superuser = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await superuser.unsafe(`CREATE DATABASE robotmoney_migrated`);
  } finally {
    await superuser.end({ timeout: 5 });
  }
  await client.setDatabase(ADMIN_URL.replace(/\/postgres$/, "/robotmoney_migrated"));
  await migrate();
  await seed();
  // Park the pool on the maintenance database: a template cannot be copied while
  // a session is connected to it.
  await client.setDatabase(ADMIN_URL);
  await client.sql.unsafe(
    `CREATE DATABASE "${process.env.RM_TEST_MIGRATED_TEMPLATE_DB}" TEMPLATE robotmoney_migrated`,
  );
  await client.setDatabase(baseUrl);
}

// Report the SERVER's own version, not the tag we asked for, and refuse to run
// the suite if its major is not the one this repo pins (issue #691).
//
// The tag and the server can disagree — a stale local copy of the pinned tag
// that a registry re-pointed, a mirrored/retagged image, or a DATABASE_URL
// that some future caller overrides before this file loads. The failure mode being
// closed off is not "the wrong image was named"; it is the SILENT one this
// issue found: the whole suite validating migrations against a major that
// production does not run, going green, and nothing anywhere saying which
// version it ran on. Printing it in the startup line means the next mismatch
// is visible in every single run's log instead of waiting for an audit; the
// throw means it is visible whether or not anyone reads the log.
const [server] = (await client.sql`
  SELECT current_setting('server_version')           AS version,
         current_setting('server_version_num')::int  AS num
`) as unknown as { version: string; num: number }[];
const serverMajor = Math.floor(server.num / 10000);
if (serverMajor !== POSTGRES_MAJOR) {
  throw new Error(
    `ephemeral postgres is PostgreSQL ${server.version} (major ${serverMajor}) but ${POSTGRES_IMAGE} ` +
      `is pinned to major ${POSTGRES_MAJOR} — the suite must run the major production runs. ` +
      `See scripts/lib/postgres-image.ts.`,
  );
}

console.log(
  `[tests] ephemeral postgres ready on :${port} (${name}, env=${environment.class}/${environment.hash}, ` +
    `image=${POSTGRES_IMAGE}, server=PostgreSQL ${server.version})`,
);

// ROLE STATE IS CLUSTER STATE, and ~30 files change it (a password of their own,
// a LOGIN attribute, a superuser flag for a denylist check) while every file
// runs in this one process. Each is meant to put it back, and one that does not
// would hand its successor a role nobody can log in as. So the baseline is
// asserted at the start of the run, by the cluster admin (bun runs a preload hook
// once, not per file, so a file that depends on the baseline re-asserts it in its
// own beforeAll, as stream-events-retention does): all four roles LOGIN with
// the suite's shared password and hold no cluster power. A file's own
// `beforeAll` registers later and therefore still wins for its own run.
beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    for (const role of ["rm_owner", "rm_app", "rm_worker", "rm_readonly"]) {
      await admin.unsafe(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD '${ROLE_PASSWORD}'`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
});

afterAll(async () => {
  await client.closeDb();
  Bun.spawnSync(["docker", "rm", "-f", "-v", name]);
});
