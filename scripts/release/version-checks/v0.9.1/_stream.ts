// The impure half of Q24b-site-swap-under-stream and Q24c-site-rollback-under-stream (stage only): hold a
// judge-style event stream through the website-server, run `bun smoke:web` while it is held, and return what
// the stream and a request poller saw. The decisions are _swap.ts streamSwapProblems.
//
// WHAT THE STREAM IS. The production swap of v0.9.0 (run 20261116T143356Z) waited the whole 10 s on a stop
// because an external judge client held `GET /api/swarm/participants/judge/subscribe` through nginx. This holder
// makes the same request through the same route (contract ROUTES.swarm.participants.judgeSubscribe), reads it
// the way the judge client does (readPendingFrames), and reconnects JUDGE_RECONNECT_MS after any end. It is NOT
// scripts/agent/participant/judge-client.ts runJudgeClient: that client judges what it is served (a model call and
// a signed POST), which a rehearsal must never do. It judges nothing and posts nothing: it only subscribes.
//
// THE BEARER. The route admits only a judge member's own bearer (backend/src/api/routes/swarm-judge-participant.ts).
// The step reads it from the control machine's environment, RM_SWAP_STREAM_BEARER: a disposable STAGE judge
// member's token, never a production one. Nothing in the repository mints one for a release run, so the step
// refuses, before it changes anything, when it is unset.
import { ROUTES } from "@robotmoney/contract";
import { readPendingFrames } from "../../../agent/participant/judge-client.ts";
import { stateRoot } from "../../../lib/smoke-state.ts";
import { FIRST_ROLLOUT_SUFFIX, readImageReceipt, runsSiteImage, type ImageReceipt } from "../../../lib/website-release.ts";
import { deployArgv, storeDir, type BuiltBundle } from "../../platform-bundle.ts";
import type { VersionCheck, VersionCheckContext, VersionCheckResult } from "../../version-check.ts";
import { inspectContainers, loopbackPort, websiteContainers } from "./_web.ts";
import { JUDGE_RECONNECT_MS, RECONNECT_LIMIT_MS, streamSwapProblems, type FailedRequest, type StreamSegment } from "./_swap.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The control machine's environment variable that carries the disposable stage judge's bearer. */
export const STREAM_BEARER_ENV = "RM_SWAP_STREAM_BEARER";
/** The poller asks these through the same port every POLL_MS: the site and a proxied API answer. */
const POLL_PATHS = ["/version.json", "/api/version"] as const;
const POLL_MS = 200;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type Kind = "nginx" | "caddy";

/** What the host's single running website-server is right now. */
export interface Serving {
  readonly id: string;
  readonly kind: Kind;
  readonly firstRolloutKept: boolean;
}

/** The running website-server of the instance, or why there is not exactly one. */
export function serving(ctx: Pick<VersionCheckContext, "docker" | "project">): Serving | { error: string } {
  const ids = websiteContainers(ctx);
  if (ids.running.length !== 1) return { error: `${ids.running.length} website-server containers run for the instance, not one` };
  const all = inspectContainers(ctx, ids.all);
  if ("error" in all) return all;
  const one = all.find((c) => c.Id === ids.running[0]);
  if (one === undefined) return { error: "the running website-server could not be inspected" };
  return {
    id: one.Id,
    kind: runsSiteImage({ Config: { Labels: one.Config.Labels ?? {} } }) ? "caddy" : "nginx",
    firstRolloutKept: all.some((c) => c.Name.replace(/^\//, "").endsWith(FIRST_ROLLOUT_SUFFIX) && c.State?.Running !== true),
  };
}

/** The held stream and the request poller, observing until `stop()`. */
export function observe(base: string, bearer: string): { segments: StreamSegment[]; failures: FailedRequest[]; stop(): void; refused(): string | null; opened(): boolean } {
  const segments: { openedAt: number; closedAt: number | null }[] = [];
  const failures: FailedRequest[] = [];
  const abort = new AbortController();
  let refusal: string | null = null;
  void (async () => {
    while (!abort.signal.aborted && refusal === null) {
      let seg: { openedAt: number; closedAt: number | null } | undefined;
      try {
        const res = await fetch(`${base}${ROUTES.swarm.participants.judgeSubscribe}`, { headers: { Authorization: `Bearer ${bearer}`, Accept: "text/event-stream" }, signal: abort.signal });
        if (res.status === 401 || res.status === 403) {
          refusal = `the stream route answered HTTP ${res.status}: ${STREAM_BEARER_ENV} is not a judge member's bearer`;
          break;
        }
        if (!res.ok || res.body === null) failures.push({ at: Date.now(), what: `GET judge/subscribe answered HTTP ${res.status}` });
        else {
          seg = { openedAt: Date.now(), closedAt: null };
          segments.push(seg);
          // Read the way the judge client does; the frames carry work the rehearsal never takes.
          for await (const _pending of readPendingFrames(res.body)) void _pending;
          seg.closedAt = Date.now();
        }
      } catch (e) {
        if (seg !== undefined && seg.closedAt === null) seg.closedAt = Date.now();
        else if (seg === undefined && !abort.signal.aborted) failures.push({ at: Date.now(), what: `GET judge/subscribe failed: ${(e as Error).message}` });
      }
      if (!abort.signal.aborted && refusal === null) await sleep(JUDGE_RECONNECT_MS);
    }
  })();
  const poll = setInterval(() => {
    for (const path of POLL_PATHS) {
      void fetch(`${base}${path}?rm-swap-poll=${Date.now()}`, { signal: AbortSignal.timeout(2_000) })
        .then((res) => {
          if (res.status !== 200) failures.push({ at: Date.now(), what: `GET ${path} answered HTTP ${res.status}` });
        })
        .catch((e) => failures.push({ at: Date.now(), what: `GET ${path} failed: ${(e as Error).message}` }));
    }
  }, POLL_MS);
  return {
    segments,
    failures,
    stop() {
      clearInterval(poll);
      abort.abort();
    },
    refused: () => refusal,
    opened: () => segments.length > 0,
  };
}

/** The signed bundle the release built on stage (platform-bundle.ts build), or why there is none. */
export function builtBundle(release: string): BuiltBundle | { error: string } {
  try {
    return JSON.parse(readFileSync(join(storeDir(release), "bundle.json"), "utf8")) as BuiltBundle;
  } catch {
    return { error: `${join(storeDir(release), "bundle.json")} is not readable: Q13a-site-bundle builds the bundle` };
  }
}

export interface SwapUnderStream {
  readonly kind: "deploy" | "rollback";
  /** What must serve before the run starts, and (for a rollback) what must serve after it. */
  readonly before: Kind;
  readonly after: Kind;
}

/**
 * Hold the stream, run `bun smoke:web` (a deploy of the release's own bundle, or a rollback), and judge the
 * run. Stage only: it changes what the host serves, exactly as Q24d-site-bundle-deploy does on production.
 */
export async function runUnderStream(ctx: VersionCheckContext, plan: SwapUnderStream): Promise<VersionCheckResult> {
  if (!ctx.host) return { found: {}, problems: ["the step passes no --host: the stream is held through the target host's website-server"] };
  const bearer = process.env[STREAM_BEARER_ENV];
  if (bearer === undefined || bearer.trim() === "") return { found: {}, problems: [`${STREAM_BEARER_ENV} is not set on the control machine: a judge-style stream needs a disposable stage judge member's bearer, and none was minted (refusing before anything changes)`] };
  const now = serving(ctx);
  if ("error" in now) return { found: {}, problems: [now.error] };
  const problems: string[] = [];
  if (now.kind !== plan.before) problems.push(`before the ${plan.kind} the host serves ${now.kind}, not ${plan.before}: the rehearsal needs ${plan.before} as the container being retired`);
  if (plan.kind === "rollback" && !now.firstRolloutKept) problems.push(`no stopped <name>${FIRST_ROLLOUT_SUFFIX} container is kept: the rollback has nothing to start`);
  const port = loopbackPort(ctx, now.id, 8080);
  if (port === null) problems.push("the website-server publishes no host port for 8080");
  if (problems.length > 0 || port === null) return { found: { before: now.kind }, problems };

  let argv: string[];
  if (plan.kind === "deploy") {
    const built = builtBundle(ctx.release);
    if ("error" in built) return { found: {}, problems: [built.error] };
    argv = deployArgv(ctx.host, ctx.instance, built.file, ctx.origin);
  } else {
    argv = ["bun", "run", "smoke:web", "--host", ctx.host, "--instance", ctx.instance, "--rollback", "--origin", ctx.origin];
  }

  const base = await ctx.hostOrigin(port);
  const obs = observe(base, bearer);
  const started = Date.now();
  try {
    // The stream must be open before the swap starts: a run with nothing held proves nothing.
    for (let i = 0; i < 100 && !obs.opened() && obs.refused() === null; i++) await sleep(200);
    if (obs.refused() !== null) return { found: {}, problems: [obs.refused()!] };
    if (!obs.opened()) return { found: {}, problems: ["no event stream connected within 20 s, so the swap was not started"] };
    const child = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    const receipt = readImageReceipt(join(stateRoot(process.env), "web-image", ctx.instance));
    if (receipt === null || Date.parse(receipt.startedAt) < started) return { found: { exit: code }, problems: [`smoke:web exited ${code} and wrote no receipt for this run`] };
    // Observe until the client is connected again or the limit after the stop has passed.
    const stop = receipt.gap?.startedAt === undefined ? Date.now() : Date.parse(receipt.gap.startedAt);
    while (Date.now() < stop + RECONNECT_LIMIT_MS + 1_000 && !obs.segments.some((s) => s.openedAt > stop)) await sleep(250);
    obs.stop();
    const graded = streamSwapProblems(receipt as ImageReceipt, { segments: obs.segments, failures: obs.failures }, plan.kind);
    if (code !== 0) graded.problems.unshift(`bun smoke:web exited ${code}`);
    if (obs.refused() !== null) graded.problems.push(obs.refused()!);
    const after = serving(ctx);
    if ("error" in after) graded.problems.push(`after the ${plan.kind}: ${after.error}`);
    else {
      if (after.kind !== plan.after) graded.problems.push(`after the ${plan.kind} the host serves ${after.kind}, not ${plan.after}`);
      if (plan.kind === "deploy" && !after.firstRolloutKept) graded.problems.push(`after the first rollout no stopped <name>${FIRST_ROLLOUT_SUFFIX} container is kept`);
      if (plan.kind === "rollback" && after.firstRolloutKept) graded.problems.push(`after the rollback a stopped <name>${FIRST_ROLLOUT_SUFFIX} container is still kept: nginx was not the container that came back`);
    }
    if (plan.kind === "rollback" && plan.after === "nginx") {
      // The restored nginx serves: the site and the proxied API answer through the same port.
      for (const path of POLL_PATHS) {
        const res = await fetch(`${base}${path}?rm-swap-after=${Date.now()}`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
        if (res === null || res.status !== 200) graded.problems.push(`after the rollback GET ${path} answered ${res === null ? "nothing" : res.status}, not 200`);
      }
    }
    return {
      found: { ...graded.found, kind: plan.kind, serverBefore: plan.before, serverAfter: plan.after, receiptStartedAt: receipt.startedAt, smokeWebExit: code, poll: { everyMs: POLL_MS, paths: POLL_PATHS }, streamSegments: obs.segments.length },
      problems: graded.problems,
    };
  } finally {
    obs.stop();
  }
}

export type { VersionCheck };
