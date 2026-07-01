import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

console.log(`[demo] project=${project}  api=:${apiPort}  mcp=:${mcpPort}`);

// --- Container lifecycle --------------------------------------------------
function dockerCompose(args: string[], check = true): Bun.SyncSubprocess {
  const r = Bun.spawnSync(["docker", "compose", ...args], {
    cwd: repoRoot,
    env: dockerEnv,
    stdout: "inherit",
    stderr: "inherit",
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
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${label} failed (exit ${code})`);
}

// On a startup failure, the containers are about to be torn down — capture their
// state and logs FIRST so CI shows the real cause (e.g. a crash-loop) instead of
// only a blind "timed out waiting for /health".
function dumpDiagnostics(): void {
  console.error("\n[demo] --- container diagnostics ---");
  dockerCompose(["ps", "-a"], false);
  dockerCompose(["logs", "--no-color", "--tail", "60"], false);
  console.error("[demo] --- end diagnostics ---\n");
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
  console.log(`[demo]   inspect:     bun run demo:status`);
  console.log(`[demo]   logs:        docker compose -p ${project} logs -f`);
  console.log(`[demo]   tear down:   bun run demo:down`);
}

// LOCAL flow never tears down — not on Ctrl-C, not on SIGTERM. Only the explicit
// `bun run demo:down` stops the stack. (The CI flow calls cleanup() directly.)
process.on("SIGINT", () => { printLeaveRunning(); process.exit(0); });
process.on("SIGTERM", () => { printLeaveRunning(); process.exit(0); });

// --- Readiness helpers ----------------------------------------------------
async function waitForPostgres(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = Bun.spawnSync(
      ["docker", "compose", "exec", "-T", "postgres", "pg_isready", "-U", DB_USER, "-d", DB_NAME],
      { cwd: repoRoot, env: dockerEnv, stdout: "ignore", stderr: "ignore" },
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
  const proc = Bun.spawn(cmd, { cwd, env, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${label} failed (exit ${code})`);
}

// --- Orchestration --------------------------------------------------------
async function main(): Promise<void> {
  console.log("[demo] building compose images…");
  await runCompose(["build"], "compose build");

  console.log("[demo] starting postgres…");
  await runCompose(["up", "-d", "postgres"], "start postgres");
  await waitForPostgres();
  console.log("[demo] postgres healthy");

  console.log("[demo] running migrations…");
  // LOCAL only: seed the fast (~2 min, staggered) demo schedules so the worker's
  // own scheduler drives regime + research. CI leaves the flag unset so the seed
  // stays byte-for-byte the prod default (see backend/src/db/seed.ts).
  const fastSchedEnv = process.env.CI ? [] : ["-e", "DEMO_FAST_SCHEDULES=1"];
  await runCompose(["run", "--rm", "-T", ...fastSchedEnv, "api", "bun", "run", "src/db/migrate.ts"], "migrations");

  console.log("[demo] starting api, worker, mcp…");
  await runCompose(["up", "-d"], "start services");
  await waitForHttp(`${backendUrl}/health`);
  await waitForHttp(`${mcpUrl}/health`);
  console.log("[demo] api + mcp healthy");

  const researchKeys = ["channel-divergence", "late-cycle-signals"];

  if (process.env.CI) {
    // CI: run checks then tear down.
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
  // Phase A done (stack healthy). Record state, print the READY routes, then
  // start the staggered ~2-min action loops. Never auto-tears-down.

  // Phase A: persist the state file so demo:down/demo:status can rebuild the env.
  writeStateFile();

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

  // Frontend check — ONCE at startup, non-fatal (unchanged behaviour). Runs in a
  // child process, so its process.exit on failure can't take the demo down.
  run(["bun", "run", "scripts/demo-frontend-check.ts"], repoRoot,
    { ...process.env, BACKEND_URL: backendUrl } as Record<string, string>, "frontend checks")
    .then(() => console.log("[demo] frontend checks passed"))
    .catch((err) => console.error("[demo] frontend checks failed (stack still running):", err instanceof Error ? err.message : err));

  // ── Phase B: staggered ~2-min demo actions ───────────────────────────────
  // Analytics (regime + research) is driven by the WORKER's own scheduler via the
  // fast demo schedules seeded above — regime on even minutes, research on odd, so
  // those two action types are already staggered from each other (see seed.ts).
  //
  // The committee session needs live MCP agents to submit takes, so it is driven
  // by a loop HERE. It fires immediately (data on first load) then every ~2 min.
  // Because it is anchored to demo-start rather than the wall-clock minute, it is
  // naturally offset from the analytics minute-boundary ticks — a third stagger.
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
    console.log(`\n[demo] committee tick #${tick + 1} → ${date}/${subject.id}`);
    try {
      await e2e.runSession(date, subject, tick + 1);
    } catch (err) {
      console.error("[demo] committee session failed (stack still running):", err instanceof Error ? err.message : err);
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
  console.error("[demo] startup failed:", err instanceof Error ? err.message : err);
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
