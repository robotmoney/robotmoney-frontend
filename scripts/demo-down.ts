// Explicit teardown for the standing local demo. Reads .agents/demo-state.json,
// rebuilds the exact docker compose env, and runs `docker compose down` — WITHOUT
// `-v` (issue: demo persistent volumes): containers + network are removed but the
// postgres data volume (or the `--pg-data` host dir) is KEPT, so a later
// `bun run demo` resumes from where it left off.
//
// This matches the running demo's own Ctrl-C / SIGTERM behavior — both now keep
// data (see scripts/lib/demo-main.ts onSignal()/cleanup() and docs/architecture.md
// §(c)). Deleting demo data is a SEPARATE, explicit act: `bun run demo:clean`
// (scripts/demo-clean.ts) removes the label-namespaced demo volumes; it never
// touches a `--pg-data` host directory.
//
// State-file policy: the state file is KEPT on teardown (the data it points to
// survives, so the pointer must too) — `demo:status` reads it, and it stays until
// the next boot overwrites it or `demo:clean` removes the volume it names.
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
  // Exactly one is set (issue: demo persistent volumes): a `--pg-data` host bind
  // dir, or the fresh-per-run named volume that survives teardown.
  pgDataDir?: string;
  pgVolume?: string;
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

console.log(`[demo:down] tearing down project=${s.project} (created ${s.createdAt}) — keeping postgres data…`);
// NO `-v`: keep the volume / --pg-data dir.
const r = Bun.spawnSync(["docker", "compose", "down"], {
  cwd: repoRoot,
  env: dockerEnv,
  stdout: "inherit",
  stderr: "inherit",
});

if (r.exitCode !== 0) {
  console.error(`[demo:down] docker compose down exited ${r.exitCode}`);
  process.exit(r.exitCode ?? 1);
}

const where = s.pgDataDir ? `--pg-data dir ${s.pgDataDir}` : `volume ${s.pgVolume ?? `${s.project}_pgdata`}`;
console.log(`[demo:down] containers + network removed for ${s.project}; postgres data kept (${where})`);
if (s.pgDataDir) {
  console.log(`[demo:down]   resume:  bun run demo -- --pg-data ${s.pgDataDir}`);
}
console.log(`[demo:down]   reclaim demo volumes when done: bun run demo:clean`);
console.log(`[demo:down] state file kept (points to the surviving data): ${stateFile}`);
