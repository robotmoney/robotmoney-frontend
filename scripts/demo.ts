// Self-contained demo orchestrator. `bun run demo` (→ `bun scripts/demo.ts`)
// provisions the WHOLE stack on freshly-chosen random ports, runs one committee
// session through the MCP server, then keeps the servers running for the browser
// until interrupted — and on exit (Ctrl-C, SIGTERM, or any failure) tears down
// every container + volume it created. Nothing is assumed to be running first.
//
// Isolation: each run uses three random free TCP ports (Postgres / API / MCP)
// and a unique COMPOSE_PROJECT_NAME, so concurrent or repeated runs never clash
// and cleanup is always scoped to exactly this run's resources.
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const backendDir = join(repoRoot, "backend");
const mcpDir = join(repoRoot, "mcp");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Random free ports ----------------------------------------------------
// Open N OS-assigned ephemeral ports at once (held open simultaneously so they
// are guaranteed distinct), read their numbers, then release them.
async function freePorts(n: number): Promise<number[]> {
  const servers: ReturnType<typeof createServer>[] = [];
  for (let i = 0; i < n; i++) {
    const srv = await new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
      const s = createServer();
      s.on("error", reject);
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    servers.push(srv);
  }
  const ports = servers.map((s) => (s.address() as AddressInfo).port);
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  return ports;
}

// --- Run config -----------------------------------------------------------
const [pgPort, apiPort, mcpPort] = await freePorts(3);
const project = `rmdemo_${crypto.randomUUID().slice(0, 8)}`;
const DB_USER = "robotmoney";
const DB_PASSWORD = "robotmoney";
const DB_NAME = "robotmoney";
const databaseUrl = `postgres://${DB_USER}:${DB_PASSWORD}@localhost:${pgPort}/${DB_NAME}`;
const backendUrl = `http://localhost:${apiPort}`;
const mcpUrl = `http://localhost:${mcpPort}`;

// Env shared by every `docker compose` call — pins the project (for isolation +
// scoped teardown) and the random host port + credentials for postgres.
const dockerEnv: Record<string, string> = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  POSTGRES_PORT: String(pgPort),
  POSTGRES_USER: DB_USER,
  POSTGRES_PASSWORD: DB_PASSWORD,
  POSTGRES_DB: DB_NAME,
} as Record<string, string>;

console.log(`[demo] project=${project}  postgres=:${pgPort}  api=:${apiPort}  mcp=:${mcpPort}`);

// --- Child + container lifecycle ------------------------------------------
const children: Bun.Subprocess[] = [];

function dockerCompose(args: string[], check = true): Bun.SyncSubprocess {
  const r = Bun.spawnSync(["docker", "compose", ...args], {
    cwd: repoRoot,
    env: dockerEnv,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (check && r.exitCode !== 0) {
    throw new Error(`docker compose ${args.join(" ")} failed (exit ${r.exitCode})`);
  }
  return r;
}

// Idempotent, synchronous teardown — safe to call from signal handlers AND the
// process "exit" event. Kills the API/worker/MCP children, then removes ALL
// containers + volumes for this run's compose project. Runs exactly once.
let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  console.log("\n[demo] tearing down…");
  for (const c of children) {
    try { c.kill("SIGTERM"); } catch { /* already gone */ }
  }
  const r = dockerCompose(["down", "-v"], false);
  console.log(
    r.exitCode === 0
      ? `[demo] teardown complete — no containers/volumes left for ${project}`
      : `[demo] teardown exited ${r.exitCode}`,
  );
}

process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("exit", () => { cleanup(); });

// --- Readiness helpers ----------------------------------------------------
async function waitForPostgres(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = Bun.spawnSync(
      ["docker", "compose", "exec", "-T", "postgres", "pg_isready", "-U", DB_USER, "-d", DB_NAME],
      { cwd: repoRoot, env: dockerEnv, stdout: "ignore", stderr: "ignore" },
    );
    if (r.exitCode === 0) return;
    await sleep(1000);
  }
  throw new Error("postgres did not become ready in time");
}

async function waitForHttp(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function run(cmd: string[], cwd: string, env: Record<string, string>, label: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${label} failed (exit ${code})`);
}

// --- Orchestration --------------------------------------------------------
async function main(): Promise<void> {
  // 1. Postgres (the only container; api/worker/mcp run as fast Bun children).
  console.log("[demo] starting postgres…");
  dockerCompose(["up", "-d", "postgres"]);
  await waitForPostgres();
  console.log("[demo] postgres healthy");

  // 2. Migrations.
  console.log("[demo] running migrations…");
  await run(["bun", "run", "src/db/migrate.ts"], backendDir,
    { ...process.env, DATABASE_URL: databaseUrl, RM_ENV: "demo" } as Record<string, string>, "migrations");

  // 3. API child (also serves the static frontend, same origin as prod).
  console.log("[demo] starting api…");
  children.push(Bun.spawn(["bun", "run", "src/api/index.ts"], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: databaseUrl, RM_ENV: "demo", API_PORT: String(apiPort), STATIC_DIR: "../frontend/public" } as Record<string, string>,
    stdout: "inherit", stderr: "inherit",
  }));

  // 4. Worker child — drains the queue and ticks the scheduler (slice B jobs).
  console.log("[demo] starting worker…");
  children.push(Bun.spawn(["bun", "run", "src/worker/index.ts"], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: databaseUrl, RM_ENV: "demo" } as Record<string, string>,
    stdout: "inherit", stderr: "inherit",
  }));

  // 5. MCP server child — wraps the API for member agents.
  console.log("[demo] starting mcp server…");
  children.push(Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: mcpDir,
    env: { ...process.env, BACKEND_URL: backendUrl, MCP_PORT: String(mcpPort) } as Record<string, string>,
    stdout: "inherit", stderr: "inherit",
  }));

  await waitForHttp(`${backendUrl}/health`);
  await waitForHttp(`${mcpUrl}/health`);
  console.log("[demo] api + mcp healthy");

  // 6. Drive one full committee session through the MCP server.
  console.log("\n[demo] running committee session…");
  await run(["bun", "run", "src/e2e.ts"], mcpDir,
    { ...process.env, BACKEND_URL: backendUrl, MCP_URL: `${mcpUrl}/mcp` } as Record<string, string>, "committee session");

  // 7. Keep everything up for the browser.
  console.log("\n=== stack is live (Ctrl-C to tear everything down) ===");
  console.log(`  frontend   ${backendUrl}/`);
  console.log(`  regime     ${backendUrl}/regime`);
  console.log(`  committee  ${backendUrl}/committee`);
  console.log(`  research   ${backendUrl}/research/*`);
  console.log(`  mcp health ${mcpUrl}/health`);
  console.log("");
  await new Promise<never>(() => { /* run until a signal triggers cleanup */ });
}

main().catch((err) => {
  console.error("[demo] startup failed:", err instanceof Error ? err.message : err);
  cleanup();
  process.exit(1);
});
