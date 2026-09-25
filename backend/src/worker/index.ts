// Always-on worker process entry: resolves this process's execution lane,
// runs preflight checks 1-3 as rm_worker, and only then runs the
// drain/scheduler/reaper loops via runtime.ts. Run with
// `WORKER_LANE=<analytics|research|generic> bun run src/worker/index.ts`.
//
// WORKER_LANE is REQUIRED (issue #107): an empty or unknown lane fails loudly
// here instead of silently claiming every kind — the compose topology gives
// each lane its own container (worker-analytics / worker-research; see
// docker-compose.yml).
import { config, warnIfStrategyVaultsUnconfigured } from "../config.ts";
import { runStartupPreflight } from "../db/preflight.ts";
import { resolveLane } from "./lanes.ts";

// Empty strategy-vault list → loud warning, never a refusal to boot (issue
// #642, decision D37). This lane runs the wallet SAMPLER (handlers/wallet.ts),
// which writes the persisted history /allocation and /performance read, so an
// unconfigured list here silently bakes idle-USDC-only NAV into that history.
warnIfStrategyVaultsUnconfigured();

// Resolved before preflight so a missing or unknown WORKER_LANE refuses first,
// on its own message, without touching the database.
const lane = resolveLane(process.env.WORKER_LANE);

// PREFLIGHT CHECKS 1-3 AS rm_worker (spec §7.2, #1026 criterion 120): "run
// checks 1–3 at startup against their own credential, log, and refuse to …
// claim work on failure." Before startWorker, so a refusal claims no job, ticks
// no schedule, reaps nothing — and writes NO HEARTBEAT: every heartbeat is
// written from inside startWorker's loops (runtime.ts), so a refused worker
// never reports itself alive. The signal a stack's readiness reads is the log
// line, exactly `startup_preflight: passed` or one
// `startup_preflight: refused check <n>: <reason>` per refusal, then exit 1.
// No RM_ENV exception here: nothing spawns this entrypoint against a harness
// database. backend/tests/worker-startup-preflight.test.ts spawns this file and
// proves a refusal claims zero jobs.
//
// A MISSING credential is check 1's question too, and gets the same signal.
// db/worker-client.ts refuses at import when WORKER_DATABASE_URL is unset, and
// a static import would throw that before this body runs — an uncaught error
// with neither line, which readiness would read as "still starting". So the
// variable is tested first, and the modules that build the pool are imported
// only once it exists. Both are imported BEFORE the preflight runs: check 2
// judges the registry, and it must hold every query this program registers.
if (!process.env.WORKER_DATABASE_URL) {
  const refused = await runStartupPreflight({ role: "rm_worker", databaseUrl: undefined, rmEnv: config.env });
  for (const line of refused.lines) console.error(line);
  process.exit(1);
}
const { closeDb, workerDatabaseUrl } = await import("../db/worker-client.ts");
const { startWorker } = await import("./runtime.ts");

const startup = await runStartupPreflight({ role: "rm_worker", databaseUrl: workerDatabaseUrl(), rmEnv: config.env });
if (!startup.passed) {
  for (const line of startup.lines) console.error(line);
  await closeDb();
  process.exit(1);
}
for (const line of startup.lines) console.log(line);

const worker = startWorker({ lane });

let shutdownStarted = false;
async function shutdown(signal: string): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`\n${signal} received, shutting down…`);
  await worker.stop();
  await closeDb();
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
