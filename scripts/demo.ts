import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Random free ports ----------------------------------------------------
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
const [apiPort, mcpPort] = await freePorts(2);
const project = `rmdemo_${crypto.randomUUID().slice(0, 8)}`;
const DB_USER = "robotmoney";
const DB_PASSWORD = "robotmoney";
const DB_NAME = "robotmoney";
const databaseUrl = `postgres://${DB_USER}:${DB_PASSWORD}@postgres:5432/${DB_NAME}`;
const backendUrl = `http://localhost:${apiPort}`;
const mcpUrl = `http://localhost:${mcpPort}`;
const composeFiles = "docker-compose.yml:docker-compose.demo.yml";

// Env shared by every `docker compose` call — pins the project, selects the
// demo override, and sets random host ports + credentials.
const dockerEnv: Record<string, string> = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_FILE: composeFiles,
  DEMO_PROJECT: project,
  DATABASE_URL: databaseUrl,
  WEB_PORT: String(apiPort),
  MCP_PORT: String(mcpPort),
  POSTGRES_USER: DB_USER,
  POSTGRES_PASSWORD: DB_PASSWORD,
  POSTGRES_DB: DB_NAME,
} as Record<string, string>;

console.log(`[demo] project=${project}  api=:${apiPort}  mcp=:${mcpPort}`);

// --- Container lifecycle --------------------------------------------------
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

async function runCompose(args: string[], label: string): Promise<void> {
  const proc = Bun.spawn(["docker", "compose", ...args], {
    cwd: repoRoot,
    env: dockerEnv,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${label} failed (exit ${code})`);
}

let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  console.log("\n[demo] tearing down…");
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
  console.log("[demo] building compose images…");
  await runCompose(["build"], "compose build");

  console.log("[demo] starting postgres…");
  await runCompose(["up", "-d", "postgres"], "start postgres");
  await waitForPostgres();
  console.log("[demo] postgres healthy");

  console.log("[demo] running migrations…");
  await runCompose(["run", "--rm", "-T", "api", "bun", "run", "src/db/migrate.ts"], "migrations");

  console.log("[demo] starting api, worker, mcp…");
  await runCompose(["up", "-d"], "start services");
  await waitForHttp(`${backendUrl}/health`);
  await waitForHttp(`${mcpUrl}/health`);
  console.log("[demo] api + mcp healthy");

  console.log("\n[demo] running committee session…");
  await run(["bun", "run", "src/e2e.ts"], join(repoRoot, "mcp"),
    { ...process.env, BACKEND_URL: backendUrl, MCP_URL: `${mcpUrl}/mcp` } as Record<string, string>, "committee session");

  console.log("[demo] running frontend checks…");
  await run(["bun", "run", "scripts/demo-frontend-check.ts"], repoRoot,
    { ...process.env, BACKEND_URL: backendUrl } as Record<string, string>, "frontend checks");

  console.log("\n=== stack is live (Ctrl-C to tear everything down) ===");
  console.log(`  frontend   ${backendUrl}/`);
  console.log(`  regime     ${backendUrl}/regime`);
  console.log(`  committee  ${backendUrl}/committee`);
  console.log(`  research   ${backendUrl}/research/*`);
  console.log(`  mcp health ${mcpUrl}/health`);
  console.log(`  containers docker ps -a --filter name=${project}`);
  console.log("");
  await new Promise<never>(() => { /* run until a signal triggers cleanup */ });
}

main().catch((err) => {
  console.error("[demo] startup failed:", err instanceof Error ? err.message : err);
  cleanup();
  process.exit(1);
});
