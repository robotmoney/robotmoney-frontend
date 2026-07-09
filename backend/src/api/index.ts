// HTTP entrypoint. Uses Bun's native server (Bun.serve) — no framework. It both
// answers the JSON API and serves the static frontend (STATIC_DIR), so a
// single-box deployment needs no reverse proxy.
import { join, normalize } from "node:path";
import { ROUTES } from "@robotmoney/contract";
import { config, assertNoVaultAddressCollision } from "../config.ts";
import { sql } from "../db/client.ts";
import { createComment, listComments } from "./routes/comments.ts";
import { getRegimeSnapshots, getResearchSignal, getVaultEconomics, getWalletBalances } from "./routes/dashboards.ts";
import { getProjects } from "./routes/projects.ts";
import { handleCommittee } from "./routes/committee.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Serve a file from STATIC_DIR; fall back to index.html for client routes so SPA
// deep links and refreshes work. Returns null if static serving is disabled.
async function serveStatic(pathname: string): Promise<Response | null> {
  if (!config.staticDir) return null;
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = join(config.staticDir, safe);
  if (pathname.endsWith("/")) filePath = join(filePath, "index.html");

  const file = Bun.file(filePath);
  if (await file.exists()) return new Response(file);

  // No file extension → treat as a client route, serve the shell.
  if (!safe.split("/").pop()!.includes(".")) {
    const index = Bun.file(join(config.staticDir, "index.html"));
    if (await index.exists()) return new Response(index);
  }
  return null;
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

    if (pathname === ROUTES.projects.list && req.method === "GET") {
      return json(await getProjects());
    }

    if (pathname.startsWith("/api/dashboards/research-signals/") && req.method === "GET") {
      const key = decodeURIComponent(pathname.split("/").pop()!);
      const r = await getResearchSignal(key);
      return json(r ?? { error: "not found" }, r ? 200 : 404);
    }

    if (pathname.startsWith("/api/committee/")) {
      const r = await handleCommittee(req, url);
      if (r) return json(r.body, r.status);
    }

    // Unmatched API path → 404 JSON (never fall through to static).
    if (pathname.startsWith("/api/")) return json({ error: "not found" }, 404);

    const stat = await serveStatic(pathname);
    if (stat) return stat;
    return new Response("Not found", { status: 404 });
}

console.log(`api listening on :${server.port} (env=${config.env})`);
if (config.staticDir) console.log(`serving static frontend from ${config.staticDir}`);
