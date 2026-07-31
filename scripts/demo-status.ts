// Status of the standing local demo. Reads .agents/demo-state.json, rebuilds the
// docker compose env, and runs `docker compose ps` so you can confirm the stack
// is still up. Teardown (`bun run demo:down` or Ctrl-C) KEEPS the postgres data
// (issue: demo persistent volumes), so this state file may describe a STOPPED demo
// whose data survives — `docker compose ps` then shows no running containers while
// the PG-data line below still points at the kept volume / --pg-data dir. Tear down
// with `bun run demo:down`; reclaim stopped demos' data with `bun run demo:clean`.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_CONTAINER_PORT,
  parseComposePortOutput,
  portArgs,
  POSTGRES_CONTAINER_PORT,
} from "./stack/index.ts";
import { buildDemoLifecycleComposeEnv } from "./lib/demo-lifecycle-env.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const stateFile = join(repoRoot, ".agents", "demo-state.json");

interface DemoState {
  project: string;
  // HISTORY, not truth: what Docker assigned to the boot that wrote this file.
  // livePort() below asks the daemon what is published now and that wins.
  apiPort: number;
  // Optional: D21 retired the mcp container; state files written since then omit
  // it, but an older standing demo's state file may still carry it.
  mcpPort?: number;
  pgPort?: number;
  // Did this boot apply docker-compose.stage.yml (`bun run demo -- --stage`),
  // pinning the api to the cloudflared origin? Provenance only; optional
  // because a state file written before --stage existed has no such flag.
  stage?: boolean;
  // Environment class + hash (scripts/stack/naming.ts) so the labels compose
  // interpolates here match the ones `up` stamped. Optional for the same
  // backward-compatibility reason.
  envClass?: string;
  envHash?: string;
  composeFiles: string;
  // For an --external-pg boot these four are REDACTED placeholders, not
  // credentials: the real ones live in .env and must never be copied into a file
  // inside the checkout. `externalPg` is the flag to branch on — optional
  // because state files written before the flag existed have no such field.
  externalPg?: boolean;
  databaseUrl: string;
  dbUser: string;
  dbPassword: string;
  dbName: string;
  logFile?: string;
  // Data location (issue: demo persistent volumes): exactly one is set — a
  // `--pg-data` host bind dir, or the fresh-per-run named volume kept on teardown.
  pgDataDir?: string;
  pgVolume?: string;
  createdAt: string;
}

if (!existsSync(stateFile)) {
  console.log("[demo:status] no demo state found (no demo appears to be running)");
  process.exit(0);
}

const s: DemoState = JSON.parse(readFileSync(stateFile, "utf8"));

// NO WEB_PORT / POSTGRES_PORT. docker-compose.yml no longer interpolates a host
// port anywhere (both services publish container ports only; the daemon assigns
// the host side), so nothing here has to invent a value for `config`/`ps` to
// resolve.
const dockerEnv = buildDemoLifecycleComposeEnv(s, process.env);

// THE LIVE PORTS COME FROM THE DAEMON, NOT FROM THE STATE FILE.
//
// The state file records what Docker assigned to the boot that wrote it, and
// that is genuinely history: it survives teardown by design, it is left behind
// by a crashed boot before any container existed (ports 0), and a later boot in
// another checkout can be the one actually running. Reporting a stale number as
// "the demo is at :NNNNN" sends the operator to a dead or foreign port — that
// exact failure was hit on this host. `docker compose port` asks what is
// published RIGHT NOW; an unrunning service simply yields nothing.
function livePort(service: string, containerPort: number): number | undefined {
  const r = Bun.spawnSync(["docker", "compose", ...portArgs(service, containerPort)], {
    cwd: repoRoot,
    env: dockerEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) return undefined;
  try {
    return parseComposePortOutput(new TextDecoder().decode(r.stdout), service, containerPort);
  } catch {
    // Not running / not published. `docker compose ps` below is the honest
    // report of that, so this stays quiet rather than shouting about a stopped
    // demo the operator is deliberately inspecting.
    return undefined;
  }
}
const liveApiPort = livePort("api", API_CONTAINER_PORT);
// An --external-pg boot has no postgres service, so asking the daemon for its
// published port is not a question with an answer — skip it rather than let the
// "not running" branch imply a container that ought to be up.
const livePgPort = s.externalPg ? undefined : livePort("postgres", POSTGRES_CONTAINER_PORT);
// `?? undefined` on the recorded pgPort keeps an old state file (no pgPort
// field) from printing "undefined" as if it were a number.
const shownApi = liveApiPort !== undefined ? `:${liveApiPort} (live)` : `:${s.apiPort} (from state file — NOT RUNNING)`;
const shownPg = s.externalPg
  ? "EXTERNAL (managed — from .env; no container)"
  : livePgPort !== undefined ? `:${livePgPort} (live)` : s.pgPort !== undefined ? `:${s.pgPort} (from state file — NOT RUNNING)` : "unknown";

console.log(`[demo:status] project=${s.project}  api=${shownApi}  pg=${shownPg}  (created ${s.createdAt})`);
if (s.envClass || s.envHash) {
  console.log(`[demo:status]   environment: ${s.envClass ?? "unknown"}/${s.envHash ?? "unknown"}  (container labels robotmoney.env / robotmoney.env.hash)`);
}
if (s.stage) {
  console.log(`[demo:status]   --stage:    api PINNED to :${liveApiPort ?? s.apiPort} — this is the cloudflared origin for stage.robotmoney-labs.dev.`);
}
if (liveApiPort !== undefined && liveApiPort !== s.apiPort) {
  // Worth saying out loud rather than silently preferring the live value: it
  // means the state file belongs to a DIFFERENT boot than the running stack.
  console.log(`[demo:status]   NOTE: the state file records api=:${s.apiPort}, but the daemon publishes :${liveApiPort}. The live value wins.`);
}
if (liveApiPort !== undefined) console.log(`[demo:status]   Site:      http://127.0.0.1:${liveApiPort}/`);
console.log(`[demo:status]   state file: ${stateFile}`);
if (s.logFile) console.log(`[demo:status]   log file:   ${s.logFile}`);
if (s.externalPg) {
  console.log(`[demo:status]   pg data:    EXTERNAL managed server ${s.databaseUrl} — owned by that server, NOT by this demo.`);
  console.log(`[demo:status]               demo:down and demo:clean cannot touch it; this boot's writes are permanent.`);
} else if (s.pgDataDir) {
  console.log(`[demo:status]   pg data:    --pg-data ${s.pgDataDir}  (bind; resume: bun run demo -- --pg-data ${s.pgDataDir})`);
} else {
  console.log(`[demo:status]   pg data:    volume ${s.pgVolume ?? `${s.project}_pgdata`}  (kept on teardown; reclaim: bun run demo:clean)`);
}
console.log("");

const r = Bun.spawnSync(["docker", "compose", "ps"], {
  cwd: repoRoot,
  env: dockerEnv,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(r.exitCode ?? 0);
