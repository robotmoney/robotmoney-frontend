import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync, openSync, writeSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTui, color, hr, truncate, spinner, visibleLen, type Tui } from "./lib/tui.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
// State file consumed by `bun run demo:down` / `demo:status` to reconstruct the
// exact docker compose env. `.agents/` is the repo's runtime cache dir.
const stateFile = join(repoRoot, ".agents", "demo-state.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Random free ports ----------------------------------------------------
async function freePorts(n: number): Promise<number[]> {
  const servers: ReturnType<typeof createServer>[] = [];
  for (let i = 0; i < n; i++) {
    const srv = await new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
      const s = createServer();
      s.on("error", reject);
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    servers.push(srv);
  }
  const ports = servers.map((s) => (s.address() as AddressInfo).port);
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  return ports;
}

// --- Run config -----------------------------------------------------------
// Random host ports for api, mcp AND postgres — a standing local demo must not
// collide with a postgres already bound to :5432 on the dev box (api/worker/mcp
// reach postgres over the compose network by service name, so the published host
// port is only for external tooling; it just needs to be free).
const [apiPort, mcpPort, pgPort] = await freePorts(3);
const project = `rmdemo_${crypto.randomUUID().slice(0, 8)}`;
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
const composeFiles = "docker-compose.yml:docker-compose.demo.yml";
const researchKeys = ["channel-divergence", "late-cycle-signals"];

// Env shared by every `docker compose` call — pins the project, selects the
// demo override, and sets random host ports + credentials.
const dockerEnv: Record<string, string> = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_FILE: composeFiles,
  DEMO_PROJECT: project,
  DATABASE_URL: databaseUrl,
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
    { name: "MCP", url: `${mcpUrl}/health` },
  ],
  containers: [
    { name: "postgres", phase: "pending" },
    { name: "api", phase: "pending" },
    { name: "worker", phase: "pending" },
    { name: "mcp", phase: "pending" },
  ],
  steps: [
    { name: "migrate", status: "pending" },
    { name: "api /health", status: "pending" },
    { name: "mcp /health", status: "pending" },
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

log(`project=${project}  api=:${apiPort}  mcp=:${mcpPort}  pg=:${pgPort}`);

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
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  console.log("\n[demo] tearing down…");
  const r = dockerCompose(["down", "-v"], false);
  console.log(
    r.exitCode === 0
      ? `[demo] teardown complete — no containers/volumes left for ${project}`
      : `[demo] teardown exited ${r.exitCode}`,
  );
}

// Write the state file so `demo:down`/`demo:status` can rebuild dockerEnv.
function writeStateFile(): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  const state = {
    project,
    apiPort,
    mcpPort,
    pgPort,
    composeFiles,
    databaseUrl,
    dbUser: DB_USER,
    dbPassword: DB_PASSWORD,
    dbName: DB_NAME,
    logFile,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// Remove the state file after an explicit teardown so `demo:status`/`demo:down`
// don't point at a torn-down run. Best-effort.
function removeStateFile(): void {
  try { rmSync(stateFile, { force: true }); } catch { /* best effort */ }
}

// Print how to inspect and tear down, then leave the stack UP. Used by the
// signal handlers and startup-failure path in the LOCAL flow — the demo never
// auto-tears-down; teardown is only ever `bun run demo:down`.
function printLeaveRunning(): void {
  console.log("\n[demo] containers left RUNNING (no auto-teardown).");
  console.log(`[demo]   state file:  ${stateFile}`);
  console.log(`[demo]   log file:    ${logFile}`);
  console.log(`[demo]   inspect:     bun run demo:status`);
  console.log(`[demo]   logs:        docker compose -p ${project} logs -f`);
  console.log(`[demo]   tear down:   bun run demo:down`);
}

// Ctrl-C / SIGTERM tear the stack down (containers + volume) and exit. In TUI mode
// restore the terminal FIRST so the teardown narration prints on the normal screen
// with a visible cursor. The log file persists after teardown for post-mortem, so
// we print its path. (The CI flow calls cleanup() directly; the startup-failure
// path leaves containers up for inspection.)
function onSignal(): void {
  if (tui) tui.stop();
  unpatchConsole();
  console.log(`\n[demo] logs: ${logFile}`);
  cleanup();
  removeStateFile();
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

// --- Research polling (no backend change) ---------------------------------
// The worker's scheduler drives regime.classify (even min) + analytics.run (odd
// min) via the fast demo schedules. We observe them by polling the REAL task
// queue over `docker compose exec -T postgres psql`. The `jobs` table carries the
// honest lifecycle state (pending→running→succeeded/failed); `job_runs` only ever
// holds terminal rows (see worker/loop.ts), so we read state from `jobs` and join
// job_runs for the finished timestamp/error. Notes for finished runs are fetched
// once from the dashboard API (what actually landed). Fully defensive: any query
// failure is logged and skipped — it never crashes the TUI.
const researchNotes = new Map<number, string>();
// Countdown to the next worker-scheduled run per kind. We ask the DB for the
// seconds remaining (authoritative — avoids host/container clock skew) each poll
// and interpolate between polls in render(). regime.classify + analytics.run can
// each have BOTH a default daily row and a fast demo row enabled, so we take the
// SOONEST (MIN) upcoming run per kind.
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
    const snap = await fetch(`${backendUrl}/api/dashboards/regime-snapshots?range=1`).then((r) => (r.ok ? r.json() : null));
    const latest = snap?.latest;
    let note = latest
      ? `regime → ${latest.regime ?? "?"}${latest.composite != null ? ` ${Number(latest.composite).toFixed(2)}` : ""}`
      : "regime updated";
    if (kind === "analytics.run") {
      const sig = await fetch(`${backendUrl}/api/dashboards/research-signals/${researchKeys[0]}`).then((r) => (r.ok ? r.json() : null));
      if (sig?.signalKey) note += ` · research: ${sig.signalKey}`;
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
    "WHERE j.kind IN ('analytics.run','regime.classify') ORDER BY j.id DESC LIMIT 8";
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
    "AND kind IN ('analytics.run','regime.classify') GROUP BY kind";
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
      color("2", `  next regime ${fmtCountdown(secsUntilNext("regime.classify"))} · research ${fmtCountdown(secsUntilNext("analytics.run"))}`),
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
  footer.push(color("2", "  Ctrl-C / SIGTERM tears down the stack (containers + volume)."));

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
  // LOCAL only: seed the fast (~2 min, staggered) demo schedules so the worker's
  // own scheduler drives regime + research. CI leaves the flag unset so the seed
  // stays byte-for-byte the prod default (see backend/src/db/seed.ts).
  const fastSchedEnv = process.env.CI ? [] : ["-e", "DEMO_FAST_SCHEDULES=1"];
  await runCompose(["run", "--rm", "-T", ...fastSchedEnv, "api", "bun", "run", "src/db/migrate.ts"], "migrations");
  setStep("migrate", "done");

  log("starting api, worker, mcp…");
  for (const n of ["api", "worker", "mcp"]) setContainer(n, "starting");
  await runCompose(["up", "-d"], "start services");
  setContainer("worker", "healthy", "running"); // no /health endpoint — up ⇒ running
  setStep("api /health", "running");
  await waitForHttp(`${backendUrl}/health`);
  setContainer("api", "healthy");
  setStep("api /health", "done");
  setStep("mcp /health", "running");
  await waitForHttp(`${mcpUrl}/health`);
  setContainer("mcp", "healthy");
  setStep("mcp /health", "done");
  log("api + mcp healthy");

  if (process.env.CI) {
    // CI: run checks then tear down. (Unchanged — pure console, "inherit" stdio.)
    console.log("\n[demo] running committee session…");
    await run(["bun", "run", "src/e2e.ts"], join(repoRoot, "mcp"),
      { ...process.env, BACKEND_URL: backendUrl, MCP_URL: `${mcpUrl}/mcp` } as Record<string, string>, "committee session");

    console.log("[demo] running frontend checks…");
    await run(["bun", "run", "scripts/demo-frontend-check.ts"], repoRoot,
      { ...process.env, BACKEND_URL: backendUrl } as Record<string, string>, "frontend checks");

    console.log("[demo] running browser checks…");
    await run(["bun", "run", "test:browser"], repoRoot,
      { ...process.env, BACKEND_URL: backendUrl } as Record<string, string>, "browser checks");

    console.log("\n[demo] CI mode — all checks passed, tearing down…");
    cleanup();
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
    console.log(`  MCP:        ${mcpUrl}/health`);
    console.log(`  State file: ${stateFile}`);
    console.log(`  Log file:   ${logFile}`);
    console.log("");
    console.log("  Demo actions run on a ~2-min staggered cadence.");
    console.log("  Ctrl-C / SIGTERM tears down the stack (containers + volume).");
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

  // Each subject runs on its OWN schedule (own interval + a stagger offset) so woon
  // and mav appear in separate panes on separate cadences. Execution is SERIALIZED
  // (run the earliest-due subject, then reschedule just that one) so two committee
  // sessions never run concurrently and race on the shared member roster. runSession
  // with sessionIndex>0 self-seeds the (subject, regime) for its date, so no subject
  // needs pre-seeding here.
  const COMMITTEE_INTERVAL_MS = 120_000; // ~2 min per subject
  interface SubjectSchedule { subject: { id: string; name: string }; intervalMs: number; nextAt: number; runs: number; }
  const schedules: SubjectSchedule[] = e2e.SUBJECTS.map((s: { id: string; name: string }, i: number) => ({
    subject: s, intervalMs: COMMITTEE_INTERVAL_MS, nextAt: Date.now() + i * 60_000, runs: 0,
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
  // newcomer take + post a memo. The first admission fires early so it's visible;
  // thereafter a NEW character joins every ONBOARD_INTERVAL, indefinitely (curated
  // names first, then generated ones so the demo never runs dry).
  const NEWCOMER_NAMES = [
    "Helios", "Selene", "Rhea", "Nyx", "Eos", "Theia", "Hyperion", "Phoebe",
    "Coeus", "Crius", "Iapetus", "Metis", "Tethys", "Themis", "Mnemosyne",
  ];
  const NEWCOMER_LENSES = ["liquidity", "volatility", "credit", "tail risk", "sentiment", "flows", "macro", "positioning"];
  const FIRST_ONBOARD_MS = 60_000;     // first admission ~1 min in (after the base committee shows)
  const ONBOARD_INTERVAL_MS = 300_000; // then a new character every 5 min
  // Deterministic name/lens/bias for the n-th admission — shared by the driver and the
  // upcoming-queue preview so the TUI shows exactly who joins next.
  function plannedNewcomer(n: number): { memberId: string; name: string; lens: string; bias: number } {
    const name = NEWCOMER_NAMES[n] ?? `Astra ${n + 1}`;
    return {
      memberId: name.toLowerCase().replace(/\s+/g, "-"),
      name,
      lens: NEWCOMER_LENSES[n % NEWCOMER_LENSES.length],
      bias: ((n % 5) - 2) * 0.05, // spread -0.10 … +0.10
    };
  }
  async function onboardingDriver(): Promise<void> {
    for (let n = 0; ; n++) {
      const delay = n === 0 ? FIRST_ONBOARD_MS : ONBOARD_INTERVAL_MS;
      const dueAt = Date.now() + delay;
      // Preview the next few admissions (this one + its successors) with countdowns.
      state.upcoming = [0, 1, 2].map((k) => {
        const p = plannedNewcomer(n + k);
        return { memberId: p.memberId, name: p.name, at: dueAt + k * ONBOARD_INTERVAL_MS };
      });
      await sleep(delay);
      const { memberId, name, lens, bias } = plannedNewcomer(n);
      startOnboarding(memberId, name); // append to the persistent pane + drop from upcoming
      try {
        const { member, creds } = await e2e.onboardMember({ memberId, name, lens, bias }, {
          reviewMs: 6000,
          onStage: (stage: string, ok: boolean) => setOnboardStep(memberId, stage, ok ? "done" : "failed"),
        });
        onboardedCreds.set(memberId, creds);
        e2e.MEMBERS.push(member); // grow the roster → joins subsequent sessions
        setOnboardStep(memberId, "session", "running");
        log(`onboarded ${memberId} (#${n + 1}) — committee now ${e2e.MEMBERS.length} seats; awaiting first session`);
      } catch (err) {
        log(`onboarding ${memberId} failed (stack still running): ${err instanceof Error ? err.message : err}`);
      }
    }
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
  } else {
    // Failure may have happened before Phase A wrote the state file, yet the
    // containers can already be up. Write it best-effort so `demo:down` can find
    // and tear them down, then print instructions. Never auto-teardown locally.
    try { writeStateFile(); } catch { /* best effort */ }
    printLeaveRunning();
  }
  process.exit(1);
});
