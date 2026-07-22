// Test bootstrap: provision an ephemeral Postgres in Docker, point DATABASE_URL
// at it, and apply migrations — ONCE, before any test file imports the db client.
// Fails loudly if Docker/Postgres can't start (never a silent skip).
import net from "node:net";
import { afterAll } from "bun:test";

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
  });
}

const port = await freePort();
const name = `rmtest_pg_${crypto.randomUUID().slice(0, 8)}`;

// Must be set BEFORE any module reads config.databaseUrl / creates the pool.
process.env.DATABASE_URL = `postgres://robotmoney:robotmoney@localhost:${port}/robotmoney`;
process.env.RM_ENV = "ephemeral";
process.env.COMMITTEE_NOTIFICATION_EMAIL_FROM = "committee-test@robotmoney.invalid";

const up = Bun.spawnSync([
  "docker", "run", "-d", "--rm", "--name", name,
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
console.log(`[tests] ephemeral postgres ready on :${port} (${name})`);

const { closeDb } = await import("../src/db/client.ts");
afterAll(async () => {
  await closeDb();
  Bun.spawnSync(["docker", "rm", "-f", name]);
});
