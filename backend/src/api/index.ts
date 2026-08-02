// HTTP entrypoint. Uses Bun's native server (Bun.serve) — no framework. It both
// answers the JSON API and serves the static frontend (STATIC_DIR), so a
// single-box deployment needs no reverse proxy.
import { ROUTES } from "@robotmoney/contract";
import { config, assertNoVaultAddressCollision } from "../config.ts";
import { sql } from "../db/client.ts";
import { createComment, listComments } from "./routes/comments.ts";
import { getRegimeSnapshots, getResearchSignal, getVaultEconomics, getWalletBalances, getBuybacks, getTokenMetrics, getWalletSleeves, getAllocation, getEntities, getMarketOverview, getList2, getLeaderboard, getActivityLog, getAgentsDirectory, getAgentDetail, getCoinsList, getVaultsList, getWalletsList, getCoinProfile, getVaultProfile, getWalletProfile } from "./routes/dashboards.ts";
import { createSubmission } from "./routes/submissions.ts";
import { getProjectDetail, getProjects, updateProjectOverview } from "./routes/projects.ts";
import { handleSwarm } from "./routes/swarm.ts";
import { handleAdmin } from "./routes/admin.ts";
import { handleAnalytics } from "./routes/analytics.ts";
import { serveStatic } from "./static.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Config-time double-count guard (issue #84): refuse to boot if a prop-wallet
// address collides with the vault/adapter set (their shares are the OTHER half
// of Total AUM, valued by vault-economics), or if a tracked asset is the rmUSDC
// vault share. Fail-closed at startup — a misconfiguration must never serve a
// live-looking double-counted number.
assertNoVaultAddressCollision();

const server = Bun.serve({
  port: config.apiPort,
  async fetch(req, server) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "OPTIONS") return new Response(null, { status: 204 });

    // Client ip for rate limiting. X-Forwarded-For is client-controlled and only
    // trustworthy behind a known proxy, so we use it ONLY when TRUST_PROXY=1
    // (taking the last hop = the proxy's view of the peer); otherwise the raw
    // socket address. Prevents trivial rate-limit evasion via spoofed XFF.
    const peer = server.requestIP(req)?.address || "";
    let clientIp = peer;
    if (config.trustProxy) {
      const fwd = req.headers.get("x-forwarded-for");
      if (fwd) clientIp = fwd.split(",").map((s) => s.trim()).filter(Boolean).pop() || peer;
    }

    try {
      return await route(req, url, pathname, clientIp);
    } catch (err) {
      // Malformed percent-encoding (decodeURIComponent) → 400; anything else →
      // a sanitized 500 (never leak a stack). No unhandled rejections from fetch.
      if (err instanceof URIError) return json({ error: "bad request" }, 400);
      console.error("api error:", err);
      return json({ error: "internal error" }, 500);
    }
  },
});

async function route(req: Request, url: URL, pathname: string, clientIp: string): Promise<Response> {
    if (pathname === ROUTES.health) {
      let db = "down";
      try { await sql`SELECT 1`; db = "up"; } catch { db = "down"; }
      return json({ status: "ok", env: config.env, db });
    }

    if (pathname === ROUTES.comments.list && req.method === "GET") {
      return json(await listComments(url));
    }

    if (pathname === ROUTES.comments.create && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const r = await createComment(body, clientIp);
      return json(r.body, r.status);
    }

    if (pathname === ROUTES.dashboards.regimeSnapshots && req.method === "GET") {
      return json(await getRegimeSnapshots(url));
    }

    if (pathname === ROUTES.dashboards.vaultEconomics && req.method === "GET") {
      return json(await getVaultEconomics());
    }

    if (pathname === ROUTES.dashboards.walletBalances && req.method === "GET") {
      return json(await getWalletBalances());
    }

    if (pathname === ROUTES.dashboards.buybacks && req.method === "GET") {
      return json(await getBuybacks());
    }

    if (pathname === ROUTES.dashboards.tokenMetrics && req.method === "GET") {
      return json(await getTokenMetrics());
    }

    if (pathname === ROUTES.dashboards.walletSleeves && req.method === "GET") {
      return json(await getWalletSleeves());
    }

    if (pathname === ROUTES.dashboards.allocation && req.method === "GET") {
      return json(await getAllocation());
    }

    if (pathname === ROUTES.dashboards.entities && req.method === "GET") {
      return json(await getEntities());
    }

    if (pathname === ROUTES.dashboards.overview && req.method === "GET") {
      return json(await getMarketOverview());
    }

    if (pathname === ROUTES.dashboards.list2 && req.method === "GET") {
      return json(await getList2());
    }

    if (pathname === ROUTES.dashboards.leaderboard && req.method === "GET") {
      return json(await getLeaderboard());
    }

    // Public /submit intake (issue #393, §5.17) — anonymous, rate-limited per ip.
    if (pathname === ROUTES.dashboards.submissions && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const r = await createSubmission(body, clientIp);
      return json(r.body, r.status);
    }

    if (pathname === ROUTES.dashboards.activity && req.method === "GET") {
      return json(await getActivityLog());
    }

    if (pathname === ROUTES.dashboards.agents && req.method === "GET") {
      return json(await getAgentsDirectory());
    }

    // /agents/:id "Money-agent dossier" (issue #390, §5.8, P3.2). Checked
    // after the exact-match /agents directory route above so it only ever
    // catches a genuine sub-path segment.
    if (pathname.startsWith("/api/dashboards/agents/") && req.method === "GET") {
      const id = decodeURIComponent(pathname.slice("/api/dashboards/agents/".length));
      const detail = await getAgentDetail(id);
      return json(detail ?? { error: "not found" }, detail ? 200 : 404);
    }

    // Analytics-dashboard directory list feeds (issue #386) — a distinct
    // feature area from the treasury-dashboard reads above, sharing only the
    // route namespace.
    if (pathname === ROUTES.dashboards.coins && req.method === "GET") {
      return json(await getCoinsList());
    }

    if (pathname === ROUTES.dashboards.vaults && req.method === "GET") {
      return json(await getVaultsList());
    }

    if (pathname === ROUTES.dashboards.wallets && req.method === "GET") {
      return json(await getWalletsList());
    }

    // Coin/vault/wallet detail dossiers (issue #391, §5.10/§5.12/§5.14). Same
    // startsWith + trailing-segment pattern as research-signals above; a
    // fetch* returning null (not found or a malformed id) is a clean 404.
    // Checked AFTER the exact-match LIST routes directly above so a bare
    // "/api/dashboards/coins" (no trailing segment) never falls through here.
    if (pathname.startsWith("/api/dashboards/coins/") && req.method === "GET") {
      const id = decodeURIComponent(pathname.slice("/api/dashboards/coins/".length));
      const r = await getCoinProfile(id);
      return json(r ?? { error: "not found" }, r ? 200 : 404);
    }

    if (pathname.startsWith("/api/dashboards/vaults/") && req.method === "GET") {
      const id = decodeURIComponent(pathname.slice("/api/dashboards/vaults/".length));
      const r = await getVaultProfile(id);
      return json(r ?? { error: "not found" }, r ? 200 : 404);
    }

    if (pathname.startsWith("/api/dashboards/wallets/") && req.method === "GET") {
      const id = decodeURIComponent(pathname.slice("/api/dashboards/wallets/".length));
      const r = await getWalletProfile(id);
      return json(r ?? { error: "not found" }, r ? 200 : 404);
    }

    if (pathname === ROUTES.projects.list && req.method === "GET") {
      return json(await getProjects());
    }

    // Admin-managed overview write (issue #93). Privileged; no AI enrichment.
    if (pathname.startsWith("/api/projects/admin/") && req.method === "POST") {
      const slug = decodeURIComponent(pathname.slice("/api/projects/admin/".length));
      const r = await updateProjectOverview(req, slug);
      return json(r.body, r.status);
    }

    // ProjectProfile dossier (issue #389, §5.5, P3.1) — GET /api/projects/:slug.
    // Checked after the admin-write prefix above (which is also under
    // /api/projects/) so a POST to .../admin/<slug> never falls through here.
    if (pathname.startsWith("/api/projects/") && req.method === "GET") {
      const slug = decodeURIComponent(pathname.slice("/api/projects/".length));
      const project = await getProjectDetail(slug);
      if (!project) return json({ error: "project not found" }, 404);
      return json({ project });
    }

    if (pathname.startsWith("/api/dashboards/research-signals/") && req.method === "GET") {
      const key = decodeURIComponent(pathname.split("/").pop()!);
      const r = await getResearchSignal(key);
      return json(r ?? { error: "not found" }, r ? 200 : 404);
    }

    // Legacy path redirect (issue #263 pass 2): committee → swarm rename moved
    // every route under this prefix. 308 preserves method + body so an
    // already-onboarded external member agent hardcoding the old path (several
    // of these are POSTs) keeps working through the deprecation window instead
    // of hitting a 404.
    if (pathname.startsWith("/api/committee/")) {
      const target = "/api/swarm/" + pathname.slice("/api/committee/".length) + url.search;
      return new Response(null, { status: 308, headers: { Location: target } });
    }

    if (pathname.startsWith("/api/swarm/")) {
      const r = await handleSwarm(req, url);
      if (r) return json(r.body, r.status);
    }

    // Analytics ingestion boundary (issue #106): the analytics-provider-only
    // typed read/mutation surface updater processes use instead of direct SQL.
    if (pathname.startsWith("/api/analytics/")) {
      const r = await handleAnalytics(req, url);
      if (r) return json(r.body, r.status);
    }

    // Admin task-queue dashboard (read-only over jobs/job_schedules/job_runs).
    if (pathname.startsWith("/api/admin/")) {
      const r = await handleAdmin(req, url);
      if (r) return json(r.body, r.status);
    }

    // Unmatched API path → 404 JSON (never fall through to static).
    if (pathname.startsWith("/api/")) return json({ error: "not found" }, 404);

    const stat = await serveStatic(pathname, config.staticDir);
    if (stat) return stat;
    return new Response("Not found", { status: 404 });
}

console.log(`api listening on :${server.port} (env=${config.env})`);
if (config.staticDir) console.log(`serving static frontend from ${config.staticDir}`);
