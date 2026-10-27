// scripts/release/public-analytics-read.ts — read-only access to the public
// analytics routes (/api/public/analytics/**) for the release checks (issue
// 1476): the SDK checks of the template's soak (Q35 to Q37 (C23 to C25)) and the v0.7.0
// version checks. Every function takes the fetcher and the sleeper as
// parameters, so a unit test runs offline against a fake API.
//
// Nothing here writes. The public routes are GET only. A 429 or 503 is waited
// out as its Retry-After says (the routes' own load protection, issue 1422).
import { createHash } from "node:crypto";

export const PUBLIC_API = "/api/public/analytics";

/** The fetch the checks use; a test passes a fake. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type Sleeper = (ms: number) => Promise<void>;

export interface Net {
  readonly origin: string;
  readonly fetch: Fetcher;
  readonly sleep: Sleeper;
}

/** The real network: global fetch with a 60 s timeout, and a timer. */
export function realNet(origin: string): Net {
  return {
    origin: origin.replace(/\/+$/, ""),
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(60_000) }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** PURE. The wait a Retry-After header asks for, in ms; 1 s when it is missing or not a count, never over 70 s. */
export function retryAfterMs(header: string | null): number {
  const n = header === null ? NaN : Number(header);
  return Math.min(70_000, (Number.isFinite(n) && n >= 0 ? n : 1) * 1000);
}

/** GET with 429/503 waited out (at most `tries` times). Returns the last response. */
export async function getWithRetry(net: Net, path: string, init?: RequestInit, tries = 6): Promise<Response> {
  let res = await net.fetch(`${net.origin}${path}`, init);
  for (let i = 1; i < tries && (res.status === 429 || res.status === 503); i++) {
    await net.sleep(retryAfterMs(res.headers.get("retry-after")));
    res = await net.fetch(`${net.origin}${path}`, init);
  }
  return res;
}

export interface ReportRow {
  readonly report_id: number;
  readonly run_key: string;
  readonly asof: string;
  readonly checksum: string;
  readonly byte_length: number;
}

/** Every published report the list names, oldest first, or why the list could not be read. */
export async function listReports(net: Net, maxPages = 60): Promise<{ reports: ReportRow[]; problems: string[] }> {
  const reports: ReportRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await getWithRetry(net, `${PUBLIC_API}/reports?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (res.status !== 200) return { reports, problems: [`GET ${PUBLIC_API}/reports answered ${res.status}`] };
    let body: { reports?: ReportRow[]; nextCursor?: string | null };
    try { body = (await res.json()) as typeof body; } catch { return { reports, problems: [`GET ${PUBLIC_API}/reports is not JSON`] }; }
    reports.push(...(body.reports ?? []));
    cursor = body.nextCursor ?? null;
    if (cursor === null) return { reports, problems: [] };
  }
  return { reports, problems: [`${PUBLIC_API}/reports has more than ${maxPages} pages; the latest run was not reached`] };
}

/** PURE. The newest published report (highest report id), or undefined when none is published. */
export function latestReport(reports: readonly ReportRow[]): ReportRow | undefined {
  return reports.reduce<ReportRow | undefined>((best, r) => (best === undefined || r.report_id > best.report_id ? r : best), undefined);
}

/** The words that name a target with no published run: the checks that need one fail with this, never skip. */
export const noRunMessage = (what: string): string =>
  `the target has no published run: ${PUBLIC_API}/reports lists none, so ${what} has no run to use (a check never skips for want of one)`;
