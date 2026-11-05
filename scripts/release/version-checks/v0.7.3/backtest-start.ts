// Q38-backtest-start (PR 1562, issue 1559): every line in a market's regime backtest starts on the
// same date, at $1. Read-only: one GET of the regime snapshots route with the backtest included.
//
// Stage only (stageOnly, no production twin). The backtest is written by the scheduled analytics
// run, so the build that serves it is not the build that made it until the next run after READY.
// On stage, Q34a-analytics-load has watched that run before this step starts. Production's run
// can fall hours after its soak, and production runs the tree stage passed (SP.8).
//
// Before PR 1562 the hodl and stables lines started on their first priced date (2018-01-01 for
// eth), four and a half months before the strategies (2018-05-15), so a v0.7.2 run fails here.
import type { VersionCheck } from "../../version-check.ts";

export const BACKTEST_PATH = "/api/dashboards/regime-snapshots?range=4000&include=backtest";

interface Entry { readonly start_date?: unknown; readonly equity_curve?: readonly { readonly date?: unknown; readonly value?: unknown }[] }

/** PURE. Each market's start dates by line, from the route's body; null when the body has no backtest. */
export function backtestStarts(body: unknown): Record<string, Record<string, string>> | null {
  const bt = (body as { latest?: { backtest?: unknown } } | null)?.latest?.backtest;
  if (!bt || typeof bt !== "object") return null;
  const out: Record<string, Record<string, string>> = {};
  for (const [market, lines] of Object.entries(bt as Record<string, unknown>)) {
    if (!lines || typeof lines !== "object") continue;
    for (const [line, e] of Object.entries(lines as Record<string, Entry>)) {
      if (!e || typeof e !== "object" || !("start_date" in e)) continue;
      (out[market] ??= {})[line] = String(e.start_date);
    }
  }
  return out;
}

/** PURE. Why the served backtest still has lines that start apart, or not at $1; empty when it passes. */
export function backtestStartProblems(status: number, text: string): string[] {
  if (status !== 200) return [`GET ${BACKTEST_PATH} answered ${status}, not 200`];
  let body: unknown;
  try { body = JSON.parse(text); } catch { return [`GET ${BACKTEST_PATH} did not answer JSON`]; }
  const starts = backtestStarts(body);
  if (!starts || Object.keys(starts).length === 0) return [`GET ${BACKTEST_PATH} carries no backtest in latest`];
  const problems: string[] = [];
  const bt = (body as { latest: { backtest: Record<string, Record<string, Entry>> } }).latest.backtest;
  for (const [market, lines] of Object.entries(starts)) {
    const dates = new Set(Object.values(lines));
    if (dates.size !== 1) problems.push(`market ${market}: lines start on different dates (${Object.entries(lines).map(([l, d]) => `${l} ${d}`).join(", ")}): the backtest before PR 1562 is still served`);
    for (const line of Object.keys(lines)) {
      const first = bt[market]?.[line]?.equity_curve?.[0];
      if (!first || first.value !== 1 || first.date !== lines[line]) problems.push(`market ${market} line ${line}: the equity curve opens at ${JSON.stringify(first)}, not {date: ${lines[line]}, value: 1}`);
    }
  }
  return problems;
}

export default (async (ctx) => {
  const res = await ctx.http(BACKTEST_PATH);
  let starts: ReturnType<typeof backtestStarts> = null;
  try { starts = backtestStarts(JSON.parse(res.text)); } catch { /* reported by the problems */ }
  return { found: { path: BACKTEST_PATH, status: res.status, starts }, problems: backtestStartProblems(res.status, res.text) };
}) satisfies VersionCheck;
