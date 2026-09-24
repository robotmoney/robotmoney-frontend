// `bun smoke:down [--instance <name>]` — stop one deployment instance's stack.
//
// Spec §1: `bun smoke` brings the stack up and EXITS; "`bun smoke:down` is the
// only way to stop them". It acts on ONE named instance (§1.1): the one named
// by `--instance`, or the only instance with state on this host (it refuses to
// guess between several). It reads the instance's stack record from its state
// directory (scripts/lib/smoke-state.ts), rebuilds the exact compose env, and
// runs `docker compose down` — WITHOUT `-v`: containers + network are removed
// but the postgres data volume is KEPT, so a later `bun smoke --local volume`
// reattaches it. Deleting smoke data is a SEPARATE, explicit act: `bun run
// smoke:clean`, which never touches a volume a running smoke still uses.
//
// It also CLOSES the instance's open journal: the journal described a running
// stack, and this command is the operator deliberately stopping it. A later
// run then starts from current state instead of refusing over a stop the
// operator asked for (§1.3 rule 3 is about ANOTHER operation's changes).
//
// A second instance on the same host is never touched: every compose call is
// scoped to this instance's recorded project.
//
// The stack record is KEPT (the data it points to survives, so the pointer must
// too); the next boot of the instance overwrites it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDockerRunner, purgeSmokeEvalContainers } from "./lib/smoke-volumes.ts";
import { removeSmokeAnalyticsToken } from "./lib/smoke-secret.ts";
import { buildSmokeLifecycleComposeEnv, dbModeFromState } from "./lib/smoke-lifecycle-env.ts";
import { instanceFlag, readStackState, selectExistingInstance, stateRoot } from "./lib/smoke-state.ts";
import { closeOpenJournal } from "./lib/smoke-journal.ts";
import { instanceComposeEnv } from "./stack/config.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");

let paths;
try {
  paths = selectExistingInstance(stateRoot(process.env), instanceFlag(process.argv.slice(2)));
} catch (err) {
  console.error(`[smoke:down] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const instance = paths.dir.split("/").at(-1)!;

let s;
try {
  s = readStackState(paths);
} catch (err) {
  console.error(`[smoke:down] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (s === null) {
  console.log(`[smoke:down] instance ${instance} has no stack record (${paths.stackStateFile}); nothing to tear down.`);
  if (closeOpenJournal(paths, "stopped by bun smoke:down")) console.log(`[smoke:down] closed its open journal.`);
  process.exit(0);
}

// A run still holding the deployment lock is told nothing by this command; say
// so, because its journal will describe a stack that no longer exists.
if (existsSync(paths.lockFile)) {
  let holder = "unknown";
  try { holder = String((JSON.parse(readFileSync(paths.lockFile, "utf8")) as { holderPid?: number }).holderPid ?? "unknown"); } catch { /* still a lock */ }
  console.warn(`[smoke:down] WARNING: a \`bun smoke\` run (pid ${holder}) holds instance ${instance}'s deployment lock; stopping its stack anyway.`);
}

// Rebuild the same compose env the boot used, so we target the right project:
// the stack record's values plus the instance's own state directory, which the
// compose file requires (no checkout fallback).
const dockerEnv = {
  ...buildSmokeLifecycleComposeEnv(s, process.env),
  ...instanceComposeEnv({ name: instance, stateDir: paths.dir }),
};

const mode = dbModeFromState(s);
console.log(
  mode === "external"
    ? `[smoke:down] tearing down instance ${instance} (project=${s.project}, created ${s.createdAt}) — its database is EXTERNAL and is not touched…`
    : `[smoke:down] tearing down instance ${instance} (project=${s.project}, created ${s.createdAt}) — keeping postgres data…`,
);
if (s.stage) {
  // Worth saying out loud: this is the smoke the tunnel points at, so tearing it
  // down takes stage.robotmoney-labs.dev offline until a `--static-port` boot returns.
  console.log(`[smoke:down] this smoke was booted with --static-port (web pinned to :${s.webPort}, the cloudflared origin) — the stage site goes down with it.`);
}

const run = makeDockerRunner(dockerEnv);
const purged = purgeSmokeEvalContainers(run, { project: s.project });
if (purged.removed.length > 0) {
  console.log(`[smoke:down] purged ${purged.removed.length} evaluation container(s): ${purged.removed.join(", ")}`);
}
if (purged.skipped.length > 0) {
  console.log(`[smoke:down] WARNING: failed to purge evaluation container(s): ${purged.skipped.map((sk) => `${sk.name} (${sk.reason})`).join(", ")}`);
}

// NO `-v`: keep the volume. `--env-file /dev/null`: compose must not read the
// checkout's `.env` for interpolation (scripts/stack/config.ts composeArgs()).
const r = Bun.spawnSync(["docker", "compose", "--env-file", "/dev/null", "down"], {
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
  if (!removeSmokeAnalyticsToken(s.analyticsTokenFile, paths)) {
    console.warn(`[smoke:down] refused unsafe analytics-token cleanup path: ${s.analyticsTokenFile}`);
  }
}

if (s.smokeTwinContainer) {
  // AFTER `compose down`, never before: the stack must stop talking to the smoke-twin
  // before it disappears.
  const rm = Bun.spawnSync(["docker", "rm", "-f", s.smokeTwinContainer], { stdout: "ignore", stderr: "ignore" });
  console.log(
    rm.exitCode === 0
      ? `[smoke:down] smoke-twin container ${s.smokeTwinContainer} removed.`
      : `[smoke:down] WARNING: could not remove smoke-twin container ${s.smokeTwinContainer} (already gone?).`,
  );
}

if (closeOpenJournal(paths, "stopped by bun smoke:down")) {
  console.log(`[smoke:down] closed instance ${instance}'s open journal (the next boot starts from current state).`);
}

if (mode === "smoke-twin") {
  console.log(`[smoke:down] containers + network removed for ${s.project}; the smoke-twin's restored copy of production is KEPT in volume ${s.smokeTwinVolume ?? "(unrecorded)"}`);
  console.log(`[smoke:down]   that copy holds real credential material — reclaim it with: bun run smoke:clean`);
  console.log(`[smoke:down]   re-run (restores a FRESH copy from backup ${s.smokeTwinBackupStamp ?? "?"}):  bun smoke --local dump --instance ${instance}`);
} else if (mode === "external") {
  // Nothing here ever owned the data. Say which server the (now stopped) stack
  // was writing to so the operator knows where its rows actually went.
  console.log(`[smoke:down] containers + network removed for ${s.project}; the EXTERNAL database is untouched (${s.databaseUrl})`);
  console.log(`[smoke:down]   resume:  bun smoke${s.stage ? " --static-port" : ""} --instance ${instance}   (same server)`);
} else {
  const volume = s.pgVolume ?? `${s.project}_pgdata`;
  console.log(`[smoke:down] containers + network removed for ${s.project}; postgres data kept (volume ${volume})`);
  console.log(`[smoke:down]   resume:  bun smoke${s.stage ? " --static-port" : ""} --local volume --instance ${instance}`);
  console.log(`[smoke:down]   reclaim smoke volumes when done: bun run smoke:clean`);
}
console.log(`[smoke:down] stack record kept (points to the surviving data): ${paths.stackStateFile}`);
