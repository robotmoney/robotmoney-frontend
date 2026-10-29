#!/usr/bin/env bun
// scripts/release/analytics-load-check.ts — the stage load check of issue 1514
// (batch pool saturation), run ON THE TARGET HOST by the stage-only step
// Q34a-analytics-load.
//
//   bun scripts/release/analytics-load-check.ts --instance <name> [--window-minutes 120] [--receipt-dir <dir>]
//   bun scripts/release/analytics-load-check.ts --instance <name> --since <iso> --until <iso> [--receipt-dir <dir>]
//   bun scripts/release/analytics-load-check.ts --log <api log file> [--receipt-dir <dir>]
//
// WHY. Since the v0.7.0 cutover the api's batch pool saturated at every
// 3-hourly analytics run on production: queue claims answered 503 db_saturated
// and source-acquisitions and vintages requests took 6 to 9.5 s. Stage showed
// none of it. This check measures one scheduled run on stage, with production's
// dump and connection budget, and fails the way production did.
//
// WHAT IT READS. It starts no analytics run (no unscheduled run anywhere). It
// waits for the next scheduled run, the next 3-hour boundary in UTC (research
// `0 */3 * * *`, regime `30 */3 * * *`), and watches that run's window. Then it
// reads the api container's log for the window and the api's /health `db_pool`
// telemetry at the window's start and end. `--since/--until` grades a window
// that has passed; `--log` grades a saved api log.
//
// WHAT IT PRINTS. One row per route the api logged: its request count, p50, p95
// and max duration, the time split into limiter wait, pool admission wait and
// handler time, and its 503 db_saturated count. Then which wait dominates, and
// the pools' refusals over the window. The api logs only slow requests (5 s and
// over) and refusals, so the rows count those, not every request.
//
// THE OLD LINE. An api built before issue 1514 logs a slow request without the
// wait split, and a refusal without its gate. Both are still parsed: the split
// shows as unknown and the gate is read from the error's message. So the check
// runs against the current production build and still fails.
//
// It exits 1 when any request took 5 s or more, or any request answered
// db_saturated (a log line, or a pool's refused_total that grew in the window).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { instancePaths, readStackState, stateRoot } from "../lib/smoke-state.ts";

/** The owner's rule: no api request takes 5 s or more (the request deadline stays 10 s). */
export const SLOW_MS = 5_000;
/** The analytics producer's schedules repeat every 3 hours, on the hour in UTC (research at :00, regime at :30). */
export const SCHEDULE_PERIOD_HOURS = 3;
/** How long after the boundary the window stays open: both runs of the tick, well before the next one. */
export const DEFAULT_WINDOW_MINUTES = 120;

/** One request the api logged as slow (or as cut off at the limit). */
export interface LoggedRequest {
  readonly at: string | null;
  readonly method: string;
  readonly path: string;
  readonly ms: number;
  readonly status: string;
  /** null on the old line, which has no wait split. */
  readonly limiterMs: number | null;
  readonly poolMs: number | null;
  readonly handlerMs: number | null;
}

/** One request the api refused with 503 db_saturated. */
export interface SaturatedAnswer {
  readonly at: string | null;
  readonly path: string;
  /** The gate that refused: `batch`, `request` or `pipeline:<instance>/<holder>`; null when the log does not say. */
  readonly gate: string | null;
}

export interface ParsedApiLog {
  readonly requests: readonly LoggedRequest[];
  readonly saturated: readonly SaturatedAnswer[];
}

const TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/;
const SLOW = /\[api\] (?:slow request|request ran past the \d+s limit, so the client was cut off): (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S+) took (\d+(?:\.\d+)?)s status=(\S+)(?: limiter_wait_ms=(\d+) pool_wait_ms=(\d+) handler_ms=(\d+))?/;
const ERROR_503 = /api error \(503 (\S+?)\)(?: db_saturated gate=(\S+):(?=\s|$))?/;
const SATURATED_MESSAGE = /database pool "([^"]+)" is saturated/;
/** How far below an old-format `api error (503 …)` line its error's message may sit (Bun prints a code frame first). */
const LOOKAHEAD_LINES = 40;

/** PURE. The slow requests and db_saturated answers in an api log (`docker logs --timestamps`, or without timestamps). */
export function parseApiLog(text: string): ParsedApiLog {
  const lines = text.split("\n");
  const requests: LoggedRequest[] = [];
  const saturated: SaturatedAnswer[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const at = TS.exec(line)?.[1] ?? null;
    const slow = SLOW.exec(line);
    if (slow) {
      const n = (v: string | undefined) => (v === undefined ? null : Number(v));
      requests.push({
        at, method: slow[1]!, path: slow[2]!, ms: Math.round(Number(slow[3]) * 1000), status: slow[4]!,
        limiterMs: n(slow[5]), poolMs: n(slow[6]), handlerMs: n(slow[7]),
      });
      continue;
    }
    const refused = ERROR_503.exec(line);
    if (!refused) continue;
    if (refused[2] !== undefined) {
      saturated.push({ at, path: refused[1]!, gate: refused[2] });
      continue;
    }
    // The old line: `api error (503 <path>):` then the error, on this line or
    // below it. A 503 is db_saturated only when the error says a pool is
    // saturated; db_timeout and an unavailable database answer 503 too.
    for (let j = i; j < Math.min(lines.length, i + LOOKAHEAD_LINES); j++) {
      if (j > i && (lines[j]!.includes("api error (") || lines[j]!.includes("[api] "))) break;
      const m = SATURATED_MESSAGE.exec(lines[j]!);
      if (m) {
        saturated.push({ at, path: refused[1]!, gate: m[1]! });
        break;
      }
    }
  }
  return { requests, saturated };
}

/** PURE. The nearest-rank percentile of sorted values. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export interface RouteRow {
  readonly route: string;
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  /** Sums over the requests that carry the split; null when none does (the old line). */
  readonly limiterMs: number | null;
  readonly poolMs: number | null;
  readonly handlerMs: number | null;
  /** Requests logged on the old line, without a split. */
  readonly unsplit: number;
  readonly saturated: number;
  readonly gates: readonly string[];
}

/** The /health `db_pool` counters one pool reports. */
export interface PoolCounters {
  readonly max: number;
  readonly admitted_total: number;
  readonly refused_total: number;
  readonly timeout_total: number;
}

export interface DbPoolSnapshot {
  readonly request: PoolCounters;
  readonly batch: PoolCounters;
}

export interface LoadReport {
  readonly rows: readonly RouteRow[];
  readonly slow: number;
  readonly saturated: number;
  /** Refusals the pools counted in the window (/health), when both snapshots were read. */
  readonly poolRefusals: { readonly request: number; readonly batch: number } | null;
  readonly batchMax: number | null;
  /** Which part of the slow requests' time dominates, over the requests that carry the split. */
  readonly dominant: { readonly part: "limiter" | "pool" | "handler"; readonly share: number } | null;
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/** PURE. The per-route table and the verdict. */
export function summarize(parsed: ParsedApiLog, pools: { start: DbPoolSnapshot | null; end: DbPoolSnapshot | null } = { start: null, end: null }): LoadReport {
  const routes = new Set([...parsed.requests.map((r) => r.path), ...parsed.saturated.map((s) => s.path)]);
  const rows: RouteRow[] = [...routes].sort().map((route) => {
    const reqs = parsed.requests.filter((r) => r.path === route);
    const ms = reqs.map((r) => r.ms).sort((a, b) => a - b);
    const split = reqs.filter((r) => r.limiterMs !== null);
    const sum = (k: "limiterMs" | "poolMs" | "handlerMs") => (split.length === 0 ? null : split.reduce((a, r) => a + (r[k] ?? 0), 0));
    const sat = parsed.saturated.filter((s) => s.path === route);
    return {
      route, count: reqs.length, p50Ms: percentile(ms, 50), p95Ms: percentile(ms, 95), maxMs: ms.at(-1) ?? 0,
      limiterMs: sum("limiterMs"), poolMs: sum("poolMs"), handlerMs: sum("handlerMs"), unsplit: reqs.length - split.length,
      saturated: sat.length, gates: [...new Set(sat.map((s) => s.gate ?? "unknown"))].sort(),
    };
  });

  const slow = parsed.requests.filter((r) => r.ms >= SLOW_MS);
  const totals = { limiter: 0, pool: 0, handler: 0 };
  for (const r of slow) if (r.limiterMs !== null) {
    totals.limiter += r.limiterMs;
    totals.pool += r.poolMs ?? 0;
    totals.handler += r.handlerMs ?? 0;
  }
  const all = totals.limiter + totals.pool + totals.handler;
  const top = (Object.entries(totals) as ["limiter" | "pool" | "handler", number][]).sort((a, b) => b[1] - a[1])[0]!;
  const dominant = all > 0 ? { part: top[0], share: top[1] / all } : null;

  const poolRefusals = pools.start && pools.end
    ? { request: pools.end.request.refused_total - pools.start.request.refused_total, batch: pools.end.batch.refused_total - pools.start.batch.refused_total }
    : null;
  const problems: string[] = [];
  if (slow.length > 0) problems.push(`${slow.length} request(s) took ${SLOW_MS / 1000} s or more (max ${(Math.max(...slow.map((r) => r.ms)) / 1000).toFixed(1)} s)`);
  if (parsed.saturated.length > 0) problems.push(`${parsed.saturated.length} request(s) answered 503 db_saturated`);
  if (poolRefusals && poolRefusals.request + poolRefusals.batch > 0) {
    problems.push(`the pools refused ${poolRefusals.batch} batch and ${poolRefusals.request} request admission(s) in the window (/health db_pool)`);
  }
  return {
    rows, slow: slow.length, saturated: parsed.saturated.length, poolRefusals, batchMax: pools.end?.batch.max ?? pools.start?.batch.max ?? null,
    dominant, ok: problems.length === 0, problems,
  };
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const part = (ms: number | null) => (ms === null ? "unknown" : sec(ms));

/** PURE. The report as text: one row per route, then the verdict. */
export function renderReport(report: LoadReport, window: { since: string; until: string } | null): string {
  const out: string[] = [];
  if (window) out.push(`analytics load check: ${window.since} to ${window.until}`);
  out.push("route | count | p50 | p95 | max | limiter wait | pool wait | handler | db_saturated (gate)");
  out.push("--- | --- | --- | --- | --- | --- | --- | --- | ---");
  for (const r of report.rows) {
    const unsplit = r.unsplit > 0 && r.limiterMs !== null ? ` (+${r.unsplit} unknown)` : "";
    out.push([
      r.route, r.count, sec(r.p50Ms), sec(r.p95Ms), sec(r.maxMs),
      part(r.limiterMs) + unsplit, part(r.poolMs) + unsplit, part(r.handlerMs) + unsplit,
      r.saturated > 0 ? `${r.saturated} (${r.gates.join(", ")})` : "0",
    ].join(" | "));
  }
  if (report.rows.length === 0) out.push("(no slow request and no db_saturated answer in the window)");
  out.push("");
  out.push(report.dominant
    ? `dominant wait over the slow requests: ${report.dominant.part} (${Math.round(report.dominant.share * 100)}%)`
    : report.slow > 0 ? "dominant wait over the slow requests: unknown (this api logs no wait split)" : "dominant wait: none (no slow request)");
  if (report.poolRefusals) out.push(`pool refusals in the window (/health db_pool): batch ${report.poolRefusals.batch}, request ${report.poolRefusals.request}; batch pool max ${report.batchMax}`);
  out.push(report.ok ? "PASS: no request of 5 s or more, no db_saturated answer" : `FAIL: ${report.problems.join("; ")}`);
  return `${out.join("\n")}\n`;
}

/** PURE. The start of the next scheduled run at or after `now`: the next 3-hour boundary in UTC. */
export function nextScheduledRun(now: Date): Date {
  const t = new Date(now);
  t.setUTCMinutes(0, 0, 0);
  while (t.getTime() < now.getTime() || t.getUTCHours() % SCHEDULE_PERIOD_HOURS !== 0) t.setUTCHours(t.getUTCHours() + 1);
  return t;
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function dbPool(apiPort: number): Promise<DbPoolSnapshot | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/health`, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as { db_pool?: DbPoolSnapshot | null };
    return body.db_pool ?? null;
  } catch {
    return null;
  }
}

function apiContainer(project: string): string | null {
  const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.service=api"], { encoding: "utf8" });
  return ps.status === 0 ? (ps.stdout.split("\n").map((l) => l.trim()).find(Boolean) ?? null) : null;
}

async function main(): Promise<number> {
  const receiptDir = flag("--receipt-dir");
  const logFile = flag("--log");
  let text: string;
  let window: { since: string; until: string } | null = null;
  let pools: { start: DbPoolSnapshot | null; end: DbPoolSnapshot | null } = { start: null, end: null };

  if (logFile) {
    text = readFileSync(logFile, "utf8");
  } else {
    const instance = flag("--instance");
    if (!instance) {
      console.error("usage: bun scripts/release/analytics-load-check.ts --instance <name> [--window-minutes N | --since <iso> --until <iso>] [--receipt-dir <dir>] | --log <file>");
      return 2;
    }
    const record = readStackState(instancePaths(stateRoot(process.env), instance));
    if (record === null) {
      console.error(`[analytics-load-check] instance ${instance} has no stack record`);
      return 1;
    }
    const container = apiContainer(record.project);
    if (!container) {
      console.error(`[analytics-load-check] compose project ${record.project} has no running api container`);
      return 1;
    }
    const since = flag("--since");
    const until = flag("--until");
    if (since !== undefined || until !== undefined) {
      if (!since || !until || Number.isNaN(Date.parse(since)) || Number.isNaN(Date.parse(until))) {
        console.error("[analytics-load-check] --since and --until are ISO instants, given together");
        return 2;
      }
      window = { since, until };
    } else {
      const minutes = Number(flag("--window-minutes") ?? DEFAULT_WINDOW_MINUTES);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        console.error("[analytics-load-check] --window-minutes is a positive number");
        return 2;
      }
      const start = nextScheduledRun(new Date());
      const end = new Date(start.getTime() + minutes * 60_000);
      console.log(`[analytics-load-check] waiting for the scheduled run at ${start.toISOString()}; the window closes at ${end.toISOString()}`);
      await Bun.sleep(Math.max(0, start.getTime() - Date.now()));
      const startPools = await dbPool(record.apiPort);
      await Bun.sleep(Math.max(0, end.getTime() - Date.now()));
      pools = { start: startPools, end: await dbPool(record.apiPort) };
      window = { since: start.toISOString(), until: end.toISOString() };
    }
    const logs = spawnSync("docker", ["logs", "--timestamps", "--since", window.since, "--until", window.until, container], { maxBuffer: 1 << 30 });
    if (logs.status !== 0) {
      console.error(`[analytics-load-check] docker logs ${container} failed: ${logs.stderr}`);
      return 1;
    }
    text = Buffer.concat([logs.stdout, logs.stderr]).toString("utf8");
  }

  const report = summarize(parseApiLog(text), pools);
  const rendered = renderReport(report, window);
  process.stdout.write(rendered);
  if (receiptDir) {
    mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(receiptDir, "analytics-load-check.md"), rendered, { mode: 0o600 });
    writeFileSync(join(receiptDir, "analytics-load-check.json"), `${JSON.stringify({ step: "analytics-load-check", window, ...report, at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  }
  return report.ok ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
