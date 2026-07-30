import { mkdirSync, writeFileSync, openSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTui, color, hr, truncate, spinner, visibleLen, type Tui } from "./tui.ts";
import { resolveDemoEnv } from "./demo-env.ts";
import { listDemoVolumes, makeDockerRunner, purgeDemoEvalContainers, removeDemoVolumes } from "./demo-volumes.ts";
import { decideRegimeBootAction, REGIME_BOOT_MAX_ATTEMPTS, type RegimeBootStaleness } from "./regime-boot.ts";
import { COMMITTEE_INTERVAL_MS, COMMITTEE_STAGGER_MS } from "./demo-schedule.ts";
import {
  classifyOutcome,
  explainOutcome,
  formatOutcomeEvidence,
  resolveModelConfig,
  runOnboardingEvalWithRetry,
  type OnboardingIdentity,
  type OnboardingEvalResult,
} from "./onboarding-eval.ts";
import { NEWCOMER_NAMES, plannedNewcomer as plannedNewcomerBase } from "./demo-newcomers.ts";
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
import { COMMITTEE_ROSTER_CAP, path as routePath, ROUTES } from "@robotmoney/contract";

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
// container or host port; members reach the committee REST API on the api port.)
//
// THE ONE EXCEPTION: `bun run demo -- --stage` appends docker-compose.stage.yml,
// which pins the api's host port (only) to 48787, the tunnel origin. It is a
// CLI ARGUMENT, never an env var — the same hard rule `--pg-data` follows (no
// per-property env config) — because pinning the tunnel port is a property of
// one deliberate invocation, never of a shell that happens to have something
// exported. It FAILS LOUDLY when the port is held rather than falling back,
// because cloudflared routes 48787 and nothing else: a fallback would produce a
// green boot serving a 502. Postgres stays Docker-assigned even under --stage.
const stageMode = process.argv.includes("--stage");

// Loud, never silent. A stale `.env` (or an exported shell var) carrying
// WEB_PORT/POSTGRES_PORT no longer influences anything; say so with the reason
// rather than letting an operator believe a pin took effect.
for (const warning of stalePortEnvWarnings(process.env)) console.warn(`[demo] ${warning}`);

if (stageMode) {
  console.warn(
    `[demo] ############################################################\n` +
      `[demo] # --stage: the web/api host port is PINNED to ${STAGE_WEB_PORT}.\n` +
      `[demo] # This is the ONE fixed port in the system — cloudflared routes\n` +
      `[demo] # stage.robotmoney-labs.dev to it and to nothing else. Only one\n` +
      `[demo] # stack can hold it at a time, so do not run --stage alongside\n` +
      `[demo] # another --stage boot or CI's demo. Postgres (and every other\n` +
      `[demo] # published port) is still DOCKER-ASSIGNED under --stage.\n` +
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
          `[demo] (e.g. \`bun run demo:down\` for a standing demo) and re-run, or drop --stage\n` +
          `[demo] to boot on a Docker-assigned port with no tunnel.`,
      );
      process.exit(1);
    }
    throw err;
  }
}
if (stageMode) await stagePreflight();

// Filled in from `docker compose port` once the containers exist — see
// applyHostPorts() below. They are 0 until then, and nothing may publish a URL
// built from them before that: a number nobody assigned is worse than no number.
let apiPort = 0;
let pgPort = 0;
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
const database = DEFAULT_STACK_DATABASE;
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
const composeFilesBase = ["docker-compose.yml", "docker-compose.demo.yml", ...(stageMode ? [STAGE_COMPOSE_FILE] : [])]
  .join(":");
let composeFilesRun = composeFilesBase;
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
  composeFilesRun = `${composeFilesBase}:${overrideFile}`;
}

// Admin dashboard password (/admin — the task-queue jobs dashboard, guarded by
// ADMIN_TOKEN). A FRESH random secret every launch, set on the environment HERE —
// before dockerEnv/compose interpolation and before any child process or the
// dynamically-imported committee session driver reads it — so the api container
// and every internal admin caller (the session driver's admin(), onboarding
// activate, rmpc-release-e2e) authenticate with the SAME value. It is printed
// ONLY to the interactive TUI
// (see render()): never passed to log(), never serialized by writeStateFile()
// (demo-state.json), and never printed in the plain non-TUI READY block.
// Both secrets are minted by the shared stack config's
// generateStackCredentials() (a FUNCTION, never executed on import) so the demo
// and every other consumer of the stack mint them identically.
const credentials = generateStackCredentials();
const adminPassword = credentials.adminToken;
process.env.ADMIN_TOKEN = adminPassword;

// Analytics-provider bearer credential (issue #106). The worker's analytics
// updater jobs submit computed outputs through the authenticated
// /api/analytics/* boundary; the api verifies this same shared secret. A FRESH
// random value per launch, set here (before compose interpolation) so both
// containers agree. NEVER printed — not in logs, not in the TUI, not in
// demo-state.json.
const analyticsToken = credentials.analyticsToken;
process.env.ANALYTICS_TOKEN = analyticsToken;

// Data-path resolution (issue #147: DEMO_HERMETIC and the stubbed/offline path
// were removed entirely — every boot, local or CI, is production parity: live
// Base mainnet RPC + live analytics + floor seed).
const demoEnv = resolveDemoEnv(process.env);

// Compose interpolation values the DEMO honours from the operator's own
// environment, passed to the shared stack explicitly via `extraComposeEnv`.
//
// Why an allowlist and not `...process.env`: scripts/stack deliberately does not
// inherit the ambient environment (§11.3 E1 — that is what keeps a provider key
// out of a container). But the DEMO is an operator tool, and these knobs are
// documented and load-bearing for it: exporting COMMITTEE_WINDOW_MINUTES=5 or a
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
  "COMMITTEE_AGGREGATE_CRON",
  "COMMITTEE_CLOSE_WINDOW_CRON",
  "COMMITTEE_NOTIFICATION_EMAIL_FROM",
  "COMMITTEE_NOTIFICATION_EMAIL_TRANSPORT_TOKEN",
  "COMMITTEE_NOTIFICATION_EMAIL_TRANSPORT_URL",
  "COMMITTEE_OPEN_SESSION_CRON",
  "COMMITTEE_PUBLISH_BRIEF_CRON",
  "COMMITTEE_PUBLISH_CRON",
  "COMMITTEE_SCHEDULES_ENABLED",
  "COMMITTEE_WINDOW_MINUTES",
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
  // Analytics-provider bearer (issue #106): api verifies, worker submits with
  // it (docker-compose's `ANALYTICS_TOKEN: ${ANALYTICS_TOKEN:-}` lines). Never
  // printed anywhere.
  ANALYTICS_TOKEN: analyticsToken,
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
type Phase = "pending" | "building" | "starting" | "healthy" | "failed";
type StepStatus = "pending" | "running" | "done" | "failed";
interface ResearchEntry { id: number; kind: string; state: "queued" | "running" | "done"; asof?: string; at?: string; note: string; }
interface MemberState { stage: "connect" | "fetch" | "thinking" | "reporting" | "waiting" | "done" | "absent"; stance?: string; confidence?: number; }
// Local structural mirrors of the committee session driver's types
// (scripts/lib/committee/session.ts SessionProgress / agent.ts
// OnboardedMemberHome). The driver is loaded via a dynamic import() (untyped)
// so the driver's module-load reads BACKEND_URL AFTER it is set below; these
// local aliases keep our annotations decoupled from that dynamic boundary.
type SessionProgress = (ev:
  | { type: "session"; state: string; sessionId?: number; subject: string; date?: string }
  | { type: "member"; memberId: string; stage: MemberState["stage"]; stance?: string; confidence?: number }
) => void;
// A real-onboarded member's persistent container HOME (its rmpc keystore +
// stored token) and the owner-held keystore passphrase (issue #361 Phase 3).
type OnboardedMemberHome = { volume: string; passphrase?: string };
// Per-subject committee pane. Each subject (woon, mav, …) runs on its OWN schedule
// and gets its OWN pane, so the TUI shows them side by side.
interface CommitteeState {
  subjectName: string;
  sessionState: string;
  sessionId?: number;
  members: Record<string, MemberState>;
  publishedCount: number;
  history: { date: string; synthesis: string }[];
  nextAt: number; // epoch-ms of this subject's next session; 0 = running now
}
// Prospective committee-member onboarding, shown as a full-width checklist strip.
// The steps mirror the real join gates; session/memo/admitted flip to done when the
// new member is observed participating (take + memo) in a live session.
type OnboardStepStatus = "pending" | "running" | "done" | "failed";
interface OnboardStep { key: string; status: OnboardStepStatus; }
interface OnboardState { memberId: string; name: string; steps: OnboardStep[]; }
// A member scheduled to be admitted in the future, with the epoch-ms of its admission
// so the TUI can render a live countdown.
interface UpcomingMember { memberId: string; name: string; at: number; }
interface DemoState {
  services: { name: string; url: string }[];
  containers: { name: string; phase: Phase; detail?: string }[];
  steps: { name: string; status: StepStatus }[];
  research: ResearchEntry[];
  committees: Record<string, CommitteeState>; // keyed by subject id; populated once SUBJECTS is imported
  onboarded: OnboardState[]; // every prospective member that has entered onboarding — kept in the pane with its live status checks
  upcoming: UpcomingMember[]; // scheduled future admissions, each with a countdown to its turn
  messages: string[];
}
// The route table, rebuilt once the api's host port is known. Before that the
// base is "" and every row says so rather than rendering a link to a port
// nobody has been given — Docker assigns it when the container starts, which is
// several minutes into a cold build.
function serviceRoutes(base: string): { name: string; url: string }[] {
  const at = (p: string) => (base ? `${base}${p}` : "(pending — Docker assigns the host port when api starts)");
  return [
    { name: "Site", url: at("/") },
    { name: "Regime", url: at("/regime") },
    { name: "Committee", url: at("/committee") },
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
    { name: "postgres", phase: "pending" },
    { name: "api", phase: "pending" },
    // One container per worker execution lane (issue #107): committee is the
    // reserved interactive lane; analytics (regime + pipelines) and research
    // run independently so a blocked research fetch can't starve the others.
    { name: "worker-committee", phase: "pending" },
    { name: "worker-analytics", phase: "pending" },
    { name: "worker-research", phase: "pending" },
  ],
  steps: [
    { name: "migrate", status: "pending" },
    { name: "api /health", status: "pending" },
    { name: "edgar seed", status: "pending" },
  ],
  research: [],
  committees: {},
  onboarded: [],
  upcoming: [],
  messages: [],
};

function setContainer(name: string, phase: Phase, detail?: string): void {
  const c = state.containers.find((x) => x.name === name);
  if (c) { c.phase = phase; if (detail !== undefined) c.detail = detail; }
}
function setStep(name: string, status: StepStatus): void {
  const s = state.steps.find((x) => x.name === name);
  if (s) s.status = status;
}
// The prospective-member join checklist, in order — tracks docs/architecture.md
// §11.2 exactly. connect→claim are driven by the real-inference eval harness's
// observed step-state record (scripts/lib/onboarding-eval.ts): a vanilla
// OpenCode agent container works these out for itself from the canonical
// prompt with real inference, no scripting (§11 R8). session/memo/admitted
// flip when the newly-admitted member is separately observed submitting a
// signed take + posting a memo in a live committee session (via
// committeeProgress) — the SAME mechanism that already drives these three for
// the long-standing hardcoded roster, since the eval's observe-only design has
// no visibility into ongoing session participation (see onboarding-eval.ts's
// module doc comment).
const ONBOARD_STEPS = ["connect", "discover", "toolchain", "apply", "approve", "claim", "session", "memo", "admitted"];
// Begin (or resume) a member's join checklist. The member is appended to the persistent
// onboarded list so its status checks stay in the pane after admission, and it is dropped
// from the upcoming queue now that its turn has arrived.
function startOnboarding(memberId: string, name: string): void {
  if (!state.onboarded.some((o) => o.memberId === memberId)) {
    state.onboarded.push({ memberId, name, steps: ONBOARD_STEPS.map((key) => ({ key, status: "pending" as OnboardStepStatus })) });
  }
  state.upcoming = state.upcoming.filter((u) => u.memberId !== memberId);
}
function setOnboardStep(memberId: string, key: string, status: OnboardStepStatus): void {
  const step = state.onboarded.find((o) => o.memberId === memberId)?.steps.find((s) => s.key === key);
  if (step) step.status = status;
}

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
    `host ports=(assigned by Docker at start${stageMode ? "; api PINNED to :" + STAGE_WEB_PORT + " by --stage" : ""})`,
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
  log(`host ports (Docker-assigned): api=:${apiPort}${stageMode ? " (STAGE-PINNED — cloudflared origin)" : ""}  pg=:${pgPort}`);
  if (!stageMode && apiPort === STAGE_WEB_PORT) {
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
  const r = dockerCompose(["down"], false);
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
    stage: stageMode,
    // The environment this boot belongs to, so the container/volume labels
    // demo:down and demo:status interpolate match the ones `up` stamped.
    envClass: stackEnvironment.class,
    envHash: stackEnvironment.hash,
    composeFiles: composeFilesBase,
    databaseUrl,
    dbUser: DB_USER,
    dbPassword: DB_PASSWORD,
    dbName: DB_NAME,
    logFile,
    // Data location (issue: demo persistent volumes). Exactly one is set:
    //   pgDataDir → a `--pg-data` host bind dir (resume with the same flag);
    //   pgVolume  → the fresh-per-run named volume (survives; reclaim via demo:clean).
    ...(pgDataDir ? { pgDataDir } : { pgVolume: `${project}_pgdata` }),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// After a signal teardown, tell the operator their data survived and how to resume
// or reclaim it (issue: demo persistent volumes — teardown keeps the data now).
function printResumeHint(): void {
  if (pgDataDir) {
    console.log(`[demo] postgres data kept in --pg-data dir ${pgDataDir}.`);
    console.log(`[demo]   resume:  bun run demo -- --pg-data ${pgDataDir}`);
  } else {
    console.log(`[demo] postgres data kept in volume ${project}_pgdata (fresh-per-run).`);
    console.log(`[demo]   for a resumable demo, boot with: bun run demo -- --pg-data <host-dir>`);
  }
  console.log(`[demo]   reclaim demo volumes: bun run demo:clean`);
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

// --- Research polling (no backend change) ---------------------------------
// The worker's scheduler drives regime.classify (hourly at :07, analytics lane) +
// research.refresh (hourly at :37, research lane) via the demo schedules. We
// observe them by polling the REAL task queue over
// `docker compose exec -T postgres psql`. The `jobs` table carries the
// honest lifecycle state (pending→running→succeeded/failed); `job_runs` only ever
// holds terminal rows (see worker/loop.ts), so we read state from `jobs` and join
// job_runs for the finished timestamp/error. Notes for finished runs are fetched
// once from the dashboard API (what actually landed). Fully defensive: any query
// failure is logged and skipped — it never crashes the TUI.
const researchNotes = new Map<number, string>();
// Countdown to the next worker-scheduled run per kind. We ask the DB for the
// seconds remaining (authoritative — avoids host/container clock skew) each poll
// and interpolate between polls in render(). regime.classify + research.refresh
// can each have BOTH a default daily row and a fast demo row enabled, so we take
// the SOONEST (MIN) upcoming run per kind — the two countdowns are INDEPENDENT
// (separate kinds, separate schedules, separate lanes).
interface NextRun { secondsUntil: number; fetchedAt: number; }
const nextRuns: Record<string, NextRun> = {};
function secsUntilNext(kind: string): number | null {
  const nr = nextRuns[kind];
  if (!nr) return null;
  return Math.max(0, Math.round(nr.secondsUntil - (Date.now() - nr.fetchedAt) / 1000));
}
function mapJobState(status: string): ResearchEntry["state"] {
  if (status === "pending") return "queued";
  if (status === "running") return "running";
  return "done"; // succeeded | failed | dead
}
async function fetchResearchNote(id: number, kind: string, failed: boolean, err: string): Promise<void> {
  if (failed) { researchNotes.set(id, `failed: ${err.split("\n")[0] || "error"}`); return; }
  try {
    // Kind-scoped summary (issue #107: regime and research are distinct jobs) —
    // a regime job reports the landed snapshot, a research job the landed signal.
    let note = "updated";
    if (kind === "regime.classify") {
      const snap = await fetch(`${backendUrl}${ROUTES.dashboards.regimeSnapshots}?range=1`).then((r) => (r.ok ? r.json() : null));
      const latest = snap?.latest;
      note = latest
        ? `regime → ${latest.regime ?? "?"}${latest.composite != null ? ` ${Number(latest.composite).toFixed(2)}` : ""}`
        : "regime updated";
    } else if (kind === "research.refresh") {
      const sig = await fetch(`${backendUrl}${routePath(ROUTES.dashboards.researchSignal, { key: researchKeys[0] })}`).then((r) => (r.ok ? r.json() : null));
      note = sig?.signalKey ? `research: ${sig.signalKey}` : "research updated";
    }
    researchNotes.set(id, `${note} (report written)`);
  } catch (e) {
    log(`research note fetch failed for job ${id}: ${e instanceof Error ? e.message : e}`);
  }
}
async function pollResearch(): Promise<void> {
  const q =
    "SELECT j.id, j.kind, j.status, " +
    "COALESCE(to_char(jr.finished_at,'HH24:MI:SS'), to_char(j.run_after,'HH24:MI:SS')), " +
    "COALESCE(jr.error,'') " +
    "FROM jobs j LEFT JOIN job_runs jr ON jr.job_id = j.id " +
    "WHERE j.kind IN ('regime.classify','research.refresh') ORDER BY j.id DESC LIMIT 8";
  const r = Bun.spawnSync(
    ["docker", "compose", "exec", "-T", "postgres", "psql", "-U", DB_USER, "-d", DB_NAME, "-tAF", "|", "-c", q],
    { cwd: repoRoot, env: dockerEnv, stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) { log(`research poll query failed (exit ${r.exitCode})`); return; }
  const rows = new TextDecoder().decode(r.stdout).trim().split("\n").filter(Boolean);
  const entries: ResearchEntry[] = [];
  for (const row of rows) {
    const [idStr, kind, status, at, err] = row.split("|");
    const id = Number(idStr);
    if (!Number.isFinite(id)) continue;
    const st = mapJobState(status);
    const failed = status === "failed" || status === "dead";
    // First time we see a finished run, fetch its one-line summary from the API.
    if (st === "done" && !researchNotes.has(id)) {
      researchNotes.set(id, failed ? "failed" : "done — fetching summary…");
      void fetchResearchNote(id, kind, failed, err);
    }
    const note = st === "done" ? (researchNotes.get(id) ?? "done") : st === "running" ? "running…" : "queued";
    entries.push({ id, kind, state: st, at, note });
  }
  state.research = entries;
}
// Poll the schedules table for the next fire time of the analytics kinds so the
// TUI can show a live countdown. GROUP BY kind + MIN → the soonest upcoming run
// even when a daily and a fast-demo row are both enabled. Defensive: any failure
// is logged and skipped.
async function pollNextRuns(): Promise<void> {
  const q =
    "SELECT kind, MIN(GREATEST(0, EXTRACT(EPOCH FROM (next_run_at - now()))))::int " +
    "FROM job_schedules WHERE enabled AND next_run_at IS NOT NULL " +
    "AND kind IN ('regime.classify','research.refresh') GROUP BY kind";
  const r = Bun.spawnSync(
    ["docker", "compose", "exec", "-T", "postgres", "psql", "-U", DB_USER, "-d", DB_NAME, "-tAF", "|", "-c", q],
    { cwd: repoRoot, env: dockerEnv, stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) { log(`next-run poll query failed (exit ${r.exitCode})`); return; }
  const rows = new TextDecoder().decode(r.stdout).trim().split("\n").filter(Boolean);
  for (const row of rows) {
    const [kind, secs] = row.split("|");
    const n = Number(secs);
    if (kind && Number.isFinite(n)) nextRuns[kind] = { secondsUntil: n, fetchedAt: Date.now() };
  }
}
let researchTimer: ReturnType<typeof setTimeout> | null = null;
function startResearchPolling(): void {
  const tick = async () => {
    try { await pollResearch(); } catch (e) { log(`research poll error: ${e instanceof Error ? e.message : e}`); }
    try { await pollNextRuns(); } catch (e) { log(`next-run poll error: ${e instanceof Error ? e.message : e}`); }
    researchTimer = setTimeout(() => void tick(), 4000);
  };
  void tick();
}

// --- Container health polling ---------------------------------------------
// Actively check the REAL docker container status (not just the HTTP /health
// endpoints) so a crash / restart-loop / unhealthy Docker healthcheck surfaces in
// the Startup pane. Polls `docker compose ps` and maps each service's State+Health
// to a pane phase: ✓ healthy · ✗ errored · spinner while starting/checking. Only
// postgres declares a Docker healthcheck; for api/worker the signal is process
// state (running vs exited/restarting) — i.e. the "absence of errors". Fully
// defensive: any failure is logged and skipped, never crashing the TUI.
interface PsEntry { Service?: string; Name?: string; State?: string; Health?: string; ExitCode?: number; }
function classifyContainer(e: PsEntry): { phase: Phase; detail?: string } {
  const st = (e.State ?? "").toLowerCase();
  const h = (e.Health ?? "").toLowerCase();
  if (st === "running") {
    if (h === "starting") return { phase: "starting", detail: "health: starting" };
    if (h === "unhealthy") return { phase: "failed", detail: "unhealthy" };
    return { phase: "healthy", detail: h || undefined }; // healthy, or no healthcheck defined
  }
  if (st === "restarting") return { phase: "failed", detail: "restarting" };
  if (st === "exited" || st === "dead") return { phase: "failed", detail: `exited${e.ExitCode != null ? ` ${e.ExitCode}` : ""}` };
  if (st === "created" || st === "paused") return { phase: "starting", detail: st };
  return { phase: "starting", detail: st || "checking" };
}
async function pollContainerHealth(): Promise<void> {
  healthChecking = true;
  try {
    // Async spawn (not spawnSync) so the render loop keeps animating the refresh
    // spinner while docker runs. `-a` includes stopped/exited containers.
    const proc = Bun.spawn(["docker", "compose", "ps", "-a", "--format", "json"], {
      cwd: repoRoot, env: dockerEnv, stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) { log(`container health poll failed (exit ${proc.exitCode})`); return; }
    // Compose emits either NDJSON (one object per line, v2.21+) or a JSON array.
    const entries: PsEntry[] = [];
    const trimmed = out.trim();
    if (trimmed.startsWith("[")) {
      try { entries.push(...(JSON.parse(trimmed) as PsEntry[])); } catch { /* skip */ }
    } else {
      for (const line of trimmed.split("\n").filter(Boolean)) {
        try { entries.push(JSON.parse(line) as PsEntry); } catch { /* skip malformed line */ }
      }
    }
    for (const c of state.containers) {
      const e = entries.find((x) => x.Service === c.name || x.Name?.includes(`-${c.name}-`) || x.Name?.includes(`_${c.name}_`));
      if (!e) { setContainer(c.name, "failed", "not found"); continue; }
      const { phase, detail } = classifyContainer(e);
      setContainer(c.name, phase, detail ?? "");
    }
  } catch (e) {
    log(`container health poll error: ${e instanceof Error ? e.message : e}`);
  } finally {
    healthChecking = false;
  }
}
let healthTimer: ReturnType<typeof setTimeout> | null = null;
function startHealthPolling(): void {
  const tick = async () => {
    await pollContainerHealth();
    healthTimer = setTimeout(() => void tick(), 3000);
  };
  void tick();
}

// --- TUI render -----------------------------------------------------------
let tui: Tui | undefined;
let frame = 0;
let healthChecking = false; // true while a docker-container health poll is in flight

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
// Seconds → "m:ss" for the pane countdowns; "—" when unknown (not yet polled).
const fmtCountdown = (secs: number | null): string => (secs == null ? "—" : fmtDuration(secs * 1000));

function phaseGlyph(p: Phase): string {
  if (p === "building") return color("33", spinner(frame));
  if (p === "starting") return color("36", spinner(frame));
  if (p === "healthy") return color("32", "✓");
  if (p === "failed") return color("31", "✗");
  return color("2", "·"); // pending
}
function stepGlyph(s: StepStatus): string {
  return s === "done" ? color("32", "✓") : s === "failed" ? color("31", "✗") : s === "running" ? color("33", spinner(frame)) : color("2", "·");
}
function onboardGlyph(s: OnboardStepStatus): string {
  return s === "done" ? color("32", "✓") : s === "failed" ? color("31", "✗") : s === "running" ? color("33", spinner(frame)) : color("2", "·");
}
// Three ticks that advance ONLY on the observable queued→running→done job states.
// They are NOT fabricated fetch/process/report sub-steps — the comment and labels
// stay honest about that granularity (we only observe the queue transitions).
function ticks(st: ResearchEntry["state"]): string {
  const on = color("32", "●"), off = color("2", "○");
  const n = st === "queued" ? 1 : st === "running" ? 2 : 3;
  return [0, 1, 2].map((i) => (i < n ? on : off)).join("");
}
const STAGE_COLOR: Record<MemberState["stage"], string> = {
  connect: "36", fetch: "34", thinking: "33", reporting: "35", waiting: "36", done: "32", absent: "2",
};
function memberGlyph(m: MemberState): string {
  if (m.stage === "done") return color("32", "✓");
  if (m.stage === "absent") return color("2", "✗");
  if (m.stage === "waiting") return color("36", "◔");
  return color(STAGE_COLOR[m.stage], spinner(frame));
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Equal-width column width for k side-by-side panes (accounting for " │ " gaps).
function columnWidth(width: number, k: number): number {
  return Math.floor((width - 3 * (k - 1)) / k);
}
// N side-by-side columns, joined by vertical rules; each cell truncated/padded to
// an equal width. Rows past a column's content are blank.
function columns(panes: string[][], width: number): string[] {
  const k = panes.length;
  const gap = " │ ";
  const colW = Math.max(12, columnWidth(width, k));
  const n = Math.max(0, ...panes.map((p) => p.length));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const cells = panes.map((p) => {
      const cell = truncate(p[i] ?? "", colW);
      return cell + " ".repeat(Math.max(0, colW - visibleLen(cell)));
    });
    out.push(cells.join(gap));
  }
  return out;
}

function renderResearch(height: number): string[] {
  const out = [
    color("1", "Research") +
      color("2", `  next regime ${fmtCountdown(secsUntilNext("regime.classify"))} · research ${fmtCountdown(secsUntilNext("research.refresh"))}`),
  ];
  out.push(color("2", "kind                 state    detail"));
  for (const e of state.research.slice(0, Math.max(0, height - 2))) {
    const stateLbl = e.state === "done" ? color("32", "done ") : e.state === "running" ? color("33", "run  ") : color("2", "queue");
    out.push(`${ticks(e.state)} ${e.kind.padEnd(17)} ${stateLbl} ${e.note}`);
  }
  if (state.research.length === 0) out.push(color("2", "  (waiting for the worker's scheduler to fire…)"));
  return out;
}

function renderCommittee(subjectId: string, height: number): string[] {
  const c = state.committees[subjectId];
  if (!c) return [color("2", "(no data)")];
  const nextTxt = c.nextAt > 0 ? `next ${fmtDuration(Math.max(0, c.nextAt - Date.now()))}` : "running…";
  const out = [
    color("1", c.subjectName) + color("2", `  [${c.sessionState}] pub:${c.publishedCount} · ${nextTxt}`),
  ];
  const ids = Object.keys(c.members);
  for (const id of ids) {
    const m = c.members[id];
    const stance = m.stance ? color(STAGE_COLOR[m.stage] || "37", ` ${m.stance}${m.confidence != null ? ` c=${m.confidence}` : ""}`) : "";
    out.push(`${memberGlyph(m)} ${cap(id).padEnd(9)} ${m.stage.padEnd(9)}${stance}`);
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
  lines.push(hr(W, healthChecking ? `Startup ${spinner(frame)}` : "Startup"));
  lines.push("  " + state.containers.map((c) => `${phaseGlyph(c.phase)} ${c.name}${c.detail ? color("2", `(${c.detail})`) : ""}`).join("   "));
  lines.push("  " + state.steps.map((s) => `${stepGlyph(s.status)} ${s.name}`).join("   "));

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
      const cells = ob.steps.map((s) => `${onboardGlyph(s.status)} ${s.key}`).join("  ");
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

  // Middle region: Research + one pane per committee subject, splitting the largest
  // remaining space. Side-by-side columns when they fit; stacked when too narrow.
  const midH = Math.max(3, H - lines.length - footer.length - 1);
  lines.push(hr(W));
  const subjectIds = Object.keys(state.committees);
  const paneCount = 1 + subjectIds.length;
  const fits = W >= 72 && columnWidth(W, paneCount) >= 22;
  if (fits) {
    const panes = [
      renderResearch(midH),
      ...subjectIds.map((id) => renderCommittee(id, midH)),
    ].map((p) => p.slice(0, midH));
    for (const l of columns(panes, W)) lines.push(l);
  } else {
    // Too narrow for columns: stack each pane, dividing the height evenly.
    const each = Math.max(2, Math.floor(midH / paneCount));
    const panes = [
      renderResearch(each),
      ...subjectIds.map((id) => renderCommittee(id, each)),
    ];
    for (let p = 0; p < panes.length; p++) {
      if (p > 0) lines.push(color("2", "·".repeat(Math.min(W, 24))));
      for (const l of panes[p].slice(0, each)) lines.push(truncate(l, W));
    }
  }

  return [...lines, ...footer];
}

// --- Committee session progress → DemoState -------------------------------
// Maps the additive runSession/runAgent callback events onto committee state and
// logs milestones. All member stages here are REAL pipeline events emitted by the
// agent (connect/fetch/thinking/reporting/done) — no fabricated sub-steps.
function committeeProgress(subjectId: string): SessionProgress {
  return (ev) => {
    const c = state.committees[subjectId];
    if (!c) return;
    if (ev.type === "session") {
      c.sessionState = ev.state;
      if (ev.sessionId) c.sessionId = ev.sessionId;
      // Window closed → present members have submitted and now wait for synthesis.
      if (ev.state === "window_closed") {
        for (const id of Object.keys(c.members)) if (c.members[id].stage === "done") c.members[id].stage = "waiting";
      }
      log(`committee ${subjectId}: ${ev.state}`);
    } else {
      c.members[ev.memberId] = { stage: ev.stage, stance: ev.stance, confidence: ev.confidence };
      // If this is an onboarding prospect, reflect its first live participation
      // (submitting a take + posting a memo) in that member's join checklist.
      const ob = state.onboarded.find((o) => o.memberId === ev.memberId);
      if (ob && ev.stage !== "absent") {
        if (ev.stage === "done") {
          setOnboardStep(ob.memberId, "session", "done");
          setOnboardStep(ob.memberId, "memo", "done");
          setOnboardStep(ob.memberId, "admitted", "done");
          log(`onboarding ${ev.memberId}: admitted — participated + pushed memo`);
        } else {
          setOnboardStep(ob.memberId, "session", "running");
        }
      }
    }
  };
}

// --- Orchestration --------------------------------------------------------
async function main(): Promise<void> {
  // §11 R8: real inference is the demo's onboarding mode, never an optional
  // extra behind a flag — there is no hermetic/scripted onboarding fallback.
  // resolveModelConfig() resolves AGENT_MODEL against the registry and pairs
  // it with OPENCODE_API_KEY. A misconfiguration — an unknown model family, or
  // a paid model with no funded key — must fail LOUDLY here, before the demo
  // spends minutes standing up the stack, rather than have onboardingDriver()
  // throw quietly in the background later. CI's own invocation of this file exits (via the
  // `if (process.env.CI)` branch below) before ever reaching
  // onboardingDriver() — it runs a different, non-onboarding check suite — so
  // this check applies to a LOCAL standing demo unconditionally, and to a CI
  // run only when it's running the real-inference onboarding eval (Stage 7,
  // ONBOARDING_REAL_EVAL=1 — see the CI branch below): fail before spending
  // minutes standing up the stack, not ~20 minutes later at the eval step
  // itself. Which CI runs set it (issue #289): the nightly sweep in
  // .github/workflows/committee-opencode-nightly.yml, and e2e.yml on a push to
  // main, on a `pull_request` whose PR carries the `real-eval` opt-in label, or
  // on a `workflow_dispatch` started with real_eval=true. An ORDINARY PR run
  // therefore leaves ONBOARDING_REAL_EVAL empty and skips this resolve, which
  // is correct: it has no eval to fail early for.
  if (!process.env.CI || process.env.ONBOARDING_REAL_EVAL === "1") {
    resolveModelConfig(process.env);
  }

  if (tuiActive) {
    tui = createTui({ render });
    tui.start();
    patchConsole(); // capture stray console.* (incl. imported e2e.ts) into the log file
  }

  // ── The bring-up IS scripts/stack's bring-up (§11.3 E5) ──────────────────
  // build → postgres + wait → migrate → services → /health, in ONE shared
  // implementation. The demo contributes only what is genuinely demo-specific:
  // the `full` profile, its migrate flags, and the TUI rendering below.
  //
  // StackHooks is how the TUI is driven WITHOUT scripts/stack importing a
  // renderer: each lifecycle event maps onto the panes exactly as the
  // hand-rolled sequence did, so the visible boot is unchanged.
  const WORKER_LANES = ["worker-committee", "worker-analytics", "worker-research"];
  const onStackEvent = (e: StackEvent): void => {
    if (e.phase === "log") return void log(e.message);
    const { phase, status } = e;
    if (phase === "build") {
      if (status === "start") {
        log("building compose images…");
        for (const c of state.containers) setContainer(c.name, "building");
      } else {
        for (const c of state.containers) setContainer(c.name, "pending");
      }
    } else if (phase === "postgres") {
      if (status === "start") {
        log("starting postgres…");
        setContainer("postgres", "starting");
      } else {
        setContainer("postgres", "healthy");
        log("postgres healthy");
      }
    } else if (phase === "migrate") {
      if (status === "start") {
        log("running migrations…");
        setStep("migrate", "running");
      } else {
        setStep("migrate", "done");
      }
    } else if (phase === "services") {
      if (status === "start") {
        log("starting api, worker lanes (committee/analytics/research)…");
        for (const n of ["api", ...WORKER_LANES]) setContainer(n, "starting");
      } else {
        // No /health endpoint on a lane — `up` ⇒ running (unchanged semantics).
        for (const n of WORKER_LANES) setContainer(n, "healthy", "running");
        setStep("api /health", "running");
      }
    } else if (phase === "ports" && status === "done") {
      // The daemon has been asked what it published (`docker compose port`).
      // Narrated because a boot that hangs here is hanging on the readback, not
      // on the health check — a distinction that is invisible otherwise.
      log(`host ports discovered: ${e.detail ?? "?"}`);
    } else if (phase === "health" && status === "done") {
      setContainer("api", "healthy");
      setStep("api /health", "done");
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

  // DEMO_MODE — the single "this stack is the demo" flag (it replaced the
  // retired per-property fast-schedules flag). docker-compose.demo.yml pins it on
  // every demo container (and `compose run` applies that service env to this
  // one-shot too); the explicit -e here is deliberate redundancy so the seed's
  // demo gating never silently depends on which overlay files a future
  // invocation composes. Under DEMO_MODE the seed (backend/src/db/seed.ts):
  //   - adds HOURLY, staggered regime/research schedules (minutes 7 and 37) so
  //     the worker's own scheduler drives them — the required per-PR e2e gate
  //     asserts a real LIVE steady state via scripts/demo-live-smoke.ts (#147).
  //     Hourly since #287: the earlier ~2-minute pair fired one analytics
  //     action per minute against the public Base RPC and exhausted the shared
  //     host's per-IP quota, starving that very gate;
  //   - adds an HOURLY wallet.sample_balances row and disables the per-minute
  //     baseline (per-IP quota protection: the standing demo and the
  //     self-hosted CI runner share one host IP, and the per-minute sampler's
  //     ~3 GeckoTerminal price calls + several Base RPC eth_calls per tick
  //     exhaust both providers' quotas, starving CI on the same host; hourly
  //     token prices are an accepted demo tradeoff). The seed's cold-start
  //     enqueue still lands a live sample at boot, so the live-smoke gate's
  //     "live within the deadline" contract is unaffected.
  //
  // DEMO_SEED_PROJECTS — demo (local AND CI): populate the projects directory so
  // /api/projects returns a full "Agentic Economy Ecosystem" table. Demo-only —
  // prod/regular-CI seeds run `migrate` without this flag, so their seed stays
  // byte-for-byte unchanged (empty projects tables). Idempotent, so re-running
  // the demo never duplicates rows.
  //
  // Both are passed as `migrateEnv` DATA; scripts/stack/config.ts's migrateArgs()
  // renders them as the same `-e KEY=VALUE` pairs the hand-built argv used.
  //
  // up() RETURNS the host ports Docker assigned (read back with
  // `docker compose port` once the containers exist — see scripts/stack/ports.ts
  // for why the daemon picks them instead of us). Everything below this line
  // depends on that call having happened.
  applyHostPorts(await stack.up({ migrateEnv: { DEMO_MODE: "1", DEMO_SEED_PROJECTS: "1" } }));

  // EDGAR/MNA seed bootstrap (issue #108) — AFTER migrations + API readiness,
  // BEFORE the research schedule may fire. Loads the committed seed artifact
  // and ingests it through the authenticated analytics seed API (server-side
  // gap-fill: existing real rows always win, a second run is a no-op), then
  // ONLY on success flips job_schedules.research.refresh to enabled (seeded
  // disabled by db/seed.ts). A failure here throws — this is a required boot
  // step, not a best-effort one — so research.refresh is left disabled rather
  // than risk a cold-DB EDGAR crawl on the worker's very first run.
  setStep("edgar seed", "running");
  log("ingesting EDGAR/MNA seed + enabling the research schedule…");
  await run(
    ["bun", "run", "scripts/edgar-seed-bootstrap.ts"],
    join(repoRoot, "backend"),
    { ...process.env, ANALYTICS_API_URL: backendUrl, ANALYTICS_TOKEN: analyticsToken } as Record<string, string>,
    "edgar seed bootstrap",
  );
  setStep("edgar seed", "done");
  log("EDGAR/MNA seed ingested — research.refresh is now eligible");

  if (process.env.CI) {
    // CI: run checks then tear down. (Unchanged — pure console, "inherit" stdio.)
    console.log("\n[demo] running committee session…");
    // RM_ALLOW_INSECURE=1: docker-compose.demo.yml runs the api container with
    // this flag, so the backend's regime-write/admin gates ARE open here. The
    // session driver is secure-by-default
    // (scripts/lib/committee/session.ts regimeWriteInsecure — opt-IN, mirroring
    // backend config.ts allowInsecure), so tell it explicitly that this stack
    // is insecure, keeping its 5c/5d cross-role log annotations truthful ("gate
    // open").
    //
    // The stack's exact compose env (stack.spawnEnv) + COMPOSE_FILE ride along
    // because the session driver now launches one member-agent CONTAINER per
    // present member (issue #361 Phase 2, scripts/lib/committee/agent.ts
    // railFromEnv) — its `docker compose run` children must re-resolve the
    // same compose model this boot created, or the volume-hash check prompts
    // to recreate live data (see scripts/agent/member-agent.ts).
    await run(["bun", "run", "scripts/lib/committee/session.ts"], repoRoot,
      { ...process.env, ...stack.spawnEnv, COMPOSE_FILE: composeFilesRun, BACKEND_URL: backendUrl, RM_ALLOW_INSECURE: "1" } as Record<string, string>, "committee session");

    // Issue #209: exercise the repo-native single-member starter against this
    // required per-PR live stack. Its --e2e mode only provisions isolated
    // member credentials + an open session; the actual poll → brief → author →
    // memo → canonicalize → sign → submit → verified readback path is the same
    // exported implementation operators run. (D21: REST is the only transport.)
    console.log("[demo] running starter committee agent (REST)…");
    const starterEnv = {
      ...process.env,
      BACKEND_URL: backendUrl,
      ADMIN_TOKEN: adminPassword,
    } as Record<string, string>;
    const { BACKEND_URL: _missingBackend, ...withoutBackendUrl } = starterEnv;
    await expectRunFailure(
      ["bun", "run", "scripts/starter-committee-agent.ts", "--transport=rest", "--e2e"],
      repoRoot,
      withoutBackendUrl,
      "starter committee agent missing BACKEND_URL guard",
    );
    const { ADMIN_TOKEN: _missingAdmin, ...withoutAdminToken } = starterEnv;
    await expectRunFailure(
      ["bun", "run", "scripts/starter-committee-agent.ts", "--transport=rest", "--e2e"],
      repoRoot,
      withoutAdminToken,
      "starter committee agent missing ADMIN_TOKEN guard",
    );
    await run(
      ["bun", "run", "scripts/starter-committee-agent.ts", "--transport=rest", "--e2e"],
      repoRoot,
      starterEnv,
      "starter committee agent REST live-stack exercise",
    );

    console.log("[demo] running frontend checks…");
    await run(["bun", "run", "scripts/demo-frontend-check.ts"], repoRoot,
      { ...process.env, BACKEND_URL: backendUrl } as Record<string, string>, "frontend checks");

    console.log("[demo] running browser checks…");
    await run(["bun", "run", "test:browser"], repoRoot,
      { ...process.env, BACKEND_URL: backendUrl } as Record<string, string>, "browser checks");

    // LIVE steady-state smoke (issue #128, now the ONLY CI path since issue #147
    // removed DEMO_HERMETIC and the hermetic RPC guard): assert >=2 published
    // committee sessions, a fresh regime snapshot, wallet/vault provenance live
    // (with only the documented #120 degrades), and both research signals
    // served. Fails loudly, naming the leg/feed — never a skip.
    console.log("[demo] asserting LIVE steady state (demo-live-smoke)…");
    await run(["bun", "run", "scripts/demo-live-smoke.ts"], repoRoot,
      { ...process.env, BACKEND_URL: backendUrl } as Record<string, string>, "live smoke assertions");

    // Additive, env-gated (issue #104): the rmpc-release-e2e nightly reuses this
    // EXACT boot instead of standing up a parallel stack. Only runs when
    // RMPC_RELEASE_E2E=1 — unset (and therefore a no-op) in e2e.yml and
    // committee-opencode-nightly.yml, so this is zero behaviour change there.
    if (process.env.RMPC_RELEASE_E2E === "1") {
      console.log("\n[demo] running rmpc release e2e driver…");
      await run(["bun", "run", "scripts/rmpc-release-e2e.ts"], repoRoot,
        { ...process.env, BACKEND_URL: backendUrl } as Record<string, string>, "rmpc release e2e");
    }

    // Additive, env-gated (Stage 7, §11 R8, docs/plans/onboarding-ic-workflow.md):
    // the REAL-INFERENCE onboarding admission sweep reuses this EXACT
    // already-booted stack instead of standing up a parallel one — same
    // pattern as RMPC_RELEASE_E2E above. Only runs when ONBOARDING_REAL_EVAL=1.
    // Which CI runs set it (issue #289): the nightly sweep in
    // .github/workflows/committee-opencode-nightly.yml, and
    // .github/workflows/e2e.yml on exactly three events — a push to main, a
    // `pull_request` whose PR carries the `real-eval` OPT-IN LABEL, and a
    // `workflow_dispatch` started with real_eval=true. It is off by default on
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
      for (const model of sweepModels) {
        for (let i = 0; i < identitiesPerModel; i++) {
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
        }
      }
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

    console.log("\n[demo] CI mode — all checks passed, tearing down…");
    cleanup();
    cleanCiVolume(); // required: reclaim this run's volume so the shared runner never leaks one
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
    console.log(`  Committee:  ${backendUrl}/committee`);
    for (const k of researchKeys) console.log(`  Research:   ${backendUrl}/research/${k}`);
    // URL only — the admin password is shown in the interactive TUI, never here.
    console.log(`  Admin:      ${backendUrl}/admin  (password shown in the interactive TUI only)`);
    console.log(`  State file: ${stateFile}`);
    console.log(`  Log file:   ${logFile}`);
    console.log(`  PG data:    ${pgDataDir ? `--pg-data ${pgDataDir} (bind; resumable)` : `volume ${project}_pgdata (fresh-per-run; kept on teardown)`}`);
    console.log("");
    console.log("  Demo actions run on a ~2-min staggered cadence.");
    console.log("  Ctrl-C / SIGTERM tears down the stack (containers + network; postgres data kept).");
    console.log("  Reclaim stopped demos' data volumes with: bun run demo:clean");
    console.log("");
  }
  log(`READY — Site ${backendUrl}/  ·  state ${stateFile}`);

  // Research pane: begin polling the worker's real job queue (TUI mode only).
  if (tuiActive) startResearchPolling();
  // Startup pane: begin live-checking the real docker container status (TUI only).
  if (tuiActive) startHealthPolling();

  // Frontend check — ONCE at startup, non-fatal (unchanged behaviour). Runs in a
  // child process, so its process.exit on failure can't take the demo down.
  run(["bun", "run", "scripts/demo-frontend-check.ts"], repoRoot,
    { ...process.env, BACKEND_URL: backendUrl } as Record<string, string>, "frontend checks")
    .then(() => log("frontend checks passed"))
    .catch((err) => log(`frontend checks failed (stack still running): ${err instanceof Error ? err.message : err}`));

  // ── Phase B: staggered demo actions ──────────────────────────────────────
  // Analytics (regime + research) is driven by the WORKER's own scheduler via the
  // demo schedules seeded above — regime hourly at :07, research hourly at :37, so
  // those two action types are already staggered from each other (see seed.ts).
  //
  // The committee session drives live agents to submit takes over REST, so it
  // runs from a loop HERE. It fires immediately (data on first load) then every
  // ~2 min.
  //
  // The session driver captures BACKEND_URL at module load, so set it BEFORE
  // the dynamic import. main()'s reset-heavy flow is guarded by import.meta.url,
  // so importing here does NOT reset — we reset ONCE below and then accumulate.
  process.env.BACKEND_URL = backendUrl;
  const e2e = await import(join(repoRoot, "scripts", "lib", "committee", "session.ts"));

  // One-time setup: reset once (clears any prior demo history) + seed regime.
  // The regime snapshot is the PRODUCER's own regime.classify job (issue #361
  // Phase 4) — enqueued by the platform, computed and submitted by the
  // worker-analytics lane under its own credential; the removed
  // admin("regime") classifier path no longer exists.
  await e2e.admin("reset");
  const today = new Date().toISOString().slice(0, 10);
  await e2e.runRegimeClassify(today);

  // Self-heal: verify the boot regime run actually landed a FRESH snapshot before
  // handing off to the worker's recurring cron. A transient live-fetch failure (or
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
      await e2e.runRegimeClassify(today).catch((err: unknown) => log(`regime re-run failed: ${err instanceof Error ? err.message : err}`));
    }
  }

  // Each subject runs on its OWN schedule (own interval + a stagger offset) so woon
  // and mav appear in separate panes on separate cadences. Execution is SERIALIZED
  // (run the earliest-due subject, then reschedule just that one) so two committee
  // sessions never run concurrently and race on the shared member roster. runSession
  // with sessionIndex>0 self-seeds the (subject, regime) for its date, so no subject
  // needs pre-seeding here.
  // Cadence constants live in scripts/lib/demo-schedule.ts (shared with the
  // nightly LIVE smoke, which derives its deadlines from them — issue #128).
  interface SubjectSchedule { subject: { id: string; name: string }; intervalMs: number; nextAt: number; runs: number; }
  const schedules: SubjectSchedule[] = e2e.SUBJECTS.map((s: { id: string; name: string }, i: number) => ({
    subject: s, intervalMs: COMMITTEE_INTERVAL_MS, nextAt: Date.now() + i * COMMITTEE_STAGGER_MS, runs: 0,
  }));
  // Populate the per-subject panes and seed their countdowns.
  for (const sch of schedules) {
    state.committees[sch.subject.id] = {
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
  const sessionRail = {
    repoRoot,
    composeProject: project,
    composeFiles: composeFilesRun.split(":"),
    composeSpawnEnv: stack.spawnEnv,
    modelConfig: resolveModelConfig(process.env),
    onboardedHomes,
  };

  async function committeeDriver(): Promise<void> {
    for (;;) {
      // Pick the earliest-due subject and wait until its slot.
      const due = schedules.reduce((a, b) => (b.nextAt < a.nextAt ? b : a));
      const wait = due.nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      const subject = due.subject;
      const c = state.committees[subject.id];
      // Rotate the date per THIS subject's own run count so sessions accumulate
      // without colliding on UNIQUE(date, subject_id).
      const date = new Date(Date.now() + due.runs * 86400_000).toISOString().slice(0, 10);
      log(`committee → ${date}/${subject.id}`);
      c.members = {};
      c.nextAt = 0; // running now → pane shows "running…"
      try {
        const res = await e2e.runSession(date, subject, due.runs + 1, {
          rail: sessionRail,
          onProgress: tuiActive ? committeeProgress(subject.id) : undefined,
        });
        c.publishedCount++;
        const synth: string = res?.pub?.session?.synthesis ?? "";
        c.history.push({ date, synthesis: synth });
        if (c.history.length > 4) c.history.shift();
        log(`committee published ${date}/${subject.id}`);
      } catch (err) {
        log(`committee session failed (stack still running): ${err instanceof Error ? err.message : err}`);
      }
      due.runs++;
      due.nextAt = Date.now() + due.intervalMs;
      c.nextAt = due.nextAt;
    }
  }
  void committeeDriver();

  // ── Periodic new-member onboarding (§11 R8: real-inference eval) ─────────
  // Every admission launches ONE vanilla OpenCode member-agent container
  // (scripts/lib/onboarding-eval.ts) and hands it the canonical copy-paste
  // prompt with a generated identity — no scripting beyond that: the agent
  // installs the committee-onboarding skill + `rmpc`, generates its own
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
  const FIRST_ONBOARD_MS = 60_000;     // first admission ~1 min in (after the base committee shows)
  const ONBOARD_INTERVAL_MS = 300_000; // then a new admission starts every 5 min (real eval duration is additive)
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
    for (let n = 0; n < NEWCOMER_NAMES.length; n++) {
      const delay = n === 0 ? FIRST_ONBOARD_MS : ONBOARD_INTERVAL_MS;
      const dueAt = Date.now() + delay;
      // Preview the next few admissions (this one + its successors, if any are
      // left in the fixed list) with countdowns.
      const upcoming: UpcomingMember[] = [];
      for (const k of [0, 1, 2]) {
        const p = plannedNewcomer(n + k);
        if (p) upcoming.push({ memberId: p.identity.runId, name: p.identity.name, at: dueAt + k * ONBOARD_INTERVAL_MS });
      }
      state.upcoming = upcoming;
      await sleep(delay);
      const planned = plannedNewcomer(n);
      if (!planned) break; // exhausted the fixed roster — stop, no generated fallback
      const { identity, lens, bias } = planned;
      // Roster cap: once the active committee reaches the contract's
      // COMMITTEE_ROSTER_CAP, stop admitting — the same finite-roster bound
      // above already stops the demo from growing forever, but this stays as
      // defense in depth for a shared/reused roster. activeMemberCount() now
      // fails CONSERVATIVELY (assume full, never assume empty) on a read
      // error, so a transient fetch problem pauses admission instead of
      // silently waving one through.
      const active = await e2e.activeMemberCount();
      if (active >= COMMITTEE_ROSTER_CAP) {
        state.upcoming = [];
        log(`onboarding ${identity.name} skipped — roster full (${active}/${COMMITTEE_ROSTER_CAP})`);
        continue;
      }
      startOnboarding(identity.runId, identity.name); // append to the persistent pane + drop from upcoming
      setOnboardStep(identity.runId, "connect", "running"); // container is about to launch
      // Owner-held for this member's LIFETIME in this demo (issue #361 Phase
      // 3): the same passphrase must unlock the keystore in every later
      // session run. Never logged; redacted from transcripts at the source.
      const keystorePassphrase = crypto.randomUUID();
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
        });

        // Rekey the pane entry to the server-minted memberId (§11 R2) as soon as
        // it's known, so committeeProgress's later ev.memberId lookups match.
        const ob = state.onboarded.find((o) => o.memberId === identity.runId);
        if (ob && result.memberId) ob.memberId = result.memberId;
        const entryId = result.memberId ?? identity.runId;

        // The strip renders straight from the harness's OBSERVED step-state
        // record — no fabricated sub-steps. Drop the harness's own trailing
        // "session" entry (it means "reached the active roster", which this
        // driver already tracks via `admitted` below); the strip's OWN
        // session/memo/admitted tail tracks real committee participation.
        for (const s of result.steps) {
          if (s.step === "session") continue;
          setOnboardStep(entryId, s.step, s.status === "done" ? "done" : "pending");
        }

        if (!result.admitted) {
          // Mark the FIRST not-yet-done step in the pane's own (full 9-step)
          // checklist as failed — not just among the harness's first 6: a
          // member that reaches "claim" but never lands on the active roster
          // (e.g. the auto-approve call itself failing) would otherwise render
          // all-green with nothing visibly red.
          const stalledOb = state.onboarded.find((o) => o.memberId === entryId);
          const stalledAt = stalledOb?.steps.find((s) => s.status !== "done");
          if (stalledAt) setOnboardStep(entryId, stalledAt.key, "failed");
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
        e2e.MEMBERS.push({ memberId: result.memberId!, name: identity.name, lens, bias, present: true });
        setOnboardStep(entryId, "session", "running");
        // Classified on the success path too, so every admission attempt leaves
        // the SAME outcome vocabulary in the log — a run that reads "admitted"
        // and one that reads "refused" are then directly comparable.
        log(`onboarding ${identity.name} classified ${classifyOutcome(result)}`);
        log(`onboarded ${identity.name} (#${n + 1}/${NEWCOMER_NAMES.length}) memberId=${result.memberId} — committee now ${e2e.MEMBERS.length} seats; awaiting first session`);
      } catch (err) {
        log(`onboarding ${identity.name} eval threw (stack still running): ${err instanceof Error ? err.message : err}`);
      }
    }
    state.upcoming = [];
    log(`onboarding complete — all ${NEWCOMER_NAMES.length} named newcomers attempted, no more will join`);
  }
  void onboardingDriver();

  await new Promise<never>(() => { /* run forever; Ctrl-C/SIGTERM (or `demo:down`) stops the stack */ });
}

main().catch((err) => {
  const em = err instanceof Error ? err.message : String(err);
  if (tui) tui.stop();        // restore terminal FIRST (never leave escape junk)
  unpatchConsole();
  if (logFd !== undefined) { try { writeSync(logFd, `[${ts()}] startup failed: ${em}\n`); } catch {} }
  for (const c of state.containers) if (c.phase === "starting" || c.phase === "building") setContainer(c.name, "failed");
  console.error("[demo] startup failed:", em);
  if (!cleaned) dumpDiagnostics();
  // CI tears down on failure; LOCAL never does — leave containers up for
  // inspection and tell the operator how to look and how to tear down.
  if (process.env.CI) {
    cleanup();
    cleanCiVolume(); // even on failure the shared runner must not leak this run's volume
  } else {
    // Failure may have happened before Phase A wrote the state file, yet the
    // containers can already be up. Write it best-effort so `demo:down` can find
    // and tear them down, then print instructions. Never auto-teardown locally.
    try { writeStateFile(); } catch { /* best effort */ }
    printLeaveRunning();
  }
  process.exit(1);
});
