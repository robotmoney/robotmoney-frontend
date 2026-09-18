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
