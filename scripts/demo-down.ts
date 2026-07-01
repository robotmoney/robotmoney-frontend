// Explicit teardown for the standing local demo. `bun run demo` never tears the
// stack down (not on Ctrl-C, not on startup failure) — this is the ONLY way to
// stop it. Reads .agents/demo-state.json, rebuilds the exact docker compose env,
// runs `docker compose down -v`, then removes the state file.
import { existsSync, readFileSync, rmSync } from "node:fs";
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
  createdAt: string;
}

if (!existsSync(stateFile)) {
  console.log("[demo:down] no demo state found (nothing to tear down)");
  process.exit(0);
}

const s: DemoState = JSON.parse(readFileSync(stateFile, "utf8"));

// Rebuild the same dockerEnv the demo used, so we target the right project.
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

console.log(`[demo:down] tearing down project=${s.project} (created ${s.createdAt})…`);
const r = Bun.spawnSync(["docker", "compose", "down", "-v"], {
  cwd: repoRoot,
  env: dockerEnv,
  stdout: "inherit",
  stderr: "inherit",
});

if (r.exitCode !== 0) {
  console.error(`[demo:down] docker compose down exited ${r.exitCode} — state file kept for retry`);
  process.exit(r.exitCode ?? 1);
}

rmSync(stateFile, { force: true });
console.log(`[demo:down] teardown complete — no containers/volumes left for ${s.project}`);
console.log(`[demo:down] removed ${stateFile}`);
