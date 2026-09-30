// THE CONTRACT BETWEEN THE JUDGE AND THE SERVICE THAT STARTS ITS CONTAINER
// (issue #1012) — and nothing else.
//
// A LEAF ON PURPOSE, for the same reason judge-budget.ts is one: judge.ts
// carries this module's database wiring, and the two other readers of this
// contract must not. Those readers are
//
//   - scripts/agent/agent-launcher.ts, the service on the other end, which runs
//     in an image with no backend source and no `bun install` at all; and
//   - scripts/tests/integration/agent-launcher-compose-config.test.ts, which
//     asserts the rendered compose topology and would otherwise have to
//     re-spell the URL it is checking, which is how the compose default and the
//     code default drift apart and the worker starts posting judgings into a
//     hostname nothing answers on.
//
// So: no imports, no environment reads, no I/O. Two strings, a port and a type.
// judge.ts re-exports all of it, so every existing caller keeps its import.

/** The container-internal port the launcher listens on. */
export const JUDGE_LAUNCHER_PORT = 8799;

/**
 * THE ONE SERVICE IN THE STACK THAT HOLDS THE DOCKER SOCKET.
 *
 * `api` and `worker-swarm` deliberately do NOT: they ask this narrow internal
 * endpoint to run one short-lived judge container and hand the answer back. It
 * is a compose-network hostname, never a published port — see docker-compose.yml's
 * `agent-launcher` block.
 */
export const DEFAULT_JUDGE_LAUNCHER_URL = `http://agent-launcher:${JUDGE_LAUNCHER_PORT}`;

/** The launcher's only launch route. `{model, prompt, timeoutMs}` in, one answer out. */
export const JUDGE_LAUNCH_PATH = "/internal/launch/judge";
/** Liveness, for compose's healthcheck. */
export const JUDGE_LAUNCHER_HEALTH_PATH = "/internal/health";

/**
 * THE WIRE SHAPE OF THE LAUNCHER'S ONE ANSWER — a discriminated union, always
 * under HTTP 200 when the launcher itself worked.
 *
 * The three cases are kept APART on the wire for the same reason the judge's
 * fail-closed reasons are kept apart: "the model said no" and "the rail broke"
 * have different operators and different fixes, and a single `{error: string}`
 * would make the caller guess which it was handed. Collapsing `model_status`
 * into an HTTP status here would be worse still — a 402 from the vendor would
 * become indistinguishable from this service refusing, which is exactly the
 * conflation the D-A7 split exists to prevent.
 */
export type JudgeLaunchAnswer =
  | { ok: true; text: string; providerUsage?: unknown }
  | { ok: false; kind: "model_status"; status: number; body: string }
  | { ok: false; kind: "launcher"; detail: string };
