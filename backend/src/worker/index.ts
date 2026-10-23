// Always-on pipeline worker process entry: resolves this process's execution
// lane, proves it can reach the api with its pipeline-worker token, and only
// then runs the drain/scheduler/reaper loops via runtime.ts. Run with
// `WORKER_LANE=<analytics|generic> bun run src/worker/index.ts`.
//
// WORKER_LANE is REQUIRED (issue #107): an empty or unknown lane fails loudly
// here instead of silently claiming every kind — the compose topology runs
// one worker container, worker-analytics (see docker-compose.yml).
//
// NO DATABASE CREDENTIAL (issue 1034, decision D75). Only the api holds one.
// This process claims, renews and settles its jobs, reads the state its
// handlers need and writes their rows through /api/pipeline/**
// (worker/pipeline-client.ts), presenting the token PIPELINE_TOKEN_FILE names.
// Its whole import graph reaches no database module and no `postgres` import
// (backend/tests/pipeline-worker-boundary.test.ts).
import { warnIfStrategyVaultsUnconfigured } from "../config.ts";
import { resolveLane } from "./lanes.ts";
import { databaseKeysIn, pipelineStartupCheck } from "./startup-check.ts";

// A database key in this process's environment refuses the start, naming the
// key and never its value. A worker handed a credential is a composition
// error, and running beside it would hide one.
const leaked = databaseKeysIn(process.env);
if (leaked.length > 0) {
  console.error(
    `pipeline_startup: refused: this worker holds no database credential (D75), but its environment sets ${leaked.join(", ")}`,
  );
  process.exit(1);
}

// Empty strategy-vault list → loud warning, never a refusal to boot (issue
// #642, decision D37). This lane runs the wallet SAMPLER (handlers/wallet.ts),
// which writes the persisted history /allocation and /performance read, so an
// unconfigured list here silently bakes idle-USDC-only NAV into that history.
warnIfStrategyVaultsUnconfigured();

// Resolved before the startup check so a missing or unknown WORKER_LANE
// refuses first, on its own message, without reaching the api.
const lane = resolveLane(process.env.WORKER_LANE);

// THE STARTUP CHECK IS HTTP. The api must answer /health and accept the
// pipeline-worker token with both of its rights before this worker claims
// anything. A stack's readiness reads the log line: exactly
// `pipeline_startup: passed`, or `pipeline_startup: refused: <reason>` and
// exit 1. The api not answering yet is not a refusal: the check waits for it,
// as a rolling boot needs (issue 1378). A refused token is, and no heartbeat is
// written before the check passes, so a refused worker never reports itself
// alive.
const { resolveApiHealthUrl } = await import("./boot.ts");
const startup = await pipelineStartupCheck({ apiHealthUrl: resolveApiHealthUrl() });
if (!startup.passed) {
  console.error(startup.line);
  process.exit(1);
}
console.log(startup.line);

const { startWorker } = await import("./runtime.ts");
const worker = startWorker({ lane, apiHealthUrl: resolveApiHealthUrl() });

let shutdownStarted = false;
async function shutdown(signal: string): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`\n${signal} received, shutting down…`);
  await worker.stop();
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
