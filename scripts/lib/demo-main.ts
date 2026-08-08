import { mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTui, color, hr, truncate, spinner, type Tui } from "./tui.ts";
import { resolveDemoEnv } from "./demo-env.ts";
import { DB_PREFLIGHT_STEP, dbPreflightArgv, EXTERNAL_PG_FLAG, externalPgOverlayYaml, postgresPhaseNarration, resolveExternalPg } from "./demo-external-pg.ts";
import { listDemoVolumes, makeDockerRunner, purgeDemoEvalContainers, removeDemoVolumes } from "./demo-volumes.ts";
import { provisionDemoAnalyticsTokenAfterPreflight, removeDemoAnalyticsToken } from "./demo-secret.ts";
import { decideRegimeBootAction, REGIME_BOOT_MAX_ATTEMPTS, type RegimeBootStaleness } from "./regime-boot.ts";
import {
  plannedRunAt,
  planSubjectSchedules,
  renderCadenceLine,
  resolveDemoCadenceForBoot,
  type SubjectCadencePlan,
} from "./demo-schedule.ts";
import {
  admissionRecord,
  ADMISSION_RECORD_FILE,
  classifyOutcome,
  explainOutcome,
  formatAdmissionRecords,
  formatOutcomeEvidence,
  resolveModelConfig,
  runOnboardingEvalWithRetry,
  type AdmissionRecord,
  type OnboardingIdentity,
  type OnboardingEvalResult,
} from "./onboarding-eval.ts";
import { startProspectTranscript } from "./demo-prospect-transcript.ts";
import { NEWCOMER_NAMES, plannedNewcomer as plannedNewcomerBase } from "./demo-newcomers.ts";
import {
  SMOKE_MEMBERS,
  adoptRestoredRoster,
  bootstrapStepNames,
  isSmokeMode,
  scenarioPlan,
} from "./smoke-mode.ts";
import { admissionDelayMs, decideAdmission } from "./swarm/roster-plan.ts";
import { memberHomeVolumeName } from "../agent/member-agent.ts";
import {
  assertStageWebPortFree,
  createStack,
  DEFAULT_STACK_DATABASE,
  describePortHolders,
  ENV_CLASS_COMPOSE_VAR,
  ENV_HASH_COMPOSE_VAR,
  generateStackCredentials,
  hostBackendUrl,
  internalDatabaseUrl,
  makeCommandRunner,
  PortUnavailableError,
  resolveStackEnvironment,
  stackProjectName,
  stalePortEnvWarnings,
  STAGE_COMPOSE_FILE,
  STAGE_WEB_PORT,
  type StackConfig,
  type StackEvent,
  type StackHostPorts,
} from "../stack/index.ts";
import { SWARM_ROSTER_CAP, ROUTES } from "@robotmoney/contract";
import {
  columns,
  columnWidth,
  swarmProgress,
  fmtCountdown,
  fmtDuration,
  memberGlyph,
  onboardGlyph,
  phaseGlyph,
  renderResearchPane,
  setContainer,
  setFatal,
  setFatalWriters,
  setOnboardStep,
  setStep,
  STAGE_COLOR,
  startOnboarding,
  stepGlyph,
  ticks,
  type DemoState,
  type UpcomingMember,
  type WriterQuiesce,
} from "./demo-tui-view.ts";
import { createReadinessPolling } from "./demo-readiness-polling.ts";
import {
  DB_WRITER_SERVICES,
  renderFailurePane,
  selectFailureDetail,
} from "./demo-failure.ts";
import { renderTelemetryPane, startTelemetryPolling } from "./demo-telemetry.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");
// State file consumed by `bun run demo:down` / `demo:status` to reconstruct the
// exact docker compose env. `.agents/` is the repo's runtime cache dir.
const stateFile = join(repoRoot, ".agents", "demo-state.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Run config -----------------------------------------------------------
// HOST PORTS ARE ASSIGNED BY DOCKER. Both published ports (api and postgres)
// are chosen by the daemon: docker-compose.yml publishes container ports only
// (`ports: ["8787"]` / `["5432"]`), and this file learns the host side back
// from `docker compose port` after the containers are up. Nothing here — and
// nothing in .env / .env.example — names a host port.
//
// Why (the full rationale is in scripts/stack/ports.ts's header). Two shapes
// have already failed. First, a FIXED default: the api port "preferred" 48787,
// so a CI boot (no `.env`) raced the standing stage demo for the exact port
// cloudflared routes stage.robotmoney-labs.dev to and took the site down, while
// the operator's `.env` pinned both ports so nothing was random locally at all.
// Then, a SELF-DRAWN random port: bind a free port, close it, hand the number
// to compose — a TOCTOU race, because anything on this box (a second demo, a
// concurrent job on the self-hosted runner) can take the port in the gap before
// compose binds it, and randomizing more stacks only widened the gap. Docker
// choosing and binding in one step inside the daemon has neither failure mode.
// (D21 retired the member-facing MCP server — there is no longer an `mcp`
// container or host port; members reach the swarm REST API on the api port.)
//
// THE ONE EXCEPTION: `bun run demo -- --static-port` appends docker-compose.stage.yml,
// which pins the api's host port (only) to 48787, the tunnel origin. It is a
// CLI ARGUMENT, never an env var — the same hard rule `--pg-data` follows (no
// per-property env config) — because pinning the tunnel port is a property of
// one deliberate invocation, never of a shell that happens to have something
// exported. It FAILS LOUDLY when the port is held rather than falling back,
// because cloudflared routes 48787 and nothing else: a fallback would produce a
// green boot serving a 502. Postgres stays Docker-assigned even when pinned.
// `--static-port` says what the flag DOES: it pins the web/api host port to the
// one fixed number in the system instead of letting Docker assign one. The old
// name, `--stage`, described an environment rather than an effect, which made it
// read like "boot the staging environment" — it never did that; it only pinned a
// port. Still accepted, with a warning, so a committed cloudflared runbook or an
// operator's muscle memory keeps working.
const STATIC_PORT_FLAG = "--static-port";
const LEGACY_STAGE_FLAG = "--stage";
// `bun smoke` → `bun scripts/demo.ts --smoke`. Every decision the flag implies
// lives in scripts/lib/smoke-mode.ts (executed by
// scripts/tests/unit/smoke-mode.test.ts); this file holds only the wiring.
const smokeMode = isSmokeMode(process.argv);
const scenario = scenarioPlan(smokeMode);
const usedLegacyStageFlag = process.argv.includes(LEGACY_STAGE_FLAG);
const staticPortMode = process.argv.includes(STATIC_PORT_FLAG) || usedLegacyStageFlag;
if (usedLegacyStageFlag) {
  console.warn(
    `[demo] ${LEGACY_STAGE_FLAG} is DEPRECATED and now means ${STATIC_PORT_FLAG} — same behaviour, clearer name ` +
      `(it pins the host port; it never selected an environment). Update your invocation.`,
  );
}

// …and the same argument selects the demo's CADENCE PROFILE (issue #371) — the
// swarm interval, the SUBMISSION WINDOW (#570), the subject phase offset and the
// producer beats. A `--static-port` boot is the standing/public demo (6 h per
// subject); every other boot, CI included, keeps today's fast ~2-min values.
// Every number lives in scripts/lib/demo-schedule.ts, which also ASSERTS that
// the constants resolved here are the ones this invocation claims — fatal if not.
const cadence = resolveDemoCadenceForBoot({ stage: staticPortMode, env: process.env });

// Loud, never silent. A stale `.env` (or an exported shell var) carrying
// WEB_PORT/POSTGRES_PORT no longer influences anything; say so with the reason
// rather than letting an operator believe a pin took effect.
for (const warning of stalePortEnvWarnings(process.env)) console.warn(`[demo] ${warning}`);

if (staticPortMode) {
  console.warn(
    `[demo] ############################################################\n` +
      `[demo] # --static-port: the web/api host port is PINNED to ${STAGE_WEB_PORT}.\n` +
      `[demo] # This is the ONE fixed port in the system — cloudflared routes\n` +
      `[demo] # stage.robotmoney-labs.dev to it and to nothing else. Only one\n` +
      `[demo] # stack can hold it at a time, so do not run --static-port\n` +
      `[demo] # alongside another pinned boot or CI's demo. Postgres (and every\n` +
      `[demo] # other published port) is still DOCKER-ASSIGNED.\n` +
      `[demo] ############################################################`,
  );
}

// --stage PRE-FLIGHT. The pin now lives entirely in docker-compose.stage.yml,
// so a held 48787 would surface as compose's own bind failure — accurate but
// opaque, buried in build output, and silent about WHO holds the port. This
// check runs BEFORE `compose up` so the operator gets the actionable version:
// name the holder, refuse to boot, exit non-zero. It is a diagnostic, not an
// allocation — the port is 48787 either way (see assertStageWebPortFree's
// comment on why this bind is not the TOCTOU pattern we just deleted).
async function stagePreflight(): Promise<void> {
  try {
    await assertStageWebPortFree();
  } catch (err) {
    if (err instanceof PortUnavailableError) {
      console.error(`[demo] FATAL: ${err.message}`);
      console.error(`[demo] what currently holds :${err.port}:`);
      console.error(describePortHolders(err.port, makeCommandRunner(process.env)));
      console.error(
        `[demo] NOT falling back to another port: cloudflared routes only :${STAGE_WEB_PORT}, so a\n` +
          `[demo] fallback would boot green and serve a 502 to every visitor. Free the port\n` +
          `[demo] (e.g. \`bun run demo:down\` for a standing demo) and re-run, or drop --static-port\n` +
          `[demo] to boot on a Docker-assigned port with no tunnel.`,
      );
      process.exit(1);
    }
    throw err;
  }
}
if (staticPortMode) await stagePreflight();

// --- Optional external/managed Postgres (--external-pg) ---------------------
// `bun run demo -- --external-pg` runs the stack against the managed Postgres
// whose details live in `.env`, and starts NO postgres container: no service, no
// pgdata volume, no published pg host port. Resolved HERE, before any credential
// is minted or any container is created, so a missing/blank DATABASE_URL fails
// on an untouched host rather than half-way through a bring-up. See
// scripts/lib/demo-external-pg.ts for why it is a CLI argument whose value comes
// from a file rather than an env var.
//
// CONSEQUENCE, stated once and loudly at boot: a demo pointed at a real database
// MIGRATES AND SEEDS IT, and its workers write to it for as long as it runs.
// That is the point of the flag, but it is not something to discover afterwards.
let externalPg: ReturnType<typeof resolveExternalPg>;
try {
  externalPg = resolveExternalPg(process.argv, { envFilePath: join(repoRoot, ".env") });
} catch (err) {
  console.error(`[demo] FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (externalPg.enabled) {
  console.warn(
    `[demo] ############################################################\n` +
      `[demo] # ${EXTERNAL_PG_FLAG}: NO postgres container will be started.\n` +
      `[demo] # target: ${externalPg.redactedUrl}\n` +
      `[demo] # source: .env (${externalPg.source})\n` +
      `[demo] # This boot RUNS MIGRATIONS AND SEEDS against that server, and\n` +
      `[demo] # its workers write to it until the demo is stopped. Nothing in\n` +
      `[demo] # demo:down or demo:clean can undo that — those only ever touch\n` +
      `[demo] # containers and Docker volumes, and there are none here.\n` +
      `[demo] ############################################################`,
  );
}

// Filled in from `docker compose port` once the containers exist — see
// applyHostPorts() below. They are 0 until then, and nothing may publish a URL
// built from them before that: a number nobody assigned is worse than no number.
// pgPort stays NULL for an --external-pg boot: no container, so no published
// port ever exists (distinct from 0, which would read as "not discovered yet").
let apiPort = 0;
let pgPort: number | null = 0;
let backendUrl = "";

// WHICH ENVIRONMENT this boot belongs to (scripts/stack/naming.ts): `ci` under
// GitHub Actions with a hash of the workflow/run/attempt/job quadruple (stable
// for every step of one job), `local` with a per-boot random hash otherwise.
// It drives BOTH the compose project name and the labels every container and
// volume carries, so a leaked container is attributable to the environment that
// created it instead of being unreapable on a host shared by the stage demo,
// the CI runner and local evals.
const stackEnvironment = resolveStackEnvironment(process.env);
// Pin the compose project name when DEMO_PROJECT is set (re-runs reuse/tear down the
// same containers); otherwise the environment-scoped default, e.g.
// `rm_demo_stack_9f2a1c4b7d` locally or `rm_ci_stack_…` under Actions.
// dockerEnv sets DEMO_PROJECT=project either way, so the compose label stays
// consistent.
const project = process.env.DEMO_PROJECT?.trim() || stackProjectName("stack", stackEnvironment);
// The baked-in demo database credentials and the two derived URLs now come from
// the shared stack config (scripts/stack/config.ts), which carries the
// "127.0.0.1, never localhost" rationale for backendUrl. DB_USER/DB_PASSWORD/
// DB_NAME stay as local aliases for writeStateFile() and the psql polls.
// With --external-pg the managed URL is carried on the database config, which is
// what makes internalDatabaseUrl() hand containers that URL and what makes
// scripts/stack drop the postgres service. Without it, today's baked-in
// throwaway credentials are unchanged.
const database = externalPg.enabled
  ? { ...DEFAULT_STACK_DATABASE, url: externalPg.url }
  : DEFAULT_STACK_DATABASE;
const DB_USER = database.user;
const DB_PASSWORD = database.password;
const DB_NAME = database.name;
const databaseUrl = internalDatabaseUrl(database);
// Base compose files (what demo:down/demo:status rebuild from — they stop/inspect
// by project and never need the pg-data bind overlay). composeFilesRun MAY append
// a generated bind overlay below; that fuller value drives the up/run calls here.
//
// The --stage overlay belongs to the BASE list, not to the run-only extension:
// it is the one file that names a host port, so demo:status must resolve the
// same topology when it asks `docker compose port` what is actually published.
const composeFilesBase = [
  "docker-compose.yml",
  "docker-compose.demo.yml",
  ...(staticPortMode ? [STAGE_COMPOSE_FILE] : [])
].join(":");
let composeFilesRun = composeFilesBase;

// The --external-pg overlay, generated the same way (and for the same reason) as
// the --pg-data bind overlay below: a GENERATED file appended LAST, never a
// committed one, because it encodes one invocation's choice rather than a
// property of the repo. It removes the postgres service and the pgdata volume
// and drops every `depends_on: postgres`, so `docker compose up` cannot pull the
// container back in through a dependency edge. Run-only (like --pg-data):
// demo:down / demo:status stop and inspect BY PROJECT, and learn that this boot
// had no postgres from the state file's externalPg flag instead.
if (externalPg.enabled) {
  const overrideFile = join(repoRoot, ".agents", `demo-${project}-external-pg.yml`);
  mkdirSync(dirname(overrideFile), { recursive: true });
  writeFileSync(overrideFile, externalPgOverlayYaml(externalPg.redactedUrl!));
  composeFilesRun = `${composeFilesBase}:${overrideFile}`;
}
const researchKeys = ["channel-divergence", "late-cycle-signals"];

// --- Optional resumable postgres data (issue: demo persistent volumes) --------
// `bun run demo -- --pg-data <host-dir>` bind-mounts postgres's data directory to
// <host-dir> so a rebooted demo restarts from where it left off. This is a CLI
// ARGUMENT, never an env var (hard user preference, 2026-07-21: no per-property
// env config) — the resolved value is recorded in demo-state.json instead.
//
// Reuse constraints (also documented in docs/architecture.md): same postgres major
// (17) and the same baked-in demo credentials; migrate + seed are idempotent
// (backend/src/db/seed.ts uses ON CONFLICT DO NOTHING), so re-booting on old data
// converges rather than duplicating rows.
//
// Bind mounts were verified EMPIRICALLY on this Linux host: postgres:17-alpine's
// entrypoint chowns the bind dir to its own container user and inits / resumes
// cleanly, so the documented named-volume fallback was NOT needed. The data dir
// ends up postgres-owned on the host — manage it with your own tooling; demo:clean
// never touches --pg-data host dirs (they are not docker volumes).
//
// Absent the flag, every run keeps today's fresh-per-run behavior: an anonymous
// named volume <project>_pgdata (labeled robotmoney.demo=1 by docker-compose.demo.yml).
function parsePgDataArg(): string | undefined {
  const i = process.argv.indexOf("--pg-data");
  const v = i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
  return v && v.trim() ? v.trim() : undefined;
}
const rawPgData = parsePgDataArg();
// Mutually exclusive by construction, not by precedence: --pg-data bind-mounts
// the data directory OF the ephemeral postgres container, and --external-pg
// means there is no such container. Silently honouring one would leave the
// operator believing a durable data location took effect when it did not.
if (rawPgData && externalPg.enabled) {
  console.error(
    `[demo] FATAL: --pg-data and ${EXTERNAL_PG_FLAG} are mutually exclusive. --pg-data binds the data directory of ` +
      `the ephemeral postgres container; ${EXTERNAL_PG_FLAG} starts no such container (the managed server owns its ` +
      `own storage). Pass one or the other.`,
  );
  process.exit(1);
}
const pgDataDir = rawPgData ? resolve(rawPgData) : undefined;
if (pgDataDir) {
  mkdirSync(pgDataDir, { recursive: true }); // created if absent; same value across runs = same data
  // Generated bind overlay: a short-syntax bind whose TARGET is the postgres data
  // dir. Compose merges service volumes by target path, so this REPLACES the base
  // named-volume mount (verified via `docker compose config`) — no named volume is
  // created. Kept on disk across teardown so it stays valid; safe to delete when
  // idle. Lives in .agents/ (the repo's runtime cache dir).
  const overrideFile = join(repoRoot, ".agents", `demo-${project}-pgdata.yml`);
  mkdirSync(dirname(overrideFile), { recursive: true });
  writeFileSync(
    overrideFile,
    `# GENERATED by scripts/lib/demo-main.ts for \`bun run demo -- --pg-data ${rawPgData}\`.\n` +
      `# Bind-mounts postgres data to a host dir so the demo resumes from it.\n` +
      `# Safe to delete when no demo is using this dir.\n` +
      `services:\n  postgres:\n    volumes:\n      - ${pgDataDir}:/var/lib/postgresql/data\n`,
  );
  composeFilesRun = `${composeFilesRun}:${overrideFile}`;
}

// Admin dashboard password (/admin — the task-queue jobs dashboard, guarded by
// ADMIN_TOKEN). A FRESH random secret every launch. Issue #456: this used to
// be published by mutating process.env.ADMIN_TOKEN on THIS process, so every
// same-process reader (the dynamically-imported swarm session driver's
// admin()/rosterMembers()/existingMemberNames(), agent.ts's enroll()) picked
// it up implicitly off the global — the exact "module-level or process.env
// global mutable state" shape the 2026-07-14 maintainability review flagged.
// It is now threaded EXPLICITLY instead: every in-process consumer takes an
// `adminToken` parameter (sessionRail.adminToken below, and the two
// runOnboardingEvalWithRetry call sites), and every genuine CHILD PROCESS
// that needs it (the CI swarm-session driver, the browser checks, the
// rmpc-release-e2e driver, the starter-swarm-agent exerciser) gets it as
// an explicit `ADMIN_TOKEN: adminPassword` entry in that spawn's own env
// object — never via `...process.env` inheriting a value this process
// happened to have mutated onto itself. It is printed ONLY to the
// interactive TUI (see render()): never passed to log(), never serialized by
// writeStateFile() (demo-state.json), and never printed in the plain non-TUI
// READY block. Both secrets are minted by the shared stack config's
// generateStackCredentials() (a FUNCTION, never executed on import) so the
// demo and every other consumer of the stack mint them identically.
const credentials = generateStackCredentials();
const adminPassword = credentials.adminToken;

// Analytics-provider bearer credential (issue #106). The worker's analytics
// updater jobs submit computed outputs through the authenticated
// /api/analytics/* boundary; the api verifies this same shared secret. A FRESH
// random value per launch, set here (before compose interpolation) so both
// containers agree. NEVER printed — not in logs, not in the TUI, not in
// demo-state.json.
const analyticsToken = credentials.analyticsToken;
// Host-side Docker secret material belongs outside the checkout. A read-only
// repo mount still exposes .agents, so keeping credentials there made any such
// mount a secret disclosure. The per-session directory is private by mkdtemp
// and is removed after a successful lifecycle teardown.
// Resolve every model/data-path preflight before provisioning a bearer file.
// A typo or missing funded model key must not leak a temp credential directory
// for a stack that never reached creation.
const demoEnv = resolveDemoEnv(process.env, { stage: staticPortMode });
const analyticsTokenFile = provisionDemoAnalyticsTokenAfterPreflight(project, analyticsToken, () => {
  if (!process.env.CI || process.env.ONBOARDING_REAL_EVAL === "1") {
    resolveModelConfig(process.env);
  }
});
credentials.analyticsTokenFile = analyticsTokenFile;
process.env.ANALYTICS_TOKEN_FILE_HOST = analyticsTokenFile;
delete process.env.ANALYTICS_TOKEN;

// Data-path resolution (issue #147: DEMO_HERMETIC and the stubbed/offline path
// were removed entirely — every boot, local or CI, is production parity: live
// Base mainnet RPC + live analytics + floor seed).
// Compose interpolation values the DEMO honours from the operator's own
// environment, passed to the shared stack explicitly via `extraComposeEnv`.
//
// Why an allowlist and not `...process.env`: scripts/stack deliberately does not
// inherit the ambient environment (§11.3 E1 — that is what keeps a provider key
// out of a container). But the DEMO is an operator tool, and these knobs are
// documented and load-bearing for it: exporting SWARM_WINDOW_MINUTES=5 or a
// custom BASE_RPC_URL before `bun run demo` works today, and silently ignoring
// it after the bring-up moved onto the shared module would be a behaviour
// regression that is miserable to debug. Every name here is interpolated by
// docker-compose.yml / docker-compose.demo.yml and each already carries a
// `:-default` there, so an unset value behaves exactly as before. Values
// buildComposeEnv() owns (ports, credentials, DATABASE_URL, POSTGRES_*,
// DEMO_PROJECT) are deliberately NOT listed: the stack config is their single
// source and an exported value must never shadow it.
const DEMO_COMPOSE_PASSTHROUGH = [
  "BASE_RPC_URL",
  "SWARM_AGGREGATE_CRON",
  "SWARM_CLOSE_WINDOW_CRON",
  "SWARM_NOTIFICATION_EMAIL_FROM",
  "SWARM_NOTIFICATION_EMAIL_TRANSPORT_TOKEN",
  "SWARM_NOTIFICATION_EMAIL_TRANSPORT_URL",
  "SWARM_OPEN_SESSION_CRON",
  "SWARM_PUBLISH_BRIEF_CRON",
  "SWARM_PUBLISH_CRON",
  "SWARM_SCHEDULES_ENABLED",
  "SWARM_WINDOW_MINUTES",
  "FETCH_CACHE_DIR",
  "FLOOR_SEED_PATH",
  "PROJECTS_SOURCE",
  "RM_ENV",
  "WORKER_DATABASE_URL",
] as const;

function demoPassthroughEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of DEMO_COMPOSE_PASSTHROUGH) {
    const v = env[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

// Env shared by every `docker compose` call — pins the project, selects the
// demo override, resolves the data path, and sets credentials. NO host ports:
// the compose files publish container ports only and Docker picks the host
// side, so there is nothing left for WEB_PORT/POSTGRES_PORT to interpolate.
const dockerEnv: Record<string, string> = {
  ...process.env,
  ...demoEnv.composeEnv,
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_FILE: composeFilesRun,
  DEMO_PROJECT: project,
  // Environment labels (scripts/stack/naming.ts) — docker-compose.demo.yml
  // stamps these on every service and on the pgdata volume so a reaper can
  // select by label instead of by name substring. Set here as well as in
  // buildComposeEnv because this map drives the direct `docker compose` calls
  // below, which do not go through the shared stack's spawn env.
  [ENV_CLASS_COMPOSE_VAR]: stackEnvironment.class,
  [ENV_HASH_COMPOSE_VAR]: stackEnvironment.hash,
  DATABASE_URL: databaseUrl,
  // Guards the /admin task-queue dashboard (X-Admin-Token). Passed to the api
  // container via docker-compose's `ADMIN_TOKEN: ${ADMIN_TOKEN:-}` line. Random
  // per launch; the value is shown ONLY in the interactive TUI (render()).
  ADMIN_TOKEN: adminPassword,
  // Only the path crosses the host/compose environment. Docker mounts the
  // secret into API (verifier) + analytics-producer; no other process receives
  // the credential value in its environment.
  ANALYTICS_TOKEN_FILE_HOST: analyticsTokenFile,
  POSTGRES_USER: DB_USER,
  POSTGRES_PASSWORD: DB_PASSWORD,
  POSTGRES_DB: DB_NAME,
} as Record<string, string>;

// The demo's own StackConfig (docs/architecture.md §11.3 E5, §3 L2). PURE data:
// nothing spawns until main() calls `stack.up()`. This is what makes the `full`
// profile a real RUNTIME consumer of the shared bring-up rather than a test-only
// branch — the demo boot below IS scripts/stack's boot.
const demoStackConfig: StackConfig = {
  repoRoot,
  project,
  profile: "full", // core (postgres + api) + the three worker lanes
  composeFiles: composeFilesRun.split(":"),
  database,
  credentials,
  environment: stackEnvironment,
  extraComposeEnv: { ...demoEnv.composeEnv, ...demoPassthroughEnv(process.env) },
};

// --- TUI + logging gating -------------------------------------------------
// The TUI activates ONLY for an interactive local run. CI and piped/non-TTY runs
// keep the EXACT plain behaviour (console narration, "inherit" child stdio).
const noTuiArg = process.argv.includes("--no-tui");
const tuiActive = Boolean(process.stdout.isTTY) && !process.env.CI && !process.env.NO_TUI && !noTuiArg;

// Per-project append log. All raw subprocess + orchestrator output lands here so
// the TUI screen can show only distilled state. Opened for every LOCAL run (CI
// keeps pure console). A fresh run gets its own file (project is random).
const logFile = join(repoRoot, ".agents", `demo-${project}.log`);
let logFd: number | undefined;
if (!process.env.CI) {
  mkdirSync(dirname(logFile), { recursive: true });
  logFd = openSync(logFile, "a"); // 'a' → re-running never crashes on an existing file
}
// Child stdio target: raw fd in TUI mode (keeps the screen clean), else "inherit"
// exactly as before. logFd is always defined when tuiActive (tuiActive ⇒ !CI).
const outFd: number | "inherit" = tuiActive ? logFd! : "inherit";
const errFd: number | "inherit" = outFd;

const startTime = Date.now();
const ts = () => new Date().toISOString();

// --- DemoState (drives the TUI panes) -------------------------------------
// The state shape, its transitions, and the pure display helpers now live in
// ./demo-tui-view.ts (issue #456) — this file just owns the ONE instance for
// this boot and threads it through. Local structural mirror of the swarm
// session driver's OnboardedMemberHome (agent.ts). The driver is loaded via a
// dynamic import() (untyped) so the driver's module-load reads BACKEND_URL
// AFTER it is set below; this local alias keeps our annotations decoupled
// from that dynamic boundary.
type OnboardedMemberHome = { volume: string; passphrase?: string };
// The route table, rebuilt once the api's host port is known. Before that the
// base is "" and every row says so rather than rendering a link to a port
// nobody has been given — Docker assigns it when the container starts, which is
// several minutes into a cold build.
function serviceRoutes(base: string): { name: string; url: string }[] {
  const at = (p: string) => (base ? `${base}${p}` : "(pending — Docker assigns the host port when api starts)");
  return [
    { name: "Site", url: at("/") },
    { name: "Regime", url: at("/regime") },
    { name: "Swarm", url: at("/swarm") },
    ...researchKeys.map((k) => ({ name: "Research", url: at(`/research/${k}`) })),
    // Admin task-queue jobs dashboard. URL only here (safe to appear anywhere);
    // the password is rendered on its own line in the TUI Services pane, never
    // stored in state.services.
    { name: "Admin", url: at("/admin") },
  ];
}
const state: DemoState = {
  services: serviceRoutes(""),
  containers: [
    // Under --external-pg the stack starts no postgres container, so the row
    // must not carry a tile for one — a green ✓ postgres beside five real
    // services reads as a sixth container that `docker ps` would never show.
    ...(externalPg.enabled ? [] : [{ name: "postgres", phase: "pending" as const }]),
    { name: "api", phase: "pending" },
    // One container per worker execution lane (issue #107): swarm is the
    // reserved interactive lane; analytics (regime + pipelines) and research
    // run independently so a blocked research fetch can't starve the others.
    { name: "worker-swarm", phase: "pending" },
    { name: "worker-analytics", phase: "pending" },
    { name: "worker-research", phase: "pending" },
  ],
  steps: [
    // Only external boots carry the guard, so only they show its step.
    ...(externalPg.enabled ? [{ name: "db preflight", status: "pending" as const }] : []),
    { name: "migrate", status: "pending" },
    { name: "api /health", status: "pending" },
    ...bootstrapStepNames(smokeMode).map((name) => ({ name, status: "pending" as const })),
  ],
  research: [],
  swarms: {},
  onboarded: [],
  upcoming: [],
  messages: [],
  telemetry: [],
  containerErrors: [],
};

// setContainer / setStep / startOnboarding / setOnboardStep (and the
// ONBOARD_STEPS checklist they drive) now live in ./demo-tui-view.ts — every
// call site below passes `state` explicitly (e.g.
// `setContainer(state, "postgres", "healthy")`). The checklist tracks
// docs/architecture.md §11.2 exactly: connect→claim are driven by the
// real-inference eval harness's observed step-state record
// (scripts/lib/onboarding-eval.ts), and session/memo/admitted flip when the
// newly-admitted member is separately observed submitting a signed take +
// posting a memo in a live swarm session (via swarmProgress).

// --- Logging --------------------------------------------------------------
// Orchestrator narration: always append a timestamped line to the log file; in
// TUI mode push a short line into the footer buffer (last ~8); in non-TUI mode
// also console.log exactly as the demo did before.
function log(msg: string): void {
  if (logFd !== undefined) { try { writeSync(logFd, `[${ts()}] ${msg}\n`); } catch { /* best effort */ } }
  if (tuiActive) {
    state.messages.push(msg);
    if (state.messages.length > 8) state.messages.shift();
  } else {
    console.log(msg);
  }
}

// In TUI mode, dynamically-imported modules (e2e.ts) and any stray console.*
// would corrupt the alternate screen. Redirect console.* to the log file while
// the TUI is up. The TUI itself paints via process.stdout.write (untouched), so
// only console.* is captured. Restored before any normal-screen printing.
const origConsole = { log: console.log, error: console.error, warn: console.warn };
let consolePatched = false;
function patchConsole(): void {
  if (consolePatched) return;
  consolePatched = true;
  const toLog = (...a: unknown[]) => {
    if (logFd !== undefined) { try { writeSync(logFd, a.map((x) => String(x)).join(" ") + "\n"); } catch { /* ignore */ } }
  };
  console.log = toLog; console.error = toLog; console.warn = toLog;
}
function unpatchConsole(): void {
  if (!consolePatched) return;
  consolePatched = false;
  console.log = origConsole.log; console.error = origConsole.error; console.warn = origConsole.warn;
}

// One line naming the run's identity: the compose project (annotated "(fixed)"
// when DEMO_PROJECT overrode the environment-scoped default) and the
// environment class + hash that every container label carries. The host ports
// are DELIBERATELY absent here — they do not exist yet; applyHostPorts() logs
// them the moment the daemon reports them.
const fx = (isFixed: boolean) => (isFixed ? " (fixed)" : "");
log(
  `project=${project}${fx(Boolean(process.env.DEMO_PROJECT?.trim()))}  ` +
    `env=${stackEnvironment.class}/${stackEnvironment.hash}  ` +
    `host ports=(assigned by Docker at start${staticPortMode ? "; api PINNED to :" + STAGE_WEB_PORT + " by --stage" : ""})`,
);

// The single point at which this process learns its host ports. Everything
// downstream — the route table, BACKEND_URL for every child, the READY banner,
// the state file — reads them from here, so there is exactly one place that
// knows a host port and it learned it from the daemon rather than guessing.
function applyHostPorts(ports: StackHostPorts): void {
  apiPort = ports.apiPort;
  pgPort = ports.pgPort;
  backendUrl = hostBackendUrl(apiPort);
  state.services = serviceRoutes(backendUrl);
  log(
    `host ports (Docker-assigned): api=:${apiPort}${staticPortMode ? " (STAGE-PINNED — cloudflared origin)" : ""}  ` +
      `pg=${pgPort === null ? `EXTERNAL (${externalPg.redactedUrl}) — no container, no published port` : `:${pgPort}`}`,
  );
  if (!staticPortMode && apiPort === STAGE_WEB_PORT) {
    // Possible but rare: Docker draws from the host's ephemeral range, which
    // CONTAINS 48787 — it can only happen while no stage demo holds it. Not
    // fatal (nothing is broken; cloudflared would simply route the stage
    // hostname at this demo), but it must never be a silent surprise.
    log(
      `WARNING: Docker assigned this NON-stage demo the tunnel origin :${STAGE_WEB_PORT}. ` +
        `stage.robotmoney-labs.dev will resolve to THIS stack until it is torn down.`,
    );
  }
}
log(
  `data path: LIVE (production parity — Base RPC ${demoEnv.baseRpcUrl ?? "config default https://mainnet.base.org"}, ` +
    `ANALYTICS_SOURCE=${demoEnv.analyticsSource}, ANALYTICS_FLOOR_SEED=${demoEnv.analyticsFloorSeed})`,
);

// --- Container lifecycle --------------------------------------------------
function dockerCompose(args: string[], check = true): Bun.SyncSubprocess {
  const r = Bun.spawnSync(["docker", "compose", ...args], {
    cwd: repoRoot,
    env: dockerEnv,
    stdout: outFd,
    stderr: errFd,
  });
  if (check && r.exitCode !== 0) {
    throw new Error(`docker compose ${args.join(" ")} failed (exit ${r.exitCode})`);
  }
  return r;
}

// On a startup failure, the containers are about to be torn down (CI) or left up
// (local) — capture their state and logs FIRST so the real cause is visible. In
// TUI mode this lands in the log file (outFd), else on the console as before.
function dumpDiagnostics(): void {
  const diag = (m: string) => { if (logFd !== undefined) { try { writeSync(logFd, m + "\n"); } catch {} } else console.error(m); };
  diag("\n[demo] --- container diagnostics ---");
  dockerCompose(["ps", "-a"], false);
  dockerCompose(["logs", "--no-color", "--tail", "60"], false);
  diag("[demo] --- end diagnostics ---\n");
}

let cleaned = false;
let downStack: (() => { exitCode: number }) | undefined;
// Teardown = `docker compose down` WITHOUT `-v` (issue: demo persistent volumes):
// containers + network are removed but the postgres data volume (or --pg-data host
// dir) SURVIVES, so a reboot resumes from where it left off. Deleting demo data is
// now ONLY ever `bun run demo:clean` (or, in CI, the scoped cleanCiVolume() below).
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  try {
    const purged = purgeDemoEvalContainers(makeDockerRunner(dockerEnv), { project });
    if (purged.removed.length > 0) {
      console.log(`[demo] purged ${purged.removed.length} evaluation container(s): ${purged.removed.join(", ")}`);
    }
    if (purged.skipped.length > 0) {
      console.log(`[demo] WARNING: failed to purge evaluation container(s): ${purged.skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}`);
    }
  } catch (err) {
    console.log(`[demo] WARNING: failed purging evaluation containers: ${err instanceof Error ? err.message : err}`);
  }
  console.log("\n[demo] tearing down (keeping postgres data)…");
  // Once createStack() exists, teardown uses the same scoped compose handle
  // that built and started the scenario. The fallback is only for a failure
  // before that handle could be constructed.
  const r = downStack ? downStack() : dockerCompose(["down"], false);
  if (r.exitCode === 0 && !removeDemoAnalyticsToken(analyticsTokenFile, project)) {
    console.log(`[demo] WARNING: refused unsafe analytics-token cleanup path ${analyticsTokenFile}`);
  }
  const where = pgDataDir ? `--pg-data dir ${pgDataDir}` : `volume ${project}_pgdata`;
  console.log(
    r.exitCode === 0
      ? `[demo] containers + network removed for ${project}; postgres data kept (${where})`
      : `[demo] teardown exited ${r.exitCode}`,
  );
}

// CI ONLY: a required per-PR e2e boot runs on the SHARED self-hosted runner; with
// keep-by-default (above) its pgdata volume would leak on the host forever. After
// teardown, delete THIS run's volume — scoped by the robotmoney.demo.project label
// so a co-tenant standing demo's volume is never touched. CI never passes
// --pg-data, so there is exactly one named volume to reclaim. Loud, best-effort:
// a failure here is logged, never silent (it would otherwise hide a leak).
function cleanCiVolume(): void {
  try {
    const run = makeDockerRunner(dockerEnv);
    const vols = listDemoVolumes(run, { project });
    if (vols.length === 0) {
      console.log(`[demo] no demo volume to clean for ${project}`);
      return;
    }
    const { removed, skipped } = removeDemoVolumes(run, vols.map((v) => v.name));
    for (const n of removed) console.log(`[demo] reclaimed CI volume ${n}`);
    for (const s of skipped) console.log(`[demo] WARNING could not remove ${s.name}: ${s.reason}`);
  } catch (err) {
    console.log(`[demo] CI volume clean failed: ${err instanceof Error ? err.message : err}`);
  }
}

// Write the state file so `demo:down`/`demo:status` can rebuild dockerEnv AND so a
// stopped demo's surviving data stays discoverable. It is KEPT through teardown
// (data survives, so its pointer must too), overwritten by the next boot, and only
// cleared when demo:clean deletes the volume it names. Records composeFilesBase
// (down/status stop/inspect by project — the pg-data bind overlay is irrelevant to
// them) plus the data location (pgDataDir for a --pg-data bind, else the named
// volume) so `demo:status` can report where the data lives and how to resume.
function writeStateFile(): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  const state = {
    project,
    // A RECORD of what Docker assigned, never an instruction. Nothing rebuilds
    // a stack from these — compose publishes container ports only — and they
    // are 0 on the early-failure path, where the file is written best-effort
    // before the containers existed. `demo:status` therefore asks
    // `docker compose port` for the LIVE values and treats these as history:
    // a state file left by a previous boot really can disagree with the daemon.
    apiPort,
    pgPort,
    // Was the api port PINNED by `--stage` (i.e. did this boot apply
    // docker-compose.stage.yml)? Recorded so demo:down / demo:status
    // reconstruct the same compose topology, and so `demo:status` can say out
    // loud that this demo is the one the tunnel points at. Provenance only —
    // the port itself is whatever the daemon reports.
    stage: staticPortMode,
    // The environment this boot belongs to, so the container/volume labels
    // demo:down and demo:status interpolate match the ones `up` stamped.
    envClass: stackEnvironment.class,
    envHash: stackEnvironment.hash,
    composeFiles: composeFilesBase,
    // REDACTED for an --external-pg boot. The baked-in demo credentials below
    // are deliberately recorded (they are not secrets — a throwaway container
    // owns them, and demo:down/status need them to reach it), but a managed
    // server's password is a real credential and this file lives inside the
    // checkout. `externalPg` is what demo:down / demo:status branch on; the
    // redacted URL is provenance for a human reading the file.
    externalPg: externalPg.enabled,
    databaseUrl: externalPg.enabled ? externalPg.redactedUrl : databaseUrl,
    dbUser: externalPg.enabled ? "(external — see .env)" : DB_USER,
    dbPassword: externalPg.enabled ? "(external — see .env)" : DB_PASSWORD,
    dbName: externalPg.enabled ? "(external — see .env)" : DB_NAME,
    // Path only (never the bearer value), so demo:down can remove the external
    // per-session secret directory after it has successfully stopped Compose.
    analyticsTokenFile,
    logFile,
    // Data location (issue: demo persistent volumes). Exactly one is set:
    //   pgDataDir → a `--pg-data` host bind dir (resume with the same flag);
    //   pgVolume  → the fresh-per-run named volume (survives; reclaim via demo:clean).
    // NEITHER is set for --external-pg: this stack created no volume and bound no
    // host dir, and naming one would send demo:clean after storage that does not
    // exist while implying the managed server's data is this demo's to reclaim.
    ...(externalPg.enabled ? {} : pgDataDir ? { pgDataDir } : { pgVolume: `${project}_pgdata` }),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// After a signal teardown, tell the operator their data survived and how to resume
// or reclaim it (issue: demo persistent volumes — teardown keeps the data now).
function printResumeHint(): void {
  if (externalPg.enabled) {
    console.log(`[demo] the database was EXTERNAL (${externalPg.redactedUrl}) — its data was never this demo's to keep or reclaim.`);
    // EVERY flag this boot ran with, not just the pg one: both are CLI-only by
    // design, so nothing about the next boot is inferred from state. A hint that
    // dropped --stage would resume the demo on a Docker-assigned port, leaving
    // the tunnel pointing at nothing.
    console.log(`[demo]   resume:  bun run demo --${staticPortMode ? " --stage" : ""} ${EXTERNAL_PG_FLAG}`);
    return;
  }
  if (pgDataDir) {
    console.log(`[demo] postgres data kept in --pg-data dir ${pgDataDir}.`);
    console.log(`[demo]   resume:  bun run demo -- --pg-data ${pgDataDir}`);
  } else {
    console.log(`[demo] postgres data kept in volume ${project}_pgdata (fresh-per-run).`);
    console.log(`[demo]   for a resumable demo, boot with: bun run demo -- --pg-data <host-dir>`);
  }
  console.log(`[demo]   reclaim demo volumes: bun run demo:clean`);
}

// Wiring only; DB_WRITER_SERVICES carries which services and why. Best-effort
// and non-throwing — raising from the failure path would replace the real cause
// with a teardown error.
function quiesceWriters(): WriterQuiesce {
  try {
    return dockerCompose(["stop", ...DB_WRITER_SERVICES], false).exitCode === 0 ? "stopped" : "failed";
  } catch {
    return "failed";
  }
}

// Print how to inspect and tear down, then leave the stack UP. Used only by the
// LOCAL startup-FAILURE path: a failed boot is left running for inspection (it does
// NOT auto-tear-down); a clean Ctrl-C/SIGTERM tears down via onSignal(), keeping
// data. Teardown of a left-running stack is `bun run demo:down`.
function printLeaveRunning(): void {
  console.log("\n[demo] containers left RUNNING (no auto-teardown).");
  console.log(`[demo]   state file:  ${stateFile}`);
  console.log(`[demo]   log file:    ${logFile}`);
  console.log(`[demo]   inspect:     bun run demo:status`);
  console.log(`[demo]   logs:        docker compose -p ${project} logs -f`);
  console.log(`[demo]   tear down:   bun run demo:down`);
}

// Ctrl-C / SIGTERM tear the stack down (containers + network) and exit, KEEPING the
// postgres data (issue: demo persistent volumes). In TUI mode restore the terminal
// FIRST so the teardown narration prints on the normal screen with a visible cursor.
// The log file and demo-state.json BOTH persist after teardown: the log for
// post-mortem, the state file as the pointer to the surviving data (demo:status
// reads it; a future boot resumes via `--pg-data`). (The CI flow calls cleanup() +
// cleanCiVolume(); the startup-failure path leaves containers up for inspection.)
function onSignal(): void {
  if (tui) tui.stop();
  unpatchConsole();
  console.log(`\n[demo] logs: ${logFile}`);
  cleanup();
  printResumeHint();
  process.exit(0);
}
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

// --- Readiness helpers ----------------------------------------------------
// waitForPostgres/waitForHttp used to live here as hand-rolled copies; they are
// now scripts/stack/stack.ts's, reached through the `stack` handle in main().

async function run(cmd: string[], cwd: string, env: Record<string, string>, label: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: outFd, stderr: errFd });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${label} failed (exit ${code})`);
}

async function expectRunFailure(cmd: string[], cwd: string, env: Record<string, string>, label: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: outFd, stderr: errFd });
  const code = await proc.exited;
  if (code === 0) throw new Error(`${label} unexpectedly exited 0`);
}

// --- Readiness-probe polling (research queue + container health) ----------
// Moved to ./demo-readiness-polling.ts (issue #456): legacy research-queue
// polling (D25 moved regime/research cadence to the independent
// analytics-producer; these polls still read the retired
// regime.classify/research.refresh queue rows for historical TUI
// compatibility) and container health polling (the REAL docker container
// status, not just the HTTP /health endpoint). One instance per boot, created
// here once every dependency it needs (dockerEnv, the DB credentials, the
// live backendUrl) is in scope; getBackendUrl is a getter (not a snapshot)
// because backendUrl is not resolved until applyHostPorts() runs, later in
// main().
const readinessPolling = createReadinessPolling({
  repoRoot,
  dockerEnv,
  externalPgEnabled: externalPg.enabled,
  dbUser: DB_USER,
  dbName: DB_NAME,
  researchKeys,
  getBackendUrl: () => backendUrl,
  state,
  log,
});

// --- TUI render -----------------------------------------------------------
let tui: Tui | undefined;
let frame = 0;
// readinessPolling.isHealthChecking() replaces the old module-level
// healthChecking flag — true while a docker-container health poll is in flight.

// fmtDuration / fmtCountdown / phaseGlyph / stepGlyph / onboardGlyph / ticks /
// STAGE_COLOR / memberGlyph / columnWidth / columns now live in
// ./demo-tui-view.ts (issue #456) — imported above. The glyph functions take
// `frame` explicitly (this module's own spinner-frame counter) instead of
// closing over it.
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const renderResearch = (height: number): string[] =>
  renderResearchPane(state, height, fmtCountdown(readinessPolling.secsUntilNext("regime.classify")),
    fmtCountdown(readinessPolling.secsUntilNext("research.refresh")));

function renderSwarm(subjectId: string, height: number): string[] {
  const c = state.swarms[subjectId];
  if (!c) return [color("2", "(no data)")];
  const nextTxt = c.nextAt > 0 ? `next ${fmtDuration(Math.max(0, c.nextAt - Date.now()))}` : "running…";
  const out = [
    color("1", c.subjectName) + color("2", `  [${c.sessionState}] pub:${c.publishedCount} · ${nextTxt}`),
  ];
  const ids = Object.keys(c.members);
  for (const id of ids) {
    const m = c.members[id];
    const stance = m.stance ? color(STAGE_COLOR[m.stage] || "37", ` ${m.stance}${m.confidence != null ? ` c=${m.confidence}` : ""}`) : "";
    out.push(`${memberGlyph(m, frame)} ${cap(id).padEnd(9)} ${m.stage.padEnd(9)}${stance}`);
  }
  if (ids.length === 0) out.push(color("2", "  (waiting…)"));
  if (c.history.length) {
    out.push(color("2", "recent:"));
    for (const h of c.history.slice(-Math.max(1, height - ids.length - 3))) {
      out.push(color("2", `  ${h.date}: ${h.synthesis}`));
    }
  }
  return out;
}

function render(): string[] {
  frame++;
  const W = tui ? tui.columns : 80;
  const H = tui ? tui.rows : 24;
  const lines: string[] = [];

  // Header
  lines.push(color("1;36", "Robot Money — standing demo") + color("2", `   ${project}   up ${fmtDuration(Date.now() - startTime)}`));
  lines.push(color("2", `log: ${logFile}`));

  // Services pane
  lines.push(hr(W, "Services"));
  for (const s of state.services) lines.push(`  ${color("36", s.name.padEnd(10))} ${s.url}`);
  // The admin dashboard password — shown ONLY here in the interactive TUI (never
  // logged, never in demo-state.json, never in the plain READY block). Sign in at
  // the /admin URL above with this value.
  lines.push(`  ${color("33", "Admin pass".padEnd(10))} ${color("1;33", adminPassword)}`);

  // Startup pane
  lines.push(hr(W, readinessPolling.isHealthChecking() ? `Startup ${spinner(frame)}` : "Startup"));
  lines.push("  " + state.containers.map((c) => `${phaseGlyph(c.phase, frame)} ${c.name}${c.detail ? color("2", `(${c.detail})`) : ""}`).join("   "));
  lines.push("  " + state.steps.map((s) => `${stepGlyph(s.status, frame)} ${s.name}`).join("   "));

  if (state.fatal) lines.push(...renderFailurePane(state.fatal, W, project));
  lines.push(...renderTelemetryPane(state.telemetry, state.containerErrors, W));

  // Onboarding strip (full width): every prospective member keeps its join checklist
  // after admission (status checks stay visible), plus a queue of upcoming members with
  // a live countdown to when each is admitted.
  lines.push(hr(W, "Onboarding"));
  if (state.onboarded.length === 0) {
    lines.push(color("2", "  · waiting for the first prospective member…"));
  } else {
    const MAX_SHOWN = 6; // keep the strip from crowding out the panes on a long run
    const hidden = state.onboarded.length - MAX_SHOWN;
    if (hidden > 0) lines.push(color("2", `  (+${hidden} earlier admitted — checks retained)`));
    for (const ob of state.onboarded.slice(-MAX_SHOWN)) {
      const cells = ob.steps.map((s) => `${onboardGlyph(s.status, frame)} ${s.key}`).join("  ");
      lines.push(truncate(`  ${color("36", ob.name.padEnd(10))} ${color("2", `(${ob.memberId})`)}  ${cells}`, W));
    }
  }
  if (state.upcoming.length > 0) {
    const now = Date.now();
    const items = state.upcoming
      .map((u) => `${color("36", u.name)} ${color("2", `in ${fmtDuration(Math.max(0, u.at - now))}`)}`)
      .join("    ");
    lines.push(truncate(`  ${color("2", "upcoming →")} ${items}`, W));
  }

  // Footer (built first so the middle region can claim the rest of the height)
  const footer: string[] = [hr(W, "Log")];
  for (const m of state.messages) footer.push(color("2", `  ${m}`));
  footer.push(color("2", "  Ctrl-C / SIGTERM tears down the stack (containers + network; postgres data kept)."));

  // Middle region: Research + one pane per swarm subject, splitting the largest
  // remaining space. Side-by-side columns when they fit; stacked when too narrow.
  const midH = Math.max(3, H - lines.length - footer.length - 1);
  lines.push(hr(W));
  const subjectIds = Object.keys(state.swarms);
  const paneCount = 1 + subjectIds.length;
  const fits = W >= 72 && columnWidth(W, paneCount) >= 22;
  if (fits) {
    const panes = [
      renderResearch(midH),
      ...subjectIds.map((id) => renderSwarm(id, midH)),
    ].map((p) => p.slice(0, midH));
    for (const l of columns(panes, W)) lines.push(l);
  } else {
    // Too narrow for columns: stack each pane, dividing the height evenly.
    const each = Math.max(2, Math.floor(midH / paneCount));
    const panes = [
      renderResearch(each),
      ...subjectIds.map((id) => renderSwarm(id, each)),
    ];
    for (let p = 0; p < panes.length; p++) {
      if (p > 0) lines.push(color("2", "·".repeat(Math.min(W, 24))));
      for (const l of panes[p].slice(0, each)) lines.push(truncate(l, W));
    }
  }

  return [...lines, ...footer];
}

// swarmProgress (maps the additive runSession/runAgent callback events
// onto swarm state) now lives in ./demo-tui-view.ts — every call site
// passes `state` and `log` explicitly: `swarmProgress(state, subject.id, log)`.

// --- Orchestration --------------------------------------------------------
async function main(): Promise<void> {
  // §11 R8: real inference is the demo's onboarding mode, never an optional
  // extra behind a flag — there is no hermetic/scripted onboarding fallback.
  // resolveModelConfig() above resolved AGENT_MODEL against the registry and
  // paired it with OPENCODE_API_KEY before any bearer file was provisioned. A
  // misconfiguration — an unknown model family, or a paid model with no funded
  // key — therefore fails LOUDLY before the demo spends minutes standing up the
  // stack or leaves secret material behind. CI's own invocation of this file exits (via the
  // `if (process.env.CI)` branch below) before ever reaching
  // onboardingDriver() — it runs a different, non-onboarding check suite — so
  // this check applies to a LOCAL standing demo unconditionally, and to a CI
  // run only when it's running the real-inference onboarding eval (Stage 7,
  // ONBOARDING_REAL_EVAL=1 — see the CI branch below): fail before spending
  // minutes standing up the stack, not ~20 minutes later at the eval step
  // itself. Which CI runs set it (issue #289, #373): .github/workflows/e2e.yml,
  // on a push to main, on its nightly `schedule` mirror of that push (04:37 UTC
  // — the slot the retired swarm-opencode-nightly.yml held), on a
  // `pull_request` whose PR carries the `real-eval` opt-in label, or
  // on a `workflow_dispatch` started with real_eval=true. An ORDINARY PR run
  // therefore leaves ONBOARDING_REAL_EVAL empty and skips this resolve, which
  // is correct: it has no eval to fail early for.
  if (tuiActive) {
    tui = createTui({ render });
    tui.start();
    patchConsole(); // capture stray console.* (incl. imported e2e.ts) into the log file
  }
  // Observe from here on, including through a failed boot. Keep the last good
  // sample: an empty sweep means docker hiccuped, not that the lanes vanished.
  startTelemetryPolling({ repoRoot, dockerEnv, onSample: ({ samples, errors }) => {
    if (samples.length > 0) { state.telemetry = samples; state.containerErrors = errors; }
  } });

  // ── The bring-up IS scripts/stack's bring-up (§11.3 E5) ──────────────────
  // build → postgres + wait → migrate → services → /health, in ONE shared
  // implementation. The demo contributes only what is genuinely demo-specific:
  // the `full` profile, its migrate flags, and the TUI rendering below.
  //
  // StackHooks is how the TUI is driven WITHOUT scripts/stack importing a
  // renderer: each lifecycle event maps onto the panes exactly as the
  // hand-rolled sequence did, so the visible boot is unchanged.
  const WORKER_LANES = ["worker-swarm", "worker-analytics", "worker-research", "analytics-producer"];
  const onStackEvent = (e: StackEvent): void => {
    if (e.phase === "log") return void log(e.message);
    const { phase, status } = e;
    if (phase === "build") {
      if (status === "start") {
        log("building compose images…");
        for (const c of state.containers) setContainer(state, c.name, "building");
      } else {
        for (const c of state.containers) setContainer(state, c.name, "pending");
      }
    } else if (phase === "postgres") {
      const n = postgresPhaseNarration(externalPg.enabled, status, e.detail);
      if (n.container) setContainer(state, "postgres", n.container);
      if (n.log) log(n.log);
    } else if (phase === "migrate") {
      if (status === "start") {
        log("running migrations…");
        setStep(state, "migrate", "running");
      } else {
        setStep(state, "migrate", "done");
      }
    } else if (phase === "services") {
      if (status === "start") {
        log("starting api, worker lanes (swarm/analytics/research)…");
        for (const n of ["api", ...WORKER_LANES]) setContainer(state, n, "starting");
      } else {
        // No /health endpoint on a lane — `up` ⇒ running (unchanged semantics).
        for (const n of WORKER_LANES) setContainer(state, n, "healthy", "running");
        setStep(state, "api /health", "running");
      }
    } else if (phase === "ports" && status === "done") {
      // The daemon has been asked what it published (`docker compose port`).
      // Narrated because a boot that hangs here is hanging on the readback, not
      // on the health check — a distinction that is invisible otherwise.
      log(`host ports discovered: ${e.detail ?? "?"}`);
    } else if (phase === "health" && status === "done") {
      setContainer(state, "api", "healthy");
      setStep(state, "api /health", "done");
      log("api healthy");
    }
  };

  const stack = createStack(demoStackConfig, {
    // The demo is an operator tool, so its documented compose knobs still apply
    // — they arrive as demoStackConfig.extraComposeEnv (see
    // DEMO_COMPOSE_PASSTHROUGH), never as an ambient inherit: only allowlisted
    // docker-client plumbing survives out of `hostEnv`.
    hostEnv: process.env,
    io: { stdout: outFd, stderr: errFd },
    hooks: { onEvent: onStackEvent },
  });
  downStack = () => stack.down();

  async function initializeScenario(): Promise<void> {
    const step = bootstrapStepNames(smokeMode)[0]!;
    setStep(state, step, "running");
    if (scenario.initializer === "archive") {
      // Stack.up already migrated this database. The production initializer
      // restores the archive + EDGAR data without running migrate a second time.
      await stack.composeAsync(
        ["run", "--rm", "--no-deps", "-e", "ANALYTICS_API_URL=http://api:8787", "api", "bun", "run", "scripts/prod-bootstrap.ts", "--already-migrated"],
        "archive initializer (already migrated)",
        { stdout: outFd, stderr: errFd },
      );
      log("archive and restored IC rows initialized");
    } else {
      // Simulation data only. Projects/schedules were selected on the single
      // migrate call above; this producer-owned seed intentionally does not
      // restore the v0 archive.
      await stack.composeAsync(
        ["run", "--rm", "--no-deps", "analytics-producer", "bun", "run", "src/producer/index.ts", "seed"],
        "simulation analytics seed",
        { stdout: outFd, stderr: errFd },
      );
      log("simulation schedules/projects/analytics initialized (archive omitted)");
    }
    setStep(state, step, "done");
  }

  // One shared bring-up: build/start, exactly one migration, Stack.up's single
  // readiness check, and only THEN typed scenario initialization — the order
  // the startup checklist above has always displayed (migrate → api /health →
  // archive restore | simulation seed).
  // Wiring only; dbPreflightArgv carries what this is and why.
  async function classifyDatabase(): Promise<void> {
    setStep(state, DB_PREFLIGHT_STEP, "running");
    await stack.composeAsync(dbPreflightArgv(scenario.initializer), "external database preflight", { stdout: outFd, stderr: errFd });
    setStep(state, DB_PREFLIGHT_STEP, "done");
    log("db classified: empty bootstraps, populated is adopted (idempotent seed) — mode in log");
  }

  applyHostPorts(await stack.up({
    migrateEnv: scenario.migrateEnv,
    migrateScriptArgs: [...scenario.migrateScriptArgs],
    preflight: externalPg.enabled ? classifyDatabase : undefined,
    initialize: initializeScenario,
  }));

  if (process.env.CI && smokeMode) {
    // ── CI SMOKE: the bounded end-to-end verdict (issue #537) ──────────────
    // A production-shaped boot's checks are NOT the demo's checks. The demo's
    // CI block below drives two sessions with the demo's invented characters,
    // exercises the starter agent, and asserts the demo's LIVE steady state —
    // none of which a smoke stack has. What a smoke boot must prove is exactly
    // three things, and it proves them against the real HTTP API:
    //   1. the production bootstrap restored the archive;
    //   2. one NEW live swarm session completes with the restored personas;
    //   3. the imported history is still served with #498's archival semantics.
    // Session execution is the same runSession() used by demo and standing mode;
    // only its typed subjects/members input differs.
    console.log("\n[demo] smoke: running one live swarm session with the restored personas…");
    process.env.BACKEND_URL = backendUrl;
    const session = await import(join(repoRoot, "scripts", "lib", "swarm", "session.ts"));
    const roster = await session.rosterMembers(undefined, adminPassword);
    if (roster === null) throw new Error("smoke initializer restored no readable IC roster");
    const members = adoptRestoredRoster(scenario, roster);
    const rail = {
      repoRoot,
      composeProject: project,
      composeFiles: composeFilesRun.split(":"),
      composeSpawnEnv: stack.spawnEnv,
      backendUrl,
      modelConfig: resolveModelConfig(process.env),
      onboardedHomes: new Map<string, OnboardedMemberHome>(),
      adminToken: adminPassword,
    };
    await session.runSession(scenario.subjects[0]!, 1, { rail, members, initializer: scenario.initializer, cadence });

    console.log("[demo] smoke: asserting restored subjects, personas, live take and archival history…");
    await run(["bun", "run", "scripts/smoke-e2e-assert.ts"], repoRoot,
      { ...process.env, BACKEND_URL: backendUrl } as Record<string, string>, "smoke e2e assertions");

    console.log("\n[demo] CI smoke — scenario assertions passed");
  }

  if (process.env.CI && !smokeMode) {
    // CI: run checks then tear down. (Unchanged — pure console, "inherit" stdio.)
    console.log("\n[demo] running swarm session…");
    // RM_ALLOW_INSECURE=1: docker-compose.demo.yml runs the api container with
    // this flag, so the backend's regime-write/admin gates ARE open here. The
    // session driver is secure-by-default
    // (scripts/lib/swarm/session.ts regimeWriteInsecure — opt-IN, mirroring
    // backend config.ts allowInsecure), so tell it explicitly that this stack
    // is insecure, keeping its 5c/5d cross-role log annotations truthful ("gate
    // open").
    //
    // The stack's exact compose env (stack.spawnEnv) + COMPOSE_FILE ride along
    // because the session driver now launches one member-agent CONTAINER per
    // present member (issue #361 Phase 2, scripts/lib/swarm/agent.ts
    // railFromEnv) — its `docker compose run` children must re-resolve the
    // same compose model this boot created, or the volume-hash check prompts
    // to recreate live data (see scripts/agent/member-agent.ts).
    await run(["bun", "run", "scripts/lib/swarm/session.ts"], repoRoot,
      { ...process.env, ...stack.spawnEnv, COMPOSE_FILE: composeFilesRun, BACKEND_URL: backendUrl, ADMIN_TOKEN: adminPassword, RM_ALLOW_INSECURE: "1" } as Record<string, string>, "swarm session");

    // Issue #209: exercise the repo-native single-member starter against this
    // required per-PR live stack. Its --e2e mode only provisions isolated
    // member credentials + an open session; the actual poll → brief → author →
    // memo → canonicalize → sign → submit → verified readback path is the same
    // exported implementation operators run. (D21: REST is the only transport.)
    console.log("[demo] running starter swarm agent (REST)…");
    const starterEnv = {
      ...process.env,
      BACKEND_URL: backendUrl,
      ADMIN_TOKEN: adminPassword,
    } as Record<string, string>;
    const { BACKEND_URL: _missingBackend, ...withoutBackendUrl } = starterEnv;
    await expectRunFailure(
      ["bun", "run", "scripts/starter-swarm-agent.ts", "--transport=rest", "--e2e"],
      repoRoot,
      withoutBackendUrl,
      "starter swarm agent missing BACKEND_URL guard",
    );
    const { ADMIN_TOKEN: _missingAdmin, ...withoutAdminToken } = starterEnv;
    await expectRunFailure(
      ["bun", "run", "scripts/starter-swarm-agent.ts", "--transport=rest", "--e2e"],
      repoRoot,
      withoutAdminToken,
      "starter swarm agent missing ADMIN_TOKEN guard",
    );
    await run(
      ["bun", "run", "scripts/starter-swarm-agent.ts", "--transport=rest", "--e2e"],
      repoRoot,
      starterEnv,
      "starter swarm agent REST live-stack exercise",
    );

    console.log("[demo] running frontend checks…");
    await run(["bun", "run", "scripts/demo-frontend-check.ts"], repoRoot,
      { ...process.env, BACKEND_URL: backendUrl } as Record<string, string>, "frontend checks");

    console.log("[demo] running browser checks…");
    await run(["bun", "run", "test:browser"], repoRoot,
      { ...process.env, BACKEND_URL: backendUrl, ADMIN_TOKEN: adminPassword } as Record<string, string>, "browser checks");

    // LIVE steady-state smoke (issue #128, now the ONLY CI path since issue #147
    // removed DEMO_HERMETIC and the hermetic RPC guard): assert >=2 published
    // swarm sessions, a fresh regime snapshot, wallet/vault provenance live
    // (with only the documented #120 degrades), and both research signals
    // served. Fails loudly, naming the leg/feed — never a skip.
    console.log("[demo] asserting LIVE steady state (demo-live-smoke)…");
    await run(["bun", "run", "scripts/demo-live-smoke.ts"], repoRoot,
      { ...process.env, BACKEND_URL: backendUrl } as Record<string, string>, "live smoke assertions");

    // Additive, env-gated (issue #104): the rmpc-release-e2e nightly reuses this
    // EXACT boot instead of standing up a parallel stack. Only runs when
    // RMPC_RELEASE_E2E=1 — unset (and therefore a no-op) in e2e.yml, so this
    // is zero behaviour change there.
    if (process.env.RMPC_RELEASE_E2E === "1") {
      console.log("\n[demo] running rmpc release e2e driver…");
      await run(["bun", "run", "scripts/rmpc-release-e2e.ts"], repoRoot,
        { ...process.env, ...stack.spawnEnv, COMPOSE_FILE: composeFilesRun, BACKEND_URL: backendUrl, ADMIN_TOKEN: adminPassword } as Record<string, string>, "rmpc release e2e");
    }

    // Additive, env-gated (Stage 7, §11 R8, docs/plans/onboarding-ic-workflow.md):
    // the REAL-INFERENCE onboarding admission sweep reuses this EXACT
    // already-booted stack instead of standing up a parallel one — same
    // pattern as RMPC_RELEASE_E2E above. Only runs when ONBOARDING_REAL_EVAL=1.
    // Which CI runs set it (issue #289, #373): .github/workflows/e2e.yml on
    // exactly four events — a push to main, its NIGHTLY `schedule` mirror of
    // that push (04:37 UTC, the slot the retired swarm-opencode-nightly.yml
    // held), a `pull_request` whose PR carries the `real-eval` OPT-IN LABEL, and
    // a `workflow_dispatch` started with real_eval=true. It is off by default on
    // pull requests: that gating dates from the free-tier default whose quota
    // one eval per PR exhausted, and survives the funded default (D22 as
    // amended) because this repo has one self-hosted runner and an eval per PR
    // is minutes of exclusive runner time against a stochastic metric. Add the
    // `real-eval` label to opt a PR in; remove it to opt back out. A run
    // without ONBOARDING_REAL_EVAL set at all (an unlabelled `pull_request` run
    // of e2e.yml, a plain local `bun run demo`, or any invocation predating this
    // env var) is a no-op here and relies on Stage 5's separate inference-off
    // infra-rails test (scripts/tests/integration/onboarding-eval-infra.test.ts), which
    // e2e.yml still runs unconditionally on every PR. A failed/timed-out
    // admission THROWS (via `run`'s pattern — no silent pass): the whole point
    // of real inference is that a vanilla agent failing to navigate our own
    // onboarding instructions is a real regression signal, not a shrug.
    // Provider/infra flake (rate-limit signals, model refusals, and bare
    // timeouts on ANY tier — funded Zen stalls mid-session too) is mitigated by
    // runOnboardingEvalWithRetry's own retry/backoff
    // (scripts/lib/onboarding-eval.ts); it never retries a genuine navigation
    // failure, which presents as a container EXIT rather than a timeout.
    //
    // Sweep width (nightly-only knobs, both optional, both no-ops for e2e.yml,
    // which never sets them): ONBOARDING_SWEEP_MODELS is a ":"-separated
    // list of AGENT_MODEL selectors to try — family names, family/model pins,
    // or raw opencode/<id> (e.g. "deepseek:kimi:gpt/5.4"); default is the
    // single model resolveModelConfig() resolves.
    // ONBOARDING_SWEEP_IDENTITIES_PER_MODEL is how
    // many fresh admissions to run per model (default 1). e2e.yml never sets
    // either, so its eval-spending runs stay exactly one admission on one
    // model — this block is a strict superset of that behaviour, not a
    // different code path (§11 R8: one real flow, config-only differences).
    if (process.env.ONBOARDING_REAL_EVAL === "1") {
      // Nothing configured means "use the repo default", exactly as
      // resolveModelConfig() resolves it for a single admission. Reuse that
      // same resolution here so the sweep's default and a plain admission's
      // default can never drift apart.
      const sweepModels = (process.env.ONBOARDING_SWEEP_MODELS?.trim() || process.env.AGENT_MODEL || resolveModelConfig().model)
        .split(":")
        .map((m) => m.trim())
        .filter(Boolean);
      const identitiesPerModel = Math.max(1, Number.parseInt(process.env.ONBOARDING_SWEEP_IDENTITIES_PER_MODEL ?? "1", 10) || 1);
      const totalAdmissions = sweepModels.length * identitiesPerModel;
      console.log(
        `\n[demo] running REAL-INFERENCE onboarding eval sweep (§11 R8): ${totalAdmissions} admission(s) across ` +
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
            adminToken: adminPassword,
            composeSpawnEnv: stack.spawnEnv,
            env: { ...process.env, AGENT_MODEL: model },
            onEvent: (msg) => console.log(`[demo] onboarding-real-eval[${model}]: ${msg}`),
          });
          sweepResults.push({ model, result });
          records.push(admissionRecord(model, result, Date.now() - startedAt));
        }
      }
      // Reporting on the admission that already ran (issue #373) — no sampling
      // loop, no scorecard module, no second stack bring-up. Written BEFORE the
      // throw below so a RED run records exactly as much as a green one does;
      // .github/workflows/e2e.yml folds this file into $GITHUB_STEP_SUMMARY and
      // uploads it with `if: always()`, and the admission rate over time is
      // read off run history rather than a bespoke metric.
      writeFileSync(join(repoRoot, ADMISSION_RECORD_FILE), `${formatAdmissionRecords(records)}\n`);
      console.log(`[demo] wrote onboarding admission record to ${ADMISSION_RECORD_FILE}`);
      const failed = sweepResults.filter((r) => !r.result.admitted);
      for (const f of failed) if (f.result.transcript) console.log(`[demo] onboarding real-eval (${f.model}, ${f.result.identity.runId}) container transcript:\n${f.result.transcript}`);
      if (failed.length > 0) {
        throw new Error(
          `real-inference onboarding eval: ${failed.length}/${sweepResults.length} admission(s) did not reach the active roster (§11 R8) — ` +
            failed
              .map(
                (f) =>
                  `${f.model}/${f.result.identity.runId}: ${f.result.timedOut ? "timed out" : `container exited (code ${f.result.containerExitCode})`}`,
              )
              .join("; "),
        );
      }
      console.log(`[demo] real-inference onboarding eval: ${sweepResults.length}/${sweepResults.length} admission(s) admitted (§11 R8) ✓`);
    }

    console.log("\n[demo] CI demo — scenario assertions passed");
  }

  if (process.env.CI) {
    console.log("\n[demo] CI scenario complete — shared cleanup through Stack.down…");
    cleanup();
    cleanCiVolume();
    process.exit(0);
  }

  // ── LOCAL: standing demo ────────────────────────────────────────────────
  // Phase A done (stack healthy). Record state, print/route the READY routes, then
  // start the staggered ~2-min action loops. Never auto-tears-down.

  // Phase A: persist the state file so demo:down/demo:status can rebuild the env.
  writeStateFile();

  // Non-TUI keeps the exact plain READY table; TUI shows it in the Services pane.
  if (!tuiActive) {
    console.log("\n" + "── Robot Money demo — READY ──".padEnd(68, "─"));
    console.log(`  Site:       ${backendUrl}/`);
    console.log(`  Regime:     ${backendUrl}/regime`);
    console.log(`  Swarm:  ${backendUrl}/swarm`);
    for (const k of researchKeys) console.log(`  Research:   ${backendUrl}/research/${k}`);
    // URL only — the admin password is shown in the interactive TUI, never here.
    console.log(`  Admin:      ${backendUrl}/admin  (password shown in the interactive TUI only)`);
    console.log(`  State file: ${stateFile}`);
    console.log(`  Log file:   ${logFile}`);
    console.log(`  PG data:    ${pgDataDir ? `--pg-data ${pgDataDir} (bind; resumable)` : `volume ${project}_pgdata (fresh-per-run; kept on teardown)`}`);
    console.log("");
    // Rendered from the RESOLVED profile, never hardcoded — the banner must
    // state the cadence actually in force for this invocation.
    console.log(`  ${renderCadenceLine(cadence, scenario.subjects.length)}`);
    console.log("  Ctrl-C / SIGTERM tears down the stack (containers + network; postgres data kept).");
    console.log("  Reclaim stopped demos' data volumes with: bun run demo:clean");
    console.log("");
  }
  log(`READY — Site ${backendUrl}/  ·  state ${stateFile}`);

  // Research pane: begin polling the worker's real job queue (TUI mode only).
  if (tuiActive) readinessPolling.startResearchPolling();
  // Startup pane: begin live-checking the real docker container status (TUI only).
  if (tuiActive) readinessPolling.startHealthPolling();

  // Frontend check — ONCE at startup, non-fatal (unchanged behaviour). Runs in a
  // child process, so its process.exit on failure can't take the demo down.
  run(["bun", "run", "scripts/demo-frontend-check.ts"], repoRoot,
    { ...process.env, BACKEND_URL: backendUrl } as Record<string, string>, "frontend checks")
    .then(() => log("frontend checks passed"))
    .catch((err) => log(`frontend checks failed (stack still running): ${err instanceof Error ? err.message : err}`));

  // ── Phase B: staggered demo actions ──────────────────────────────────────
  // Analytics (regime + research) is driven by the analytics-producer's OWN cron
  // timers (D25 / issue #361 Phase 4), never the consumer queue. Their schedules
  // come from this invocation's cadence profile via resolveDemoEnv's composeEnv
  // (PRODUCER_REGIME_CRON / PRODUCER_RESEARCH_CRON), so regime and research stay
  // offset from each other and from the swarm beat.
  //
  // The swarm session drives live agents to submit takes over REST, so it
  // runs from a loop HERE. It fires immediately (data on first load) then on the
  // profile's swarm interval.
  //
  // The session driver captures BACKEND_URL at module load, so set it BEFORE
  // the dynamic import. main()'s reset-heavy flow is guarded by import.meta.url,
  // so importing here does NOT reset — we reset ONCE below and then accumulate.
  process.env.BACKEND_URL = backendUrl;
  const e2e = await import(join(repoRoot, "scripts", "lib", "swarm", "session.ts"));
  const producerRail = {
    repoRoot,
    composeProject: project,
    composeFiles: composeFilesRun.split(":"),
    composeSpawnEnv: stack.spawnEnv,
    backendUrl,
  };

  // One-time setup: seed regime. NOTHING IS WIPED HERE.
  //
  // This used to begin with `admin("reset")`, a TRUNCATE of every swarm
  // session, brief, recommendation and (by CASCADE) memo. That was invisible
  // while each boot got a throwaway postgres volume — there was never anything
  // to destroy — and became data loss the moment the database outlived the
  // stack: an --external-pg boot silently erased every previously published
  // memo, and RESTART IDENTITY made the next boot reuse those memo ids for
  // different memos. An ephemeral database is deleted or inspected as a whole;
  // no bring-up may TRUNCATE rows it did not create. The endpoint behind this
  // call is gone too, so there is no way back to the wiping behaviour.
  //
  // The regime snapshot is the PRODUCER's own regime.classify command (issue
  // #361 Phase 4), launched against this explicit stack rail and submitted
  // through the analytics HTTP boundary under the producer's credential; the
  // removed admin("regime") classifier path no longer exists.
  const today = new Date().toISOString().slice(0, 10);
  await e2e.runRegimeClassify(today, producerRail);

  // Self-heal: verify the boot regime run actually landed a FRESH snapshot before
  // handing off to the producer's recurring timer. A transient live-fetch failure (or
  // a throw) can leave the served snapshot frozen at the seed floor, which the
  // /regime charts would then render silently as if current. The API now reports
  // `staleness`; retry the run a few times, and if it's still stale, log LOUDLY so
  // the operator sees it instead of shipping a frozen dashboard. The fresh/rerun/
  // give-up decision is the pure decideRegimeBootAction (regime-boot.ts, unit-
  // tested); this loop keeps only the I/O around it.
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

  // Each subject runs on its OWN schedule (own interval + a stagger offset) so woon
  // and mav appear in separate panes on separate cadences. Execution is SERIALIZED
  // (run the earliest-due subject, then reschedule just that one) so two swarm
  // sessions never run concurrently and race on the shared member roster. runSession
  // with sessionIndex>0 self-seeds the (subject, regime) for its date, so no subject
  // needs pre-seeding here.
  // The TIMETABLE is decided by the pure planner in scripts/lib/demo-schedule.ts
  // (unit-tested in scripts/tests/unit/demo-schedule.test.ts; also the source of
  // the nightly LIVE smoke's deadline — issue #128). This loop keeps only the
  // I/O: every subject's first session lands promptly under BOTH profiles, and
  // later runs walk that subject's phase-offset steady-state grid.
  interface SubjectSchedule { subject: { id: string; name: string }; plan: SubjectCadencePlan; nextAt: number; runs: number; }
  const sessionSubjects = scenario.subjects.map((subject) => ({ ...subject }));
  let sessionMembers = scenario.members.map((member) => ({ ...member }));
  const plans = planSubjectSchedules(sessionSubjects.length, cadence, Date.now());
  const schedules: SubjectSchedule[] = sessionSubjects.map((s, i) => ({
    subject: s, plan: plans[i], nextAt: plans[i].firstAt, runs: 0,
  }));
  // ── Adopt the personas this database already knows ────────────────────────
  // A persistent database outlives the stack, so by the second boot the roster
  // already holds personas this process never admitted. Without this they sat on
  // the roster as historical members and never filed another take — the standing
  // demo ran three-member sessions while claiming six seats — because their
  // signing key lived in a per-boot volume and their passphrase only in the
  // previous process's memory.
  //
  // Adoption is possible because a persona's key is COMMITTED
  // (scripts/lib/swarm/fixtures/persona-keys.json): the enroll run below
  // seeds the container keystore with the known key and re-registers it against
  // the member id the database already has (registerMember is idempotent by id —
  // it rebinds the key, mints a token, and the roster cap exempts an existing
  // member). The persona keeps its id, its name and every take it has filed.
  //
  // Both scenarios reconnect database identities through one helper. It returns
  // a fresh array so a previous run can never contaminate this run's seats.
  if (smokeMode) log(`smoke mode: seating only the restored personas (${SMOKE_MEMBERS.map((m) => m.name).join(", ")})`);
  const dbRoster = await e2e.rosterMembers(undefined, adminPassword);
  if (dbRoster === null) {
    if (smokeMode) throw new Error("smoke initializer restored no readable IC roster");
    log("roster unreadable at boot — continuing with this run's simulation members");
  } else {
    const before = sessionMembers.length;
    sessionMembers = adoptRestoredRoster(scenario, dbRoster, sessionMembers);
    if (sessionMembers.length > before) log(`swarm now ${sessionMembers.length} seats (${sessionMembers.length - before} restored identities reconnected)`);
  }

  // Populate the per-subject panes and seed their countdowns.
  for (const sch of schedules) {
    state.swarms[sch.subject.id] = {
      subjectName: sch.subject.name, sessionState: "idle", members: {},
      publishedCount: 0, history: [], nextAt: sch.nextAt,
    };
  }

  // Real-onboarded members' persistent homes (issue #361 Phase 3): the eval
  // container that onboarded a newcomer ran with a persistent HOME volume, so
  // its rmpc keystore + claimed token survive it. This map hands the session
  // rail that volume (plus the owner-held passphrase), so the identity that
  // onboarded is the identity that signs every subsequent take. The retired
  // alternative — re-enrolling the newcomer with a fresh "demo-only simulation
  // key" through the privileged register shortcut — no longer exists.
  const onboardedHomes = new Map<string, OnboardedMemberHome>();

  // The member-container rail for this stack (issue #361 Phase 2): every
  // present member participates from its OWN container via the shared
  // runMemberAgent() primitive; this process only opens/closes session windows
  // and observes. resolveModelConfig() was already validated at boot.
  //
  // adminToken (issue #456): threaded explicitly instead of relying on the
  // now-removed process.env.ADMIN_TOKEN mutation. session.ts's runSession()
  // (via getAdminHeaders(adminToken)) and agent.ts's enroll() (via
  // rail.adminToken directly — issue #461 retired agent.ts's own
  // env-reading getAdminHeaders()) both take this token as an explicit
  // parameter, so this is what makes the dynamically-imported (same-process)
  // swarm session driver still authenticate correctly.
  const sessionRail = {
    ...producerRail,
    modelConfig: resolveModelConfig(process.env),
    onboardedHomes,
    adminToken: adminPassword,
  };



  async function swarmDriver(): Promise<void> {
    for (;;) {
      // Pick the earliest-due subject and wait until its slot.
      const due = schedules.reduce((a, b) => (b.nextAt < a.nextAt ? b : a));
      const wait = due.nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      const subject = due.subject;
      const c = state.swarms[subject.id];
      // NO DATE IS COMPUTED HERE. This used to be
      // `sessionDateFor(Date.now(), due.runs)` — today plus one synthetic day
      // per run — invented so repeat sessions would not collide on the old
      // UNIQUE(date, subject_id), and propped up by a boot-time TRUNCATE of all
      // session history whenever the demo wanted "today" back. Both are gone:
      // runSession() opens the session first and reads its date back from the
      // row Postgres stamped (convened_at, migration 0022), so the only clock
      // that dates a session is the database's.
      log(`swarm → ${subject.id} (convening; the database dates the session)`);
      c.members = {};
      c.nextAt = 0; // running now → pane shows "running…"
      try {
        const res = await e2e.runSession(subject, due.runs + 1, {
          rail: sessionRail,
          members: sessionMembers, cadence,
          // The STANDING loop needs this as much as the first session does.
          // Omitting it made runSession fall back to "simulation" and write
          // demo fixtures over archive-restored subjects — see session.ts.
          initializer: scenario.initializer,
          onProgress: tuiActive ? swarmProgress(state, subject.id, log) : undefined,
        });
        c.publishedCount++;
        const synth: string = res?.pub?.session?.synthesis ?? "";
        const date: string = res?.pub?.session?.date ?? "(unknown)";
        c.history.push({ date, synthesis: synth });
        if (c.history.length > 4) c.history.shift();
        log(`swarm published ${date}/${subject.id}`);
      } catch (err) {
        log(`swarm session failed (stack still running): ${err instanceof Error ? err.message : err}`);
      }
      due.runs++;
      // Next slot comes from the PLAN (self-correcting, no drift), never from a
      // literal here; clamped to "not in the past" so a session that overran its
      // slot reschedules immediately instead of firing a backlog.
      due.nextAt = Math.max(plannedRunAt(due.plan, due.runs), Date.now());
      c.nextAt = due.nextAt;
    }
  }
  void swarmDriver();

  // ── Periodic new-member onboarding (§11 R8: real-inference eval) ─────────
  // Every admission launches ONE vanilla OpenCode member-agent container
  // (scripts/lib/onboarding-eval.ts) and hands it the canonical copy-paste
  // prompt with a generated identity — no scripting beyond that: the agent
  // installs the swarm-onboarding skill + `rmpc`, generates its own
  // keypair, signs and submits the application over REST, and claims its token
  // entirely through its own real inference. This driver only OBSERVES (poll the public status
  // API + the admin roster) and performs the one scripted action §11 R7
  // explicitly allows to differ between demo and production: auto-approving
  // after 10s via the same admin API a human uses.
  //
  // The eval harness never hands this process the member's private key (§11
  // R3 — Robot Money never sees one). IDENTITY CONTINUITY (issue #361 Phase
  // 3): each candidate's container HOME is a persistent named volume, so an
  // admitted member's own rmpc keystore + claimed token survive the eval
  // container; ongoing SESSION PARTICIPATION mounts that same volume on the
  // member-container rail and signs with the SAME key that onboarded. The
  // owner-held keystore passphrase is generated here (this process plays the
  // owner, §11.3 E7) and retained for the member's lifetime in this demo. The
  // former re-enrollment path — a fresh "demo-only simulation key" via the
  // privileged register shortcut — is retired.
  //
  // RETRY POLICY (classified, not blanket — scripts/agent/classify-outcome.ts):
  // this driver rides runOnboardingEvalWithRetry, so an attempt classified
  // `refused` or `rate-limited` gets ONE retry with a DERIVED identity (same
  // display name, fresh contact) — in both cases the agent never ATTEMPTED
  // onboarding: the model declined the prompt, or the provider never let it
  // reason at all. A `navigation-failure` remains a genuine red eval result
  // (§11 R8) and is still never retried: the strip renders it failed and the
  // container transcript is logged. This matters HERE specifically because the
  // roster below is finite — on 2026-07-25 one refusal (clean exit, ~15s, all
  // steps pending) permanently forfeited a seat with nothing to retry it.
  //
  // FIXED, FINITE roster (scripts/lib/demo-newcomers.ts — the single, tested
  // source): the demo admits exactly the named newcomers listed there, in
  // order, and never more — no generated fallback name once the list is
  // exhausted, and the driver loop terminates once they're all attempted
  // rather than running forever.
  // ADMISSION CADENCE comes from the profile (scripts/lib/demo-schedule.ts), not
  // from literals here: the first admission stays prompt under both profiles
  // (after the base swarm shows), and later admissions ride the fast
  // profile's 5-min beat or, under `--stage`, the realistic swarm interval.
  // Adapt the shared finite-roster planner (demo-newcomers.ts) to the
  // real-inference driver's identity shape. `identity.runId` is a LOCAL slug
  // only (this driver's bookkeeping key + the container's --title); the real
  // memberId (§11 R2) is server-minted and only known once the harness observes
  // it. Returns null once the fixed list is exhausted — the driver stops, never
  // a generated fallback.
  function plannedNewcomer(n: number): { identity: OnboardingIdentity; lens: string; bias: number } | null {
    const p = plannedNewcomerBase(n);
    if (!p) return null;
    return {
      identity: { runId: p.memberId, name: p.name, contact: `${p.memberId}@example.test` },
      lens: p.lens,
      bias: p.bias,
    };
  }
  async function onboardingDriver(): Promise<void> {
    let admitted = 0;
    for (let n = 0; n < NEWCOMER_NAMES.length; n++) {
      // PRE-FILTER, before the wait. A persona this database already holds costs
      // nothing to pass over: the interval paces real admissions, and sleeping
      // 6 h to say "no" to a name would idle a restarted standing demo for a
      // full day before it reached the first genuinely new character. The
      // authoritative check still happens after the wait (below) — a name can be
      // taken while this one sleeps — so this only ever skips work early, never
      // admits anything it should not.
      const upNext = plannedNewcomer(n);
      if (upNext && !decideAdmission(upNext.identity.name, await e2e.existingMemberNames(undefined, adminPassword)).admit) {
        log(`onboarding ${upNext.identity.name} skipped — already on the roster (this database has been onboarded before)`);
        continue;
      }
      // Counted from ADMISSIONS, not from loop passes, so the first character
      // this boot actually admits still arrives promptly.
      const delay = admissionDelayMs(admitted, cadence.onboardingFirstMs, cadence.onboardingIntervalMs);
      const dueAt = Date.now() + delay;
      // Preview the next few admissions (this one + its successors, if any are
      // left in the fixed list) with countdowns.
      const upcoming: UpcomingMember[] = [];
      for (const k of [0, 1, 2]) {
        const p = plannedNewcomer(n + k);
        if (p) upcoming.push({ memberId: p.identity.runId, name: p.identity.name, at: dueAt + k * cadence.onboardingIntervalMs });
      }
      state.upcoming = upcoming;
      await sleep(delay);
      const planned = plannedNewcomer(n);
      if (!planned) break; // exhausted the fixed roster — stop, no generated fallback
      const { identity, lens, bias } = planned;
      // ALREADY ON THE ROSTER? The newcomer list is indexed by a counter that
      // restarts with this process, so against a persistent database every boot
      // would re-admit Helios and the roster would grow one duplicate per
      // restart (four Helios rows were observed on the standing demo — two
      // active, two stranded in `applied`). The database is the authority on who
      // has already joined; this loop only decides who is NEXT.
      //
      // Checked here, immediately before admitting, rather than once at start-up:
      // an admission takes minutes, and a name can be taken by an operator (or by
      // a second stack) in the meantime.
      const decision = decideAdmission(identity.name, await e2e.existingMemberNames(undefined, adminPassword));
      if (!decision.admit) {
        state.upcoming = [];
        log(
          decision.reason === "roster-unreadable"
            ? `onboarding ${identity.name} skipped — roster is unreadable, refusing to risk a duplicate`
            : `onboarding ${identity.name} skipped — already on the roster (this database has been onboarded before)`,
        );
        continue;
      }
      // Roster cap: once the active swarm reaches the contract's
      // SWARM_ROSTER_CAP, stop admitting — the same finite-roster bound
      // above already stops the demo from growing forever, but this stays as
      // defense in depth for a shared/reused roster. activeMemberCount() now
      // fails CONSERVATIVELY (assume full, never assume empty) on a read
      // error, so a transient fetch problem pauses admission instead of
      // silently waving one through.
      const active = await e2e.activeMemberCount();
      if (active >= SWARM_ROSTER_CAP) {
        state.upcoming = [];
        log(`onboarding ${identity.name} skipped — roster full (${active}/${SWARM_ROSTER_CAP})`);
        continue;
      }
      startOnboarding(state, identity.runId, identity.name); // append to the persistent pane + drop from upcoming
      setOnboardStep(state, identity.runId, "connect", "running"); // container is about to launch
      // Owner-held for this member's LIFETIME in this demo (issue #361 Phase
      // 3): the same passphrase must unlock the keystore in every later
      // session run. Never logged; redacted from transcripts at the source.
      const keystorePassphrase = crypto.randomUUID();
      // Retained, tailable, secret-redacted per-prospect transcript (issue
      // #317): every admission attempt, successful, failed, or still running,
      // gets a discoverable host-side record that survives the member-agent
      // container's own teardown — see scripts/lib/demo-prospect-transcript.ts.
      const attemptStartedAt = Date.now();
      const transcript = startProspectTranscript({
        repoRoot,
        composeProject: project,
        identity,
        model: resolveModelConfig(process.env).model,
      });
      log(`onboarding ${identity.name} transcript: ${transcript.directory} (tail -f ${join(transcript.directory, "events.ndjson")} while in progress)`);
      try {
        const result: OnboardingEvalResult = await runOnboardingEvalWithRetry({
          repoRoot,
          composeProject: project,
          composeFiles: composeFilesRun.split(":"),
          backendUrl,
          adminToken: adminPassword,
          composeSpawnEnv: stack.spawnEnv,
          identity,
          // Identity continuity (Phase 3): persistent per-attempt HOME volume
          // + a retained owner passphrase, so the admitted identity keeps
          // signing in later sessions.
          homeVolumeFor: (attemptIdentity) => memberHomeVolumeName(project, attemptIdentity.runId),
          keystorePassphrase,
          onEvent: (msg) => log(`onboarding-eval[${identity.runId}]: ${msg}`),
          // See startProspectTranscript's doc comment: a SINK, never `telemetry`
          // — each retry attempt still tags its own events with its own
          // attempt number, and all of them land in the one directory above.
          onStructuredEvent: transcript.sink,
        });
        transcript.finish(result, Date.now() - attemptStartedAt);

        // Rekey the pane entry to the server-minted memberId (§11 R2) as soon as
        // it's known, so swarmProgress's later ev.memberId lookups match.
        const ob = state.onboarded.find((o) => o.memberId === identity.runId);
        if (ob && result.memberId) ob.memberId = result.memberId;
        const entryId = result.memberId ?? identity.runId;

        // The strip renders straight from the harness's OBSERVED step-state
        // record — no fabricated sub-steps. Drop the harness's own trailing
        // "session" entry (it means "reached the active roster", which this
        // driver already tracks via `admitted` below); the strip's OWN
        // session/memo/admitted tail tracks real swarm participation.
        for (const s of result.steps) {
          if (s.step === "session") continue;
          setOnboardStep(state, entryId, s.step, s.status === "done" ? "done" : "pending");
        }

        if (!result.admitted) {
          // Mark the FIRST not-yet-done step in the pane's own (full 9-step)
          // checklist as failed — not just among the harness's first 6: a
          // member that reaches "claim" but never lands on the active roster
          // (e.g. the auto-approve call itself failing) would otherwise render
          // all-green with nothing visibly red.
          const stalledOb = state.onboarded.find((o) => o.memberId === entryId);
          const stalledAt = stalledOb?.steps.find((s) => s.status !== "done");
          if (stalledAt) setOnboardStep(state, entryId, stalledAt.key, "failed");
          // Which KIND of failure this was is the whole point (§11.3 E4): a
          // refusal and a navigation failure look identical in the step strip
          // but mean opposite things about our own instructions. Any attempt
          // the wrapper considered retryable is already exhausted by the time
          // control reaches here.
          const outcome = classifyOutcome(result);
          const retried = outcome === "refused" || outcome === "rate-limited" || outcome === "timed-out";
          log(
            `onboarding ${identity.name} (#${n + 1}) FAILED (${outcome}) — ` +
              `${result.timedOut ? "timed out" : `container exited (code ${result.containerExitCode})`} ` +
              "before reaching the active roster; " +
              (retried ? "retries exhausted" : "this is a real eval result, never retried"),
          );
          log(`onboarding ${identity.name} outcome evidence: ${formatOutcomeEvidence(explainOutcome(result))}`);
          if (result.identity.runId !== identity.runId) {
            log(`onboarding ${identity.name} final attempt ran as runId=${result.identity.runId} (${result.identity.contact})`);
          }
          if (result.transcript) log(`onboarding ${identity.name} container transcript:\n${result.transcript}`);
          continue;
        }

        // Admitted for real (§11 R6 verified, R2 id minted). This driver never
        // held the member's private key (R3): the member's rmpc keystore +
        // claimed token live in ITS persistent HOME volume, which the session
        // rail mounts for every later participation run — the identity that
        // onboarded is the identity that signs (issue #361 Phase 3).
        onboardedHomes.set(result.memberId!, {
          volume: result.homeVolume ?? memberHomeVolumeName(project, result.identity.runId),
          passphrase: keystorePassphrase,
        });
        sessionMembers.push({ memberId: result.memberId!, name: identity.name, lens, bias, present: true });
        admitted++; // paces the NEXT wait — skipped names must not count
        setOnboardStep(state, entryId, "session", "running");
        // Classified on the success path too, so every admission attempt leaves
        // the SAME outcome vocabulary in the log — a run that reads "admitted"
        // and one that reads "refused" are then directly comparable.
        log(`onboarding ${identity.name} classified ${classifyOutcome(result)}`);
        log(`onboarded ${identity.name} (#${n + 1}/${NEWCOMER_NAMES.length}) memberId=${result.memberId} — swarm now ${sessionMembers.length} seats; awaiting first session`);
      } catch (err) {
        log(`onboarding ${identity.name} eval threw (stack still running): ${err instanceof Error ? err.message : err}`);
        transcript.finishThrew(err, Date.now() - attemptStartedAt);
      }
    }
    state.upcoming = [];
    log(`onboarding complete — all ${NEWCOMER_NAMES.length} named newcomers attempted, no more will join`);
  }
  // Scripted newcomers are a DEMO narrative. A smoke boot shows the restored
  // committee and nothing else, so the driver never starts there; `bun demo`
  // keeps its unchanged behaviour (scripts/lib/smoke-mode.ts).
  if (scenario.runsNewcomerOnboarding) void onboardingDriver();

  await new Promise<never>(() => { /* run forever; Ctrl-C/SIGTERM (or `demo:down`) stops the stack */ });
}

// Wiring only: read the log off disk; selectFailureDetail() decides what of it
// is worth showing.
function failureDetail(): readonly string[] {
  try { return selectFailureDetail(readFileSync(logFile, "utf8"), logFile); } catch { return []; }
}

main().catch((err) => {
  const em = err instanceof Error ? err.message : String(err);
  if (logFd !== undefined) { try { writeSync(logFd, `[${ts()}] startup failed: ${em}\n`); } catch {} }
  for (const c of state.containers) if (c.phase === "starting" || c.phase === "building") setContainer(state, c.name, "failed");

  // CI tears the stack down, which also stops the writers. Unchanged: a CI boot
  // has no TUI to display in and must exit non-zero for the job to fail.
  if (process.env.CI) {
    if (tui) tui.stop();      // restore terminal FIRST (never leave escape junk)
    unpatchConsole();
    console.error("[demo] startup failed:", em);
    if (!cleaned) dumpDiagnostics();
    cleanup();
    cleanCiVolume(); // even on failure the shared runner must not leak this run's volume
    process.exit(1);
  }

  // LOCAL: the stack stays up for inspection, so the writers must be stopped
  // EXPLICITLY — leaving them running is what let a failed boot go on mutating
  // the database (an external one, under --external-pg, that no teardown can
  // roll back) for as long as the operator took to read the error.
  setFatal(state, em, { step: state.steps.find((s) => s.status === "running")?.name, detail: failureDetail() });
  setFatalWriters(state, quiesceWriters());
  for (const c of state.containers) {
    if (c.name !== "postgres" && c.phase === "healthy") setContainer(state, c.name, "failed", "stopped");
  }
  // Failure may have happened before Phase A wrote the state file, yet the
  // containers can already be up. Write it best-effort so `demo:down` can find
  // and tear them down. Never auto-teardown locally.
  try { writeStateFile(); } catch { /* best effort */ }

  if (tui) {
    // Stay resident and keep painting: the TUI IS the error report. Exiting here
    // is what used to tear the screen down and leave the operator with a bare
    // sentence on the normal screen. Ctrl-C/SIGTERM still tears down via
    // onSignal(), and `bun run demo:down` still works from another shell.
    if (!cleaned) dumpDiagnostics(); // console is patched → lands in the log file
    tui.repaint();
    return;
  }
  // No TUI (non-TTY, --no-tui, NO_TUI): nothing would ever repaint, so staying
  // resident would just hang. Print and exit exactly as before.
  unpatchConsole();
  console.error("[demo] startup failed:", em);
  for (const d of failureDetail()) console.error(`[demo]   ${d}`);
  if (!cleaned) dumpDiagnostics();
  console.log(`[demo] database writers: ${state.fatal?.writers ?? "unknown"}`);
  printLeaveRunning();
  process.exit(1);
});
