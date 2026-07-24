import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync, openSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTui, color, hr, truncate, spinner, visibleLen, type Tui } from "./tui.ts";
import { resolveDemoEnv } from "./demo-env.ts";
import { listDemoVolumes, makeDockerRunner, removeDemoVolumes } from "./demo-volumes.ts";
import { decideRegimeBootAction, REGIME_BOOT_MAX_ATTEMPTS, type RegimeBootStaleness } from "./regime-boot.ts";
import { COMMITTEE_INTERVAL_MS, COMMITTEE_STAGGER_MS } from "./demo-schedule.ts";
import { NEWCOMER_NAMES, plannedNewcomer } from "./demo-newcomers.ts";
import { COMMITTEE_ROSTER_CAP, path as routePath, ROUTES } from "@robotmoney/contract";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");
// State file consumed by `bun run demo:down` / `demo:status` to reconstruct the
// exact docker compose env. `.agents/` is the repo's runtime cache dir.
const stateFile = join(repoRoot, ".agents", "demo-state.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Port allocation ------------------------------------------------------
type Held = ReturnType<typeof createServer>;
// Bind `port` (0 = a random free one) on 127.0.0.1; resolve the HELD server if
// it bound, else null (port already in use). Callers keep every returned server
// open until all ports are chosen so two allocations can't draw the same one.
function tryBind(port: number): Promise<Held | null> {
  return new Promise((resolve) => {
    const s = createServer();
    s.on("error", () => resolve(null));
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}
// Choose a host port. Precedence: an explicit env pin wins as-is; else the
// cloudflared-facing `preferred` default if it's free (so a standing demo lands
// on the port the host tunnel already routes to); else a random free port.
async function allocatePort(fixed: number | undefined, preferred: number | undefined, held: Held[]): Promise<number> {
  if (fixed !== undefined) return fixed;
  if (preferred !== undefined) {
    const s = await tryBind(preferred);
    if (s) { held.push(s); return preferred; }
  }
  const s = await tryBind(0);
  if (!s) throw new Error("could not bind a free host port");
  held.push(s);
  return (s.address() as AddressInfo).port;
}

// --- Pinned (fixed) ports -------------------------------------------------
// A host operator can PIN a host port via env (WEB_PORT / MCP_PORT / POSTGRES_PORT)
// instead of taking a random free one — useful when the host's root cloudflared
// config routes the robotmoney.net origin to a STABLE demo port. Returns undefined
// when unset/empty (→ a random free port is drawn instead). Only one demo can hold a
// given fixed port at a time.
function parsePort(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name}=${raw} is not a valid TCP port (1-65535)`);
  }
  return n;
}

// --- Run config -----------------------------------------------------------
// Host ports for api, mcp AND postgres. The api/mcp ports prefer the stable
// cloudflared-facing defaults (48787/48788 — the same defaults docker-compose
// falls back to, and what the host tunnel routes robotmonet.net to) so a standing
// demo is reachable over the tunnel without extra config; if a default is already
// taken (another demo up), that port falls back to a random free one.
//
// Postgres has NO preferred default: a dev box often already has postgres on
// :5432, and nothing external routes to the demo's pg (api/worker/mcp reach it
// over the compose network by service name), so its host port is always random.
//
// Any of the three can still be PINNED via env (WEB_PORT/MCP_PORT/POSTGRES_PORT),
// which is honored as-is. Every returned socket is held open until all three are
// chosen, then closed together, so no two draws collide.
const fixedApiPort = parsePort("WEB_PORT");
const fixedMcpPort = parsePort("MCP_PORT");
const fixedPgPort = parsePort("POSTGRES_PORT");
const heldPorts: Held[] = [];
const apiPort = await allocatePort(fixedApiPort, 48787, heldPorts);
const mcpPort = await allocatePort(fixedMcpPort, 48788, heldPorts);
const pgPort = await allocatePort(fixedPgPort, undefined, heldPorts);
await Promise.all(heldPorts.map((s) => new Promise<void>((r) => s.close(() => r()))));
// Pin the compose project name when DEMO_PROJECT is set (re-runs reuse/tear down the
// same containers); otherwise a fresh random project per run. dockerEnv sets
// DEMO_PROJECT=project either way, so the compose label stays consistent.
const project = process.env.DEMO_PROJECT?.trim() || `rmdemo_${crypto.randomUUID().slice(0, 8)}`;
const DB_USER = "robotmoney";
const DB_PASSWORD = "robotmoney";
const DB_NAME = "robotmoney";
const databaseUrl = `postgres://${DB_USER}:${DB_PASSWORD}@postgres:5432/${DB_NAME}`;
// Use 127.0.0.1, NOT localhost: Docker publishes the container ports on IPv4
// (0.0.0.0) but GitHub Actions' daemon does not publish on IPv6, while Bun's
// fetch resolves "localhost" to ::1 first — so a localhost health check times
// out in CI even though the service is up. 127.0.0.1 forces the IPv4 path.
const backendUrl = `http://127.0.0.1:${apiPort}`;
const mcpUrl = `http://127.0.0.1:${mcpPort}`;
// Base compose files (what demo:down/demo:status rebuild from — they stop/inspect
// by project and never need the pg-data bind overlay). composeFilesRun MAY append
// a generated bind overlay below; that fuller value drives the up/run calls here.
const composeFilesBase = "docker-compose.yml:docker-compose.demo.yml";
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
// dynamically-imported mcp/src/e2e.ts reads it — so the api container and every
// internal admin caller (mcp e2e admin(), onboarding activate, rmpc-release-e2e)
// authenticate with the SAME value. It is printed ONLY to the interactive TUI
// (see render()): never passed to log(), never serialized by writeStateFile()
// (demo-state.json), and never printed in the plain non-TUI READY block.
const adminPassword = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
process.env.ADMIN_TOKEN = adminPassword;

// Analytics-provider bearer credential (issue #106). The worker's analytics
// updater jobs submit computed outputs through the authenticated
// /api/analytics/* boundary; the api verifies this same shared secret. A FRESH
// random value per launch, set here (before compose interpolation) so both
// containers agree. NEVER printed — not in logs, not in the TUI, not in
// demo-state.json.
const analyticsToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
process.env.ANALYTICS_TOKEN = analyticsToken;

// Data-path resolution (issue #147: DEMO_HERMETIC and the stubbed/offline path
// were removed entirely — every boot, local or CI, is production parity: live
// Base mainnet RPC + live analytics + floor seed).
const demoEnv = resolveDemoEnv(process.env);

// Env shared by every `docker compose` call — pins the project, selects the
// demo override, resolves the data path, and sets random host ports + credentials.
const dockerEnv: Record<string, string> = {
  ...process.env,
  ...demoEnv.composeEnv,
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_FILE: composeFilesRun,
  DEMO_PROJECT: project,
  DATABASE_URL: databaseUrl,
  // Guards the /admin task-queue dashboard (X-Admin-Token). Passed to the api
  // container via docker-compose's `ADMIN_TOKEN: ${ADMIN_TOKEN:-}` line. Random
  // per launch; the value is shown ONLY in the interactive TUI (render()).
  ADMIN_TOKEN: adminPassword,
  // Analytics-provider bearer (issue #106): api verifies, worker submits with
  // it (docker-compose's `ANALYTICS_TOKEN: ${ANALYTICS_TOKEN:-}` lines). Never
  // printed anywhere.
  ANALYTICS_TOKEN: analyticsToken,
  WEB_PORT: String(apiPort),
  MCP_PORT: String(mcpPort),
  POSTGRES_PORT: String(pgPort),
  POSTGRES_USER: DB_USER,
  POSTGRES_PASSWORD: DB_PASSWORD,
  POSTGRES_DB: DB_NAME,
} as Record<string, string>;

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
// Local structural mirrors of the mcp types (e2e.ts SessionProgress / agent.ts
// ExistingCredentials). We deliberately do NOT `import type` them across the package
// boundary: demo.ts loads e2e via a dynamic import() (untyped), and a static type
// import from ../mcp/src drags the MCP SDK into the ROOT tsc program (no mcp deps) →
// TS2307 under `bun run typecheck`. Local aliases keep our annotations decoupled.
type SessionProgress = (ev:
  | { type: "session"; state: string; sessionId?: number; subject: string; date?: string }
  | { type: "member"; memberId: string; stage: MemberState["stage"]; stance?: string; confidence?: number }
) => void;
type ExistingCredentials = { token: string; privateKey: CryptoKey };
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
const state: DemoState = {
  services: [
    { name: "Site", url: `${backendUrl}/` },
    { name: "Regime", url: `${backendUrl}/regime` },
    { name: "Committee", url: `${backendUrl}/committee` },
    ...researchKeys.map((k) => ({ name: "Research", url: `${backendUrl}/research/${k}` })),
    // Admin task-queue jobs dashboard. URL only here (safe to appear anywhere);
    // the password is rendered on its own line in the TUI Services pane, never
    // stored in state.services.
    { name: "Admin", url: `${backendUrl}/admin` },
    { name: "MCP", url: `${mcpUrl}/health` },
  ],
  containers: [
    { name: "postgres", phase: "pending" },
    { name: "api", phase: "pending" },
    // One container per worker execution lane (issue #107): committee is the
    // reserved interactive lane; analytics (regime + pipelines) and research
    // run independently so a blocked research fetch can't starve the others.
    { name: "worker-committee", phase: "pending" },
    { name: "worker-analytics", phase: "pending" },
    { name: "worker-research", phase: "pending" },
    { name: "mcp", phase: "pending" },
  ],
  steps: [
    { name: "migrate", status: "pending" },
    { name: "api /health", status: "pending" },
    { name: "mcp /health", status: "pending" },
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
// The prospective-member join checklist, in order. keypair→connect are driven by
// onboardMember(); session/memo/admitted flip when the new member is seen taking +
// posting a memo in a live session (via committeeProgress).
const ONBOARD_STEPS = ["keypair", "apply", "review", "activate", "connect", "session", "memo", "admitted"];
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

// Annotate pinned ports/project with "(fixed)" so the operator can see at a glance
// which host ports came from env (the stable-cloudflared-origin path) vs random.
const fx = (isFixed: boolean) => (isFixed ? " (fixed)" : "");
log(
  `project=${project}${fx(Boolean(process.env.DEMO_PROJECT?.trim()))}  ` +
    `api=:${apiPort}${fx(fixedApiPort !== undefined)}  ` +
    `mcp=:${mcpPort}${fx(fixedMcpPort !== undefined)}  ` +
    `pg=:${pgPort}${fx(fixedPgPort !== undefined)}`,
);
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

async function runCompose(args: string[], label: string): Promise<void> {
  const proc = Bun.spawn(["docker", "compose", ...args], {
    cwd: repoRoot,
    env: dockerEnv,
    stdout: outFd,
    stderr: errFd,
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${label} failed (exit ${code})`);
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
    apiPort,
    mcpPort,
    pgPort,
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
async function waitForPostgres(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = Bun.spawnSync(
      ["docker", "compose", "exec", "-T", "postgres", "pg_isready", "-U", DB_USER, "-d", DB_NAME],
      // Health poll fires every second — keep it quiet on the console (as before);
      // route to the log fd in TUI mode.
      { cwd: repoRoot, env: dockerEnv, stdout: outFd === "inherit" ? "ignore" : outFd, stderr: outFd === "inherit" ? "ignore" : outFd },
    );
    if (r.exitCode === 0) return;
    await sleep(1000);
  }
  throw new Error("postgres did not become ready in time");
}

async function waitForHttp(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${url}`);
}

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
// The worker's scheduler drives regime.classify (even min, analytics lane) +
// research.refresh (odd min, research lane) via the fast demo schedules. We
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
// postgres declares a Docker healthcheck; for api/worker/mcp the signal is process
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
  if (tuiActive) {
    tui = createTui({ render });
    tui.start();
    patchConsole(); // capture stray console.* (incl. imported e2e.ts) into the log file
  }

  log("building compose images…");
  for (const c of state.containers) setContainer(c.name, "building");
  await runCompose(["build"], "compose build");
  for (const c of state.containers) setContainer(c.name, "pending");

  log("starting postgres…");
  setContainer("postgres", "starting");
  await runCompose(["up", "-d", "postgres"], "start postgres");
  await waitForPostgres();
  setContainer("postgres", "healthy");
  log("postgres healthy");

  log("running migrations…");
  setStep("migrate", "running");
  // DEMO_MODE — the single "this stack is the demo" flag (it replaced the
  // retired per-property fast-schedules flag). docker-compose.demo.yml pins it on
  // every demo container (and `compose run` applies that service env to this
  // one-shot too); the explicit -e here is deliberate redundancy so the seed's
  // demo gating never silently depends on which overlay files a future
  // invocation composes. Under DEMO_MODE the seed (backend/src/db/seed.ts):
  //   - adds the fast (~2 min, staggered) regime/research schedules so the
  //     worker's own scheduler drives them — the required per-PR e2e gate
  //     asserts a real LIVE steady state via scripts/demo-live-smoke.ts (#147);
  //   - adds an HOURLY wallet.sample_balances row and disables the per-minute
  //     baseline (per-IP quota protection: the standing demo and the
  //     self-hosted CI runner share one host IP, and the per-minute sampler's
  //     ~3 GeckoTerminal price calls + several Base RPC eth_calls per tick
  //     exhaust both providers' quotas, starving CI on the same host; hourly
  //     token prices are an accepted demo tradeoff). The seed's cold-start
  //     enqueue still lands a live sample at boot, so the live-smoke gate's
  //     "live within the deadline" contract is unaffected.
  const demoModeEnv = ["-e", "DEMO_MODE=1"];
  // Demo (local AND CI): populate the projects directory so /api/projects returns
  // a full "Agentic Economy Ecosystem" table. Demo-only — prod/regular-CI seeds run
  // `migrate` without this flag, so their seed stays byte-for-byte unchanged (empty
  // projects tables). Idempotent, so re-running the demo never duplicates rows.
  const demoSeedProjectsEnv = ["-e", "DEMO_SEED_PROJECTS=1"];
  await runCompose(["run", "--rm", "-T", ...demoModeEnv, ...demoSeedProjectsEnv, "api", "bun", "run", "src/db/migrate.ts"], "migrations");
  setStep("migrate", "done");

  const WORKER_LANES = ["worker-committee", "worker-analytics", "worker-research"];
  log("starting api, worker lanes (committee/analytics/research), mcp…");
  for (const n of ["api", ...WORKER_LANES, "mcp"]) setContainer(n, "starting");
  await runCompose(["up", "-d"], "start services");
  for (const n of WORKER_LANES) setContainer(n, "healthy", "running"); // no /health endpoint — up ⇒ running
  setStep("api /health", "running");
  await waitForHttp(`${backendUrl}/health`);
  setContainer("api", "healthy");
  setStep("api /health", "done");
  setStep("mcp /health", "running");
  await waitForHttp(`${mcpUrl}/health`);
  setContainer("mcp", "healthy");
  setStep("mcp /health", "done");
  log("api + mcp healthy");

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
    // host-run mcp e2e driver is secure-by-default (mcp/src/e2e.ts
    // regimeWriteInsecure — opt-IN, mirroring backend config.ts allowInsecure),
    // so tell it explicitly that this stack is insecure, keeping its 5c/5d
    // cross-role log annotations truthful ("gate open", as before the flip).
    await run(["bun", "run", "src/e2e.ts"], join(repoRoot, "mcp"),
      { ...process.env, BACKEND_URL: backendUrl, MCP_URL: `${mcpUrl}/mcp`, RM_ALLOW_INSECURE: "1" } as Record<string, string>, "committee session");

    // Issue #209: exercise the repo-native single-member starter over BOTH
    // transports against this required per-PR live stack. Its --e2e mode only
    // provisions isolated member credentials + an open session; the actual
    // poll → brief → author → memo → canonicalize → sign → submit → verified
    // readback path is the same exported implementation operators run.
    console.log("[demo] running starter committee agent (REST + MCP OAuth)…");
    const starterEnv = {
      ...process.env,
      BACKEND_URL: backendUrl,
      MCP_URL: `${mcpUrl}/mcp`,
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
    await run(
      ["bun", "run", "scripts/starter-committee-agent.ts", "--transport=mcp", "--e2e"],
      repoRoot,
      starterEnv,
      "starter committee agent MCP live-stack exercise",
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
        { ...process.env, BACKEND_URL: backendUrl, MCP_URL: `${mcpUrl}/mcp` } as Record<string, string>, "rmpc release e2e");
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
    console.log(`  MCP:        ${mcpUrl}/health`);
    console.log(`  State file: ${stateFile}`);
    console.log(`  Log file:   ${logFile}`);
    console.log(`  PG data:    ${pgDataDir ? `--pg-data ${pgDataDir} (bind; resumable)` : `volume ${project}_pgdata (fresh-per-run; kept on teardown)`}`);
    console.log("");
    console.log("  Demo actions run on a ~2-min staggered cadence.");
    console.log("  Ctrl-C / SIGTERM tears down the stack (containers + network; postgres data kept).");
    console.log("  Reclaim stopped demos' data volumes with: bun run demo:clean");
    console.log("");
  }
  log(`READY — Site ${backendUrl}/  ·  MCP ${mcpUrl}/health  ·  state ${stateFile}`);

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

  // ── Phase B: staggered ~2-min demo actions ───────────────────────────────
  // Analytics (regime + research) is driven by the WORKER's own scheduler via the
  // fast demo schedules seeded above — regime on even minutes, research on odd, so
  // those two action types are already staggered from each other (see seed.ts).
  //
  // The committee session needs live MCP agents to submit takes, so it is driven
  // by a loop HERE. It fires immediately (data on first load) then every ~2 min.
  //
  // e2e.ts's env (BACKEND/MCP url) is captured at module load, so set it BEFORE
  // the dynamic import. main()'s reset-heavy flow is guarded by import.meta.url,
  // so importing here does NOT reset — we reset ONCE below and then accumulate.
  process.env.BACKEND_URL = backendUrl;
  process.env.MCP_URL = `${mcpUrl}/mcp`;
  const e2e = await import(join(repoRoot, "mcp", "src", "e2e.ts"));

  // One-time setup: reset once (clears any prior demo history) + seed regime.
  await e2e.admin("reset");
  const today = new Date().toISOString().slice(0, 10);
  await e2e.admin("regime", { asof: today });

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
      await e2e.admin("regime", { asof: today }).catch((err: unknown) => log(`regime re-run failed: ${err instanceof Error ? err.message : err}`));
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

  // Credentials for members onboarded at runtime (apply→activate). Passed to every
  // runSession so newly-admitted members participate (signing with their own key).
  const onboardedCreds = new Map<string, ExistingCredentials>();

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
        const res = await e2e.runSession(date, subject, due.runs + 1, undefined, onboardedCreds, tuiActive ? committeeProgress(subject.id) : undefined);
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

  // ── Periodic new-member onboarding ───────────────────────────────────────
  // Walk a brand-new prospect through the real join gates (keypair → apply →
  // review → activate → OAuth connect), then add it to the shared roster
  // (e2e.MEMBERS + onboardedCreds) so it participates in — and GROWS — the
  // committee. session/memo/admitted complete when committeeProgress sees the
  // newcomer take + post a memo. The first admission fires early so it's
  // visible; thereafter a new character joins every ONBOARD_INTERVAL. FIXED,
  // FINITE roster (NEWCOMER_NAMES, module scope above): exactly 5 named
  // newcomers, never more — no generated fallback names, and the driver loop
  // terminates once they're all attempted (or already on the roster) rather
  // than running forever.
  const FIRST_ONBOARD_MS = 60_000;     // first admission ~1 min in (after the base committee shows)
  const ONBOARD_INTERVAL_MS = 300_000; // then a new character every 5 min
  async function onboardingDriver(): Promise<void> {
    for (let n = 0; n < NEWCOMER_NAMES.length; n++) {
      const delay = n === 0 ? FIRST_ONBOARD_MS : ONBOARD_INTERVAL_MS;
      const dueAt = Date.now() + delay;
      // Preview the next few admissions (this one + its successors, if any are
      // left in the fixed list) with countdowns.
      const upcoming: UpcomingMember[] = [];
      for (const k of [0, 1, 2]) {
        const p = plannedNewcomer(n + k);
        if (p) upcoming.push({ memberId: p.memberId, name: p.name, at: dueAt + k * ONBOARD_INTERVAL_MS });
      }
      state.upcoming = upcoming;
      await sleep(delay);
      const planned = plannedNewcomer(n);
      if (!planned) break; // exhausted the fixed 5-name list — stop, no generated fallback
      const { memberId, name, lens, bias } = planned;
      // Idempotent: never re-onboard a member already on the roster (dedupe).
      if (e2e.MEMBERS.some((m: { memberId: string }) => m.memberId === memberId)) {
        log(`onboarding ${memberId} skipped — already on the roster`);
        continue;
      }
      // Roster cap: once the active committee reaches the contract's
      // COMMITTEE_ROSTER_CAP, stop admitting — the same finite-5-name bound
      // above already stops the demo from growing forever, but this stays as
      // defense in depth for a shared/reused roster. activeMemberCount() now
      // fails CONSERVATIVELY (assume full, never assume empty) on a read
      // error, so a transient fetch problem pauses admission instead of
      // silently waving one through.
      const active = await e2e.activeMemberCount();
      if (active >= COMMITTEE_ROSTER_CAP) {
        state.upcoming = [];
        log(`roster full (${active}/${COMMITTEE_ROSTER_CAP}) — onboarding paused`);
        continue;
      }
      startOnboarding(memberId, name); // append to the persistent pane + drop from upcoming
      try {
        const { member, creds } = await e2e.onboardMember({ memberId, name, lens, bias }, {
          reviewMs: 6000,
          onStage: (stage: string, ok: boolean) => setOnboardStep(memberId, stage, ok ? "done" : "failed"),
        });
        if (creds) onboardedCreds.set(memberId, creds); // null ⇒ reused member; runAgent self-enrolls
        e2e.MEMBERS.push(member); // grow the roster → joins subsequent sessions
        setOnboardStep(memberId, "session", "running");
        log(`onboarded ${memberId} (#${n + 1}/${NEWCOMER_NAMES.length}) — committee now ${e2e.MEMBERS.length} seats; awaiting first session`);
      } catch (err) {
        log(`onboarding ${memberId} failed (stack still running): ${err instanceof Error ? err.message : err}`);
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
