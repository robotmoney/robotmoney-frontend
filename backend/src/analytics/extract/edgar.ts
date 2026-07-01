// Extract stage: SEC EDGAR full-text-search (keyless) source client.
// Ported from agentjuno/robotmoney late-cycle-signals.js (fetchEdgarS4Monthly).
//
//   https://efts.sec.gov/LATEST/search-index?q=%22merger%22&forms=S-4&startdt=..&enddt=..
//
// Monthly count of S-4 filings (registration statement for mergers/exchange
// offers) → a free mechanical proxy for M&A deal flow (the late-cycle `mna`
// signal). FTS covers 2001+. SEC asks for a descriptive User-Agent and modest
// request rates; we send one request per month with retry/backoff. Each count is
// stamped on month-END so forward-fill aligns it to the month it describes
// without intra-month lookahead.
import type { Point } from "../types.ts";
import { fetchJson } from "./http.ts";

const UA = "robotmoney-research/1.0 (research@robotmoney.net)";

export const edgarUrl = (monthStart: string, monthEnd: string) =>
  `https://efts.sec.gov/LATEST/search-index?q=%22merger%22&forms=S-4&startdt=${monthStart}&enddt=${monthEnd}`;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Pure: enumerate [{monthStart, monthEnd}] (first/last calendar day) for every
// month overlapping [startIso, endIso].
export function enumerateMonths(startIso: string, endIso: string): { monthStart: string; monthEnd: string }[] {
  const out: { monthStart: string; monthEnd: string }[] = [];
  const start = new Date(startIso + "T00:00:00Z");
  const end = new Date(endIso + "T00:00:00Z");
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cur <= end) {
    const y = cur.getUTCFullYear();
    const m = cur.getUTCMonth();
    out.push({ monthStart: iso(new Date(Date.UTC(y, m, 1))), monthEnd: iso(new Date(Date.UTC(y, m + 1, 0))) });
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

// Pure: extract the hit count from an EDGAR FTS response ({ hits: { total: { value } } }).
// Returns null when absent/non-finite (a month the caller records as unrecovered).
export function parseEdgarCount(j: unknown): number | null {
  const v = (j as any)?.hits?.total?.value;
  return Number.isFinite(v) ? Number(v) : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One month's S-4 count with 4 attempts / exponential backoff. Retries 429/5xx;
// gives up (returns null) on other 4xx. Loud-logs the final failure.
export async function fetchEdgarMonthCount(
  monthStart: string,
  monthEnd: string,
  timeoutMs = 15000,
  logger: { warn?: (m: string) => void } = console,
): Promise<number | null> {
  const url = edgarUrl(monthStart, monthEnd);
  let lastErr = "unknown error";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, { signal: ac.signal, headers: { "user-agent": UA, accept: "application/json" } });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break; // non-retryable
        continue;
      }
      const count = parseEdgarCount(await res.json());
      if (count != null) return count;
      lastErr = "no count in response";
    } catch (e: any) {
      lastErr = String(e?.message ?? e);
    }
  }
  logger.warn?.(`[edgar] S-4 ${monthStart}: ${lastErr} (giving up after 4 tries)`);
  return null;
}

// Monthly S-4 counts across [startIso, endIso], stamped on each month-end.
// Unrecovered months are logged loudly and omitted (never silently zero-filled).
export async function fetchEdgarS4Monthly(
  startIso: string,
  endIso: string,
  timeoutMs = 15000,
  logger: { warn?: (m: string) => void } = console,
): Promise<Point[]> {
  const out: Point[] = [];
  const missing: string[] = [];
  for (const { monthStart, monthEnd } of enumerateMonths(startIso, endIso)) {
    const count = await fetchEdgarMonthCount(monthStart, monthEnd, timeoutMs, logger);
    if (count != null) out.push({ date: monthEnd, value: count });
    else missing.push(monthStart);
    await sleep(250);
  }
  if (missing.length > 0) logger.warn?.(`[edgar] S-4: ${missing.length} months unrecovered: ${missing.join(", ")}`);
  return out;
}
