// Test bootstrap: provision an ephemeral Postgres in Docker, point DATABASE_URL
// at it, and apply migrations — ONCE, before any test file imports the db client.
// Fails loudly if Docker/Postgres can't start (never a silent skip).
import net from "node:net";
import { afterAll, beforeEach } from "bun:test";
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
// This is a raw `docker run`, NOT compose, so the labels docker-compose.smoke.yml
// applies to every other container must be passed explicitly here.
const labelFlags = dockerLabelFlags(stackLabels(environment, name));

const baseUrl = `postgres://robotmoney:robotmoney@localhost:${port}/robotmoney`;
// Must be set BEFORE any module reads config.databaseUrl / creates the pool.
process.env.DATABASE_URL = baseUrl;
// The template a test file clones to get a clean database of its own; see
// tests/support/clean-db.ts. Published through the environment because preload
// and the helper are separate modules with no import edge between them.
process.env.RM_TEST_TEMPLATE_DB = "robotmoney_tmpl";
process.env.RM_ENV = "ephemeral";
process.env.SWARM_NOTIFICATION_EMAIL_FROM = "swarm-test@robotmoney.invalid";

const up = Bun.spawnSync([
  "docker", "run", "-d", "--rm", "--name", name,
  ...labelFlags,
  "-e", "POSTGRES_PASSWORD=robotmoney", "-e", "POSTGRES_USER=robotmoney", "-e", "POSTGRES_DB=robotmoney",
  "-p", `${port}:5432`, POSTGRES_IMAGE,
  // Durability off. This database exists for the length of one `bun test` and
  // is `docker rm -f`d afterwards, so crash recovery has nothing to recover;
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
process.on("exit", () => { try { Bun.spawnSync(["docker", "rm", "-f", name]); } catch { /* ignore */ } });

// migrate() retries a real SELECT 1 until the server accepts connections.
const { migrate } = await import("../src/db/migrate.ts");
await migrate();

// Snapshot the migrated schema as a TEMPLATE database, so any test file can
// clone a clean one for itself in tens of milliseconds instead of re-running
// the migrations (tests/support/clean-db.ts). `CREATE DATABASE ... TEMPLATE x`
// fails while any session is connected to x — including ours — so the pool is
// parked on the maintenance database `postgres` for the duration of the copy
// and handed straight back. DATABASE_URL is unchanged either side of this: a
// file that does not opt into a clean database sees exactly the shared,
// migrated `robotmoney` it always saw.
// Held as a namespace, not destructured: `sql` is a live binding that
// setDatabase() reassigns, and destructuring would freeze this file's view of
// it at the pool that is about to be closed.
const client = await import("../src/db/client.ts");
await client.setDatabase(`postgres://robotmoney:robotmoney@localhost:${port}/postgres`);
await client.sql.unsafe(`CREATE DATABASE "${process.env.RM_TEST_TEMPLATE_DB}" TEMPLATE robotmoney`);
await client.setDatabase(baseUrl);

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

afterAll(async () => {
  await client.closeDb();
  Bun.spawnSync(["docker", "rm", "-f", name]);
});
