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
import { makeDockerRunner, purgeDemoEvalContainers } from "./lib/demo-volumes.ts";
import { removeDemoAnalyticsToken } from "./lib/demo-secret.ts";
import { buildDemoLifecycleComposeEnv } from "./lib/demo-lifecycle-env.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const stateFile = join(repoRoot, ".agents", "demo-state.json");

interface DemoState {
  project: string;
  // A RECORD of what Docker assigned on the boot that wrote this file, not an
  // input: `down` publishes nothing and compose no longer interpolates a host
  // port anywhere. Reported below only so the operator recognises the stack.
  apiPort: number;
  // Optional: D21 retired the mcp container; newer state files omit it, but an
  // older standing demo's state file may still carry it.
  mcpPort?: number;
  pgPort?: number;
  // Did this boot apply docker-compose.stage.yml (`bun run demo -- --stage`),
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
  // True when the boot ran against a managed Postgres (`--external-pg`): there
  // is no postgres container to stop and no volume to keep, and the four fields
  // below are redacted placeholders rather than usable credentials. Optional —
  // state files written before the flag existed have no such field.
  externalPg?: boolean;
  databaseUrl: string;
  dbUser: string;
  dbPassword: string;
  dbName: string;
  /** External per-session Docker-secret path; contains no credential value. */
  analyticsTokenFile?: string;
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
//
// NO WEB_PORT / POSTGRES_PORT. They used to be required here purely to satisfy
// compose INTERPOLATION, because docker-compose.yml's port lines were
// `${VAR:?…}`. Those lines are gone: both services publish container ports only
// (`ports: ["8787"]` / `["5432"]`) and the daemon assigns the host side, so
// `docker compose config` for a teardown-shaped invocation resolves with no
// port input at all. One less thing a stale state file can get wrong.
const dockerEnv = buildDemoLifecycleComposeEnv(s, process.env);

console.log(
  s.externalPg
    ? `[demo:down] tearing down project=${s.project} (created ${s.createdAt}) — its database is EXTERNAL and is not touched…`
    : `[demo:down] tearing down project=${s.project} (created ${s.createdAt}) — keeping postgres data…`,
);
if (s.stage) {
  // Worth saying out loud: this is the demo the tunnel points at, so tearing it
  // down takes stage.robotmoney-labs.dev offline until a `--stage` boot returns.
  console.log(`[demo:down] this demo was booted with --stage (api pinned to :${s.apiPort}, the cloudflared origin) — the stage site goes down with it.`);
}

const run = makeDockerRunner(dockerEnv);
const purged = purgeDemoEvalContainers(run, { project: s.project });
if (purged.removed.length > 0) {
  console.log(`[demo:down] purged ${purged.removed.length} evaluation container(s): ${purged.removed.join(", ")}`);
}
if (purged.skipped.length > 0) {
  console.log(`[demo:down] WARNING: failed to purge evaluation container(s): ${purged.skipped.map((sk) => `${sk.name} (${sk.reason})`).join(", ")}`);
}

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

if (s.analyticsTokenFile) {
  if (!removeDemoAnalyticsToken(s.analyticsTokenFile, s.project)) {
    console.warn(`[demo:down] refused unsafe analytics-token cleanup path: ${s.analyticsTokenFile}`);
  }
}

if (s.externalPg) {
  // No volume, no bind dir, nothing kept — because nothing here ever owned the
  // data. Say which server the (now stopped) stack was writing to so the
  // operator knows where its rows actually went.
  console.log(`[demo:down] containers + network removed for ${s.project}; the EXTERNAL database is untouched (${s.databaseUrl})`);
  // Reproduce EVERY flag the stopped boot ran with. Both are CLI-only by design
  // (nothing is inferred from the state file at boot), so a hint that dropped
  // --stage would bring the demo back on a Docker-assigned port with the tunnel
  // still routed at :48787.
  console.log(`[demo:down]   resume:  bun run demo --${s.stage ? " --stage" : ""} --external-pg   (same server; migrate + seed are idempotent)`);
} else {
  const where = s.pgDataDir ? `--pg-data dir ${s.pgDataDir}` : `volume ${s.pgVolume ?? `${s.project}_pgdata`}`;
  console.log(`[demo:down] containers + network removed for ${s.project}; postgres data kept (${where})`);
  if (s.pgDataDir) {
    console.log(`[demo:down]   resume:  bun run demo -- --pg-data ${s.pgDataDir}`);
  }
  console.log(`[demo:down]   reclaim demo volumes when done: bun run demo:clean`);
}
console.log(`[demo:down] state file kept (points to the surviving data): ${stateFile}`);
