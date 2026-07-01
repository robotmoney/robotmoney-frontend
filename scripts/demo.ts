import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTui, color, hr, truncate, spinner, visibleLen, type Tui } from "./lib/tui.ts";
import type { SessionProgress } from "../mcp/src/e2e.ts";

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
interface DemoState {
  services: { name: string; url: string }[];
  containers: { name: string; phase: Phase; detail?: string }[];
  steps: { name: string; status: StepStatus }[];
  research: ResearchEntry[];
  committee: {
    sessionState: string;
    subject: string;
    sessionId?: number;
    members: Record<string, MemberState>;
    publishedCount: number;
    history: { date: string; subject: string; synthesis: string }[];
  };
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
  committee: { sessionState: "idle", subject: "", members: {}, publishedCount: 0, history: [] },
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

// LOCAL flow never tears down — not on Ctrl-C, not on SIGTERM. Only the explicit
// `bun run demo:down` stops the stack. (The CI flow calls cleanup() directly.)
// In TUI mode: restore the terminal FIRST (so the leave-running message prints on
// the normal screen with a visible cursor), then narrate, then exit 0.
function onSignal(): void {
  if (tui) tui.stop();
  unpatchConsole();
  printLeaveRunning();
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
let researchTimer: ReturnType<typeof setTimeout> | null = null;
function startResearchPolling(): void {
  const tick = async () => {
    try { await pollResearch(); } catch (e) { log(`research poll error: ${e instanceof Error ? e.message : e}`); }
    researchTimer = setTimeout(() => void tick(), 4000);
  };
  void tick();
}

// --- TUI render -----------------------------------------------------------
let tui: Tui | undefined;
let frame = 0;

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

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

// Two side-by-side columns for the largest region, joined by a vertical rule.
function twoCol(left: string[], right: string[], width: number): string[] {
  const gap = " │ ";
  const colW = Math.max(12, Math.floor((width - gap.length) / 2));
  const n = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const l = truncate(left[i] ?? "", colW);
    const r = truncate(right[i] ?? "", colW);
    out.push(l + " ".repeat(Math.max(0, colW - visibleLen(l))) + gap + r);
  }
  return out;
}

function renderResearch(height: number): string[] {
  const out = [color("1", "Research — scheduled analytics (polled from job queue)")];
  out.push(color("2", "kind                 state    detail"));
  for (const e of state.research.slice(0, Math.max(0, height - 2))) {
    const stateLbl = e.state === "done" ? color("32", "done ") : e.state === "running" ? color("33", "run  ") : color("2", "queue");
    out.push(`${ticks(e.state)} ${e.kind.padEnd(17)} ${stateLbl} ${e.note}`);
  }
  if (state.research.length === 0) out.push(color("2", "  (waiting for the worker's scheduler to fire…)"));
  return out;
}

function renderCommittee(height: number): string[] {
  const c = state.committee;
  const out = [color("1", `Committee — ${c.subject || "(idle)"}  [${c.sessionState}]  published:${c.publishedCount}`)];
  const ids = Object.keys(c.members);
  for (const id of ids) {
    const m = c.members[id];
    const stance = m.stance ? color(STAGE_COLOR[m.stage] || "37", ` ${m.stance}${m.confidence != null ? ` c=${m.confidence}` : ""}`) : "";
    out.push(`${memberGlyph(m)} ${cap(id).padEnd(9)} ${m.stage.padEnd(9)}${stance}`);
  }
  if (ids.length === 0) out.push(color("2", "  (no active session yet…)"));
  if (c.history.length) {
    out.push(color("2", "recent syntheses:"));
    for (const h of c.history.slice(-Math.max(1, height - ids.length - 3))) {
      out.push(color("2", `  ${h.date}/${h.subject}: ${h.synthesis}`));
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
  lines.push(hr(W, "Startup"));
  lines.push("  " + state.containers.map((c) => `${phaseGlyph(c.phase)} ${c.name}${c.detail ? color("2", `(${c.detail})`) : ""}`).join("   "));
  lines.push("  " + state.steps.map((s) => `${stepGlyph(s.status)} ${s.name}`).join("   "));

  // Footer (built first so the middle region can claim the rest of the height)
  const footer: string[] = [hr(W, "Log")];
  for (const m of state.messages) footer.push(color("2", `  ${m}`));
  footer.push(color("2", "  Ctrl-C leaves the stack running · `bun run demo:down` to stop."));

  // Middle region: Research | Committee, splitting the largest remaining space.
  const midH = Math.max(3, H - lines.length - footer.length - 1);
  lines.push(hr(W));
  if (W < 72) {
    // Narrow terminal: stack the panes instead of side-by-side.
    const half = Math.max(2, Math.floor(midH / 2));
    for (const l of renderResearch(half)) lines.push(truncate(l, W));
    for (const l of renderCommittee(midH - half)) lines.push(truncate(l, W));
  } else {
    for (const l of twoCol(renderResearch(midH), renderCommittee(midH), W)) lines.push(l);
  }

  return [...lines, ...footer];
}

// --- Committee session progress → DemoState -------------------------------
// Maps the additive runSession/runAgent callback events onto committee state and
// logs milestones. All member stages here are REAL pipeline events emitted by the
// agent (connect/fetch/thinking/reporting/done) — no fabricated sub-steps.
const committeeProgress: SessionProgress = (ev) => {
  const c = state.committee;
  if (ev.type === "session") {
    c.sessionState = ev.state;
    c.subject = ev.subject;
    if (ev.sessionId) c.sessionId = ev.sessionId;
    // Window closed → present members have submitted and now wait for synthesis.
    if (ev.state === "window_closed") {
      for (const id of Object.keys(c.members)) if (c.members[id].stage === "done") c.members[id].stage = "waiting";
    }
    log(`committee ${ev.subject}: ${ev.state}`);
  } else {
    c.members[ev.memberId] = { stage: ev.stage, stance: ev.stance, confidence: ev.confidence };
  }
};

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
    console.log("");
    console.log("  Demo actions run on a ~2-min staggered cadence.");
    console.log("  Ctrl-C leaves the stack RUNNING. Tear down with: bun run demo:down");
    console.log("");
  }
  log(`READY — Site ${backendUrl}/  ·  MCP ${mcpUrl}/health  ·  state ${stateFile}`);

  // Research pane: begin polling the worker's real job queue (TUI mode only).
  if (tuiActive) startResearchPolling();

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

  // One-time setup: reset once (clears any prior demo history), seed regime + the
  // first subject. Subsequent ticks self-seed their (date, subject) via runSession.
  await e2e.admin("reset");
  const today = new Date().toISOString().slice(0, 10);
  await e2e.admin("regime", { asof: today });
  await e2e.admin("subject", e2e.SUBJECTS[0]);

  const COMMITTEE_INTERVAL_MS = 120_000; // ~2 min
  let tick = 0;
  async function committeeTick(): Promise<void> {
    // Rotate (date, subject) each tick so sessions accumulate without colliding
    // on the UNIQUE(date, subject_id) key.
    const date = new Date(Date.now() + tick * 86400_000).toISOString().slice(0, 10);
    const subject = e2e.SUBJECTS[tick % e2e.SUBJECTS.length];
    log(`committee tick #${tick + 1} → ${date}/${subject.id}`);
    state.committee.members = {}; // fresh session — members repopulate via callback
    try {
      const res = await e2e.runSession(date, subject, tick + 1, undefined, undefined, tuiActive ? committeeProgress : undefined);
      state.committee.publishedCount++;
      const synth: string = res?.pub?.session?.synthesis ?? "";
      state.committee.history.push({ date, subject: subject.id, synthesis: synth });
      if (state.committee.history.length > 4) state.committee.history.shift();
      log(`committee published ${date}/${subject.id}`);
    } catch (err) {
      log(`committee session failed (stack still running): ${err instanceof Error ? err.message : err}`);
    }
    tick++;
    // Recursive setTimeout (not setInterval): schedule the NEXT tick only after
    // this one settles, so sessions never overlap even if one runs long.
    setTimeout(() => { void committeeTick(); }, COMMITTEE_INTERVAL_MS);
  }
  void committeeTick(); // immediate first session

  await new Promise<never>(() => { /* run forever; only `demo:down` stops the stack */ });
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
