import { existsSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSmokeEnv } from "./smoke-env.ts";
import { hostname } from "node:os";
import { loadEnvFile, postgresPhaseNarration } from "./smoke-external-pg.ts";
import { databaseName, homeEnvFilePath, urlForRole } from "./env-role.ts";
import { bannerFor, dataPathOverlayYaml, keptDataDescription, LOCAL_FLAG, localModeOf, lockTimeoutMs, ownsData, parseDataPath, parseVolumeHolders, reattachOverlayYaml, redactPostgresUrl, refuseRetiredEnv, refuseVolumeInUse, requestsDump, requestsMigrate, shouldSeed, targetConnection, usesComposePostgres, type ResolvedDataPath } from "./smoke-db-mode.ts";
import { dropShellMigrationCredential, shadowingStackEnvWarnings, smokePassthroughEnv, stackAllowInsecureFor, stackRmEnvFor } from "./smoke-compose-env.ts";
import { resolveBackupFiles } from "./restore-container.ts";
import { resolveDeploymentPolicy, resolveRmEnv } from "./smoke-env-policy.ts";
import { requireRehearsalTarget } from "./smoke-identity.ts";
import { dumpOwnershipSql, hostReadTargetState, instanceRolePasswords, localSuperuserSql, operatorTerminal, prepareChildEnv, roleUrl, runPrepareStep, superuserSqlSettled, type HostTarget, type PrepareStep } from "./smoke-database.ts";
import { acquireTargetLock, assertStillHeld, readTargetState, type TargetLock, type TargetState } from "../../backend/src/db/target-lock.ts";
import type { GeneratedRolePasswords } from "./smoke-state.ts";
import { assertSmokeTwinIsTarget, bringUpTwin, smokeTwinLeftRunningHint, smokeTwinResumeHint, smokeTwinTeardownNarration, smokeTwinUrlFromContainer, smokeTwinVolumeName } from "./smoke-twin.ts";
import { teardownContainer } from "./restore-container.ts";
import { listSmokeVolumes, makeDockerRunner, purgeSmokeEvalContainers, removeSmokeVolumes } from "./smoke-volumes.ts";
import { OPERATOR_TOKEN_FILE_ENV } from "./operator-token.ts";
import { readServiceToken, runTokenProvisioning, tokenReuseRefusal } from "./smoke-secret.ts";
import { awaitReadiness, READINESS_POLL_MS, READINESS_TIMEOUT_MS, type GateCheck } from "./smoke-readiness-scheduler.ts";
import { makeReadinessObserver } from "./smoke-readiness-probes.ts";
import { readWebCompatPlan, webCompatRefusal } from "./smoke-web-compat.ts";
import { readContractVersion } from "./api-range.ts";
import { decideRegimeBootAction, REGIME_BOOT_MAX_ATTEMPTS, type RegimeBootStaleness } from "./regime-boot.ts";
import { renderCadenceLine, resolveSmokeCadenceForBoot, stageCadenceApplies } from "./smoke-cadence.ts";
import {
  admissionRecord,
  ADMISSION_RECORD_FILE,
  formatAdmissionRecords,
  resolveModelConfig,
  runOnboardingEvalWithRetry,
  type AdmissionRecord,
  type OnboardingEvalResult,
} from "./onboarding-eval.ts";
import type { RmEnv } from "../../backend/src/acceptance-path.ts";
import { decideImagesOverride } from "./smoke-images-override.ts";
import { preflightInferenceOrExit } from "./smoke-inference-preflight.ts";
import { adoptRestoredRoster, resolveSeatAllRestored, scenarioPlan } from "./smoke-mode.ts";
import {
  assertStageWebPortFree,
  buildContextsFor,
  buildSpawnEnv,
  createStack,
  DEFAULT_STACK_DATABASE,
  describePortHolders,
  composeArgs,
  dockerClientHostEnv,
  hostBackendUrl,
  internalDatabaseUrl,
  makeCommandRunner,
  PortUnavailableError,
  resolveStackEnvironment,
  stackProjectName,
  stalePortEnvWarnings,
  STAGE_COMPOSE_FILE,
  STAGE_WEB_PORT,
  type Stack,
  type StackConfig,
  type StackEvent,
  type StackHostPorts,
  type StackStep,
  WORKER_LANE_SERVICES,
} from "../stack/index.ts";
import { gitRunner, resolveSourceIdentities } from "../stack/source-identity.ts";
import { ROUTES } from "@robotmoney/contract";
import { DB_WRITER_SERVICES, selectFailureDetail, writerQuiesceLine } from "./smoke-failure.ts";
import { POSTGRES_IMAGE } from "./postgres-image.ts";
import {
  acquireDeploymentLock,
  instanceFlag,
  instancePaths,
  readRolePasswords,
  readStackState,
  resolveInstance,
  SERVICE_TOKEN_HOLDERS,
  stateRoot,
  writeStackState,
  type DeploymentLock,
} from "./smoke-state.ts";
import {
  closeOpenJournal,
  JournalClosedUnderneathError,
  computePlanId,
  decideResume,
  expectationMismatch,
  openJournal,
  projectExpectations,
  publicKeyFingerprint,
  readJournal,
  renderPlan,
  watchForInterrupt,
  writeReceipt,
  type DeploymentPhase,
  type DeploymentPlan,
  type JournalWriter,
  type PhaseOutcome,
  type PlanId,
  type PlanTarget,
  type RosterMember,
  type StateExpectations,
} from "./smoke-journal.ts";
import { CredentialFileRefusal, loadCredentialFile, resolveCredentialPath, type CredentialEntry } from "./swarm/credential-file.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Refusals that precede everything ---------------------------------------
// Spec §1 retires SMOKE_PROJECT with no alias, and smoke-db-mode.ts owns the
// refusal text. Checked before any argument is read, any port probed or any
// credential minted, so a refused boot leaves the host exactly as it found it.
const retiredEnv = refuseRetiredEnv(process.env);
if (retiredEnv) {
  console.error(`[smoke] FATAL: ${retiredEnv}`);
  process.exit(1);
}

// --- Run config -----------------------------------------------------------
// HOST PORTS ARE ASSIGNED BY DOCKER. Both published ports (api and postgres)
// are chosen by the daemon: docker-compose.yml publishes container ports only
// (`ports: ["8787"]` / `["5432"]`), and this file learns the host side back
// from `docker compose port` after the containers are up. Nothing here — and
// nothing in .env / .env.example — names a host port.
//
// Why (the full rationale is in scripts/stack/ports.ts's header). Two shapes
// have already failed. First, a FIXED default: the api port "preferred" 48787,
// so a CI boot (no `.env`) raced the standing stage smoke for the exact port
// cloudflared routes stage.robotmoney-labs.dev to and took the site down, while
// the operator's `.env` pinned both ports so nothing was random locally at all.
// Then, a SELF-DRAWN random port: bind a free port, close it, hand the number
// to compose — a TOCTOU race, because anything on this box (a second smoke, a
// concurrent job on the self-hosted runner) can take the port in the gap before
// compose binds it, and randomizing more stacks only widened the gap. Docker
// choosing and binding in one step inside the daemon has neither failure mode.
// (D21 retired the member-facing MCP server — there is no longer an `mcp`
// container or host port; members reach the swarm REST API on the api port.)
//
// THE ONE EXCEPTION: `bun run smoke -- --static-port` appends docker-compose.stage.yml,
// which pins the api's host port (only) to 48787, the tunnel origin. It is a
// CLI ARGUMENT, never an env var — the same hard rule every data-path flag follows (no
// per-property env config) — because pinning the tunnel port is a property of
// one deliberate invocation, never of a shell that happens to have something
// exported. It FAILS LOUDLY when the port is held rather than falling back,
// because cloudflared routes 48787 and nothing else: a fallback would produce a
// green boot serving a 502. Postgres stays Docker-assigned even when pinned.
// `--static-port` says what the flag DOES: it pins the web/api host port to the
// one fixed number in the system instead of letting Docker assign one. The old
// name, `--stage`, described an environment rather than an effect, which made it
// read like "boot the staging environment" — it never did that; it only pinned a
// port. `--stage` is now refused by name (smoke-db-mode.ts RETIRED_FLAGS).
const STATIC_PORT_FLAG = "--static-port";
// A dump implies the production-shaped scenario: it is restored, populated real
// data, so the boot must never run the simulation seed against it. Nothing else
// selects that scenario: the retired `--smoke` flag is refused. (smoke-mode.ts
// holds the scenario decisions; this file is only the wiring.)
const smokeMode = requestsDump(process.argv);
const scenario = scenarioPlan(smokeMode);
const staticPortMode = process.argv.includes(STATIC_PORT_FLAG);
// AC-ID-05 — wiring only; the decision is scripts/lib/smoke-images-override.ts.
const imagesOverrideDecision = decideImagesOverride(process.argv, process.env);
for (const line of imagesOverrideDecision.banner) console.warn(`[smoke] ${line}`);
const imagesOverride = imagesOverrideDecision.path;

// …and the same argument selects the smoke's CADENCE PROFILE (issue #371): a
// `--static-port` boot is the standing/public smoke; every other boot, CI
// included, keeps the fast values. Every number lives in
// scripts/lib/smoke-cadence.ts, which also ASSERTS that the constants resolved
// here are the ones this invocation claims — fatal if not. …EXCEPT on a dump,
// which is a test instrument and runs FAST however the port is pinned — see
// stageCadenceApplies() in smoke-cadence.ts.
const twinBoot = requestsDump(process.argv);

// Loud, never silent. A stale `.env` (or an exported shell var) carrying
// WEB_PORT/POSTGRES_PORT no longer influences anything; say so with the reason
// rather than letting an operator believe a pin took effect.
for (const warning of stalePortEnvWarnings(process.env)) console.warn(`[smoke] ${warning}`);
// Same rule for a stack-owned DATABASE URL (WORKER_DATABASE_URL) inherited from a
// `.env` shared with the persistent deployment: dropped, and said out loud. It used
// to be forwarded, which pointed the worker lanes at a `postgres` host a twin boot
// does not have — see smoke-compose-env.ts.
for (const warning of shadowingStackEnvWarnings(process.env)) console.warn(`[smoke] ${warning}`);
// And a migration credential: nothing in this boot reads one from the
// environment (the migrate run logs in as rm_owner with the generated or the
// typed password, on the host). An exported one is dropped HERE, before
// anything could read it or hand it on.
{
  const dropped = dropShellMigrationCredential(process.env);
  if (dropped) console.warn(`[smoke] ${dropped}`);
}

if (staticPortMode) {
  console.warn(
    `[smoke] ############################################################\n` +
      `[smoke] # --static-port: the web/api host port is PINNED to ${STAGE_WEB_PORT}.\n` +
      `[smoke] # This is the ONE fixed port in the system — cloudflared routes\n` +
      `[smoke] # stage.robotmoney-labs.dev to it and to nothing else. Only one\n` +
      `[smoke] # stack can hold it at a time, so do not run --static-port\n` +
      `[smoke] # alongside another pinned boot or CI's smoke. Postgres (and every\n` +
      `[smoke] # other published port) is still DOCKER-ASSIGNED.\n` +
      `[smoke] ############################################################`,
  );
}

// --static-port PRE-FLIGHT. The pin lives entirely in docker-compose.stage.yml,
// so a held 48787 would surface as compose's own bind failure — accurate but
// opaque, and silent about WHO holds the port. This check runs BEFORE `compose
// up` so the operator gets the actionable version: name the holder, refuse to
// boot, exit non-zero. A diagnostic, not an allocation.
async function stagePreflight(): Promise<void> {
  try {
    await assertStageWebPortFree();
  } catch (err) {
    if (err instanceof PortUnavailableError) {
      console.error(`[smoke] FATAL: ${err.message}`);
      console.error(`[smoke] what currently holds :${err.port}:`);
      console.error(describePortHolders(err.port, makeCommandRunner(process.env)));
      console.error(
        `[smoke] NOT falling back to another port: cloudflared routes only :${STAGE_WEB_PORT}, so a\n` +
          `[smoke] fallback would boot green and serve a 502 to every visitor. Free the port\n` +
          `[smoke] (e.g. \`bun run smoke:down\` for a standing smoke) and re-run, or drop --static-port\n` +
          `[smoke] to boot on a Docker-assigned port with no tunnel.`,
      );
      process.exit(1);
    }
    throw err;
  }
}

/** A refusal before anything was mutated: name it and exit non-zero. */
function fatal(err: unknown): never {
  console.error(`[smoke] FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

/** The value of an arity-1 flag, `--flag value` or `--flag=value`; smoke-db-mode.ts validated the shape. */
function flagValue(flag: string): string | undefined {
  for (let i = 2; i < process.argv.length; i++) {
    const token = process.argv[i]!;
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
    if (token === flag) return process.argv[i + 1];
  }
  return undefined;
}

// --- Which database this boot runs against (--local <mode>) ------------------
// Every decision the flag implies — the three modes, the refusals, the banner —
// lives in scripts/lib/smoke-db-mode.ts; this file holds only the wiring.
// Resolved HERE, before the port preflight, before any credential is minted and
// before any container is created, so a bad or retired invocation fails on an
// untouched host rather than half-way through a bring-up.
let requestedDataPath: ReturnType<typeof parseDataPath>["dataPath"];
let cadence: ReturnType<typeof resolveSmokeCadenceForBoot>;
try {
  const parsed = parseDataPath(process.argv, { envFilePath: homeEnvFilePath() });
  requestedDataPath = parsed.dataPath;
  cadence = resolveSmokeCadenceForBoot({ stage: stageCadenceApplies(staticPortMode, twinBoot), cadence: parsed.cadence });
} catch (err) {
  fatal(err);
}

// --- The §4.1 policy and the §4.3 matrix, before the instance -----------------
// Refused BEFORE the instance is resolved: resolution may persist a fresh
// instance name, and a refused boot leaves the host exactly as it found it.
//
// RM_ENV comes from the process, else — for the remote database — from `~/.env`
// (§3 lists it there; args override env). A local mode reads no `~/.env` at all
// (§3: it ignores every remote connection value). The matrix is ONE function,
// backend/src/deploy-policy.ts, the same one `bun run migrate` and preflight
// check 5 call. Every row that does not depend on the target's answer refuses
// HERE — unset against a remote, `prod` against a local mode, any other value —
// judged with the one identity that row could allow. The rows that do depend on
// it run again, on the target's own answer, once the target lock is held.
const homeEnv: Record<string, string> = requestedDataPath.kind === "external" ? (loadEnvFile(homeEnvFilePath()) ?? {}) : {};
const declaredRmEnv = process.env.RM_ENV ?? homeEnv.RM_ENV;
const connection = targetConnection(requestedDataPath);
const parsedPolicy = resolveRmEnv({ RM_ENV: declaredRmEnv });
const earlyVerdict = resolveDeploymentPolicy({
  rmEnv: declaredRmEnv,
  connection,
  identity: parsedPolicy.ok && parsedPolicy.env === "prod" ? "production" : "rehearsal",
});
if (!earlyVerdict.allow) fatal(earlyVerdict.reason);
for (const warning of earlyVerdict.warnings) console.warn(`[smoke] ${warning}`);
const policy = earlyVerdict.env;
// §4.3, §8.5: `--migrate` and `--seed` are rehearsal-only and refuse on
// RM_ENV=prod, whatever the database says — so that refusal needs no database
// and comes before anything connects, and long before any owner prompt.
for (const [requested, preparation] of [[requestsMigrate(process.argv), "migrate"], [shouldSeed(process.argv), "seed"]] as const) {
  const gate = requested && policy === "prod" ? requireRehearsalTarget({ preparation, rmEnv: "prod", identity: "rehearsal", explicitlyRequested: true }) : null;
  if (gate && !gate.allow) fatal(gate.reason);
}
if (staticPortMode) await stagePreflight();
// The containers' RM_ENV: the policy, and `prod` on the standing stack by rule.
const stackRmEnv: RmEnv = stackRmEnvFor(staticPortMode, policy);
// …and this process's own, so every host-side reader of RM_ENV (the inference
// preflight below, the drivers this boot starts) judges the boot by the policy
// the matrix resolved — an unset RM_ENV under `--local` is `stage` (§4.3), a
// `~/.env` RM_ENV counts as set — never by the raw shell value (D13).
process.env.RM_ENV = stackRmEnv;

// --- Which deployment instance this run acts on (spec §1.1) -----------------
// `--instance <name>`; then the CI job's identity; then the name a previous
// local run persisted; then a fresh one, persisted. The precedence and its
// refusals are resolveInstance() in smoke-state.ts. Every state file this run
// writes — the plan's journal, the receipt, the deployment lock, the stack
// record, the log, the generated overlays, the analytics token, the website —
// lives under the instance's directory in the state root
// ($HOME/.local/state/robotmoney-smoke/<instance>, or an absolute
// RM_SMOKE_STATE_ROOT), never in the checkout: `git clean` or a worktree switch
// must not be able to lose or leak the record of what was done to a database.
//
// The instance follows the POLICY resolved above: `prod` is the production
// instance `rm_prod` (resolveInstance refuses any other name under it).
const statesRoot = (() => {
  try {
    return stateRoot(process.env);
  } catch (err) {
    return fatal(err);
  }
})();
const instance = (() => {
  try {
    return resolveInstance({
      flag: instanceFlag(process.argv.slice(2)),
      rmEnv: policy,
      environment: resolveStackEnvironment(process.env),
      stateRoot: statesRoot,
    });
  } catch (err) {
    return fatal(err);
  }
})();
const paths = instancePaths(statesRoot, instance.name, { create: true });
// WHICH ENVIRONMENT this boot belongs to (scripts/stack/naming.ts): `ci` under
// GitHub Actions with a hash of the job's identity (stable for every step of
// one job), `local` otherwise, hashed from the INSTANCE name so the compose
// project — and with it the pgdata volume and every container name — is the
// same on every boot of one instance. That stability is what lets a rerun find
// the stack and the volume its journal describes; a per-boot random project
// gave every rerun a new plan id (§1.2 hashes the volume name), so no journal
// could ever resume.
const stackEnvironment = resolveStackEnvironment(process.env, { seed: instance.name });
// The compose project is ALWAYS the environment-scoped name, e.g.
// `rm_smoke_stack_9f2a1c4b7d` locally or `rm_ci_stack_…` under Actions. It
// used to be overridable by an exported SMOKE_PROJECT; spec §1 retires that
// with no alias (refused at the top of this file).
const project = stackProjectName("stack", stackEnvironment);
/** The pgdata volume compose creates for this instance's own postgres. */
const instanceVolume = `${project}_pgdata`;

// `--local volume` with no name reattaches the volume this INSTANCE's last boot
// recorded. Refused, not guessed, when there is none: a fresh volume under a
// reattach flag would boot green on an empty database.
if (requestedDataPath.kind === "ephemeral" && requestedDataPath.reattach && !requestedDataPath.reattach.volume) {
  let saved: string | undefined;
  try { saved = readStackState(paths)?.pgVolume; } catch (err) { fatal(err); }
  if (!saved) {
    fatal(`${LOCAL_FLAG} volume found no saved volume for instance ${instance.name} (${paths.stackStateFile}); name one with ${LOCAL_FLAG} volume=<name>.`);
  }
  requestedDataPath = { kind: "ephemeral", reattach: { volume: saved } };
}
// …and refused while a running container of ANOTHER stack still mounts it,
// named or saved. This instance's own postgres is not a second writer: compose
// keeps (or recreates) the one container that already mounts it. Checked
// before any overlay is written or container created. Fails closed when the
// daemon cannot be asked: an unknown holder is not an absent one.
if (requestedDataPath.kind === "ephemeral" && requestedDataPath.reattach?.volume) {
  const volume = requestedDataPath.reattach.volume;
  const ps = Bun.spawnSync(
    ["docker", "ps", "--filter", `volume=${volume}`, "--format", '{{.Names}}\t{{.Label "com.docker.compose.project"}}'],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (ps.exitCode !== 0) {
    fatal(`${LOCAL_FLAG} volume=${volume}: could not ask Docker which containers mount it: ${ps.stderr.toString().trim()}`);
  }
  const inUse = refuseVolumeInUse(volume, parseVolumeHolders(ps.stdout.toString()).filter((h) => h.project !== project));
  if (inUse) fatal(inUse);
}

// Twin/stage: seat the FULL restored committee, not just the three committed
// personas. Reasoning in smoke-mode.ts, pin in roster-plan.test.ts: the remote
// database never qualifies.
const seatAllRestored = resolveSeatAllRestored({ smoke: smokeMode, stage: staticPortMode, dataPath: requestedDataPath });
// Two DIFFERENT questions, and for a smoke-twin they disagree — see smoke-db-mode.ts.
// Both read only the mode, so they are known before a smoke-twin has been restored.
const composePostgres = usesComposePostgres(requestedDataPath);
const reclaimable = ownsData(requestedDataPath);

// Filled in from `docker compose port` once the containers exist — see
// applyHostPorts() below. They are 0 until then, and nothing may publish a URL
// built from them before that: a number nobody assigned is worse than no number.
// pgPort stays NULL for a boot with no compose postgres (distinct from 0, which
// would read as "not discovered yet").
let apiPort = 0;
let webPort = 0;
let pgPort: number | null = 0;
let backendUrl = "";

// A `--local dump` is RESTORED as a journaled preparation (main(), after the
// plan): restoring is the most expensive mutation a boot makes, and §7 puts
// "database create/restore" after "plan and deployment lock". Only the
// volume's NAME is needed for the plan, and it is known from the backup's
// stamp without restoring anything.
const twinBackup = (() => {
  if (requestedDataPath.kind !== "smoke-twin") return undefined;
  const backup = resolveBackupFiles(requestedDataPath.backupDir);
  if ("error" in backup) return fatal(`--local dump: ${backup.error}`);
  return backup;
})();
/** The resolved data path. A dump's is assigned by its restore in main(). */
let dataPath: ResolvedDataPath =
  requestedDataPath.kind === "smoke-twin"
    ? { kind: "smoke-twin", backupDir: requestedDataPath.backupDir, url: "", redactedUrl: "(not restored yet)", container: "", volume: smokeTwinVolumeName(project, twinBackup!.stamp), stamp: twinBackup!.stamp }
    : requestedDataPath;
let smokeTwinContainer: string | undefined;
/** The ONLY form of a non-ephemeral connection safe to print or record. */
const redactedDbUrl = (): string | undefined => (dataPath.kind === "ephemeral" ? undefined : dataPath.redactedUrl);
// Only a non-default data path gets the banner: an ordinary `bun run smoke` boots
// its own container and has no consequence to warn about.
if (!composePostgres && dataPath.kind === "external") console.warn(bannerFor(dataPath));

// The baked-in smoke database credentials come from the shared stack config
// (scripts/stack/config.ts), which carries the "127.0.0.1, never localhost"
// rationale for backendUrl. For every non-ephemeral mode the resolved URL is
// carried on the database config, which is what makes internalDatabaseUrl()
// hand containers that URL and what makes scripts/stack drop the postgres
// service (stack.ts keys off `Boolean(cfg.database.url)`).
//
// The containers get the RUNTIME roles and nothing else (§3, §7.3): `api`
// rm_app, the pipeline worker rm_worker. A local mode's are the instance's
// generated passwords (set by the `instance` preparation, or read back), the
// remote database's are `~/.env`'s. The local superuser is never handed to one.
let rolePasswords: GeneratedRolePasswords | undefined;
function containerRoleUrls(dp: ResolvedDataPath): { app: string; worker: string } {
  if (dp.kind === "external") return { app: dp.url, worker: remote!.workerUrl };
  if (!rolePasswords) throw new Error("the instance's role passwords are not loaded yet");
  const target: HostTarget = dp.kind === "smoke-twin"
    ? { host: new URL(dp.url).hostname, port: Number(new URL(dp.url).port), database: decodeURIComponent(new URL(dp.url).pathname.slice(1)), sslmode: "disable" }
    : { host: "postgres", port: 5432, database: DEFAULT_STACK_DATABASE.name, sslmode: "disable" };
  return { app: roleUrl(target, "rm_app", rolePasswords.rm_app), worker: roleUrl(target, "rm_worker", rolePasswords.rm_worker) };
}
const databaseFor = (dp: ResolvedDataPath) => {
  const roleUrls = containerRoleUrls(dp);
  return dp.kind === "ephemeral" ? { ...DEFAULT_STACK_DATABASE, roleUrls } : { ...DEFAULT_STACK_DATABASE, url: roleUrls.app, roleUrls };
};
const DB_USER = DEFAULT_STACK_DATABASE.user;
const DB_PASSWORD = DEFAULT_STACK_DATABASE.password;
const DB_NAME = DEFAULT_STACK_DATABASE.name;

// --- The remote database: how the HOST reaches it, and the plan's read ----------
// §3: `~/.env` holds the connection values and the three runtime role
// passwords. The host reaches the target with them — the target lock, the
// identity read, preparation and preflight all run here, never in a container
// (which could not reach a database on this host's own loopback). The plan
// hashes the target's deployment_identity kind (§1.2), so it is read now, over
// rm_readonly. That read is the plan's EXPECTATION and nothing else: no
// decision is taken on it (criterion 34, §2 "before the first read used for a
// decision"). The §4.3 matrix runs once, after the target lock, on the locked
// read (prepareDatabase); the lock's revalidation holds this read to it (§2).
const remote = dataPath.kind === "external"
  ? (() => {
      const readerUrl = urlForRole(homeEnv, "rm_readonly");
      const workerUrl = urlForRole(homeEnv, "rm_worker");
      if (!readerUrl || !workerUrl) {
        return fatal(`the remote database needs rm_readonly and rm_worker lines in ${homeEnvFilePath()} (spec §3), beside the connection values and rm_app.`);
      }
      const target: HostTarget = { host: homeEnv.host!, port: Number(homeEnv.port ?? "5432"), database: databaseName(homeEnv)!, sslmode: homeEnv.sslmode ?? "require" };
      return { readerUrl, workerUrl, target };
    })()
  : undefined;
const remoteState: TargetState | undefined = remote
  ? await hostReadTargetState(remote.readerUrl).catch((err: unknown) => fatal(`the remote database could not be read (${err instanceof Error ? err.message : String(err)}).`))
  : undefined;
// Base compose files (what smoke:down/smoke:status rebuild from — they stop/inspect
// by project and never need the generated overlays). The --static-port overlay
// belongs to the BASE list: it is the one file that names a host port, so
// smoke:status must resolve the same topology when it asks `docker compose port`
// what is actually published.
const composeFilesBase = [
  "docker-compose.yml",
  "docker-compose.smoke.yml",
  ...(staticPortMode ? [STAGE_COMPOSE_FILE] : [])
].join(":");
// The GENERATED overlays: the no-compose-postgres overlay (remote and dump) and
// the `--local volume` reattach overlay. Each encodes one invocation's choice,
// so each is generated rather than committed, and lives in the INSTANCE's
// overlays directory, never the checkout. Their paths are fixed here; their
// contents are written by the `instance` preparation in main(), after the plan.
const dataPathOverlay = composePostgres ? undefined : join(paths.overlaysDir, `${dataPath.kind}-pg.yml`);
const reattachedVolume = dataPath.kind === "ephemeral" ? dataPath.reattach?.volume : undefined;
// Reattaching this instance's OWN volume needs no overlay: compose already
// mounts `<project>_pgdata`.
const reattachOverlay = reattachedVolume && reattachedVolume !== instanceVolume ? join(paths.overlaysDir, "reattach.yml") : undefined;
// LAST, after every generated overlay — compose merges later files over earlier
// ones and the images pin must win. createStack() dedupes, so both spellings
// make one `-f`.
const composeFilesRun = [composeFilesBase, dataPathOverlay, reattachOverlay, imagesOverride].filter(Boolean).join(":");
const researchKeys = ["channel-divergence", "late-cycle-signals"];

// THE THREE SERVICE TOKENS (spec §3, §5). Nothing here mints one: each is a
// per-instance file under `tokens/<holder>/`, provisioned once by the one entry
// module that writes the token store (backend/scripts/provision-tokens.ts) and
// mounted into its holder alone. `--local blank|dump` provisions them as the
// journaled `prepare (tokens)` step below. A remote target and a `--local
// volume` reattach NEVER mint: they reuse the files the instance holds, and
// absent files refuse HERE, before any mutation — a remote target's tokens come
// only from an explicit `bun scripts/prod-init.ts provision-tokens` (§5,
// criterion 43). This process reads the operator's token (the admin right) for
// its own admin calls and hands a child only the file's PATH.
if (remote || (requestedDataPath.kind === "ephemeral" && requestedDataPath.reattach)) {
  const refusal = tokenReuseRefusal(paths, remote ? "remote" : "volume");
  if (refusal) fatal(refusal);
}
/** Every token file the instance holds right now, for the by-value redaction below. */
const heldTokens = (): string[] =>
  SERVICE_TOKEN_HOLDERS.flatMap((holder) => {
    try {
      return [readServiceToken(paths, holder)];
    } catch {
      return [];
    }
  });
/** The operator's token (§3: the admin routes), read when an admin call needs it. */
const operatorToken = (): string => readServiceToken(paths, "operator");
/** A child that makes admin calls gets the operator token's PATH, never its value. */
const operatorTokenEnv = (): Record<string, string> => ({ [OPERATOR_TOKEN_FILE_ENV]: paths.tokenFiles.operator });

// Model + credential before anything is provisioned (AC-MODEL-01) — what the
// standing stack refuses, and why: scripts/lib/smoke-inference-preflight.ts.
const smokeEnv = resolveSmokeEnv(process.env, { stage: staticPortMode, cadence: cadence.profile });
const inferenceComposeEnv: Record<string, string> = {}; // filled by the preflight; buildSpawnEnv() drops process.env
Object.assign(inferenceComposeEnv, preflightInferenceOrExit({ standingStack: staticPortMode, repoRoot, env: process.env }));

// Per-instance append log: every orchestrator line lands here as well as on the
// console, for post-mortem. Opened for every LOCAL run (CI keeps pure console).
//
// NO TUI (smoke spec §1): `bun smoke` never draws one, on a TTY or off it, and
// imports no TUI module (scripts/tests/unit/smoke-tui.test.ts walks the import
// graph). A running stack is observed from another terminal with
// `bun smoke:status` or `bun smoke:tui`.
const logFile = paths.logFile;
let logFd: number | undefined;
if (!process.env.CI) logFd = openSync(logFile, "a"); // 'a' → re-running never crashes on an existing file
const outFd = "inherit" as const;
const errFd = outFd;

const ts = () => new Date().toISOString();

// --- Logging --------------------------------------------------------------
// Orchestrator narration: append a timestamped line to the log file and print
// it. There is no screen to protect, so nothing is ever redirected.
function log(msg: string): void {
  if (logFd !== undefined) { try { writeSync(logFd, `[${ts()}] ${msg}\n`); } catch { /* best effort */ } }
  console.log(msg);
}

// --- The roster (spec §6.1): the credential file ----------------------------
// `--credentials <path>` overrides RM_CREDENTIALS in ~/.env. The PLAN carries
// each member's name, role and public-key fingerprint; the keys, bearers and
// model keys go only into this run's secret list, which every plan choke point
// checks by value (below). No path configured is an empty roster: this run
// starts no participant, so it stops none either (§6.1's refusal about running
// participants arrives with the participant runtime, #1026 W3).
//
// Fingerprints come from THIS file, never from a spoofed-key generation. A
// spoof generation is state a journaled phase writes (§6.4 step 1); hashing it
// into the plan would give the rerun after a `--spoof-keys` phase a different
// plan id, and the run would supersede its own journal (§1.2: the plan id
// "excludes ... any state a journaled phase itself changes").
const roster = (() => {
  try {
    const resolution = resolveCredentialPath({ RM_CREDENTIALS: loadEnvFile(homeEnvFilePath())?.RM_CREDENTIALS }, flagValue("--credentials"));
    if (!resolution.configured) return { members: { agents: [] as RosterMember[], judges: [] as RosterMember[] }, secrets: [] as string[] };
    // Read, never reconciled: this boot starts no participant, so it has no
    // desired-state plan to make (planParticipants is the participant runtime's).
    const file = loadCredentialFile(resolution.path);
    const member = (namespace: Record<string, CredentialEntry>, role: "member" | "judge"): RosterMember[] =>
      Object.entries(namespace).map(([name, entry]) => ({ name, role, keyFingerprint: publicKeyFingerprint(entry.publicKeyB64) }));
    const secrets = [...Object.values(file.agents), ...Object.values(file.judges)].flatMap((entry) => [
      entry.bearer,
      entry.modelKey,
      JSON.stringify(entry.privateJwk),
      ...Object.values(entry.privateJwk).filter((v): v is string => typeof v === "string"),
    ]);
    return { members: { agents: member(file.agents, "member"), judges: member(file.judges, "judge") }, secrets };
  } catch (err) {
    return fatal(err instanceof CredentialFileRefusal ? `credential file: ${err.message}` : err);
  }
})();

// --- The plan (spec §1.2) ---------------------------------------------------
// Printed, hashed and journaled BEFORE the first mutation. Everything a plan
// field names is resolved above without touching Docker state or the database.
/** The password inside a Postgres URL, when it has one. */
function urlPassword(url: string | undefined): string[] {
  if (!url) return [];
  try {
    const password = decodeURIComponent(new URL(url).password);
    return password ? [password] : [];
  } catch {
    return [];
  }
}
/**
 * Every secret value this run holds, for the by-value redaction check at every
 * plan choke point (computePlanId, renderPlan, openJournal, writeReceipt). The
 * shape heuristic alone misses a shapeless secret, which is why the VALUES are
 * passed. Role passwords: the instance's saved set (§5, rm_owner's included),
 * the remote database's three from `~/.env`, a restored dump's superuser
 * (added once it is restored). A TYPED owner password never enters this
 * process at all: the preparation child that prompts for it uses it and exits
 * (backend/scripts/smoke-prepare.ts). Service tokens: whatever the instance
 * already holds, plus each one `prepare (tokens)` provisions. Participant keys:
 * every credential-file entry's key, bearer and model key.
 */
const runSecrets: string[] = [
  ...heldTokens(),
  ...urlPassword(dataPath.kind === "external" ? dataPath.url : undefined),
  ...urlPassword(remote?.readerUrl),
  ...urlPassword(remote?.workerUrl),
  ...(() => {
    if (!existsSync(paths.rolePasswordsFile)) return [];
    try {
      return Object.values(readRolePasswords(paths));
    } catch (err) {
      return fatal(err);
    }
  })(),
  ...roster.secrets,
];
const redaction = { secrets: runSecrets };

function planTarget(): PlanTarget {
  if (dataPath.kind === "external") {
    const url = new URL(dataPath.url);
    return {
      kind: "remote",
      rmEnv: policy,
      // The kind the plan was built against, as read — `absent` when the target
      // is not enrolled. Never a verdict: the matrix judges the locked read.
      identity: remoteState!.identity === "missing" ? "absent" : remoteState!.identity,
      host: url.hostname,
      port: url.port === "" ? 5432 : Number(url.port),
      dbname: decodeURIComponent(url.pathname.replace(/^\//, "")),
    };
  }
  const mode = localModeOf(dataPath) ?? "blank";
  const volume = dataPath.kind === "smoke-twin" ? dataPath.volume : (reattachedVolume ?? instanceVolume);
  // §4.3 refuses `prod` with any local mode (above), so a local plan is `stage`,
  // and its identity is the one it requires: written by smoke as rehearsal for
  // `blank` and `dump`, already rehearsal for `volume` (checked under the lock).
  return { kind: "local", rmEnv: "stage", identity: "rehearsal", mode, volume };
}

const plan: DeploymentPlan = (() => {
  try {
    // Each image's SOURCE identity (D52): the Git tree of its build context,
    // computed from the working tree, so a rebuild from unchanged sources keeps
    // the plan id and any edit under a context moves it. The built digest is
    // not known yet and is recorded in the receipt instead.
    const sources = resolveSourceIdentities(gitRunner(repoRoot), buildContextsFor("full", { externalPostgres: !composePostgres }));
    return {
      instance: instance.name,
      target: planTarget(),
      images: Object.fromEntries(Object.entries(sources).map(([service, source]) => [service, { source, digest: null }])),
      roster: roster.members,
      // Every non-secret value that changes what this boot does. Not the compose
      // project (derived from the instance, and random-looking enough that the
      // redaction check would rightly refuse it), not a URL (a Base RPC URL can
      // carry an API key in its path).
      configuration: {
        RM_ENV: stackRmEnv,
        SMOKE_CADENCE: cadence.profile,
        STATIC_PORT: String(staticPortMode),
        SHIPPED_IMAGES: String(Boolean(imagesOverride)),
        ANALYTICS_SOURCE: smokeEnv.analyticsSource,
        ANALYTICS_FLOOR_SEED: smokeEnv.analyticsFloorSeed,
      },
      mutations: [
        ...(requestsMigrate(process.argv) ? (["migrate"] as const) : []),
        ...(shouldSeed(process.argv) ? (["seed"] as const) : []),
      ],
    };
  } catch (err) {
    return fatal(err);
  }
})();
const planId: PlanId = (() => {
  try {
    return computePlanId(plan, redaction);
  } catch (err) {
    return fatal(err);
  }
})();

// `--local blank` means an EMPTY database. An instance whose volume already
// exists holds data from an earlier boot; reattaching it under a `blank` flag
// would boot green on data the operator said was not there. The one exception
// is a rerun of the SAME plan whose journal is still open: that is §1.3's
// resume, and its volume is the one the journal's own preparation created.
if (dataPath.kind === "ephemeral" && !reattachedVolume) {
  const exists = Bun.spawnSync(["docker", "volume", "inspect", instanceVolume], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  let resuming = false;
  try {
    const open = readJournal(paths);
    resuming = open !== null && open.closedAt === null && open.planId === planId;
  } catch (err) {
    fatal(err);
  }
  if (exists && !resuming) {
    fatal(
      `${LOCAL_FLAG} blank: instance ${instance.name} already holds data in volume ${instanceVolume} from an earlier boot. ` +
        `Reattach it with \`${LOCAL_FLAG} volume\`, stop and reclaim it with \`bun smoke:down --instance ${instance.name}\` ` +
        `then \`bun smoke:clean\`, or boot a fresh instance with \`--instance <new name>\`.`,
    );
  }
}

// One line naming the run's identity: the instance, the compose project and the
// environment class + hash every container label carries. The host ports are
// DELIBERATELY absent — they do not exist yet.
log(
  `instance=${instance.name} (${instance.source})  project=${project}  ` +
    `env=${stackEnvironment.class}/${stackEnvironment.hash}  ` +
    `host ports=(assigned by Docker at start${staticPortMode ? "; web PINNED to :" + STAGE_WEB_PORT + " by --static-port" : ""})`,
);
log(`state: ${paths.dir}`);

// The single point at which this process learns its host ports. Everything
// downstream — the route table, BACKEND_URL for every child, the READY banner,
// the stack record — reads them from here, and it learned them from the daemon.
function applyHostPorts(ports: StackHostPorts): void {
  apiPort = ports.apiPort;
  // Issue #892: website-server, not api, is the static/SPA origin — BACKEND_URL resolves against its port.
  webPort = ports.webPort;
  pgPort = ports.pgPort;
  backendUrl = hostBackendUrl(webPort);
  log(
    `host ports (Docker-assigned): api=:${apiPort} web=:${webPort}${staticPortMode ? " (web STAGE-PINNED — cloudflared origin)" : ""}  ` +
      `pg=${pgPort === null ? `${dataPath.kind.toUpperCase()} (${redactedDbUrl()}) — no container, no published port` : `:${pgPort}`}`,
  );
  if (!staticPortMode && webPort === STAGE_WEB_PORT) {
    log(
      `WARNING: Docker assigned this NON-stage smoke the tunnel origin :${STAGE_WEB_PORT}. ` +
        `stage.robotmoney-labs.dev will resolve to THIS stack until it is torn down.`,
    );
  }
}

// --- Container lifecycle --------------------------------------------------
// The smoke's StackConfig (docs/architecture.md §11.3 E5): PURE data, built
// once the data path is resolved (a dump's URL exists only after its restore).
// dockerEnv is the stack's own spawn env for every DIRECT `docker compose`
// call below (diagnostics, teardown, quiesce): allowlisted docker-client
// plumbing plus buildComposeEnv()'s explicit map, and nothing else (§4.4,
// criterion 122).
let smokeStackConfig: StackConfig | undefined;
let dockerEnv: Record<string, string> | undefined;
function makeStackConfig(): StackConfig {
  smokeStackConfig = {
    repoRoot,
    project,
    profile: "full", // core (postgres + api) + the worker lanes, scheduler and producer
    composeFiles: composeFilesRun.split(":"),
    database: databaseFor(dataPath),
    environment: stackEnvironment,
    rmEnv: stackRmEnv,
    // §4.4: never allow-insecure under RM_ENV=prod (refuseWeakeningFlagsOnProd).
    allowInsecure: stackAllowInsecureFor(policy),
    imagesOverride,
    instance: { name: instance.name, stateDir: paths.dir },
    // NO MODEL KEY. The judge is a participant and takes its key from
    // credential.json (smoke spec §6.1, D52). No service this stack starts calls
    // a model.
    extraComposeEnv: {
      ...smokeEnv.composeEnv,
      ...smokePassthroughEnv(process.env),
      ...inferenceComposeEnv,
    },
  };
  dockerEnv = {
    ...buildSpawnEnv(smokeStackConfig, process.env),
    COMPOSE_PROJECT_NAME: project,
    COMPOSE_FILE: composeFilesRun,
  };
  return smokeStackConfig;
}

// `--env-file /dev/null` on EVERY compose call: compose otherwise loads the
// checkout's `.env` for interpolation by itself, whatever env it was handed
// (scripts/stack/config.ts composeArgs() explains the leak it caused).
function dockerCompose(args: string[], check = true): Bun.SyncSubprocess {
  if (!dockerEnv) throw new Error("no stack has been configured yet; nothing to run compose against");
  const r = Bun.spawnSync(["docker", "compose", "--env-file", "/dev/null", ...args], {
    cwd: repoRoot,
    env: dockerEnv,
    stdout: outFd,
    stderr: errFd,
    // Its own process group, as every stack child (scripts/stack/stack.ts).
    detached: true,
  } as Parameters<typeof Bun.spawnSync>[1]);
  if (check && r.exitCode !== 0) {
    throw new Error(`docker compose ${args.join(" ")} failed (exit ${r.exitCode})`);
  }
  return r;
}

// On a startup failure, the containers are about to be torn down (CI) or left up
// (local) — capture their state and logs FIRST so the real cause is visible.
function dumpDiagnostics(): void {
  if (!dockerEnv) return;
  const diag = (m: string) => { if (logFd !== undefined) { try { writeSync(logFd, m + "\n"); } catch {} } console.error(m); };
  diag("\n[smoke] --- container diagnostics ---");
  dockerCompose(["ps", "-a"], false);
  dockerCompose(["logs", "--no-color", "--tail", "60"], false);
  diag("[smoke] --- end diagnostics ---\n");
}

let cleaned = false;
let downStack: (() => { exitCode: number }) | undefined;
// CI ONLY. Teardown = `docker compose down` WITHOUT `-v`, then the scoped
// cleanCiVolume() below. A LOCAL boot never tears itself down: it exits at
// readiness and Docker keeps the stack up; `bun smoke:down` stops it.
function cleanup(): void {
  if (cleaned || !dockerEnv) return;
  cleaned = true;
  try {
    const purged = purgeSmokeEvalContainers(makeDockerRunner(dockerEnv), { project });
    if (purged.removed.length > 0) {
      console.log(`[smoke] purged ${purged.removed.length} evaluation container(s): ${purged.removed.join(", ")}`);
    }
    if (purged.skipped.length > 0) {
      console.log(`[smoke] WARNING: failed to purge evaluation container(s): ${purged.skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}`);
    }
  } catch (err) {
    console.log(`[smoke] WARNING: failed purging evaluation containers: ${err instanceof Error ? err.message : err}`);
  }
  console.log("\n[smoke] tearing down (keeping postgres data)…");
  const r = downStack ? downStack() : dockerCompose(["down"], false);
  // The smoke-twin goes LAST, after the stack has stopped talking to it. Its VOLUME
  // survives on purpose (the ephemeral-pgdata contract); smoke:clean reclaims it.
  if (smokeTwinContainer) {
    teardownContainer(smokeTwinContainer, (m) => console.log(`[smoke] ${m}`));
    console.log(`[smoke] ${smokeTwinTeardownNarration(dataPath)}`);
  }
  // The journal described a stack that no longer exists; a rerun starts from
  // current state instead of refusing over this job's own teardown.
  try { closeOpenJournal(paths, "the CI job tore its own stack down"); } catch { /* reported by the next run */ }
  const where = keptDataDescription(dataPath, project);
  console.log(
    r.exitCode !== 0
      ? `[smoke] teardown exited ${r.exitCode}`
      : `[smoke] containers + network removed for ${project}${where ? `; postgres data kept (${where})` : ""}`,
  );
}

// CI ONLY: a required per-PR e2e boot runs on a SHARED runner; with
// keep-by-default its pgdata volume would leak on the host forever. After
// teardown, delete THIS run's volume — scoped by the robotmoney.smoke.project
// label so a co-tenant standing smoke's volume is never touched. Loud,
// best-effort: a failure here is logged, never silent.
function cleanCiVolume(): void {
  if (!dockerEnv) return;
  try {
    const run = makeDockerRunner(dockerEnv);
    const vols = listSmokeVolumes(run, { project });
    if (vols.length === 0) {
      console.log(`[smoke] no smoke volume to clean for ${project}`);
      return;
    }
    const { removed, skipped } = removeSmokeVolumes(run, vols.map((v) => v.name));
    for (const n of removed) console.log(`[smoke] reclaimed CI volume ${n}`);
    for (const s of skipped) console.log(`[smoke] WARNING could not remove ${s.name}: ${s.reason}`);
  } catch (err) {
    console.log(`[smoke] CI volume clean failed: ${err instanceof Error ? err.message : err}`);
  }
}

// Record the stack in the instance's stack-state.json so `smoke:down` /
// `smoke:status` can rebuild the compose env AND so a stopped smoke's surviving
// data stays discoverable. Kept through teardown (data survives, so its pointer
// must too) and overwritten by the next boot of this instance. Records
// composeFilesBase (down/status stop/inspect by project — the generated
// overlays are irrelevant to them) plus the named volume the data lives in.
function writeStateFile(): void {
  writeStackState(paths, {
    instance: instance.name,
    project,
    // A RECORD of what Docker assigned, never an instruction; 0 on the
    // early-failure path. `smoke:status` asks `docker compose port` for the
    // LIVE values and treats these as history.
    apiPort,
    // Issue #892: the static/SPA origin is website-server, NOT api.
    webPort,
    pgPort,
    stage: staticPortMode,
    // The environment this boot belongs to, so the container/volume labels
    // smoke:down and smoke:status interpolate match the ones `up` stamped.
    envClass: stackEnvironment.class,
    envHash: stackEnvironment.hash,
    composeFiles: composeFilesBase,
    // REDACTED for every non-ephemeral boot. The baked-in smoke credentials are
    // recorded (a throwaway container owns them, and smoke:down/status need
    // them to reach it); a managed server's password is a real credential.
    db: dataPath.kind,
    externalPg: !composePostgres,
    ...(dataPath.kind === "smoke-twin"
      ? { smokeTwinContainer: dataPath.container, smokeTwinVolume: dataPath.volume, smokeTwinBackupStamp: dataPath.stamp }
      : {}),
    databaseUrl: composePostgres ? internalDatabaseUrl(DEFAULT_STACK_DATABASE) : (redactedDbUrl() ?? ""),
    dbUser: composePostgres ? DB_USER : `(${dataPath.kind} — see the banner)`,
    dbPassword: composePostgres ? DB_PASSWORD : `(${dataPath.kind} — see the banner)`,
    dbName: composePostgres ? DB_NAME : `(${dataPath.kind} — see the banner)`,
    logFile,
    // Data location: the volume a blank boot created, or the one a `--local
    // volume` boot reattached. `--local volume` with no name reattaches exactly
    // this. NOT set for a remote or dump boot: this stack created no compose
    // volume, and naming one would send smoke:clean after storage that does not
    // exist. (A dump's volume is recorded under its own key.)
    ...(composePostgres ? { pgVolume: reattachedVolume ?? instanceVolume } : {}),
    createdAt: new Date().toISOString(),
  });
}

// After an interrupted or failed run, tell the operator how to resume, inspect
// or stop it. EVERY flag this boot ran with: all are CLI-only by design, so a
// hint that dropped --static-port would resume on a Docker-assigned port.
function printResumeHint(): void {
  const flags = process.argv.slice(2).filter((a) => a !== `--instance=${instance.name}`);
  const withInstance = flags.includes("--instance") ? flags : [...flags, "--instance", instance.name];
  console.log(`[smoke]   resume (same plan ${planId.slice(0, 12)}…):  bun smoke ${withInstance.join(" ")}`);
  console.log(`[smoke]   inspect:  bun smoke:status --instance ${instance.name}`);
  console.log(`[smoke]   stop:     bun smoke:down --instance ${instance.name}`);
  if (!reclaimable) {
    console.log(`[smoke] the database was REMOTE (${redactedDbUrl()}) — its data was never this smoke's to keep or reclaim.`);
  } else if (dataPath.kind === "smoke-twin") {
    for (const line of smokeTwinResumeHint(dataPath)) console.log(`[smoke] ${line}`);
  } else {
    console.log(`[smoke] postgres data is in volume ${reattachedVolume ?? instanceVolume}; reclaim stopped smokes' volumes with bun run smoke:clean`);
  }
}

// Wiring only; DB_WRITER_SERVICES carries which services and why. Best-effort
// and non-throwing — raising from the failure path would replace the real cause
// with a teardown error.
function quiesceWriters(): "stopped" | "failed" {
  try {
    return dockerCompose(["stop", ...DB_WRITER_SERVICES], false).exitCode === 0 ? "stopped" : "failed";
  } catch {
    return "failed";
  }
}

// Print how to inspect and tear down, then leave the stack UP. Used only by the
// LOCAL startup-FAILURE path: a failed boot is left running for inspection.
function printLeaveRunning(): void {
  console.log("\n[smoke] containers left RUNNING (no auto-teardown).");
  console.log(`[smoke]   state:       ${paths.dir}`);
  console.log(`[smoke]   log file:    ${logFile}`);
  console.log(`[smoke]   inspect:     bun smoke:status --instance ${instance.name}`);
  console.log(`[smoke]   logs:        docker compose -p ${project} logs -f`);
  console.log(`[smoke]   tear down:   bun smoke:down --instance ${instance.name}`);
  for (const line of smokeTwinLeftRunningHint(smokeTwinContainer)) console.log(`[smoke] ${line}`);
}

// Every bun child this boot starts runs with `--no-env-file`, as the boot itself
// does (package.json's `smoke` script): bun would otherwise auto-load the
// checkout's `.env` into the child, and a boot reads no env file from the
// checkout (criterion 122). The child's environment is the map handed to it.
function withoutEnvFile(cmd: string[]): string[] {
  return cmd[0] === "bun" ? ["bun", "--no-env-file", ...cmd.slice(1)] : cmd;
}

async function run(cmd: string[], cwd: string, env: Record<string, string>, label: string): Promise<void> {
  const proc = Bun.spawn(withoutEnvFile(cmd), { cwd, env, stdout: outFd, stderr: errFd });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${label} failed (exit ${code})`);
}

async function expectRunFailure(cmd: string[], cwd: string, env: Record<string, string>, label: string): Promise<void> {
  const proc = Bun.spawn(withoutEnvFile(cmd), { cwd, env, stdout: outFd, stderr: errFd });
  const code = await proc.exited;
  if (code === 0) throw new Error(`${label} unexpectedly exited 0`);
}

// --- Observed state (spec §1.3's state expectations) -------------------------
// What is true RIGHT NOW, read from Docker and, when it is reachable, the
// database: the running application services and the image each runs, and the
// migration ledger plus the schema manifest hash. Read-only in every path.
/** Running application containers of this project, by compose service: service → image digest. */
function runningServices(): Record<string, string> {
  const ids = Bun.spawnSync(
    ["docker", "ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.oneoff=False"],
    { stdout: "pipe", stderr: "pipe" },
  ).stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean);
  if (ids.length === 0) return {};
  const out = Bun.spawnSync(
    ["docker", "inspect", "--format", '{{index .Config.Labels "com.docker.compose.service"}}\t{{.Image}}', ...ids],
    { stdout: "pipe", stderr: "pipe" },
  ).stdout.toString();
  const services: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const [service = "", image = ""] = line.trim().split("\t");
    if (service && service !== "postgres" && image.startsWith("sha256:")) services[service] = image;
  }
  return services;
}

/** One running container of this project for `service`, or undefined. */
function serviceContainer(service: string): string | undefined {
  return Bun.spawnSync(
    ["docker", "ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`, "--filter", "label=com.docker.compose.oneoff=False"],
    { stdout: "pipe", stderr: "pipe" },
  ).stdout.toString().split("\n")[0]?.trim() || undefined;
}

const LEDGER_SQL = "SELECT name FROM schema_migrations ORDER BY name";
const MANIFEST_SQL = "SELECT content_hash FROM schema_manifest";
/**
 * The migration ledger and manifest hash, or `null` when the database cannot be
 * asked right now. Once the target lock is held, over the lock's own direct
 * connection (a read, never a mutation). Before it: for the remote database, a
 * short-lived HOST connection as rm_readonly (a host tool reaches a database on
 * this host's own loopback; a `docker run psql` could not, wave-2 open problem
 * 6); for a Postgres this boot owns, `psql` inside its container, as the local
 * superuser that created it, read-only.
 */
async function observeSchema(): Promise<{ ledger: string[]; manifestHash: string | null } | null> {
  if (targetLock) {
    const state = await readTargetState(targetLock.connection).catch(() => null);
    return state ? { ledger: [...state.ledger], manifestHash: state.manifestHash } : null;
  }
  if (remote) {
    const state = await hostReadTargetState(remote.readerUrl).catch(() => null);
    return state ? { ledger: [...state.ledger], manifestHash: state.manifestHash } : null;
  }
  const run = (argv: string[]) => Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  const inContainer = (container: string, user: string, db: string) => {
    const query = (q: string) => run(["docker", "exec", container, "psql", "-U", user, "-d", db, "-tAq", "-c", q]);
    const ledger = query(LEDGER_SQL);
    if (ledger.exitCode !== 0 && !/does not exist/.test(ledger.stderr.toString())) return null;
    const manifest = query(MANIFEST_SQL);
    return {
      ledger: ledger.exitCode === 0 ? ledger.stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean) : [],
      manifestHash: manifest.exitCode === 0 ? manifest.stdout.toString().trim() || null : null,
    };
  };
  if (composePostgres) {
    const pg = serviceContainer("postgres");
    return pg ? inContainer(pg, DB_USER, DB_NAME) : null;
  }
  if (dataPath.kind === "smoke-twin" && dataPath.url) {
    const url = new URL(dataPath.url);
    return inContainer(dataPath.container, decodeURIComponent(url.username), decodeURIComponent(url.pathname.slice(1)));
  }
  return null;
}

// --- Orchestration --------------------------------------------------------
/** Thrown at a phase boundary after a SIGINT/SIGTERM, once the stop is journaled (§1.4). */
class StoppedAtBoundary extends Error {}
/**
 * A refusal taken before this boot's first write to anything: the target, the
 * live site, or a container (§13.3's web-compat refusal). The failure path
 * journals it and exits non-zero, and — unlike a startup failure — stops no
 * writer and tears nothing down: every container running is the PREVIOUS
 * deployment's, and the refusal exists to leave it exactly as it was.
 */
class RefusedBeforeAnyWrite extends Error {}

const EMPTY_OUTCOME: PhaseOutcome = {
  migrationsApplied: [],
  manifestPublished: null,
  participantsStarted: [],
  participantsStopped: [],
  servicesReplaced: {},
  spoofGenerationWritten: null,
};

let journal: JournalWriter | undefined;
/** The journal record this run has begun and not yet ended, if any. */
let openRecord: { phase: DeploymentPhase; step: string | null } | undefined;
let lock: DeploymentLock | undefined;
/** The §2 target lock, held from the `lock` preparation to the end of the run. */
let targetLock: TargetLock | undefined;

/** Release the target lock explicitly (§2: "It is released explicitly on exit"); bounded, never throws. */
async function releaseTargetLock(): Promise<void> {
  const held = targetLock;
  targetLock = undefined;
  if (held) await Promise.race([held.release(), sleep(5_000)]).catch(() => undefined);
}

async function main(): Promise<void> {
  // ── §1.2: print the plan, take the deployment lock, open the journal ──────
  log("\n── plan ──");
  for (const line of renderPlan(plan, planId, redaction).trimEnd().split("\n")) log(`  ${line}`);
  try {
    lock = acquireDeploymentLock(paths, planId);
  } catch (err) {
    fatal(err);
  }
  process.on("exit", () => lock?.release());
  // Ctrl-C / SIGTERM stop at the NEXT PHASE BOUNDARY (§1.4): the watch only
  // records the request, the boundaries below honour it, and nothing is torn
  // down. A second signal does not escalate. The docker children run in their
  // own process group (scripts/stack/stack.ts), so a terminal's Ctrl-C reaches
  // this process and not the step it is waiting on.
  const interrupt = watchForInterrupt();

  let lastExpectations: StateExpectations | undefined;
  const observe = async (): Promise<StateExpectations> => {
    const schema = await observeSchema();
    lastExpectations = {
      ledger: schema?.ledger ?? lastExpectations?.ledger ?? [],
      manifestHash: schema ? schema.manifestHash : (lastExpectations?.manifestHash ?? null),
      identity: plan.target.identity,
      participants: [],
      services: runningServices(),
      spoofGeneration: null,
    };
    return lastExpectations;
  };

  // §1.3: resume only under the same plan id; supersede on a different one;
  // refuse when another operation moved the world. The world is READ only
  // under the target lock (§2, §7, criterion 34): at open the decision is taken
  // on the journal alone — its own ledger and manifest stand in for the
  // database's — and the schema half of the resume check is made the moment
  // the lock is held (holdSchemaToJournal), against a read on the lock's own
  // connection, every time a journal is resumed.
  const onDisk = readJournal(paths);
  const resumable = onDisk !== null && onDisk.closedAt === null && onDisk.planId === planId ? onDisk : null;
  const journalExpects = resumable ? projectExpectations(resumable) : null;
  lastExpectations = {
    ledger: journalExpects?.ledger ?? [],
    manifestHash: journalExpects?.manifestHash ?? null,
    identity: plan.target.identity,
    participants: [],
    services: runningServices(),
    spoofGeneration: null,
  };
  /** What the resumed journal expects of the schema, held to the locked read. */
  let recheckSchema = journalExpects;
  /** Set when THIS run restored the dump: the restore, not the old journal, defines the schema. */
  let restoredThisRun = false;
  const decision = decideResume(onDisk, planId, lastExpectations);
  if (decision.kind === "refuse") fatal(`the journal for instance ${instance.name} refuses this run: ${decision.reason}`);
  if (decision.kind === "supersede") log(decision.report);
  if (decision.kind === "resume") log(`resuming the journal for plan ${planId} (it continues at ${decision.nextPhase})`);
  journal = openJournal(paths, decision, plan, redaction);
  const committedSteps = new Set(
    (resumable?.phases ?? []).filter((r) => r.status === "committed").map((r) => `${r.phase}:${r.step ?? ""}`),
  );

  const begin = async (phase: DeploymentPhase, step: string | null): Promise<void> => {
    if (interrupt.requested()) {
      await journal!.beginPhase(phase, step, await observe());
      await journal!.endPhase("interrupted", `stopped by SIGINT/SIGTERM at the boundary before ${phase}${step ? ` (${step})` : ""}; nothing of it ran`);
      throw new StoppedAtBoundary(`stopped at the boundary before ${phase}${step ? ` (${step})` : ""}`);
    }
    await journal!.beginPhase(phase, step, await observe());
    openRecord = { phase, step };
    log(`phase: ${phase}${step ? ` (${step})` : ""}`);
    // §2, Connection loss: "Detected at every phase boundary; the tool journals
    // the phase and exits non-zero. No phase proceeds on a lock the tool cannot
    // prove it still holds." Proven by a round trip, never a flag; a failure
    // here is journaled against the phase that was about to run.
    if (targetLock) await assertStillHeld(targetLock, `${phase}${step ? ` (${step})` : ""}`);
  };
  const commit = async (outcome: Partial<PhaseOutcome> = {}): Promise<void> => {
    if (!openRecord) return;
    await journal!.commitPhase({ ...EMPTY_OUTCOME, ...outcome });
    openRecord = undefined;
  };
  // A resumed run holds the schema to its journal under the target lock, on
  // the lock's own connection. What it is held to is the journal as it stood
  // at open (the resume was decided on it), except when this run restored the
  // dump itself: then the restored copy is this run's own journaled work, and
  // the journal AS IT NOW STANDS (its records begun after the restore) is the
  // expectation.
  const holdSchemaToJournal = async (): Promise<void> => {
    if (!recheckSchema) return;
    if (!targetLock) throw new Error("holdSchemaToJournal runs only under the target lock");
    const locked = await readTargetState(targetLock.connection);
    const current = restoredThisRun ? readJournal(paths) : null;
    const expected = (current !== null ? projectExpectations(current) : null) ?? recheckSchema;
    const mismatch = expectationMismatch(expected, { ledger: [...locked.ledger], manifestHash: locked.manifestHash });
    recheckSchema = null;
    if (mismatch) throw new Error(`refusing to resume plan ${planId}: ${mismatch}, and no journaled outcome accounts for the difference`);
  };

  await begin("plan", decision.kind === "resume" ? "resume" : null);
  await commit();

  // ── Preparation that precedes the stack ───────────────────────────────────
  // The instance's generated files: the four role passwords of a Postgres this
  // boot owns (§5) and the compose overlays. The service tokens are the
  // `prepare (tokens)` step's, once the database is enrolled.
  await begin("prepare", "instance");
  // The stack record FIRST, before any compose call or container: the compose
  // project is fixed by the instance, and `smoke:status` / `smoke:down` find a
  // stack only through this record.
  writeStateFile();
  const mode = localModeOf(requestedDataPath);
  if (mode !== null) {
    rolePasswords = instanceRolePasswords(paths, mode);
    runSecrets.push(...Object.values(rolePasswords));
  }
  if (dataPathOverlay && dataPath.kind !== "smoke-twin") writeFileSync(dataPathOverlay, dataPathOverlayYaml(dataPath));
  if (reattachOverlay && reattachedVolume) {
    const overrideFile = reattachOverlay;
    writeFileSync(overrideFile, reattachOverlayYaml(reattachedVolume));
  }
  await commit();

  if (requestedDataPath.kind === "smoke-twin") {
    // §7: database create/restore after the plan and the deployment lock. A
    // rerun of the SAME plan whose restore already committed reattaches the
    // restored copy it recorded and never restores into it again.
    const recorded = committedSteps.has("prepare:restore") ? readStackState(paths)?.smokeTwinContainer : undefined;
    const reattachUrl = recorded ? smokeTwinUrlFromContainer(recorded) : null;
    if (committedSteps.has("prepare:restore") && (!recorded || !reattachUrl)) {
      throw new Error(
        `--local dump: this plan's restore already committed, and its container ${recorded ?? "(unrecorded)"} is gone. ` +
          "Restoring again would replace the copy this journal describes; stop it with `bun smoke:down`, reclaim it " +
          "with `bun smoke:clean`, and boot a fresh plan.",
      );
    }
    if (reattachUrl && recorded) {
      const url = new URL(reattachUrl);
      dataPath = { ...(dataPath as Extract<ResolvedDataPath, { kind: "smoke-twin" }>), url: reattachUrl, redactedUrl: redactPostgresUrl(reattachUrl), container: recorded, volume: readStackState(paths)?.smokeTwinVolume ?? "" };
      smokeTwinContainer = recorded;
      runSecrets.push(...urlPassword(url.toString()));
      if (dataPathOverlay) writeFileSync(dataPathOverlay, dataPathOverlayYaml(dataPath));
      log(`--local dump: reattached the restored copy ${recorded} this plan committed; nothing is restored again`);
    } else {
      await begin("prepare", "restore");
      const twin = await bringUpTwin({ backupDir: requestedDataPath.backupDir, project, log: (m) => log(m) });
      dataPath = twin.dataPath;
      smokeTwinContainer = twin.container;
      restoredThisRun = true;
      runSecrets.push(...urlPassword(twin.dataPath.kind === "smoke-twin" ? twin.dataPath.url : undefined));
      console.warn(bannerFor(dataPath));
      // The restore superuser does what doadmin does, and no more: the four
      // roles, and every application object handed to rm_owner (§3, §7.3).
      const twinUrl = new URL(twin.dataPath.url);
      const twinDb = decodeURIComponent(twinUrl.pathname.slice(1));
      const owned = await superuserSqlSettled(twin.container, decodeURIComponent(twinUrl.username), twinDb, dumpOwnershipSql(rolePasswords!, twinDb));
      if (owned !== null) throw new Error(`--local dump: the restored copy's roles and ownership could not be set: ${owned}`);
      if (dataPathOverlay) writeFileSync(dataPathOverlay, dataPathOverlayYaml(dataPath));
      writeStateFile();
      await commit();
    }
  }

  // ── The bring-up IS scripts/stack's bring-up (§11.3 E5) ──────────────────
  // assemble → database → site → build → preflight → services → /health, in ONE
  // shared implementation. The smoke contributes the `full` profile, the
  // database half (prepareDatabase), the narration, and — through beforeStep —
  // its phase boundaries.
  const onStackEvent = (e: StackEvent): void => {
    if (e.phase === "log") return void log(e.message);
    const { phase, status } = e;
    if (phase === "build") {
      if (status === "start") log("building compose images…");
    } else if (phase === "postgres") {
      const n = postgresPhaseNarration(!composePostgres, status, e.detail);
      if (n.log) log(n.log);
    } else if (phase === "services") {
      // system-scheduler is started here too, but it is NOT a worker lane
      // (issue #1026): it claims no jobs and holds no database credential.
      if (status === "start") log(`starting ${e.detail ?? "services"}…`);
    } else if (phase === "ports" && status === "done") {
      log(`host ports discovered: ${e.detail ?? "?"}`);
    } else if (phase === "health" && status === "done") {
      log("api healthy");
    }
  };

  const stack: Stack = createStack(makeStackConfig(), {
    hostEnv: process.env,
    io: { stdout: outFd, stderr: errFd },
    hooks: { onEvent: onStackEvent },
  });
  downStack = () => stack.down();
  if (dataPath.kind === "smoke-twin") assertSmokeTwinIsTarget(stack.spawnEnv, containerRoleUrls(dataPath).app);

  // NO MODE IMPLIES --seed OR --migrate (spec §4.3, §5, §8.5). Each runs only
  // when the operator asked for it, on every data path.
  const seeds = shouldSeed(process.argv);
  const migrates = requestsMigrate(process.argv);
  if (!seeds) console.warn(`[smoke] no --seed: no demo data. The full preflight still checks the schema.`);
  // What this boot's preflight found, for the receipt (§1.4).
  const preflightResults: { check: string; pass: boolean; detail: string }[] = [];

  // ── The database half (spec §7): create → target lock → matrix → preparation ──
  // How the HOST reaches the target, and the step request each preparation gets.
  let hostTarget: HostTarget | undefined = remote?.target;
  const holder = { tool: "smoke", planId, instance: instance.name, host: hostname(), pid: process.pid };
  const step = (action: PrepareStep["action"], note?: string): PrepareStep => ({
    action,
    rmEnv: parsedPolicy.ok && parsedPolicy.source === "explicit" ? policy : null,
    connection: remote ? "remote" : "local",
    target: hostTarget!,
    credentials: remote ? { source: "home-env", file: homeEnvFilePath() } : { source: "instance", stateRoot: statesRoot, instance: instance.name },
    lock: { backendPid: targetLock!.backendPid, holder: targetLock!.holder },
    stateDir: paths.dir,
    // §5: "No terminal prompt exists in local modes"; a remote run prompts only on a terminal.
    nonInteractive: !operatorTerminal(),
    ...(note ? { note } : {}),
  });
  const prepare = async (action: PrepareStep["action"], note?: string): Promise<Record<string, unknown>> => {
    const outcome = await runPrepareStep(repoRoot, step(action, note), prepareChildEnv(process.env));
    if (!outcome.ok) throw new Error(`${action}: ${outcome.error}`);
    return outcome.detail;
  };

  async function prepareDatabase(): Promise<void> {
    // CREATE (a local mode): the Postgres this boot owns, and — for a blank
    // one, once — the four roles and the database, by the local superuser, the
    // way doadmin provisions a fresh cluster (§7.3). Nothing is read for a
    // decision yet.
    if (composePostgres) {
      await begin("prepare", "database");
      await stack.composeAsync(["up", "-d", "postgres"], "start postgres", { stdout: outFd, stderr: errFd });
      await stack.waitForPostgres();
      if (mode === "blank" && !committedSteps.has("prepare:database")) {
        const created = await superuserSqlSettled(serviceContainer("postgres")!, DB_USER, DB_NAME, localSuperuserSql(rolePasswords!, DB_NAME));
        if (created !== null) throw new Error(`--local blank: the local superuser could not create the roles and the database: ${created}`);
      }
      hostTarget = { host: "127.0.0.1", port: stack.publishedPort("postgres", 5432), database: DB_NAME, sslmode: "disable" };
      await commit();
    } else if (dataPath.kind === "smoke-twin") {
      const url = new URL(dataPath.url);
      hostTarget = { host: url.hostname, port: Number(url.port), database: decodeURIComponent(url.pathname.slice(1)), sslmode: "disable" };
    }

    // THE TARGET LOCK (§2): after create/restore, before the first read used
    // for a decision; one constant key, over a direct connection, waiting at
    // most --lock-timeout behind another holder and then refusing, naming it.
    // Having acquired it, the target is re-read and held to the plan.
    await begin("prepare", "lock");
    const lockUrl = remote ? remote.readerUrl : roleUrl(hostTarget!, "rm_readonly", rolePasswords!.rm_readonly);
    const expected = remoteState ?? (await hostReadTargetState(lockUrl));
    const acquired = await acquireTargetLock({ databaseUrl: lockUrl, holder, timeoutMs: lockTimeoutMs(process.argv), expected });
    if (!acquired.acquired) throw new Error(acquired.reason);
    targetLock = acquired.lock;
    log(`target lock held (${targetLock.holder.tool}, plan ${planId.slice(0, 12)}, backend pid ${targetLock.backendPid})`);

    // THE MATRIX (§4.3), on the target's own answer, read under the lock.
    const locked = await readTargetState(targetLock.connection);
    const verdict = resolveDeploymentPolicy({ rmEnv: declaredRmEnv, connection, identity: locked.identity === "missing" ? null : locked.identity });
    if (!verdict.allow) throw new Error(verdict.reason);
    await holdSchemaToJournal();
    await commit();

    // AUTHORIZED PREPARATION, each step rm_owner, each fenced, each journaled
    // alone and never redone by a rerun of the same plan (§1.3).
    if (mode === "blank" && !committedSteps.has("prepare:bootstrap")) {
      await begin("prepare", "bootstrap");
      const detail = await prepare("bootstrap");
      await commit({ manifestPublished: String(detail.manifest) });
    }
    if (mode === "dump" && !committedSteps.has("prepare:enroll")) {
      await begin("prepare", "enroll");
      await prepare("enroll", `--local dump ${(dataPath as Extract<ResolvedDataPath, { kind: "smoke-twin" }>).stamp}`);
      await commit();
    }
    if (migrates && !committedSteps.has("prepare:migrate")) {
      await begin("prepare", "migrate");
      const detail = await prepare("migrate");
      await commit({ migrationsApplied: (detail.applied as string[]) ?? [], manifestPublished: String(detail.manifest) });
    }
    if (seeds && !committedSteps.has("prepare:seed")) {
      await begin("prepare", "seed");
      await prepare("seed");
      await commit();
    }
    // THE THREE SERVICE TOKENS (§3, §5): provisioned unattended for a database
    // this boot created or restored, once per plan — a rerun of the same plan
    // finds the step committed and reuses the files, never rotating them
    // (§1.3). Every other boot reuses the instance's files and never mints.
    if ((mode === "blank" || mode === "dump") && !committedSteps.has("prepare:tokens")) {
      await begin("prepare", "tokens");
      const provisioned = await runTokenProvisioning(repoRoot, {
        instance: instance.name,
        stateRoot: statesRoot,
        target: hostTarget!,
        lock: { backendPid: targetLock!.backendPid, holder: targetLock!.holder },
        stateDir: paths.dir,
      }, prepareChildEnv(process.env));
      if (!provisioned.ok) throw new Error(`tokens: ${provisioned.error}`);
      runSecrets.push(...heldTokens());
      log(`service tokens provisioned for ${provisioned.holders.join(", ")} (hash and rights in the token store; secrets in ${paths.tokensDir})`);
      await commit();
    } else {
      const refusal = tokenReuseRefusal(paths, remote ? "remote" : "volume");
      if (refusal) throw new Error(refusal);
    }
  }

  // The analytics-producer's own seed command, a client of the running api
  // that authenticates with the producer's token: it belongs to READINESS on
  // EVERY boot (§6.3: "`analytics-producer` to have authenticated with its
  // token and completed its seed command"), not only under `--seed`. It is
  // idempotent (the EDGAR bootstrap and a research refresh). Its outcome is a
  // named readiness result, so a failure is recorded, not thrown past.
  let seedOutcome = { completed: false, detail: "the analytics-producer seed command has not run" };
  async function producerSeed(): Promise<void> {
    log("analytics-producer seed command…");
    try {
      await stack.composeAsync(
        ["run", "--rm", "--no-deps", "analytics-producer", "bun", "run", "src/producer/index.ts", "seed"],
        "analytics-producer seed",
        { stdout: outFd, stderr: errFd },
      );
      seedOutcome = { completed: true, detail: "`src/producer/index.ts seed` exited 0 with the producer's token" };
    } catch (err) {
      seedOutcome = { completed: false, detail: err instanceof Error ? err.message : String(err) };
    }
    log(`analytics-producer seed: ${seedOutcome.completed ? "complete" : `FAILED — ${seedOutcome.detail}`}`);
  }

  // The phase boundaries, hung on the stack's own steps. Each ends the open
  // record, honours a pending Ctrl-C, and begins the next one.
  const beforeStep = async (stackStep: StackStep): Promise<void> => {
    if (stackStep === "assemble") {
      await commit();
      await begin("prepare", "assemble");
    } else if (stackStep === "database") {
      // §13.3, D54: BEFORE THE FIRST MUTATION OF THE TARGET — no role, no
      // lock, no migrate, no seed, no token — the site that will serve this
      // plan's api (the one it deploys, else the live one) must admit this
      // tree's API version. stack.up assembles `_static` before this boundary
      // precisely so the decision can be taken here. A refusal leaves the
      // database, the live site and every container as they were.
      await commit();
      await begin("prepare", "web-compat");
      const compat = readWebCompatPlan(paths.webDir, join(repoRoot, "_static"), readContractVersion(repoRoot));
      const refusal = webCompatRefusal(compat);
      if (refusal) throw new RefusedBeforeAnyWrite(refusal);
      log(`web compat: API ${compat.apiVersion} is inside ${(compat.deploys ?? compat.live)!.siteId}'s range (${(compat.deploys ?? compat.live)!.range})`);
      await commit();
    } else if (stackStep === "site") {
      // W7: the assembled `_static` becomes this instance's current site
      // (stack.ts places it; scripts/lib/smoke-site.ts). A switch of `current`
      // changes what a running website-server serves, so it is journaled. The
      // compat decision was taken at the `database` boundary, before any write.
      await commit();
      await begin("prepare", "site");
    } else if (stackStep === "build") {
      await commit();
      await begin("prepare", "images");
    } else if (stackStep === "postgres") {
      await commit();
    } else if (stackStep === "services") {
      await commit();
      // PREFLIGHT (§7): checks 1-6, read-only, after every preparation and
      // before any application service is replaced, from the host as
      // rm_readonly under the target lock. Its report is the receipt's; any
      // refusal stops the boot here.
      await begin("preflight", null);
      const detail = await prepare("preflight");
      const report = detail.report as { passed: boolean; results: { check: string; findings: { severity: string; message: string }[] }[] };
      for (const result of report.results) {
        const refusals = result.findings.filter((f) => f.severity === "refuse");
        const detailText = result.findings.map((f) => `${f.severity}: ${f.message}`).join(" | ") || "no finding";
        preflightResults.push({ check: result.check, pass: refusals.length === 0, detail: detailText });
      }
      if (!report.passed) {
        throw new Error(`preflight refused the boot: ${preflightResults.filter((r) => !r.pass).map((r) => `${r.check} (${r.detail})`).join("; ")}`);
      }
      await commit();
      await begin("replace", null);
    } else if (stackStep === "health") {
      // Every service `compose up` just brought to its planned image, recreated
      // or kept, and the digest each now runs.
      await commit({ servicesReplaced: runningServices() });
      // Participants (§6.2) are standing containers started by the participant
      // runtime (#1026 W3). This boot plans the roster and starts none of them.
      await begin("participants", null);
      if (plan.roster.agents.length + plan.roster.judges.length > 0) {
        log(`participants: roster of ${plan.roster.agents.length} agent(s) and ${plan.roster.judges.length} judge(s) planned; the participant runtime that starts them is not wired yet`);
      }
      await commit();
      await begin("readiness", null);
    }
  };

  applyHostPorts(await stack.up({
    // The database half runs first and migrates by itself (the host-side
    // migrate run); the stack's legacy in-container migrate step never runs.
    prepareDatabase,
    migrate: false,
    initialize: producerSeed, deferredServices: ["analytics-producer"],
    beforeStep,
  }));

  // ── Readiness (§6.3) and the receipt (§1.4) ─────────────────────────────
  // Every condition of §6.3, each a named result, read from its own authority
  // (scripts/lib/smoke-readiness-probes.ts) and judged by one gate
  // (smoke-readiness-scheduler.ts). Containers being up proves none of them.
  // The gate only reads: a scheduler with exhausted work fails readiness and
  // is left exactly as it is — the restart is the operator's (§6.3).
  writeStateFile();
  const observeReadiness = makeReadinessObserver({
    project,
    composePrefix: composeArgs(project, composeFilesRun.split(":")),
    apiUrl: hostBackendUrl(apiPort),
    operatorToken: operatorToken(),
    workerServices: [...WORKER_LANE_SERVICES],
    producerService: "analytics-producer",
    schedulerService: "system-scheduler",
    seed: () => seedOutcome,
    run: (args) => {
      const r = Bun.spawnSync(["docker", ...args], { env: dockerEnv!, stdout: "pipe", stderr: "pipe" });
      return { exitCode: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    },
  });
  let lastLine = "";
  const verdict = await awaitReadiness(observeReadiness, {
    timeoutMs: READINESS_TIMEOUT_MS,
    pollMs: READINESS_POLL_MS,
    onPoll: (checks: readonly GateCheck[]) => {
      const line = `readiness: ${checks.filter((c) => c.pass).length}/${checks.length} — waiting on ${checks.filter((c) => !c.pass).map((c) => c.check).join(", ") || "nothing"}`;
      if (line !== lastLine) log((lastLine = line));
    },
  });
  for (const c of verdict.checks) log(`  readiness ${c.check}: ${c.pass ? "pass" : "FAIL"} — ${c.detail}`);
  if (!verdict.passed) throw new Error(`readiness failed: ${verdict.reason}`);
  const readiness = verdict.checks;

  if (!process.env.CI) {
    // Non-fatal, as it always was: data freshness is logged, never a boot failure.
    await ensureFreshRegime(stack);
    await run(["bun", "run", "scripts/smoke-frontend-check.ts"], repoRoot,
      { ...process.env, BACKEND_URL: backendUrl } as Record<string, string>, "frontend checks")
      .then(() => log("frontend checks passed"))
      .catch((err) => log(`frontend checks failed (stack still running): ${err instanceof Error ? err.message : err}`));
  }

  const images = runningServices();
  const schema = await observeSchema();
  // Readiness started the deferred analytics-producer; that is its replacement.
  await commit({ servicesReplaced: Object.fromEntries(Object.entries(images).filter(([service]) => service === "analytics-producer")) });
  await writeReceipt(paths, {
    planId,
    plan,
    instance: instance.name,
    writtenAt: new Date().toISOString(),
    images,
    schema: { manifestHash: schema?.manifestHash ?? "none", migrations: schema?.ledger ?? [] },
    preflight: preflightResults,
    readiness,
  }, redaction);
  log(`receipt written: ${paths.receiptFile}`);

  if (process.env.CI) await runCiScenario(stack);

  // ── LOCAL: the stack is up; `bun smoke` exits (spec §1) ───────────────────
  // Containers stay up under Docker (`restart: unless-stopped`); `bun smoke:down`
  // stops them. The READY table. The per-boot admin token is never printed.
  console.log("\n" + "── Robot Money smoke — READY ──".padEnd(68, "─"));
  console.log(`  Site:       ${backendUrl}/`);
  console.log(`  Regime:     ${backendUrl}/regime`);
  console.log(`  Swarm:  ${backendUrl}/swarm`);
  for (const k of researchKeys) console.log(`  Research:   ${backendUrl}/research/${k}`);
  console.log(`  Admin:      ${backendUrl}/admin`);
  console.log(`  Instance:   ${instance.name}  (${paths.dir})`);
  console.log(`  Log file:   ${logFile}`);
  console.log(`  PG data:    ${keptDataDescription(dataPath, project) ?? `remote (${redactedDbUrl()})`}`);
  console.log("");
  // Rendered from the RESOLVED profile, never hardcoded.
  console.log(`  ${renderCadenceLine(cadence, scenario.subjects.length)}`);
  console.log(`  Observe from another terminal: bun smoke:status --instance ${instance.name} · bun smoke:tui --instance ${instance.name}`);
  console.log(`  The stack keeps running after this command exits. Stop it with: bun smoke:down --instance ${instance.name}`);
  console.log("  Reclaim stopped smokes' data volumes with: bun run smoke:clean");
  console.log("");
  log(`READY — Site ${backendUrl}/  ·  instance ${instance.name}`);
  interrupt.dispose();
  // §2: "It is released explicitly on exit."
  await releaseTargetLock();
  process.exit(0);
}

// One-time regime snapshot at boot, then verify it landed FRESH before handing
// off to the producer's own recurring timer (issue #361 Phase 4). NOTHING IS
// WIPED: no bring-up may TRUNCATE rows it did not create. The fresh/rerun/
// give-up decision is the pure decideRegimeBootAction (regime-boot.ts); this
// keeps only the I/O.
async function ensureFreshRegime(stack: Stack): Promise<void> {
  // The session driver captures BACKEND_URL at module load, so set it BEFORE the
  // dynamic import.
  process.env.BACKEND_URL = backendUrl;
  const e2e = await import(join(repoRoot, "scripts", "lib", "swarm", "session.ts"));
  const producerRail = {
    repoRoot,
    composeProject: project,
    composeFiles: composeFilesRun.split(":"),
    composeSpawnEnv: stack.spawnEnv,
    backendUrl,
  };
  const today = new Date().toISOString().slice(0, 10);
  await e2e.runRegimeClassify(today, producerRail).catch((err: unknown) => log(`regime run failed: ${err instanceof Error ? err.message : err}`));
  for (let attempt = 1; attempt <= REGIME_BOOT_MAX_ATTEMPTS; attempt++) {
    let staleness: RegimeBootStaleness | null = null;
    try {
      const snap = await fetch(`${backendUrl}${ROUTES.dashboards.regimeSnapshots}?range=1`).then((r) => (r.ok ? r.json() : null));
      staleness = snap?.staleness ?? null;
    } catch (err) {
      log(`regime freshness check failed (attempt ${attempt}/${REGIME_BOOT_MAX_ATTEMPTS}): ${err instanceof Error ? err.message : err}`);
    }
    const decision = decideRegimeBootAction(staleness, attempt);
    log(decision.message);
    if (decision.action === "fresh") break;
    if (decision.action === "rerun") {
      await e2e.runRegimeClassify(today, producerRail).catch((err: unknown) => log(`regime re-run failed: ${err instanceof Error ? err.message : err}`));
    }
  }
}

// CI: the scenario checks against the booted stack, then the shared teardown.
async function runCiScenario(stack: Stack): Promise<never> {
  if (process.env.CI && dataPath.kind === "smoke-twin") {
    // ── CI DUMP: the bounded end-to-end verdict (issue #537) ───────────────
    // Proves, against the real HTTP API: (1) the restore brought over real,
    // queryable committee data, (2) one NEW live session completes with the
    // restored personas, (3) imported history still serves under #498's
    // archival semantics. No judge coverage: nothing on this stack judges
    // inline (D48/D53) — it returns with the participant judge.
    console.log("\n[smoke] dump: running one live swarm session with the restored personas…");
    process.env.BACKEND_URL = backendUrl;
    const session = await import(join(repoRoot, "scripts", "lib", "swarm", "session.ts"));
    const roster = await session.rosterMembers(undefined, operatorToken());
    if (roster === null) throw new Error("dump restored no readable IC roster");
    const members = adoptRestoredRoster(scenario, roster, undefined, { twin: true, seatAllActive: seatAllRestored });
    const rail = {
      repoRoot,
      composeProject: project,
      composeFiles: composeFilesRun.split(":"),
      composeSpawnEnv: stack.spawnEnv,
      backendUrl,
      modelConfig: resolveModelConfig(process.env, { standingStack: staticPortMode }),
      onboardedHomes: new Map<string, { volume: string; passphrase?: string }>(),
      operatorToken: operatorToken(),
    };
    await session.runSession(scenario.subjects[0]!, 1, { rail, members, initializer: "adopt", cadence });

    console.log("[smoke] dump: asserting restored subjects, personas, live take and archival history…");
    await run(["bun", "run", "scripts/smoke-e2e-assert.ts"], repoRoot,
      { ...process.env, BACKEND_URL: backendUrl } as Record<string, string>, "smoke e2e assertions");
    console.log("\n[smoke] CI dump — scenario assertions passed");
  }

  if (process.env.CI && dataPath.kind !== "smoke-twin") {
    // No RM_ALLOW_INSECURE: D52 (1) retired the insecure gate, and the driver
    // presents the operator's token for its admin calls and asserts that a
    // member token is REFUSED on the role-gated routes (session.ts 5c/5d). The
    // stack's exact compose env + COMPOSE_FILE ride along because the driver
    // launches one member-agent CONTAINER per present member (issue #361), and
    // its `docker compose run` children must re-resolve the same compose model.
    console.log("\n[smoke] running swarm session…");
    await run(["bun", "run", "scripts/lib/swarm/session.ts"], repoRoot,
      { ...process.env, ...stack.spawnEnv, COMPOSE_FILE: composeFilesRun, BACKEND_URL: backendUrl, ...operatorTokenEnv() } as Record<string, string>, "swarm session");

    // Issue #209: the repo-native single-member starter against this live stack,
    // including its two missing-credential guards. (D21: REST is the only transport.)
    console.log("[smoke] running starter swarm agent (REST)…");
    const starterEnv = { ...process.env, BACKEND_URL: backendUrl, ...operatorTokenEnv() } as Record<string, string>;
    const { BACKEND_URL: _missingBackend, ...withoutBackendUrl } = starterEnv;
    await expectRunFailure(["bun", "run", "scripts/starter-swarm-agent.ts", "--transport=rest", "--e2e"], repoRoot,
      withoutBackendUrl, "starter swarm agent missing BACKEND_URL guard");
    const { [OPERATOR_TOKEN_FILE_ENV]: _missingOperator, ...withoutOperatorToken } = starterEnv;
    await expectRunFailure(["bun", "run", "scripts/starter-swarm-agent.ts", "--transport=rest", "--e2e"], repoRoot,
      withoutOperatorToken, `starter swarm agent missing ${OPERATOR_TOKEN_FILE_ENV} guard`);
    await run(["bun", "run", "scripts/starter-swarm-agent.ts", "--transport=rest", "--e2e"], repoRoot,
      starterEnv, "starter swarm agent REST live-stack exercise");

    console.log("[smoke] running frontend checks…");
    await run(["bun", "run", "scripts/smoke-frontend-check.ts"], repoRoot,
      { ...process.env, BACKEND_URL: backendUrl } as Record<string, string>, "frontend checks");

    console.log("[smoke] running browser checks…");
    await run(["bun", "run", "test:browser"], repoRoot,
      { ...process.env, BACKEND_URL: backendUrl, ...operatorTokenEnv() } as Record<string, string>, "browser checks");

    // LIVE steady-state smoke (issue #128): assert published swarm sessions, a
    // fresh regime snapshot, wallet/vault provenance live, both research
    // signals served. Fails loudly, naming the leg/feed — never a skip.
    console.log("[smoke] asserting LIVE steady state (smoke-live-smoke)…");
    await run(["bun", "run", "scripts/smoke-live-smoke.ts"], repoRoot,
      { ...process.env, BACKEND_URL: backendUrl } as Record<string, string>, "live smoke assertions");

    // PRODUCT invariants, via the same driver a cutover runs. tier=full is only
    // ever for a dump boot; this simulation roster carries deliberate no-shows
    // and no judge runs here, so tier=readonly.
    const verifyTier = "readonly";
    console.log(`[smoke] verifying product invariants (verify-live, tier=${verifyTier})…`);
    await run(["bun", "run", "scripts/verify-live.ts", "--base", backendUrl, "--tier", verifyTier], repoRoot,
      { ...process.env } as Record<string, string>, "live product verification");

    // Additive, env-gated (issue #104): the rmpc-release-e2e nightly reuses this
    // EXACT boot. Unset (a no-op) in e2e.yml.
    if (process.env.RMPC_RELEASE_E2E === "1") {
      console.log("\n[smoke] running rmpc release e2e driver…");
      await run(["bun", "run", "scripts/rmpc-release-e2e.ts"], repoRoot,
        { ...process.env, ...stack.spawnEnv, COMPOSE_FILE: composeFilesRun, BACKEND_URL: backendUrl, ...operatorTokenEnv() } as Record<string, string>, "rmpc release e2e");
    }

    // Additive, env-gated REAL-INFERENCE onboarding admission sweep (§11 R8),
    // reusing this EXACT stack. ONBOARDING_REAL_EVAL=1 only on e2e.yml's nightly
    // `schedule` mirror, a `real-eval`-labelled PR, or a real_eval dispatch
    // (issue #289, #373, #803). A failed/timed-out admission THROWS; provider
    // flake is retried inside runOnboardingEvalWithRetry. ONBOARDING_SWEEP_MODELS
    // and ONBOARDING_SWEEP_IDENTITIES_PER_MODEL widen the sweep (nightly-only).
    if (process.env.ONBOARDING_REAL_EVAL === "1") {
      const sweepModels = (process.env.ONBOARDING_SWEEP_MODELS?.trim() || process.env.AGENT_MODEL || resolveModelConfig().model)
        .split(":")
        .map((m) => m.trim())
        .filter(Boolean);
      const identitiesPerModel = Math.max(1, Number.parseInt(process.env.ONBOARDING_SWEEP_IDENTITIES_PER_MODEL ?? "1", 10) || 1);
      console.log(
        `\n[smoke] running REAL-INFERENCE onboarding eval sweep (§11 R8): ${sweepModels.length * identitiesPerModel} admission(s) across ` +
          `${sweepModels.length} model(s) [${sweepModels.join(", ")}], ${identitiesPerModel} identit${identitiesPerModel === 1 ? "y" : "ies"} each…`,
      );
      const sweepResults: Array<{ model: string; result: OnboardingEvalResult }> = [];
      const records: AdmissionRecord[] = [];
      for (const model of sweepModels) {
        for (let i = 0; i < identitiesPerModel; i++) {
          const startedAt = Date.now();
          const result = await runOnboardingEvalWithRetry({
            repoRoot,
            composeProject: project,
            composeFiles: composeFilesRun.split(":"),
            backendUrl,
            automationToken: operatorToken(),
            composeSpawnEnv: stack.spawnEnv,
            env: { ...process.env, AGENT_MODEL: model },
            onEvent: (msg) => console.log(`[smoke] onboarding-real-eval[${model}]: ${msg}`),
          });
          sweepResults.push({ model, result });
          records.push(admissionRecord(model, result, Date.now() - startedAt));
        }
      }
      // Written BEFORE the throw below so a RED run records exactly as much as a
      // green one does; e2e.yml folds this file into $GITHUB_STEP_SUMMARY.
      writeFileSync(join(repoRoot, ADMISSION_RECORD_FILE), `${formatAdmissionRecords(records)}\n`);
      console.log(`[smoke] wrote onboarding admission record to ${ADMISSION_RECORD_FILE}`);
      const failed = sweepResults.filter((r) => !r.result.admitted);
      for (const f of failed) if (f.result.transcript) console.log(`[smoke] onboarding real-eval (${f.model}, ${f.result.identity.runId}) container transcript:\n${f.result.transcript}`);
      if (failed.length > 0) {
        throw new Error(
          `real-inference onboarding eval: ${failed.length}/${sweepResults.length} admission(s) did not reach the active roster (§11 R8) — ` +
            failed
              .map((f) => `${f.model}/${f.result.identity.runId}: ${f.result.timedOut ? "timed out" : `container exited (code ${f.result.containerExitCode})`}`)
              .join("; "),
        );
      }
      console.log(`[smoke] real-inference onboarding eval: ${sweepResults.length}/${sweepResults.length} admission(s) admitted (§11 R8) ✓`);
    }
    console.log("\n[smoke] CI smoke — scenario assertions passed");
  }
  console.log("\n[smoke] CI scenario complete — shared cleanup through Stack.down…");
  await releaseTargetLock();
  cleanup();
  cleanCiVolume();
  process.exit(0);
}

// Wiring only: read the log off disk; selectFailureDetail() decides what of it
// is worth showing.
function failureDetail(): readonly string[] {
  try { return selectFailureDetail(readFileSync(logFile, "utf8"), logFile); } catch { return []; }
}

main().catch(async (err) => {
  const em = err instanceof Error ? err.message : String(err);
  // Journal first (below), then let go of the target lock: every exit path
  // releases it explicitly (§2), and a refused or stopped run must not hold it.
  if (logFd !== undefined) { try { writeSync(logFd, `[${ts()}] ${err instanceof StoppedAtBoundary ? "stopped" : "startup failed"}: ${em}\n`); } catch {} }

  // The journal was closed (or replaced) underneath this run — `smoke:down`
  // stopped the instance. The operator's stop wins: this run neither journals
  // nor touches a container again, and it does not rewrite the stack record.
  if (err instanceof JournalClosedUnderneathError) {
    console.error(`[smoke] ${em}`);
    console.error(`[smoke] stopped: instance ${instance.name} was stopped underneath this run; nothing further was started or torn down.`);
    console.error(`[smoke]   inspect:  bun smoke:status --instance ${instance.name}`);
    process.exit(1);
  }

  // §1.4: a stop at a phase boundary is journaled (by begin()), undoes nothing
  // and tears nothing down, and exits NON-ZERO: an interrupted deployment is not
  // a successful one, and a caller must not read it as one.
  if (err instanceof StoppedAtBoundary) {
    console.error(`[smoke] ${em}. Nothing was torn down; the journal records where the run stopped.`);
    await releaseTargetLock();
    try { writeStateFile(); } catch { /* best effort */ }
    printResumeHint();
    process.exit(130);
  }

  // Journal the failure against the phase it happened in (§1.3: the journal is
  // written before each phase and marked after).
  if (journal && openRecord) {
    try { await journal.endPhase("failed", em); } catch { /* the error below is the one to report */ }
  }
  await releaseTargetLock();

  // A refusal before this boot's first write: nothing of this plan ran, and
  // every running container is the previous deployment's. Stopping its writers
  // (below) would take down the live service over a boot that changed nothing.
  if (err instanceof RefusedBeforeAnyWrite) {
    console.error(`[smoke] refused: ${em}`);
    console.error("[smoke] nothing was changed: the database, the live site and every running container are as they were.");
    process.exit(1);
  }

  // CI tears the stack down, which also stops the writers, and must exit
  // non-zero for the job to fail.
  if (process.env.CI) {
    console.error("[smoke] startup failed:", em);
    if (!cleaned) dumpDiagnostics();
    cleanup();
    cleanCiVolume(); // even on failure the shared runner must not leak this run's volume
    process.exit(1);
  }

  // LOCAL: the stack stays up for inspection, so the writers must be stopped
  // EXPLICITLY — leaving them running is what let a failed boot go on mutating
  // the database (a remote one, that no teardown can roll back).
  const writers = dockerEnv ? quiesceWriters() : "none";
  // Failure may have happened before readiness wrote the stack record, yet the
  // containers can already be up. Write it best-effort so `smoke:down` can find
  // and tear them down. Never auto-teardown locally.
  try { if (dockerEnv) writeStateFile(); } catch { /* best effort */ }

  // Print and exit: nothing stays resident to repaint an error (spec §1: no TUI).
  console.error("[smoke] startup failed:", em);
  for (const d of failureDetail()) console.error(`[smoke]   ${d}`);
  if (!cleaned) dumpDiagnostics();
  console.log(`[smoke] ${writerQuiesceLine(writers)}`);
  printLeaveRunning();
  process.exit(1);
});
