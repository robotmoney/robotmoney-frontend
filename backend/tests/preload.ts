// Test bootstrap: provision an ephemeral Postgres in Docker, point DATABASE_URL
// at it, and apply migrations — ONCE, before any test file imports the db client.
// Fails loudly if Docker/Postgres can't start (never a silent skip).
import net from "node:net";
import { afterAll } from "bun:test";
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

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
  });
}

const port = await freePort();
// Environment-scoped name + labels: `rm_ci_pgtest_<job hash>` under GitHub
// Actions, `rm_demo_pgtest_<per-boot random>` locally. The host running these
// tests is also the self-hosted CI runner and the stage demo box, so a
// container left behind by a killed test run has to say which environment made
// it — and the labels are what a reaper selects on (`docker ps --filter
// label=robotmoney.env=ci`), because name-substring matching on this host is
// how you accidentally kill the live site.
const environment = resolveStackEnvironment(process.env);
const name = stackProjectName("pgtest", environment);
// This is a raw `docker run`, NOT compose, so the labels docker-compose.demo.yml
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
  "-p", `${port}:5432`, "postgres:17-alpine",
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

console.log(`[tests] ephemeral postgres ready on :${port} (${name}, env=${environment.class}/${environment.hash})`);

afterAll(async () => {
  await client.closeDb();
  Bun.spawnSync(["docker", "rm", "-f", name]);
});
