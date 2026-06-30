// HTTP entrypoint. Uses Bun's native server (Bun.serve) — no framework. It both
// answers the JSON API and serves the static frontend (STATIC_DIR), so a
// single-box deployment needs no reverse proxy.
import { join, normalize } from "node:path";
import { ROUTES } from "@robotmoney/contract";
import { config } from "../config.ts";
import { sql } from "../db/client.ts";
import { listComments } from "./routes/comments.ts";
import { getRegimeSnapshots, getResearchSignal } from "./routes/dashboards.ts";
import { handleCommittee } from "./routes/committee.ts";

function corsHeaders(origin: string | null): Record<string, string> {
  if (origin && config.corsOrigins.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
  }
  return {};
}

function json(data: unknown, origin: string | null, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
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

const server = Bun.serve({
  port: config.apiPort,
  async fetch(req) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin");
    const { pathname } = url;

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (pathname === ROUTES.health) {
      let db = "down";
      try { await sql`SELECT 1`; db = "up"; } catch { db = "down"; }
      return json({ status: "ok", env: config.env, db }, origin);
    }

    if (pathname === ROUTES.comments.list && req.method === "GET") {
      return json(await listComments(url), origin);
    }

    if (pathname === ROUTES.dashboards.regimeSnapshots && req.method === "GET") {
      return json(await getRegimeSnapshots(url), origin);
    }

    if (pathname.startsWith("/api/dashboards/research-signals/") && req.method === "GET") {
      const key = decodeURIComponent(pathname.split("/").pop()!);
      const r = await getResearchSignal(key);
      return json(r ?? { error: "not found" }, origin, r ? 200 : 404);
    }

    if (pathname.startsWith("/api/committee/")) {
      const r = await handleCommittee(req, url);
      if (r) return json(r.body, origin, r.status);
    }

    // Unmatched API path → 404 JSON (never fall through to static).
    if (pathname.startsWith("/api/")) return json({ error: "not found" }, origin, 404);

    const stat = await serveStatic(pathname);
    if (stat) return stat;
    return new Response("Not found", { status: 404 });
  },
});

console.log(`api listening on :${server.port} (env=${config.env})`);
if (config.staticDir) console.log(`serving static frontend from ${config.staticDir}`);
