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

// Must be set BEFORE any module reads config.databaseUrl / creates the pool.
process.env.DATABASE_URL = `postgres://robotmoney:robotmoney@localhost:${port}/robotmoney`;
process.env.RM_ENV = "ephemeral";
process.env.COMMITTEE_NOTIFICATION_EMAIL_FROM = "committee-test@robotmoney.invalid";

const up = Bun.spawnSync([
  "docker", "run", "-d", "--rm", "--name", name,
  ...labelFlags,
  "-e", "POSTGRES_PASSWORD=robotmoney", "-e", "POSTGRES_USER=robotmoney", "-e", "POSTGRES_DB=robotmoney",
  "-p", `${port}:5432`, "postgres:17-alpine",
]);
if (up.exitCode !== 0) {
  throw new Error(`tests require Docker+Postgres but the container failed to start:\n${up.stderr.toString()}`);
}
process.on("exit", () => { try { Bun.spawnSync(["docker", "rm", "-f", name]); } catch { /* ignore */ } });

// migrate() retries a real SELECT 1 until the server accepts connections.
const { migrate } = await import("../src/db/migrate.ts");
await migrate();
console.log(`[tests] ephemeral postgres ready on :${port} (${name}, env=${environment.class}/${environment.hash})`);

const { closeDb } = await import("../src/db/client.ts");
afterAll(async () => {
  await closeDb();
  Bun.spawnSync(["docker", "rm", "-f", name]);
});
