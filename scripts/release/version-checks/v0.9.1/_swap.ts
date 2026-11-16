// Shared reads and decisions for v0.9.1's site-changeover checks (the nginx to signed-Caddy first rollout, the
// swap fix of PR 1651 / issue 1650). Not a check itself: version-check.ts runs files by check name, and no step
// names this one (a leading underscore is no valid check name).
//
// The decisions are PURE and take what the real code records: `bun smoke:web`'s ImageReceipt
// (scripts/lib/website-release.ts), the limits it enforces (GAP_LIMIT_MS, STOP_GRACE_SECONDS,
// MIN_DOCKER_MAJOR) and the stage-deploy record scripts/release/platform-bundle.ts keeps. The reads (the
// control machine's receipt journal, the store) are thin.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "../../../lib/smoke-state.ts";
import { GAP_LIMIT_MS, IMAGE_JOURNAL_FILE, MIN_DOCKER_MAJOR, STOP_GRACE_SECONDS, type ImageReceipt, type WebAction } from "../../../lib/website-release.ts";
import { storeDir, type StageDeploy } from "../../platform-bundle.ts";

/** How long after the stop a held stream's client may take to be connected again (the owner's rehearsal limit). */
export const RECONNECT_LIMIT_MS = 10_000;
/** The judge client's delay after any stream end (scripts/agent/participant/judge-client.ts readJudgeClientConfig: `reconnectMs: 5_000`). */
export const JUDGE_RECONNECT_MS = 5_000;
/**
 * How long after the stop the held stream may stay open: the retire bound, plus a second for the control
 * machine's ssh path (the same allowance scripts/tests/integration/smoke-web-held-stream.test.ts NEW_BOUND_MS makes).
 */
export const STREAM_CUT_LIMIT_MS = STOP_GRACE_SECONDS * 1000 + 1_000;
/** A failed request is outside the gap unless it was seen from the stop to the gap's end plus this much (poll granularity). */
export const GAP_SLACK_MS = 250;

/** PURE. The start of a run, in epoch ms, from its stamp `YYYYMMDDTHHMMSSZ` (journal.ts runStamp); NaN when it is not one. */
export function runStartMs(runTs: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(runTs);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : Number.NaN;
}

/** PURE. The major version of a docker version string (`29.1.3` is 29), or null. */
export function dockerMajor(version: string): number | null {
  const m = /^(\d+)\./.exec(version.trim());
  return m ? Number(m[1]) : null;
}

/** The image receipts `bun smoke:web` journaled for an instance on this control machine, oldest first. */
export function readJournal(instance: string, env: Record<string, string | undefined> = process.env): ImageReceipt[] {
  const file = join(stateRoot(env), "web-image", instance, IMAGE_JOURNAL_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        return l.trim() === "" ? [] : [JSON.parse(l) as ImageReceipt];
      } catch {
        return [];
      }
    });
}

/** PURE. The newest receipt of `action` that started at or after `sinceMs`, or undefined. */
export function lastReceipt(journal: readonly ImageReceipt[], action: WebAction, sinceMs: number): ImageReceipt | undefined {
  return [...journal].reverse().find((r) => r.action === action && Date.parse(r.startedAt) >= sinceMs);
}

/** What stage deployed (platform-bundle.ts stage-deploy.json), or undefined when there is none. */
export function readStageDeploy(release: string): StageDeploy | undefined {
  try {
    return JSON.parse(readFileSync(join(storeDir(release), "stage-deploy.json"), "utf8")) as StageDeploy;
  } catch {
    return undefined;
  }
}

const indexOfCheck = (r: ImageReceipt, name: string): number => r.checks.findIndex((c) => c.name === name);

/**
 * PURE. Why a swap's receipt does not prove a sound swap; empty when it does. Holds the receipt to what
 * web-serving-architecture.md section 4 promises of every swap: the Docker guard ran, the new container was
 * proven on a private port first and its measured cold start fit the gate (cold start plus the retire bound at
 * most the gap limit), the live check set repeated on the public port, the gap was at most the limit, and
 * nothing was reverted.
 */
export function swapProblems(r: ImageReceipt, action: WebAction): string[] {
  const out: string[] = [];
  if (r.action !== action) out.push(`the receipt is a ${r.action}, not a ${action}`);
  if (r.outcome !== "swapped") out.push(`the outcome is ${r.outcome}${r.error ? ` (${r.error})` : ""}, not swapped`);
  if (r.error !== null) out.push(`the run recorded an error: ${r.error}`);
  for (const c of r.checks) if (!c.ok) out.push(`check ${c.name} failed: ${c.detail}`);
  if (r.revertGap !== null && r.revertGap !== undefined) out.push("the swap reverted: the receipt holds a revert gap");

  const major = dockerMajor(r.dockerVersion ?? "");
  if (major === null) out.push("the receipt records no Docker version, so the run did not read the host's Docker before it created anything");
  else if (major < MIN_DOCKER_MAJOR) out.push(`the host's Docker is ${r.dockerVersion}, below ${MIN_DOCKER_MAJOR} (docker stop --signal)`);

  // A deploy proves the new container on a private port first. A rollback to the kept nginx container has no image to pre-check (website-release.ts checkCopy).
  const preChecked = r.precheck !== null && r.precheck !== undefined;
  if (action === "deploy" || preChecked) {
    const p = r.precheck;
    if (p === null || p === undefined) out.push("the receipt holds no pre-check: the new container was not proven on a private port before the old one was touched");
    else {
      if (p.gapLimitMs !== GAP_LIMIT_MS) out.push(`the pre-check was gated by ${p.gapLimitMs} ms, not the ${GAP_LIMIT_MS} ms gap limit`);
      if (p.retireBoundMs > STOP_GRACE_SECONDS * 1000) out.push(`the pre-check assumed a ${p.retireBoundMs} ms retire bound, above the ${STOP_GRACE_SECONDS * 1000} ms the swap enforces`);
      if (!(p.coldStartMs > 0)) out.push(`the measured cold start is ${p.coldStartMs} ms: nothing was measured`);
      if (p.coldStartMs + p.retireBoundMs > GAP_LIMIT_MS) out.push(`the cold start ${p.coldStartMs} ms plus the ${p.retireBoundMs} ms retire bound exceeds the ${GAP_LIMIT_MS} ms gap limit: the gate should have refused`);
    }
    if (r.copyPort === null) out.push("the receipt names no pre-check port");
    else if (r.copyPort === r.publicPort) out.push(`the pre-check ran on the public port ${r.publicPort}, not a private one`);
    const names = ["docker-version", "cold-start", "copy", "gap", "public", "live"];
    for (const n of names) if (indexOfCheck(r, n) < 0) out.push(`check ${n} is missing from the receipt`);
    const at = (n: string) => indexOfCheck(r, n);
    if (names.every((n) => at(n) >= 0)) {
      if (!(at("docker-version") < at("cold-start"))) out.push("the Docker version was not read before the pre-check");
      if (!(at("cold-start") < at("gap") && at("copy") < at("gap"))) out.push("the pre-check (cold-start, copy) did not complete before the swap's gap");
      if (!(at("live") > at("public"))) out.push("the live check set did not repeat on the public port after the switch");
    }
  } else {
    // The kept nginx container: only the Docker guard and the swap's own checks apply.
    for (const n of ["docker-version", "gap"]) if (indexOfCheck(r, n) < 0) out.push(`check ${n} is missing from the receipt`);
  }

  if (r.gap === null || r.gap === undefined || r.gap.ms === null || r.gap.endedAt === null) out.push("the receipt holds no measured gap");
  else if (r.gap.ms > GAP_LIMIT_MS) out.push(`the gap was ${r.gap.ms} ms, over the ${GAP_LIMIT_MS} ms limit`);
  return out;
}

/** One held event stream's life: the response arrived at `openedAt`; `closedAt` is null while it is open. */
export interface StreamSegment {
  readonly openedAt: number;
  readonly closedAt: number | null;
}

/** A request that failed: when it was seen to fail (epoch ms) and what failed. */
export interface FailedRequest {
  readonly at: number;
  readonly what: string;
}

export interface StreamObservation {
  readonly segments: readonly StreamSegment[];
  readonly failures: readonly FailedRequest[];
}

/**
 * PURE. Why a swap under a held event stream is not proven; empty when it is (owner, 2026-11-16: it passes only if
 * the stream was open at the stop, the gap is at most 3000 ms, the client is connected again within 10 s of the
 * stop, and no request fails outside the gap). `stop` is the receipt's gap start: the instant before the old
 * container was told to stop. Also fails a stream that outlived the retire bound (the held stream delayed the stop).
 */
export function streamSwapProblems(r: ImageReceipt, obs: StreamObservation, action: WebAction): { problems: string[]; found: Record<string, unknown> } {
  const problems = swapProblems(r, action);
  const found: Record<string, unknown> = { gapMs: r.gap?.ms ?? null };
  if (r.gap === null || r.gap === undefined || r.gap.endedAt === null) return { problems, found };
  const stop = Date.parse(r.gap.startedAt);
  const gapEnd = Date.parse(r.gap.endedAt);
  // 1. The stream was open at the stop.
  const held = obs.segments.find((s) => s.openedAt < stop && (s.closedAt === null || s.closedAt >= stop));
  found.streamOpenAtStop = held !== undefined;
  if (held === undefined) {
    const lives = obs.segments.map((s) => `${new Date(s.openedAt).toISOString()} to ${s.closedAt === null ? "open" : new Date(s.closedAt).toISOString()}`).join(", ");
    problems.push(`no event stream was open at the stop (${r.gap.startedAt}): ${obs.segments.length === 0 ? "none ever connected" : `the streams were ${lives}`}. A swap with nothing held proves nothing`);
  } else if (held.closedAt === null) {
    // 2. The held stream did not delay the stop past the retire bound.
    problems.push("the held stream was never cut: the old container's stop did not end it");
  } else {
    const cutMs = held.closedAt - stop;
    found.streamCutMs = cutMs;
    if (cutMs > STREAM_CUT_LIMIT_MS) problems.push(`the held stream outlived the stop by ${cutMs} ms, over the ${STREAM_CUT_LIMIT_MS} ms retire bound plus ssh allowance: the stop waited on it`);
  }
  // 3. The client is connected again within the limit.
  const again = obs.segments.filter((s) => s.openedAt > stop).sort((a, b) => a.openedAt - b.openedAt)[0];
  found.reconnectMs = again === undefined ? null : again.openedAt - stop;
  if (again === undefined) problems.push(`the stream client was not connected again by the end of observation (limit ${RECONNECT_LIMIT_MS} ms after the stop)`);
  else if (again.openedAt - stop > RECONNECT_LIMIT_MS) problems.push(`the stream client reconnected ${again.openedAt - stop} ms after the stop, over the ${RECONNECT_LIMIT_MS} ms limit`);
  // 4. No request fails outside the gap.
  const outside = obs.failures.filter((f) => f.at < stop || f.at > gapEnd + GAP_SLACK_MS);
  found.failedRequests = obs.failures.length;
  found.failedOutsideGap = outside.length;
  for (const f of outside.slice(0, 5)) problems.push(`a request failed outside the gap at ${new Date(f.at).toISOString()}: ${f.what}`);
  if (outside.length > 5) problems.push(`${outside.length - 5} more requests failed outside the gap`);
  return { problems, found };
}
