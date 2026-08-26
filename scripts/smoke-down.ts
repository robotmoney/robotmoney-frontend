// Explicit teardown for the standing local smoke. Reads .agents/smoke-state.json,
// rebuilds the exact docker compose env, and runs `docker compose down` — WITHOUT
// `-v` (issue: smoke persistent volumes): containers + network are removed but the
// postgres data volume (or the `--pg-data` host dir) is KEPT, so a later
// `bun run smoke` resumes from where it left off.
//
// This matches the running smoke's own Ctrl-C / SIGTERM behavior — both now keep
// data (see scripts/lib/smoke-main.ts onSignal()/cleanup() and docs/architecture.md
// §(c)). Deleting smoke data is a SEPARATE, explicit act: `bun run smoke:clean`
// (scripts/smoke-clean.ts) removes the label-namespaced smoke volumes; it never
// touches a `--pg-data` host directory.
//
// State-file policy: the state file is KEPT on teardown (the data it points to
// survives, so the pointer must too) — `smoke:status` reads it, and it stays until
// the next boot overwrites it or `smoke:clean` removes the volume it names.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDockerRunner, purgeSmokeEvalContainers } from "./lib/smoke-volumes.ts";
import { removeSmokeAnalyticsToken } from "./lib/smoke-secret.ts";
import { buildSmokeLifecycleComposeEnv, dbModeFromState } from "./lib/smoke-lifecycle-env.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const stateFile = join(repoRoot, ".agents", "smoke-state.json");

interface SmokeState {
  project: string;
  // A RECORD of what Docker assigned on the boot that wrote this file, not an
  // input: `down` publishes nothing and compose no longer interpolates a host
  // port anywhere. Reported below only so the operator recognises the stack.
  apiPort: number;
  // Optional: D21 retired the mcp container; newer state files omit it, but an
  // older standing smoke's state file may still carry it.
  mcpPort?: number;
  pgPort?: number;
  // Did this boot apply docker-compose.stage.yml (`bun run smoke -- --stage`),
  // pinning the api to the cloudflared origin? Provenance only. Optional
  // because a state file written before --stage existed has no such flag.
  stage?: boolean;
  // Environment class + hash (scripts/stack/naming.ts) so the labels compose
  // interpolates here match the ones `up` stamped. Optional for the same
  // backward-compatibility reason; labels are irrelevant to `down` (it creates
  // nothing), so an older file just leaves them unknown rather than failing.
  envClass?: string;
  envHash?: string;
  composeFiles: string;
  // Which data path the boot ran against (`--db`). For every non-ephemeral mode
  // there is no compose postgres container to stop, and the four fields below are
  // redacted placeholders rather than usable credentials. BOTH are optional and
  // dbModeFromState() reconciles them: `db` is authoritative, `externalPg` is the
  // pre-refactor boolean a state file written before `--db` carries.
  db?: string;
  externalPg?: boolean;
  // Twin only: the container this boot restored production into, the volume
  // holding that copy, and the backup it came from. The container is removed
  // here; the VOLUME is kept, exactly as pgdata is (smoke:clean reclaims it).
  smokeTwinContainer?: string;
  smokeTwinVolume?: string;
  smokeTwinBackupStamp?: string;
  databaseUrl: string;
  dbUser: string;
  dbPassword: string;
  dbName: string;
  /** External per-session Docker-secret path; contains no credential value. */
  analyticsTokenFile?: string;
  // Exactly one is set (issue: smoke persistent volumes): a `--pg-data` host bind
  // dir, or the fresh-per-run named volume that survives teardown.
  pgDataDir?: string;
  pgVolume?: string;
  createdAt: string;
}

if (!existsSync(stateFile)) {
  console.log("[smoke:down] no smoke state found (nothing to tear down)");
  process.exit(0);
}

const s: SmokeState = JSON.parse(readFileSync(stateFile, "utf8"));

// Rebuild the same dockerEnv the smoke used, so we target the right project.
//
// NO WEB_PORT / POSTGRES_PORT. They used to be required here purely to satisfy
// compose INTERPOLATION, because docker-compose.yml's port lines were
// `${VAR:?…}`. Those lines are gone: both services publish container ports only
// (`ports: ["8787"]` / `["5432"]`) and the daemon assigns the host side, so
// `docker compose config` for a teardown-shaped invocation resolves with no
// port input at all. One less thing a stale state file can get wrong.
const dockerEnv = buildSmokeLifecycleComposeEnv(s, process.env);

const mode = dbModeFromState(s);
console.log(
  mode === "external"
    ? `[smoke:down] tearing down project=${s.project} (created ${s.createdAt}) — its database is EXTERNAL and is not touched…`
    : `[smoke:down] tearing down project=${s.project} (created ${s.createdAt}) — keeping postgres data…`,
);
if (s.stage) {
  // Worth saying out loud: this is the smoke the tunnel points at, so tearing it
  // down takes stage.robotmoney-labs.dev offline until a `--stage` boot returns.
  console.log(`[smoke:down] this smoke was booted with --static-port (api pinned to :${s.apiPort}, the cloudflared origin) — the stage site goes down with it.`);
}

const run = makeDockerRunner(dockerEnv);
const purged = purgeSmokeEvalContainers(run, { project: s.project });
if (purged.removed.length > 0) {
  console.log(`[smoke:down] purged ${purged.removed.length} evaluation container(s): ${purged.removed.join(", ")}`);
}
if (purged.skipped.length > 0) {
  console.log(`[smoke:down] WARNING: failed to purge evaluation container(s): ${purged.skipped.map((sk) => `${sk.name} (${sk.reason})`).join(", ")}`);
}

// NO `-v`: keep the volume / --pg-data dir.
const r = Bun.spawnSync(["docker", "compose", "down"], {
  cwd: repoRoot,
  env: dockerEnv,
  stdout: "inherit",
  stderr: "inherit",
});

if (r.exitCode !== 0) {
  console.error(`[smoke:down] docker compose down exited ${r.exitCode}`);
  process.exit(r.exitCode ?? 1);
}

if (s.analyticsTokenFile) {
  if (!removeSmokeAnalyticsToken(s.analyticsTokenFile, s.project)) {
    console.warn(`[smoke:down] refused unsafe analytics-token cleanup path: ${s.analyticsTokenFile}`);
  }
}

if (s.smokeTwinContainer) {
  // AFTER `compose down`, never before: the stack must stop talking to the smoke-twin
  // before it disappears, the same ordering smoke-main's cleanup() uses.
  const rm = Bun.spawnSync(["docker", "rm", "-f", s.smokeTwinContainer], { stdout: "ignore", stderr: "ignore" });
  console.log(
    rm.exitCode === 0
      ? `[smoke:down] smoke-twin container ${s.smokeTwinContainer} removed.`
      : `[smoke:down] WARNING: could not remove smoke-twin container ${s.smokeTwinContainer} (already gone?).`,
  );
}

if (mode === "smoke-twin") {
  console.log(`[smoke:down] containers + network removed for ${s.project}; the smoke-twin's restored copy of production is KEPT in volume ${s.smokeTwinVolume ?? "(unrecorded)"}`);
  console.log(`[smoke:down]   that copy holds real credential material — reclaim it with: bun run smoke:clean`);
  console.log(`[smoke:down]   re-run (restores a FRESH copy from backup ${s.smokeTwinBackupStamp ?? "?"}):  bun smoke -- --db smoke-twin`);
} else if (mode === "external") {
  // No volume, no bind dir, nothing kept — because nothing here ever owned the
  // data. Say which server the (now stopped) stack was writing to so the
  // operator knows where its rows actually went.
  console.log(`[smoke:down] containers + network removed for ${s.project}; the EXTERNAL database is untouched (${s.databaseUrl})`);
  // Reproduce EVERY flag the stopped boot ran with. Both are CLI-only by design
  // (nothing is inferred from the state file at boot), so a hint that dropped
  // --static-port would bring the smoke back on a Docker-assigned port with the
  // tunnel still routed at :48787.
  console.log(`[smoke:down]   resume:  bun run smoke --${s.stage ? " --static-port" : ""} --db external   (same server; migrate + seed are idempotent)`);
} else {
  const where = s.pgDataDir ? `--pg-data dir ${s.pgDataDir}` : `volume ${s.pgVolume ?? `${s.project}_pgdata`}`;
  console.log(`[smoke:down] containers + network removed for ${s.project}; postgres data kept (${where})`);
  if (s.pgDataDir) {
    console.log(`[smoke:down]   resume:  bun run smoke -- --pg-data ${s.pgDataDir}`);
  }
  console.log(`[smoke:down]   reclaim smoke volumes when done: bun run smoke:clean`);
}
console.log(`[smoke:down] state file kept (points to the surviving data): ${stateFile}`);
