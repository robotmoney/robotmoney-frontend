// Q41-public-surface/C29-public-surface (PR 1546, issue 1434; PR 1549, issue 1495): two changes a
// visitor or a seat sees on the public origin, both read-only.
//
//   1. The site's Content-Security-Policy lets the early-access form reach Google Apps Script and
//      Cloudflare Turnstile (PR 1546). The header comes from website-server/nginx.conf, which the
//      rolling boot never rebuilds: it copies the new file into the running website-server and
//      reloads nginx (scripts/stack/stack.ts WEBSITE_NGINX_CONF). The header on `/` is the proof
//      the reload carried the new file.
//   2. A seat can read its own health (PR 1549): GET /api/swarm/participants/health with no bearer
//      answers 401 (the route authenticates first); an api built before 1549 does not know the path.
//   3. The site the rolling boot switched to carries the five site PRs merged on 2026-11-02 (1543,
//      1512, 1466, 1428, 1497). Each is proved by a text the PR added to one served file and that
//      v0.7.0's copy of the file does not hold. Static files answer a plain 404 when missing
//      (nginx.conf's asset location), and the changelog fragment is read for an entry title, so
//      the SPA shell fallback can never pass for a page.
import type { VersionCheck } from "../../version-check.ts";

/** One served file per site PR, and the text the PR added to it. */
export const SITE_MARKERS: readonly { pr: number; path: string; text: string }[] = [
  { pr: 1543, path: "/assets/js/app/lib/site-nav.js", text: '"/news"' },
  { pr: 1512, path: "/assets/js/app/routes.js", text: '"/model-portfolio"' },
  { pr: 1466, path: "/views/changelog.html", text: "Gold joins the model portfolio" },
  { pr: 1428, path: "/assets/js/app/routes.js", text: "EARLY_ACCESS_VIEW" },
  { pr: 1497, path: "/assets/js/app/lib/session-summary.js", text: "hard_assets" },
];

/** PURE. Why one served file does not carry its PR's text; empty when it does. */
export function siteMarkerProblems(marker: { pr: number; path: string; text: string }, status: number, body: string): string[] {
  if (status !== 200) return [`GET ${marker.path} answered ${status}, not 200 (PR ${marker.pr})`];
  if (!body.includes(marker.text)) return [`GET ${marker.path} does not carry ${JSON.stringify(marker.text)}: the site before PR ${marker.pr} is still served`];
  return [];
}

export const HEALTH_ROUTE = "/api/swarm/participants/health";
/** The CSP directives PR 1546 adds, each with the source it must name. */
export const CSP_SOURCES: readonly { directive: string; source: string }[] = [
  { directive: "script-src", source: "https://challenges.cloudflare.com" },
  { directive: "frame-src", source: "https://challenges.cloudflare.com" },
  { directive: "connect-src", source: "https://script.google.com" },
  { directive: "connect-src", source: "https://script.googleusercontent.com" },
];

/** PURE. Why the site's CSP does not carry PR 1546's sources; empty when it does. */
export function cspProblems(status: number, csp: string | null): string[] {
  if (status !== 200) return [`GET / answered ${status}, not 200`];
  if (csp === null) return ["GET / carries no Content-Security-Policy header"];
  const directives = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  const out: string[] = [];
  for (const { directive, source } of CSP_SOURCES) {
    if (!(directives.get(directive) ?? []).includes(source)) out.push(`the site's CSP ${directive} does not name ${source} (the nginx.conf before PR 1546 is still served): ${csp}`);
  }
  return out;
}

/** PURE. Why the health route's answer with no credential does not show the route is there; empty when it does. */
export function healthProblems(status: number, body: string): string[] {
  if (status === 401) return [];
  return [`GET ${HEALTH_ROUTE} with no credential answered ${status}, not 401 (an api before PR 1549 has no seat health route): ${body.slice(0, 200)}`];
}

export default (async (ctx) => {
  const res = await fetch(`${ctx.origin}/`, { signal: AbortSignal.timeout(15_000) });
  const csp = res.headers.get("content-security-policy");
  await res.arrayBuffer();
  const health = await ctx.http(HEALTH_ROUTE);
  const site: { pr: number; path: string; status: number }[] = [];
  const siteProblems: string[] = [];
  for (const marker of SITE_MARKERS) {
    const r = await fetch(`${ctx.origin}${marker.path}`, { signal: AbortSignal.timeout(15_000) });
    const body = await r.text();
    site.push({ pr: marker.pr, path: marker.path, status: r.status });
    siteProblems.push(...siteMarkerProblems(marker, r.status, body));
  }
  return {
    found: { siteStatus: res.status, csp, healthStatus: health.status, site },
    problems: [...cspProblems(res.status, csp), ...healthProblems(health.status, health.text), ...siteProblems],
  };
}) satisfies VersionCheck;
