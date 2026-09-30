// THE ONLY SERVICE IN THE STACK THAT HOLDS THE DOCKER SOCKET (issue #1012).
//
// `api` and `worker-swarm` are long-running services that take untrusted input
// and run model-derived text through a lot of code. Mounting `/var/run/docker.sock`
// into either would give that code root on the host, because the Docker socket
// IS root — there is no "read-only" mode for it and no capability to drop that
// makes it safe. So the socket is concentrated HERE, behind one internal-network
// route with one verb, and the two services that need a container started ask
// for it over HTTP instead of holding the means to start anything they like.
//
// The narrowness IS the security property, so the surface is deliberately
// minimal and is not a place to add "just one more" endpoint:
//
//   POST /internal/launch/judge   {model, prompt, timeoutMs} -> one JudgeLaunchAnswer
//   GET  /internal/health         liveness for compose's healthcheck
//
// There is no route that takes an image, a command, an entrypoint, a mount or a
// volume. The caller cannot choose WHAT runs — it can only ask for the one
// thing this file knows how to run, whose argv is built by the shared
// buildMemberAgentArgv() primitive from a shape the caller does not control.
//
// THE CREDENTIAL IS THIS PROCESS'S, NOT THE REQUEST'S. OPENCODE_API_KEY is read
// once at start-up and injected per container. A key that travelled in the
// request body would be logged by every proxy and every error path between the
// worker and here, and would let any caller on the internal network judge with
// a key of its own choosing.
//
// NOT ON THE PUBLIC INTERNET. There is no `ports:` line for this service in any
// compose file — it is reachable only from the compose network, which is why it
// needs no authentication of its own and must never gain a published port.
import {
  inFlightJudgeContainerNames,
  judgeContainerNamePrefix,
  judgeRailFromEnv,
  runJudgeAgent,
  type JudgeAgentRail,
} from "./judge-agent.ts";
import type { JudgeRunnerLine } from "./judge-runner.ts";
// THE ROUTES AND THE PORT ARE THE CALLER'S, NOT OURS. backend/src/swarm/judge-launcher.ts
// is a dependency-free leaf holding the one contract both ends read, so a
// renamed route cannot leave the worker posting judgings at a 404. Nothing else
// of the backend is imported here, and nothing else may be: this process holds
// the Docker socket and its supply chain is deliberately empty.
import {
  JUDGE_LAUNCH_PATH,
  JUDGE_LAUNCHER_HEALTH_PATH,
  JUDGE_LAUNCHER_PORT,
} from "../../backend/src/swarm/judge-launcher.ts";

export { JUDGE_LAUNCH_PATH, JUDGE_LAUNCHER_HEALTH_PATH, JUDGE_LAUNCHER_PORT };

/**
 * A request this file will act on. Everything else is refused with a `launcher`
 * answer rather than a bare 400: the caller is judge.ts's transport, and a shape
 * it can already read is strictly more useful to an operator than a status code
 * it has to guess about.
 */
export interface JudgeLaunchRequest {
  model: string;
  prompt: string;
  timeoutMs: number;
}

export function parseLaunchRequest(body: unknown): JudgeLaunchRequest | { error: string } {
  const b = body as Record<string, unknown> | null;
  const model = typeof b?.model === "string" ? b.model.trim() : "";
  const prompt = typeof b?.prompt === "string" ? b.prompt : "";
  const timeoutMs = typeof b?.timeoutMs === "number" ? b.timeoutMs : NaN;
  if (!model) return { error: "launch request carried no model" };
  if (prompt.trim() === "") return { error: "launch request carried no prompt" };
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { error: "launch request carried no positive timeoutMs" };
  return { model, prompt, timeoutMs };
}

function answer(line: JudgeRunnerLine): Response {
  // ALWAYS 200 when this process worked. The union in the body is what says
  // which of the three things happened, and collapsing "the model returned 402"
  // into an HTTP 402 here would make a vendor refusal indistinguishable from
  // this service refusing — the exact conflation judge.ts's D-A7 split exists
  // to prevent.
  return Response.json(line, { status: 200 });
}

function launcherFailure(detail: string): Response {
  return answer({ ok: false, kind: "launcher", detail });
}

export async function handleLaunch(rail: JudgeAgentRail, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return launcherFailure("launch request body was not JSON");
  }
  const parsed = parseLaunchRequest(body);
  if ("error" in parsed) return launcherFailure(parsed.error);
  try {
    const result = await runJudgeAgent(rail, parsed);
    return answer(result.line);
  } catch (err) {
    // A throw out of the rail — the bundler, the spool directory, a Docker CLI
    // that is not there. Reported as the RAIL failing, which is what it is; the
    // container (if any) was already removed by runMemberAgent()'s finally.
    return launcherFailure(`judge launch threw: ${(err instanceof Error ? err.message : String(err)).slice(0, 400)}`);
  }
}

export function launcherPort(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.SWARM_AGENT_LAUNCHER_PORT ?? "").trim();
  if (raw === "") return JUDGE_LAUNCHER_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`invalid SWARM_AGENT_LAUNCHER_PORT "${raw}" — expected a TCP port number`);
  }
  return parsed;
}

export function createLauncherFetch(rail: JudgeAgentRail): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === JUDGE_LAUNCHER_HEALTH_PATH) {
      return Response.json({ status: "ok", project: rail.composeProject, launchable: true });
    }
    if (req.method === "POST" && url.pathname === JUDGE_LAUNCH_PATH) return handleLaunch(rail, req);
    return new Response("not found", { status: 404 });
  };
}

// ── THE EXIT PATH NO `finally` CAN COVER ────────────────────────────────────
//
// A judging's container is normally removed twice over: `docker compose run
// --rm` on a clean exit, and runMemberAgent()'s finally-bracketed `docker rm -f`
// on every other in-process ending (timeout, crash, a throw out of the bundler).
// Both are in-process, and BOTH are skipped when THIS process is the thing that
// ends — the launcher is a `restart: unless-stopped` service, so being stopped
// and restarted mid-judging is an ordinary event, not a pathological one. Worse,
// `--rm` cannot cover it either: that removal is performed by the docker CLI
// CLIENT this process spawned, so a launcher killed with SIGKILL leaves the
// client orphaned against a container the daemon will hold indefinitely.
//
// So cleanup is bracketed at the PROCESS boundary too, in two layers:
//
//   1. SIGTERM/SIGINT — the signals `docker compose stop|restart|down` and an
//      operator's Ctrl-C actually send. Whatever is still in flight is removed
//      by name before this process exits.
//   2. A BOOT SWEEP — for the endings a handler never sees (SIGKILL, OOM kill,
//      a killed CI job, the host rebooting). The next incarnation of the service
//      reaps every judge container of its compose project before it serves a
//      single request.
//
// Layer 2 removes containers this process did not start, which is correct here
// and would not be everywhere: compose runs exactly ONE agent-launcher per
// project (`restart: unless-stopped`, no `deploy.replicas`), so any judge
// container alive at this process's boot belongs to a previous incarnation of
// this same service by construction. A second concurrent launcher in one
// project would break that assumption — which is why the sweep is scoped to
// `rail.composeProject` and nothing broader.
const decode = (b: unknown) => new TextDecoder().decode(b as Uint8Array);

/** Judge containers of this project the daemon holds right now, by name. */
export function listJudgeContainers(rail: JudgeAgentRail): string[] {
  const r = Bun.spawnSync(
    ["docker", "ps", "-a", "--filter", `name=${judgeContainerNamePrefix(rail.composeProject)}`, "--format", "{{.Names}}"],
    { env: rail.composeSpawnEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) {
    console.error(`[agent-launcher] could not list judge containers (exit ${r.exitCode}): ${decode(r.stderr).slice(0, 300)}`);
    return [];
  }
  return decode(r.stdout).split("\n").map((s) => s.trim()).filter(Boolean);
}

/**
 * `docker rm -f` each name, best effort — the SAME primitive runMemberAgent()
 * uses in its own `finally`, so there is one way a judge container dies.
 * Returns the names actually removed.
 */
export function forceRemoveContainers(names: string[], env: Record<string, string>): string[] {
  const removed: string[] = [];
  for (const name of names) {
    const r = Bun.spawnSync(["docker", "rm", "-f", name], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    // Exit 0 means removed; anything else means it was already gone or the
    // daemon is unreachable, and neither is worth failing a shutdown over.
    if (r.exitCode === 0) removed.push(name);
  }
  return removed;
}

/**
 * LAYER 2. Called once at boot, BEFORE the first request is served. Loud when it
 * finds anything: a reaped container is evidence that a previous incarnation of
 * this service was killed mid-judging, and an operator should see that.
 */
export function reapOrphanedJudgeContainers(rail: JudgeAgentRail): string[] {
  const orphans = listJudgeContainers(rail);
  if (orphans.length === 0) return [];
  const removed = forceRemoveContainers(orphans, rail.composeSpawnEnv);
  console.error(
    `[agent-launcher] boot sweep reaped ${removed.length}/${orphans.length} judge container(s) stranded by a ` +
      `previous incarnation of this service: ${orphans.join(", ")}`,
  );
  return removed;
}

/**
 * LAYER 1. Removes everything still in flight, then exits. Returns the names it
 * removed so a caller (and the integration test) can assert on them.
 */
export function shutdownJudgeContainers(rail: JudgeAgentRail): string[] {
  const inFlight = inFlightJudgeContainerNames();
  if (inFlight.length === 0) return [];
  const removed = forceRemoveContainers(inFlight, rail.composeSpawnEnv);
  console.error(
    `[agent-launcher] shutting down mid-judging — removed ${removed.length}/${inFlight.length} in-flight judge ` +
      `container(s): ${inFlight.join(", ")}`,
  );
  return removed;
}

/** Wires layer 1 onto the signals a compose stop/restart actually sends. */
export function installShutdownReaper(
  rail: JudgeAgentRail,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      try {
        shutdownJudgeContainers(rail);
      } catch (err) {
        // A failed sweep must never stop the process from stopping — the boot
        // sweep is the backstop for exactly this.
        console.error(`[agent-launcher] shutdown sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      exit(0);
    });
  }
}

/**
 * A LAUNCHER THAT CANNOT LAUNCH, SAYING SO ON EVERY REQUEST.
 *
 * The alternative — exiting at start-up — was the first shape of this, and it is
 * wrong for one specific reason: `restart: unless-stopped` plus a process that
 * exits immediately is a crash loop, and `docker compose up --wait` then fails
 * the WHOLE stack over a judge credential. A stack that will not boot because
 * one optional actor has no key is a much worse failure than a judge that fails
 * closed, and it is not the failure this service is here to have.
 *
 * So it serves, reports its own incapacity on `/internal/health` (`launchable:
 * false`, WITH the reason), and answers every launch with the `launcher` arm
 * naming exactly what is missing. Nothing is silently degraded: the judging
 * still fails closed as `launcher_unavailable`, and the operator gets the cause
 * in the reason instead of in a crash-looping container's logs.
 */
export function createUnavailableLauncherFetch(detail: string): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === JUDGE_LAUNCHER_HEALTH_PATH) {
      return Response.json({ status: "ok", launchable: false, reason: detail });
    }
    if (req.method === "POST" && url.pathname === JUDGE_LAUNCH_PATH) return launcherFailure(detail);
    return new Response("not found", { status: 404 });
  };
}

if (import.meta.main) {
  const port = launcherPort();
  let rail: JudgeAgentRail | null = null;
  let unavailable = "";
  try {
    rail = judgeRailFromEnv();
  } catch (err) {
    unavailable = `agent-launcher cannot launch: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (rail) {
    // BEFORE `Bun.serve`, deliberately: a judging accepted while a previous
    // incarnation's container is still running would be swept by its own sweep.
    reapOrphanedJudgeContainers(rail);
    installShutdownReaper(rail);
  }
  Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch: rail ? createLauncherFetch(rail) : createUnavailableLauncherFetch(unavailable),
  });
  if (rail) console.log(`[agent-launcher] listening on :${port} for compose project ${rail.composeProject}`);
  // LOUD, and on every boot — this is the line an operator greps for when the
  // judge reports `launcher_unavailable` and the container looks healthy.
  else console.error(`[agent-launcher] listening on :${port} but NOT launchable — ${unavailable}`);
}
