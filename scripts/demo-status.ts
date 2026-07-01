// Status of the standing local demo. Reads .agents/demo-state.json, rebuilds the
// docker compose env, and runs `docker compose ps` so you can confirm the stack
// is still up (the demo never auto-tears-down). Tear down with `bun run demo:down`.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const stateFile = join(repoRoot, ".agents", "demo-state.json");

interface DemoState {
  project: string;
  apiPort: number;
  mcpPort: number;
  pgPort?: number;
  composeFiles: string;
  databaseUrl: string;
  dbUser: string;
  dbPassword: string;
  dbName: string;
  logFile?: string;
  createdAt: string;
}

if (!existsSync(stateFile)) {
  console.log("[demo:status] no demo state found (no demo appears to be running)");
  process.exit(0);
}

const s: DemoState = JSON.parse(readFileSync(stateFile, "utf8"));

const dockerEnv: Record<string, string> = {
  ...process.env,
  COMPOSE_PROJECT_NAME: s.project,
  COMPOSE_FILE: s.composeFiles,
  DEMO_PROJECT: s.project,
  DATABASE_URL: s.databaseUrl,
  WEB_PORT: String(s.apiPort),
  MCP_PORT: String(s.mcpPort),
  POSTGRES_PORT: String(s.pgPort ?? 5432),
  POSTGRES_USER: s.dbUser,
  POSTGRES_PASSWORD: s.dbPassword,
  POSTGRES_DB: s.dbName,
} as Record<string, string>;

console.log(`[demo:status] project=${s.project}  api=:${s.apiPort}  mcp=:${s.mcpPort}  (created ${s.createdAt})`);
console.log(`[demo:status]   Site:      http://127.0.0.1:${s.apiPort}/`);
console.log(`[demo:status]   MCP:       http://127.0.0.1:${s.mcpPort}/health`);
console.log(`[demo:status]   state file: ${stateFile}`);
if (s.logFile) console.log(`[demo:status]   log file:   ${s.logFile}`);
console.log("");

const r = Bun.spawnSync(["docker", "compose", "ps"], {
  cwd: repoRoot,
  env: dockerEnv,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(r.exitCode ?? 0);
