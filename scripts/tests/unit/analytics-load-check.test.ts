// scripts/tests/unit/analytics-load-check.test.ts — the stage load check of
// issue 1514 (scripts/release/analytics-load-check.ts): its log parser, its
// per-route table and its verdict, on fixture api logs.
import { describe, expect, test } from "bun:test";
import { nextScheduledRun, parseApiLog, percentile, renderReport, summarize, type DbPoolSnapshot } from "../../release/analytics-load-check.ts";

const T = (s: string) => `2026-10-28T06:${s}.000000000Z`;
const ua = "ua=Bun/1.3.14";

/** A window with traffic but nothing slow and no refusal: the api logs nothing for it. */
const CLEAN = [
  `${T("00:01")} [analytics-producer] research run started`,
  `${T("00:02")} db pools: connection budget 87 = max_connections 100 − superuser_reserved_connections 3 − reserved_connections 0 − headroom 10; shares: request 10 + batch 5 + guard 1 = 16`,
].join("\n");

/** The fix build's line: a request of exactly 5.0 s, with its split. */
const FIVE_SECONDS = `${T("31:10")} [api] slow request: POST /api/analytics/source-acquisitions took 5.0s status=200 limiter_wait_ms=0 pool_wait_ms=12 handler_ms=4988 ${ua}`;

/** Production's line before issue 1514: a 9.5 s vintages freeze, no split. */
const VINTAGES_OLD = `${T("33:40")} [api] slow request: POST /api/analytics/vintages took 9.5s status=200 ${ua}`;

/** Production's refusal before issue 1514: the gate is only in the error's message, below a code frame. */
const CLAIM_SATURATED_OLD = [
  `${T("32:00")} api error (503 /api/pipeline/queue/claim): 94 |           timer: setTimeout(() => {`,
  `${T("32:00")} 95 |             const at = queue.indexOf(entry);`,
  `${T("32:00")} 96 |             reject(new DbSaturatedError(name, waitMs));`,
  `${T("32:00")}                         ^`,
  `${T("32:00")} DbSaturatedError: database pool "batch" is saturated: no connection became free within 500ms`,
  `${T("32:00")}       at <anonymous> (/app/backend/src/db/pool-gate.ts:96:24)`,
].join("\n");

/** The fix build's refusal line names its gate. */
const CLAIM_SATURATED_NEW = `${T("32:05")} api error (503 /api/pipeline/queue/claim) db_saturated gate=pipeline:rm_prod/pipeline-worker: DbSaturatedError: database pool "pipeline:rm_prod/pipeline-worker" is saturated`;

/** A 503 that is not a saturation (a statement timeout) is not counted. */
const TIMEOUT_503 = [
  `${T("34:00")} api error (503 /api/analytics/raw-history): PostgresError: canceling statement due to statement timeout`,
  `${T("34:00")}  code: "57014"`,
].join("\n");

const pool = (refused: number): DbPoolSnapshot => ({
  request: { max: 10, admitted_total: 100, refused_total: 0, timeout_total: 0 },
  batch: { max: 3, admitted_total: 500, refused_total: refused, timeout_total: 0 },
});

describe("parseApiLog", () => {
  test("reads the fix build's slow line with its split, and the old line with none", () => {
    const parsed = parseApiLog([FIVE_SECONDS, VINTAGES_OLD].join("\n"));
    expect(parsed.requests).toEqual([
      { at: T("31:10"), method: "POST", path: "/api/analytics/source-acquisitions", ms: 5000, status: "200", limiterMs: 0, poolMs: 12, handlerMs: 4988 },
      { at: T("33:40"), method: "POST", path: "/api/analytics/vintages", ms: 9500, status: "200", limiterMs: null, poolMs: null, handlerMs: null },
    ]);
  });

  test("reads a db_saturated refusal in both forms, with its gate, and ignores a 503 that is not one", () => {
    const parsed = parseApiLog([CLAIM_SATURATED_OLD, CLAIM_SATURATED_NEW, TIMEOUT_503].join("\n"));
    expect(parsed.saturated).toEqual([
      { at: T("32:00"), path: "/api/pipeline/queue/claim", gate: "batch" },
      { at: T("32:05"), path: "/api/pipeline/queue/claim", gate: "pipeline:rm_prod/pipeline-worker" },
    ]);
  });

  test("a request cut off at the limit is read as a slow request too", () => {
    const parsed = parseApiLog(`[api] request ran past the 10s limit, so the client was cut off: GET /api/x took 11.2s status=200 limiter_wait_ms=0 pool_wait_ms=0 handler_ms=11200 ${ua}`);
    expect(parsed.requests.map((r) => [r.path, r.ms, r.at])).toEqual([["/api/x", 11200, null]]);
  });
});

describe("the verdict", () => {
  test("a clean window passes", () => {
    const report = summarize(parseApiLog(CLEAN), { start: pool(0), end: pool(0) });
    expect(report.ok).toBe(true);
    expect(report.rows).toEqual([]);
    expect(renderReport(report, null)).toContain("PASS: no request of 5 s or more, no db_saturated answer");
  });

  test("a 5.0 s request fails, and its row carries the split", () => {
    const report = summarize(parseApiLog([CLEAN, FIVE_SECONDS].join("\n")));
    expect(report.ok).toBe(false);
    expect(report.rows).toEqual([{
      route: "/api/analytics/source-acquisitions", count: 1, p50Ms: 5000, p95Ms: 5000, maxMs: 5000,
      limiterMs: 0, poolMs: 12, handlerMs: 4988, unsplit: 0, saturated: 0, gates: [],
    }]);
    expect(report.dominant).toEqual({ part: "handler", share: 4988 / 5000 });
    expect(renderReport(report, null)).toContain("/api/analytics/source-acquisitions | 1 | 5.0s | 5.0s | 5.0s | 0.0s | 0.0s | 5.0s | 0");
  });

  test("a 9.5 s vintages request on the old line fails, its split shown as unknown", () => {
    const report = summarize(parseApiLog(VINTAGES_OLD));
    expect(report.ok).toBe(false);
    expect(report.problems.join()).toContain("took 5 s or more (max 9.5 s)");
    const text = renderReport(report, { since: "2026-10-28T06:00:00.000Z", until: "2026-10-28T08:00:00.000Z" });
    expect(text).toContain("/api/analytics/vintages | 1 | 9.5s | 9.5s | 9.5s | unknown | unknown | unknown | 0");
    expect(text).toContain("dominant wait over the slow requests: unknown");
  });

  test("one db_saturated claim fails, its row names the gate, and the pool's refusal shows in the telemetry", () => {
    const report = summarize(parseApiLog([CLEAN, CLAIM_SATURATED_OLD].join("\n")), { start: pool(4), end: pool(5) });
    expect(report.ok).toBe(false);
    expect(report.saturated).toBe(1);
    expect(report.rows).toEqual([{
      route: "/api/pipeline/queue/claim", count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0,
      limiterMs: null, poolMs: null, handlerMs: null, unsplit: 0, saturated: 1, gates: ["batch"],
    }]);
    expect(report.poolRefusals).toEqual({ request: 0, batch: 1 });
    expect(renderReport(report, null)).toContain("/api/pipeline/queue/claim | 0 | 0.0s | 0.0s | 0.0s | unknown | unknown | unknown | 1 (batch)");
  });

  test("a pool refusal the log missed still fails the window", () => {
    expect(summarize(parseApiLog(CLEAN), { start: pool(0), end: pool(2) }).ok).toBe(false);
  });
});

describe("the window", () => {
  test("the next scheduled run is the next 3-hour boundary in UTC, or now when now is one", () => {
    expect(nextScheduledRun(new Date("2026-10-28T02:59:59Z")).toISOString()).toBe("2026-10-28T03:00:00.000Z");
    expect(nextScheduledRun(new Date("2026-10-28T03:00:00Z")).toISOString()).toBe("2026-10-28T03:00:00.000Z");
    expect(nextScheduledRun(new Date("2026-10-28T03:00:01Z")).toISOString()).toBe("2026-10-28T06:00:00.000Z");
    expect(nextScheduledRun(new Date("2026-10-28T22:10:00Z")).toISOString()).toBe("2026-10-29T00:00:00.000Z");
  });

  test("percentiles are nearest-rank", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([], 50)).toBe(0);
  });
});
