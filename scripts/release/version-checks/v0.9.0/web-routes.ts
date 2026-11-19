// Q38-web-routes/C26-web-routes (web serving P1 1636): the website-server holds the route and header
// contract of web-serving-architecture.md §3.3 against the real site, asked on the container's own
// loopback port on the target host (no Cloudflare in between, so its cache and compression play no part).
// Read-only: GETs.
//
// The contract is the server's, not nginx's or Caddy's: scripts/tests/support/website-routes-table.ts holds
// it for a fixture site, and both servers pass it in CI. This check asks the rows that hold for the real
// site's content (the echo and api-down rows need a fixture api; CI covers them):
//   - `/` and every sitemap route answer 200 with the security headers and Cache-Control no-cache;
//   - `/version.json` and `/sitemap.xml` answer 200 with the asset Cache-Control;
//   - an unknown client route falls back to the shell: 200, a page's headers;
//   - a missing asset (a path with a file extension) answers 404, never the shell;
//   - the server does not compress (`Content-Encoding` absent, though the request accepts gzip);
//   - `/api/version`, `/health`, `/version` and `/api/status/maintenance` are proxied to the api: 200.
import { headerProblems } from "../../web-release-lib.ts";
import type { VersionCheck } from "../../version-check.ts";
import { loopbackPort, websiteContainers } from "./_web.ts";

/** A path the site never serves, so the fallback and missing-asset rows hit no real file. */
export const PROBE_SLUG = "rm-v090-route-check";

export interface Answer {
  readonly path: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type RowKind = "page" | "asset" | "fallback" | "missing" | "proxy";
export interface Row { readonly path: string; readonly kind: RowKind }

/** PURE. The rows to ask: the fixed ones, then every sitemap route as a page. */
export function routeRows(sitemapRoutes: readonly string[]): Row[] {
  const fixed: Row[] = [
    { path: "/", kind: "page" },
    { path: "/version.json", kind: "asset" },
    { path: "/sitemap.xml", kind: "asset" },
    { path: `/swarm/members/${PROBE_SLUG}`, kind: "fallback" },
    { path: `/assets/js/app/${PROBE_SLUG}-missing.js`, kind: "missing" },
    { path: `/${PROBE_SLUG}-missing.png`, kind: "missing" },
    { path: "/api/version", kind: "proxy" },
    { path: "/health", kind: "proxy" },
    { path: "/version", kind: "proxy" },
    { path: "/api/status/maintenance", kind: "proxy" },
  ];
  const seen = new Set(fixed.map((r) => r.path));
  return [...fixed, ...sitemapRoutes.filter((p) => !seen.has(p) && seen.add(p)).map((path) => ({ path, kind: "page" as const }))];
}

/** PURE. The pathnames a sitemap lists (its <loc> URLs are absolute, on the public origin). */
export function sitemapPaths(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].flatMap((m) => {
    try {
      const u = new URL(m[1]!, "https://placeholder.invalid");
      return [`${u.pathname}${u.search}`];
    } catch {
      return [];
    }
  });
}

/** PURE. Where the answers break the contract; empty when every row holds. `shellBody` is the fallback row's body. */
export function routeProblems(rows: readonly Row[], answers: ReadonlyMap<string, Answer>): string[] {
  const out: string[] = [];
  const fallback = rows.find((r) => r.kind === "fallback");
  const shell = fallback ? answers.get(fallback.path)?.body : undefined;
  for (const row of rows) {
    const a = answers.get(row.path);
    if (a === undefined) { out.push(`${row.path}: not asked`); continue; }
    const want = row.kind === "missing" ? 404 : 200;
    if (a.status !== want) { out.push(`${row.path}: answered ${a.status}, not ${want}`); continue; }
    if (row.kind === "page" || row.kind === "fallback" || row.kind === "asset") out.push(...headerProblems(row.path, a.headers));
    if (row.kind !== "proxy" && a.headers["content-encoding"] !== undefined) out.push(`${row.path}: the server compressed the answer (Content-Encoding ${a.headers["content-encoding"]}); compression is the edge's`);
    if (row.kind === "missing" && shell !== undefined && shell !== "" && a.body === shell) out.push(`${row.path}: a missing asset answered with the shell`);
  }
  if (rows.filter((r) => r.kind === "page").length < 2) out.push("the sitemap listed no route besides /");
  return out;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Ask every row of the contract at `base` (the container's loopback origin). */
export async function askRoutes(base: string, fetcher: Fetcher): Promise<{ rows: Row[]; answers: Map<string, Answer> }> {
  const ask = async (path: string): Promise<Answer> => {
    const res = await fetcher(`${base}${path}`, { headers: { "Accept-Encoding": "gzip, deflate, br" }, redirect: "manual" });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    // Bun decodes a compressed body itself; the header still says whether the server encoded it.
    return { path, status: res.status, headers, body: await res.text() };
  };
  const sitemap = await ask("/sitemap.xml");
  const rows = routeRows(sitemap.status === 200 ? sitemapPaths(sitemap.body) : []);
  const answers = new Map<string, Answer>([["/sitemap.xml", sitemap]]);
  for (const r of rows) if (!answers.has(r.path)) answers.set(r.path, await ask(r.path));
  return { rows, answers };
}

export default (async (ctx) => {
  const { running } = websiteContainers(ctx);
  if (running.length !== 1) return { found: { running }, problems: [`${running.length} website-server containers run for the instance, not one`] };
  const port = loopbackPort(ctx, running[0]!, 8080);
  if (port === null) return { found: { container: running[0] }, problems: ["the website-server publishes no host port for 8080"] };
  const base = `http://127.0.0.1:${port}`;
  const { rows, answers } = await askRoutes(base, (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }));
  return {
    found: { base, rows: rows.length, statuses: Object.fromEntries([...answers.values()].map((a) => [a.path, a.status])) },
    problems: routeProblems(rows, answers),
  };
}) satisfies VersionCheck;
