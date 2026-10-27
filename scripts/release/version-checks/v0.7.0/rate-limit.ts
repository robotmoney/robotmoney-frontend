// V10-rate-limit (PR 1429): over its budget a client of the public routes gets
// 429 with Retry-After. A report's bytes cost 10 of a client's 100 tokens a
// minute (PUBLIC_ANALYTICS_HEAVY_COST, PUBLIC_ANALYTICS_TOKENS_PER_MINUTE), so
// the check asks for the newest run's report with its ETag as If-None-Match
// (a 304 sends no bytes) until it is refused, at most 30 times, and requires:
// a 429, a Retry-After that is a positive whole number of seconds, and a body
// that says why. It runs last of the version steps: it spends this client's
// minute budget, and the other checks wait out a 429 as the routes ask.
// Reads only: GETs of /reports.
import { getWithRetry, latestReport, listReports, noRunMessage, PUBLIC_API, realNet, type Net } from "../../public-analytics-read.ts";
import type { VersionCheck } from "../../version-check.ts";

export const MAX_REQUESTS = 30;

export interface Probe {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly body: string;
}

/** PURE. Why the probes do not show a 429 with Retry-After; empty when they do. */
export function rateLimitProblems(probes: readonly Probe[]): string[] {
  const refused = probes.find((p) => p.status === 429);
  if (refused === undefined) return [`${probes.length} requests of the heavy route never drew a 429 (statuses: ${[...new Set(probes.map((p) => p.status))].join(", ")})`];
  const out: string[] = [];
  if (refused.retryAfter === null || !/^[1-9]\d*$/.test(refused.retryAfter)) out.push(`the 429 carries Retry-After ${JSON.stringify(refused.retryAfter)}, not a positive whole number of seconds`);
  if (!/rate limit|budget/i.test(refused.body)) out.push(`the 429 body does not say why: ${JSON.stringify(refused.body.slice(0, 120))}`);
  const unexpected = probes.filter((p) => p.status !== 200 && p.status !== 304 && p.status !== 429);
  if (unexpected.length > 0) out.push(`before the 429 a request answered ${unexpected[0]!.status}`);
  return out;
}

export async function rateLimit(net: Net): Promise<{ found: Record<string, unknown>; problems: string[] }> {
  const { reports, problems } = await listReports(net);
  if (problems.length > 0) return { found: {}, problems };
  const row = latestReport(reports);
  if (row === undefined) return { found: {}, problems: [noRunMessage("the rate limit check")] };
  const path = `${PUBLIC_API}/reports?run=${encodeURIComponent(row.run_key)}`;
  const first = await getWithRetry(net, path);
  const etag = first.headers.get("etag");
  await first.arrayBuffer();
  const probes: Probe[] = [];
  for (let i = 0; i < MAX_REQUESTS; i++) {
    // No retry here: a 429 is the answer being asserted.
    const res = await net.fetch(`${net.origin}${path}`, etag ? { headers: { "If-None-Match": etag } } : undefined);
    probes.push({ status: res.status, retryAfter: res.headers.get("retry-after"), body: await res.text() });
    if (res.status === 429) break;
  }
  return { found: { run_key: row.run_key, requests: probes.length, statuses: probes.map((p) => p.status).slice(-3), retryAfter: probes.at(-1)?.retryAfter ?? null }, problems: rateLimitProblems(probes) };
}

export default ((ctx) => rateLimit(realNet(ctx.origin))) satisfies VersionCheck;
