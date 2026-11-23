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
import { maintenanceProblems } from "./maintenance-file.ts";

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
  /** HTTP status of the answer; 0 when there was none or it timed out. */
  status: number;
  /** Epoch milliseconds the answer (or the timeout) came; absent on receipts written before issue 1703. */
  endedAt?: number;
  /** endedAt minus at; absent on receipts written before issue 1703. */
  latencyMs?: number;
  /** The path asked, when the probe asks more than one. */
  path?: string;
  /**
   * Set only on an answer from the maintenance status route (issue 1501): true
   * when it was a 200 whose body is a valid active MaintenanceStatus. A receipt
   * that carries it is not a site answer, so the status and gap rules skip it.
   */
  maintenance?: boolean;
}

/** PURE. Whether an answer of the maintenance status route announces an active window: a 200 whose body is a valid MaintenanceStatus with state active. */
export function maintenanceAnswer(status: number, body: string): boolean {
  if (status !== 200) return false;
  let value: unknown;
  try { value = JSON.parse(body); } catch { return false; }
  return maintenanceProblems(value).length === 0 && (value as { state: string }).state === "active";
}

/** A receipt the site answered (`/`, `/version.json`), not the maintenance status route. */
const isSiteAnswer = (r: ProbeReceipt): boolean => r.maintenance === undefined;

/** The worst latency the probe saw on one path (issue 1703): a report, never a failure. `step` is the release step running then, when known. */
export interface LatencyFinding { path: string; latencyMs: number; at: number; step?: string }

/** PURE. The worst latencyMs per path, over the receipts that recorded one, ordered by path. */
export function latencyReport(receipts: readonly ProbeReceipt[]): LatencyFinding[] {
  const worst = new Map<string, LatencyFinding>();
  for (const r of receipts) {
    if (typeof r.latencyMs !== "number") continue;
    const path = r.path ?? (r.maintenance === undefined ? "/" : "/api/status/maintenance");
    const had = worst.get(path);
    if (had === undefined || r.latencyMs > had.latencyMs) worst.set(path, { path, latencyMs: r.latencyMs, at: r.at });
  }
  return [...worst.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export interface ProbeGrade {
  ok: boolean;
  receipts: number;
  /** Site answers that were not 200 and fall outside every excused span. */
  nonOk: ProbeReceipt[];
  /** Site answers that were not 200 inside an excused span: a swap's measured gap (issue 1630). */
  excused?: ProbeReceipt[];
  /** Spans longer than the interval plus jitter with no successful site answer started in them, as [from, to] epoch ms. */
  gaps: Array<[number, number]>;
  /** Maintenance status route answers that were not 200, outside every excused span and declared window (issue 1703). */
  maintenanceFailures: ProbeReceipt[];
  /** The worst latency per path (issue 1703). Slow answers are reported here and fail nothing. */
  latency: LatencyFinding[];
  problems: string[];
}

/** An excused span in epoch ms, inclusive: a website-server swap's gap, from its receipt (web-serving-architecture.md §4.1). */
export interface ExcusedSpan { readonly start: number; readonly end: number }

/** PURE. Whether a receipt was asked inside an excused span. */
const inSpan = (spans: readonly ExcusedSpan[], at: number): boolean => spans.some((s) => at >= s.start && at <= s.end);

/**
 * Grade the receipts of one window. `windowStart` and `windowEnd` (epoch ms)
 * bound it: the first receipt must land within one interval of the start and
 * the last within one interval of the end, so a probe that died is a failure.
 * A site answer that is not 200 (a timeout is status 0) fails the grade unless
 * it was asked inside one of `excused`: the gaps a swap's receipt measured
 * (issue 1630). The gap rule is measured on the starts of successful site
 * answers (an excused one counts as successful), so a slow 200 is no gap
 * (issue 1703). A maintenance status route answer that is not 200 outside an
 * excused span fails too. Latency is reported, never failed.
 */
export function gradeProbeReceipts(
  receipts: readonly ProbeReceipt[],
  window: { start: number; end: number },
  intervalMs: number = PROBE_INTERVAL_MS,
  jitterMs: number = PROBE_JITTER_MS,
  excused: readonly ExcusedSpan[] = [],
): ProbeGrade {
  const sorted = receipts.filter(isSiteAnswer).sort((a, b) => a.at - b.at);
  const limit = intervalMs + jitterMs;
  const failedAnswers = sorted.filter((r) => r.status !== 200);
  const nonOk = failedAnswers.filter((r) => !inSpan(excused, r.at));
  const excusedAnswers = failedAnswers.filter((r) => inSpan(excused, r.at));
  const maintenanceFailures = receipts.filter((r) => !isSiteAnswer(r) && r.status !== 200 && !inSpan(excused, r.at)).sort((a, b) => a.at - b.at);
  const gaps: Array<[number, number]> = [];
  const marks = [window.start, ...sorted.filter((r) => r.status === 200 || inSpan(excused, r.at)).map((r) => r.at), window.end];
  for (let i = 1; i < marks.length; i++) if (marks[i]! - marks[i - 1]! > limit) gaps.push([marks[i - 1]!, marks[i]!]);
  const problems: string[] = [];
  if (sorted.length === 0) problems.push("no probe receipts in the window");
  if (nonOk.length > 0) problems.push(`${nonOk.length} probe answer(s) were not 200${excused.length > 0 ? " outside the swap gap(s) the receipts recorded" : ""}`);
  if (gaps.length > 0) problems.push(`${gaps.length} span(s) with no successful site answer exceeded ${(intervalMs + jitterMs) / 1000} s`);
  if (maintenanceFailures.length > 0) problems.push(maintenanceProblem(maintenanceFailures.length));
  return { ok: problems.length === 0, receipts: sorted.length, nonOk, ...(excused.length > 0 ? { excused: excusedAnswers } : {}), gaps, maintenanceFailures, latency: latencyReport(receipts), problems };
}

const maintenanceProblem = (n: number) => `${n} answer(s) of the maintenance status route were not 200 outside a declared maintenance window`;

/**
 * Grade the receipts of a window that holds one declared maintenance window
 * (a breaking cutover: every service but website-server is down between the
 * maintenance page going on and off, issue 1501). The site never goes down, so
 * any non-200 site answer fails, inside the window or out. Only the gaps that
 * start and end within one interval of the window pass. And the window must
 * show the maintenance page was served: at least one maintenance receipt
 * inside it is true, or the grade fails. A receipt still counts toward the
 * window when it falls between its edges, so a probe that died before the
 * window opened fails.
 */
export function gradeProbeWithDeclaredWindow(
  receipts: readonly ProbeReceipt[],
  window: { start: number; end: number },
  declared: { start: number; end: number },
  intervalMs: number = PROBE_INTERVAL_MS,
  jitterMs: number = PROBE_JITTER_MS,
  excused: readonly ExcusedSpan[] = [],
): ProbeGrade {
  const base = gradeProbeReceipts(receipts, window, intervalMs, jitterMs, excused);
  const limit = intervalMs + jitterMs;
  const inWindow = (at: number) => at >= declared.start && at <= declared.end;
  const gaps = base.gaps.filter(([from, to]) => !(from >= declared.start - limit && to <= declared.end + limit));
  const maintenanceFailures = base.maintenanceFailures.filter((r) => !inWindow(r.at));
  const problems: string[] = [];
  if (base.receipts === 0) problems.push("no probe receipts in the window");
  if (base.nonOk.length > 0) problems.push(`${base.nonOk.length} probe answer(s) of the site were not 200 (the site stays up through a declared maintenance window)`);
  if (gaps.length > 0) problems.push(`${gaps.length} gap(s) outside the declared maintenance window exceeded ${intervalMs / 1000} s`);
  if (maintenanceFailures.length > 0) problems.push(maintenanceProblem(maintenanceFailures.length));
  if (!receipts.some((r) => r.maintenance === true && inWindow(r.at))) problems.push("no answer inside the declared maintenance window announced an active maintenance window (/api/status/maintenance)");
  return { ok: problems.length === 0, receipts: base.receipts, nonOk: base.nonOk, ...(base.excused !== undefined ? { excused: base.excused } : {}), gaps, maintenanceFailures, latency: base.latency, problems };
}

/** Receipts are JSON lines: {"at": <epoch ms>, "status": <int>}, with optional maintenance, path, endedAt and latencyMs (older lines lack the last three). */
export function parseProbeReceipts(text: string): ProbeReceipt[] {
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const r = JSON.parse(l) as Partial<ProbeReceipt>;
      if (typeof r.at !== "number" || typeof r.status !== "number") throw new Error(`bad probe receipt line: ${l}`);
      return {
        at: r.at, status: r.status,
        ...(typeof r.maintenance === "boolean" ? { maintenance: r.maintenance } : {}),
        ...(typeof r.endedAt === "number" ? { endedAt: r.endedAt } : {}),
        ...(typeof r.latencyMs === "number" ? { latencyMs: r.latencyMs } : {}),
        ...(typeof r.path === "string" ? { path: r.path } : {}),
      };
    });
}

export function readProbeReceipts(path: string): ProbeReceipt[] {
  return parseProbeReceipts(readFileSync(path, "utf8"));
}

/** How long one ask may take before it is a timeout receipt (status 0). */
export const PROBE_TIMEOUT_MS = 10_000;

/** Wait for `p`, or resolve undefined after `ms`. The timer is cleared when `p` settles first. */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<undefined>((done) => { timer = setTimeout(() => done(undefined), ms); });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** Ask `url` once with its own timeout: the status and body, or status 0 when the fetch failed or timed out. Never throws. */
async function ask(url: string, fetchImpl: typeof fetch, timeoutMs: number, readBody: boolean): Promise<{ status: number; body: string }> {
  const go = (async () => {
    const res = await fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: readBody ? await res.text() : "" };
  })().catch(() => ({ status: 0, body: "" }));
  return (await within(go, timeoutMs)) ?? { status: 0, body: "" };
}

/** One probe: ask `url` and say what came back, when it was asked and answered, and how long it took. Never throws. */
export async function probeOnce(url: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<ProbeReceipt> {
  const at = now();
  const { status } = await ask(url, fetchImpl, timeoutMs, false);
  const endedAt = now();
  return { at, status, endedAt, latencyMs: endedAt - at };
}

/** One ask of the maintenance status route (issue 1501): the receipt records whether it announced an active window. Never throws. */
export async function probeMaintenance(url: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<ProbeReceipt> {
  const at = now();
  const { status, body } = await ask(url, fetchImpl, timeoutMs, true);
  const endedAt = now();
  return { at, status, maintenance: maintenanceAnswer(status, body), endedAt, latencyMs: endedAt - at };
}
