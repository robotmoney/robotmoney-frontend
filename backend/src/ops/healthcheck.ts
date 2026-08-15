// Docker healthcheck entry for the worker lanes and the analytics producer.
// Referenced from docker-compose.yml as `bun run src/ops/healthcheck.ts`
// (WORKDIR /app; the image is oven/bun and carries no curl, so this follows the
// api's `bun`-based check rather than inventing a shell dependency).
//
// Exits 0 while the process's work loop is making progress, 1 once its
// heartbeat has gone stale. The one-line reason is printed either way: Docker
// keeps healthcheck output in `.State.Health.Log`, which makes
// `docker inspect` say WHY a lane went red instead of just that it did.
//
// A WORKER LANE container additionally reports on the scheduler's own
// heartbeat (issue #614 AC1), written to a SEPARATE file
// (schedulerHeartbeatPath) by worker/runtime.ts's dedicated scheduler loop. A
// frozen scheduler is otherwise invisible: before this, the only heartbeat in
// the container was written by the unrelated drain loop, so a lane with an
// empty claim allowlist idling happily could report healthy forever while its
// scheduler tick was wedged. The producer never runs a scheduler tick and has
// no such file, so its absence there is expected and not checked.
import { checkHeartbeatFile, heartbeatPath, schedulerHeartbeatPath } from "./heartbeat.ts";
import { existsSync } from "node:fs";

const path = heartbeatPath();
const verdict = await checkHeartbeatFile(path);
console.log(`${verdict.healthy ? "ok" : "STALE"}: ${verdict.reason} [${path}]`);

const schedulerPath = schedulerHeartbeatPath();
// Only meaningful for a process that actually runs a scheduler loop (the
// worker lanes). The producer container never writes this file, so its
// absence is not itself a failure — checkHeartbeatFile would otherwise report
// "no heartbeat file" for a process that was never supposed to have one.
let schedulerHealthy = true;
if (existsSync(schedulerPath)) {
  const schedulerVerdict = await checkHeartbeatFile(schedulerPath);
  console.log(`${schedulerVerdict.healthy ? "ok" : "STALE"}: ${schedulerVerdict.reason} [${schedulerPath}]`);
  schedulerHealthy = schedulerVerdict.healthy;
}

process.exit(verdict.healthy && schedulerHealthy ? 0 : 1);
