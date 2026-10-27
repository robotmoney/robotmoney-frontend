// Rollout ordering, the website-stop owner gate and the 15 s site probe
// (issue 1220, scope item (d)).
//
// A release replaces one unit at a time, in this order: the website, then the
// api and workers, then the migrate, then the participants. Nothing in the plan
// may stop website-server unless the step names the owner decision that allows
// it. While the plan runs, a synthetic probe asks the public site for `/` every
// 15 s and keeps a receipt per answer. Postflight grades the receipts: every
// answer 200, and no gap between receipts over 15 s (plus a small jitter
// allowance), across the whole window.
import { readFileSync } from "node:fs";

export type RolloutUnit = "website" | "api-workers" | "migrate" | "participants";

/** The order units are replaced in. */
export const ROLLOUT_ORDER: readonly RolloutUnit[] = ["website", "api-workers", "migrate", "participants"];

export interface RolloutStep {
  unit: RolloutUnit;
  /** What the step does to containers. */
  action: "replace" | "stop" | "run";
  /** True when the step stops website-server. */
  stopsWebsite?: boolean;
  /** The named owner decision that permits stopping website-server (e.g. "D61 (Lucas, 2026-10-11)"). */
  ownerDecision?: string;
}

export function validateRolloutPlan(steps: readonly RolloutStep[]): string[] {
  const problems: string[] = [];
  let last = -1;
  steps.forEach((step, i) => {
    const rank = ROLLOUT_ORDER.indexOf(step.unit);
    if (rank < 0) problems.push(`step ${i + 1}: unknown unit ${step.unit}`);
    else if (rank < last) problems.push(`step ${i + 1}: ${step.unit} comes after a later unit (order is ${ROLLOUT_ORDER.join(", ")})`);
    else last = rank;
    const stops = step.stopsWebsite === true || (step.unit === "website" && step.action === "stop");
    if (stops && (typeof step.ownerDecision !== "string" || step.ownerDecision.trim() === "")) {
      problems.push(`step ${i + 1}: stopping website-server needs a named owner decision (ownerDecision)`);
    }
  });
  return problems;
}

/** Throws on an unordered plan or a website stop without an owner decision. */
export function assertRolloutPlan(steps: readonly RolloutStep[]): void {
  const problems = validateRolloutPlan(steps);
  if (problems.length > 0) throw new Error(`refusing the rollout plan: ${problems.join("; ")}`);
}

/** The default plan: the website is replaced (never stopped), then the rest. */
export function defaultRolloutPlan(): RolloutStep[] {
  return [
    { unit: "website", action: "replace" },
    { unit: "api-workers", action: "replace" },
    { unit: "migrate", action: "run" },
    { unit: "participants", action: "replace" },
  ];
}

export const PROBE_INTERVAL_MS = 15_000;
/** Timer jitter allowed on top of the interval before a gap counts as a miss. */
export const PROBE_JITTER_MS = 2_000;

export interface ProbeReceipt {
  /** Epoch milliseconds the probe asked. */
  at: number;
  /** HTTP status of the answer; 0 when there was none. */
  status: number;
}

export interface ProbeGrade {
  ok: boolean;
  receipts: number;
  nonOk: ProbeReceipt[];
  /** Gaps longer than the interval, as [from, to] epoch ms. */
  gaps: Array<[number, number]>;
  problems: string[];
}

/**
 * Grade the receipts of one window. `windowStart` and `windowEnd` (epoch ms)
 * bound it: the first receipt must land within one interval of the start and
 * the last within one interval of the end, so a probe that died is a failure.
 */
export function gradeProbeReceipts(
  receipts: readonly ProbeReceipt[],
  window: { start: number; end: number },
  intervalMs: number = PROBE_INTERVAL_MS,
  jitterMs: number = PROBE_JITTER_MS,
): ProbeGrade {
  const sorted = [...receipts].sort((a, b) => a.at - b.at);
  const limit = intervalMs + jitterMs;
  const nonOk = sorted.filter((r) => r.status !== 200);
  const gaps: Array<[number, number]> = [];
  const marks = [window.start, ...sorted.map((r) => r.at), window.end];
  for (let i = 1; i < marks.length; i++) if (marks[i]! - marks[i - 1]! > limit) gaps.push([marks[i - 1]!, marks[i]!]);
  const problems: string[] = [];
  if (sorted.length === 0) problems.push("no probe receipts in the window");
  if (nonOk.length > 0) problems.push(`${nonOk.length} probe answer(s) were not 200`);
  if (gaps.length > 0) problems.push(`${gaps.length} gap(s) between receipts exceeded ${intervalMs / 1000} s`);
  return { ok: problems.length === 0, receipts: sorted.length, nonOk, gaps, problems };
}

/**
 * Grade the receipts of a window that holds one declared maintenance window
 * (a breaking cutover: the stack is down between the maintenance page going
 * on and off). Inside `declared` (epoch ms, on to off) a non-200 answer and
 * the gaps that start and end within one interval of it are the window, and
 * pass. Outside it, the grade is `gradeProbeReceipts` unchanged: any non-200
 * or gap fails. A receipt still counts toward the window when it falls
 * between its edges, so a probe that died before the window opened fails.
 */
export function gradeProbeWithDeclaredWindow(
  receipts: readonly ProbeReceipt[],
  window: { start: number; end: number },
  declared: { start: number; end: number },
  intervalMs: number = PROBE_INTERVAL_MS,
  jitterMs: number = PROBE_JITTER_MS,
): ProbeGrade {
  const base = gradeProbeReceipts(receipts, window, intervalMs, jitterMs);
  const limit = intervalMs + jitterMs;
  const inWindow = (at: number) => at >= declared.start && at <= declared.end;
  const nonOk = base.nonOk.filter((r) => !inWindow(r.at));
  const gaps = base.gaps.filter(([from, to]) => !(from >= declared.start - limit && to <= declared.end + limit));
  const problems: string[] = [];
  if (base.receipts === 0) problems.push("no probe receipts in the window");
  if (nonOk.length > 0) problems.push(`${nonOk.length} probe answer(s) outside the declared maintenance window were not 200`);
  if (gaps.length > 0) problems.push(`${gaps.length} gap(s) outside the declared maintenance window exceeded ${intervalMs / 1000} s`);
  return { ok: problems.length === 0, receipts: base.receipts, nonOk, gaps, problems };
}

/** Receipts are JSON lines: {"at": <epoch ms>, "status": <int>}. */
export function parseProbeReceipts(text: string): ProbeReceipt[] {
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const r = JSON.parse(l) as Partial<ProbeReceipt>;
      if (typeof r.at !== "number" || typeof r.status !== "number") throw new Error(`bad probe receipt line: ${l}`);
      return { at: r.at, status: r.status };
    });
}

export function readProbeReceipts(path: string): ProbeReceipt[] {
  return parseProbeReceipts(readFileSync(path, "utf8"));
}

/** One probe: ask `url` and say what came back. Never throws. */
export async function probeOnce(url: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<ProbeReceipt> {
  const at = now();
  try {
    const res = await fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    return { at, status: res.status };
  } catch {
    return { at, status: 0 };
  }
}
