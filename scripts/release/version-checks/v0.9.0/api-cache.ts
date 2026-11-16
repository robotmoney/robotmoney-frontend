// Q42-api-cache/C30-api-cache (web serving P6 1635; R12, web-serving-architecture.md §3.4): the api owns
// the public analytics cache, and the web server stores no api response. Read-only: three GETs of one
// public list URL and a read of the web server's config, on the target host.
//
// WHAT IT REQUIRES:
//   - asked DIRECTLY (the api container's loopback port, no web server in between), a public analytics list
//     URL nobody asked before answers 200 with X-Cache-Status MISS, and the same URL asked again answers
//     200 with X-Cache-Status HIT: the api's own store answered. v0.8.0's api sends no X-Cache-Status;
//     nginx's proxy_cache sent it;
//   - asked a third time THROUGH the website-server's loopback port, the same URL answers 200 with
//     X-Cache-Status HIT: the web server passes the api's answer through and adds no status of its own;
//   - X-Cache-Status is only ever HIT or MISS (nginx's cache also said EXPIRED, REVALIDATED, UPDATING, BYPASS);
//   - the web server's config holds no response cache: nginx's `nginx -T` names no proxy_cache, and a site
//     image's Caddyfile holds no cache directive.
// The URL carries a one-off query value the route ignores, so the store has never seen it. Each GET spends
// one of this client's public tokens (100 a minute).
import type { VersionCheck } from "../../version-check.ts";
import { linesOf, loopbackPort, websiteContainers } from "./_web.ts";
import { PUBLIC_API } from "../../public-analytics-read.ts";

export interface CacheAnswer {
  readonly via: "api" | "website-server";
  readonly status: number;
  readonly cacheStatus: string | null;
}

/** PURE. The list URL the check asks: a public list with a query value the route ignores. */
export const probePath = (stamp: string): string => `${PUBLIC_API}/reports?limit=1&rm-v090-cache=${stamp}`;

/** PURE. Why the answers do not show the api's own store behind a web server that stores nothing; empty when they do. */
export function apiCacheProblems(answers: readonly CacheAnswer[], serverConfig: { kind: "nginx" | "caddy"; text: string } | null): string[] {
  const out: string[] = [];
  const [first, second, third] = answers;
  if (first === undefined || second === undefined || third === undefined) return [`${answers.length} of the 3 requests were asked`];
  for (const a of answers) {
    if (a.status !== 200) out.push(`a request via ${a.via} answered ${a.status}, not 200`);
    if (a.cacheStatus !== null && a.cacheStatus !== "HIT" && a.cacheStatus !== "MISS") out.push(`via ${a.via}: X-Cache-Status ${a.cacheStatus} is not the api's (HIT or MISS only)`);
  }
  if (first.cacheStatus !== "MISS") out.push(`the api's first answer to a new URL says X-Cache-Status ${first.cacheStatus ?? "(absent)"}, not MISS: the api does not run the answer store`);
  if (second.cacheStatus !== "HIT") out.push(`the api's second answer to the same URL says X-Cache-Status ${second.cacheStatus ?? "(absent)"}, not HIT: the api's store did not keep it`);
  if (third.cacheStatus !== "HIT") out.push(`through the website-server the same URL says X-Cache-Status ${third.cacheStatus ?? "(absent)"}, not the api's HIT`);
  if (serverConfig === null) out.push("the website-server's config could not be read");
  else if (serverConfig.kind === "nginx" && /^\s*proxy_cache/m.test(serverConfig.text)) out.push(`nginx's config still stores api answers: ${linesOf(serverConfig.text).filter((l) => /^proxy_cache/.test(l)).slice(0, 2).join("; ")}`);
  else if (serverConfig.kind === "caddy" && /^\s*cache\b/m.test(serverConfig.text)) out.push("the Caddyfile holds a cache directive");
  return out;
}

export default (async (ctx) => {
  const project = ctx.project();
  const api = linesOf(ctx.docker(["ps", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.service=api", "--format", "{{.ID}}"]).stdout);
  const { running: web } = websiteContainers(ctx);
  if (api.length !== 1 || web.length !== 1) return { found: { api, web }, problems: [`expected one api and one website-server, found ${api.length} and ${web.length}`] };
  const apiPort = loopbackPort(ctx, api[0]!, 8787);
  const webPort = loopbackPort(ctx, web[0]!, 8080);
  if (apiPort === null || webPort === null) return { found: { apiPort, webPort }, problems: ["the api or the website-server publishes no loopback port"] };
  const path = probePath(`${Date.now()}-${process.pid}`);
  const ask = async (via: CacheAnswer["via"], port: number): Promise<CacheAnswer> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(30_000) });
    await res.arrayBuffer();
    return { via, status: res.status, cacheStatus: res.headers.get("x-cache-status") };
  };
  const answers = [await ask("api", apiPort), await ask("api", apiPort), await ask("website-server", webPort)];
  const isNginx = ctx.docker(["exec", web[0]!, "sh", "-c", "command -v nginx"]).code === 0;
  const conf = isNginx ? ctx.docker(["exec", web[0]!, "nginx", "-T"]) : ctx.docker(["exec", web[0]!, "cat", "/etc/caddy/Caddyfile"]);
  const serverConfig = conf.code === 0 ? { kind: isNginx ? ("nginx" as const) : ("caddy" as const), text: conf.stdout } : null;
  return {
    found: { path, answers, server: serverConfig?.kind ?? null },
    problems: apiCacheProblems(answers, serverConfig),
  };
}) satisfies VersionCheck;
