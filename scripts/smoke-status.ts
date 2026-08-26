// Status of the standing local smoke. Reads .agents/smoke-state.json, rebuilds the
// docker compose env, and runs `docker compose ps` so you can confirm the stack
// is still up. Teardown (`bun run smoke:down` or Ctrl-C) KEEPS the postgres data
// (issue: smoke persistent volumes), so this state file may describe a STOPPED smoke
// whose data survives — `docker compose ps` then shows no running containers while
// the PG-data line below still points at the kept volume / --pg-data dir. Tear down
// with `bun run smoke:down`; reclaim stopped smokes' data with `bun run smoke:clean`.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_CONTAINER_PORT,
  parseComposePortOutput,
  portArgs,
  POSTGRES_CONTAINER_PORT,
} from "./stack/index.ts";
import { buildSmokeLifecycleComposeEnv, dbModeFromState } from "./lib/smoke-lifecycle-env.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const stateFile = join(repoRoot, ".agents", "smoke-state.json");

interface SmokeState {
  project: string;
  // HISTORY, not truth: what Docker assigned to the boot that wrote this file.
  // livePort() below asks the daemon what is published now and that wins.
  apiPort: number;
  // Optional: D21 retired the mcp container; state files written since then omit
  // it, but an older standing smoke's state file may still carry it.
  mcpPort?: number;
  pgPort?: number;
  // Did this boot apply docker-compose.stage.yml (`bun run smoke -- --stage`),
  // pinning the api to the cloudflared origin? Provenance only; optional
  // because a state file written before --stage existed has no such flag.
  stage?: boolean;
  // Environment class + hash (scripts/stack/naming.ts) so the labels compose
  // interpolates here match the ones `up` stamped. Optional for the same
  // backward-compatibility reason.
  envClass?: string;
  envHash?: string;
  composeFiles: string;
  // For every non-ephemeral boot these four are REDACTED placeholders, not
  // credentials: the real ones live in .env (external) or in a throwaway
  // container (smoke-twin) and must never be copied into a file inside the checkout.
  // `db` is what to branch on; `externalPg` is the pre-refactor boolean, and
  // dbModeFromState() reconciles the two.
  db?: string;
  externalPg?: boolean;
  smokeTwinContainer?: string;
  smokeTwinVolume?: string;
  smokeTwinBackupStamp?: string;
  databaseUrl: string;
  dbUser: string;
  dbPassword: string;
  dbName: string;
  logFile?: string;
  // Data location (issue: smoke persistent volumes): exactly one is set — a
  // `--pg-data` host bind dir, or the fresh-per-run named volume kept on teardown.
  pgDataDir?: string;
  pgVolume?: string;
  createdAt: string;
}

if (!existsSync(stateFile)) {
  console.log("[smoke:status] no smoke state found (no smoke appears to be running)");
  process.exit(0);
}

const s: SmokeState = JSON.parse(readFileSync(stateFile, "utf8"));

// NO WEB_PORT / POSTGRES_PORT. docker-compose.yml no longer interpolates a host
// port anywhere (both services publish container ports only; the daemon assigns
// the host side), so nothing here has to invent a value for `config`/`ps` to
// resolve.
const dockerEnv = buildSmokeLifecycleComposeEnv(s, process.env);

// THE LIVE PORTS COME FROM THE DAEMON, NOT FROM THE STATE FILE.
//
// The state file records what Docker assigned to the boot that wrote it, and
// that is genuinely history: it survives teardown by design, it is left behind
// by a crashed boot before any container existed (ports 0), and a later boot in
// another checkout can be the one actually running. Reporting a stale number as
// "the smoke is at :NNNNN" sends the operator to a dead or foreign port — that
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
    // smoke the operator is deliberately inspecting.
    return undefined;
  }
}
const liveApiPort = livePort("api", API_CONTAINER_PORT);
// A non-ephemeral boot has no compose postgres service, so asking the daemon for its
// published port is not a question with an answer — skip it rather than let the
// "not running" branch imply a container that ought to be up.
const mode = dbModeFromState(s);
const livePgPort = mode === "ephemeral" ? livePort("postgres", POSTGRES_CONTAINER_PORT) : undefined;
// `?? undefined` on the recorded pgPort keeps an old state file (no pgPort
// field) from printing "undefined" as if it were a number.
const shownApi = liveApiPort !== undefined ? `:${liveApiPort} (live)` : `:${s.apiPort} (from state file — NOT RUNNING)`;
const shownPg =
  mode === "external"
    ? "EXTERNAL (managed — from .env; no container)"
    : mode === "smoke-twin"
      ? "TWIN (local restored copy; no compose container)"
      : livePgPort !== undefined ? `:${livePgPort} (live)` : s.pgPort !== undefined ? `:${s.pgPort} (from state file — NOT RUNNING)` : "unknown";

console.log(`[smoke:status] project=${s.project}  api=${shownApi}  pg=${shownPg}  (created ${s.createdAt})`);
if (s.envClass || s.envHash) {
  console.log(`[smoke:status]   environment: ${s.envClass ?? "unknown"}/${s.envHash ?? "unknown"}  (container labels robotmoney.env / robotmoney.env.hash)`);
}
if (s.stage) {
  console.log(`[smoke:status]   --static-port: api PINNED to :${liveApiPort ?? s.apiPort} — this is the cloudflared origin for stage.robotmoney-labs.dev.`);
}
if (liveApiPort !== undefined && liveApiPort !== s.apiPort) {
  // Worth saying out loud rather than silently preferring the live value: it
  // means the state file belongs to a DIFFERENT boot than the running stack.
  console.log(`[smoke:status]   NOTE: the state file records api=:${s.apiPort}, but the daemon publishes :${liveApiPort}. The live value wins.`);
}
if (liveApiPort !== undefined) console.log(`[smoke:status]   Site:      http://127.0.0.1:${liveApiPort}/`);
console.log(`[smoke:status]   state file: ${stateFile}`);
if (s.logFile) console.log(`[smoke:status]   log file:   ${s.logFile}`);
if (mode === "external") {
  console.log(`[smoke:status]   pg data:    EXTERNAL managed server ${s.databaseUrl} — owned by that server, NOT by this smoke.`);
  console.log(`[smoke:status]               smoke:down and smoke:clean cannot touch it; this boot's writes are permanent.`);
} else if (mode === "smoke-twin") {
  // NOT the pgVolume fallback below: a smoke-twin boot creates no <project>_pgdata,
  // so naming one would send the operator after storage that does not exist
  // while leaving the volume that DOES hold a copy of production unmentioned.
  console.log(`[smoke:status]   pg data:    TWIN volume ${s.smokeTwinVolume ?? "(unrecorded)"}  (restored from backup ${s.smokeTwinBackupStamp ?? "?"}; kept on teardown; reclaim: bun run smoke:clean)`);
  console.log(`[smoke:status]               it holds a copy of production, including real credential material.`);
  if (s.smokeTwinContainer) console.log(`[smoke:status]   smoke-twin:       container ${s.smokeTwinContainer}`);
} else if (s.pgDataDir) {
  console.log(`[smoke:status]   pg data:    --pg-data ${s.pgDataDir}  (bind; resume: bun run smoke -- --pg-data ${s.pgDataDir})`);
} else {
  console.log(`[smoke:status]   pg data:    volume ${s.pgVolume ?? `${s.project}_pgdata`}  (kept on teardown; reclaim: bun run smoke:clean)`);
}
console.log("");

const r = Bun.spawnSync(["docker", "compose", "ps"], {
  cwd: repoRoot,
  env: dockerEnv,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(r.exitCode ?? 0);
