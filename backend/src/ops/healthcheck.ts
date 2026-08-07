// Docker healthcheck entry for the worker lanes and the analytics producer.
// Referenced from docker-compose.yml as `bun run src/ops/healthcheck.ts`
// (WORKDIR /app; the image is oven/bun and carries no curl, so this follows the
// api's `bun`-based check rather than inventing a shell dependency).
//
// Exits 0 while the process's work loop is making progress, 1 once its
// heartbeat has gone stale. The one-line reason is printed either way: Docker
// keeps healthcheck output in `.State.Health.Log`, which makes
// `docker inspect` say WHY a lane went red instead of just that it did.
import { checkHeartbeatFile, heartbeatPath } from "./heartbeat.ts";

const path = heartbeatPath();
const verdict = await checkHeartbeatFile(path);
console.log(`${verdict.healthy ? "ok" : "STALE"}: ${verdict.reason} [${path}]`);
process.exit(verdict.healthy ? 0 : 1);
