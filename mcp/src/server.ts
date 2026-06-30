// RM-hosted, member-facing MCP server (docs/ARCHITECTURE.md §9.5). Streamable
// HTTP via the SDK's web-standard transport, served by Bun.serve, with stateful
// sessions (a transport registry keyed by mcp-session-id). Tools wrap the backend
// REST API; the member's bearer token (transport identity) is bound at session
// init and forwarded to the submit endpoint. Members sign client-side; this
// server never holds keys.
//
// Demo auth = bearer token (the §9.5 design upgrades this to OAuth 2.1). The
// valuable part — member-side signing + server-side signature verification — is
// real and unchanged.
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { canonicalizeSubmission } from "@robotmoney/contract";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8787";
const PORT = Number(process.env.MCP_PORT ?? 8788);

const j = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
async function get(path: string) { return (await fetch(`${BACKEND}${path}`)).json(); }

function buildServer(token: string | null) {
  const server = new McpServer({ name: "robotmoney-committee", version: "0.1.0" });

  server.registerTool("get_regime", { description: "Latest regime classification statistics.", inputSchema: {} },
    async () => j((await get(`/api/dashboards/regime-snapshots?range=1`)).latest));
  server.registerTool("get_open_session", { description: "The committee session currently collecting submissions, if any.", inputSchema: {} },
    async () => j(await get(`/api/committee/open-session`)));
  server.registerTool("list_sessions", { description: "All committee sessions.", inputSchema: {} },
    async () => j(await get(`/api/committee/sessions`)));
  server.registerTool("get_brief", { description: "The brief for a session.", inputSchema: { date: z.string(), subject: z.string() } },
    async ({ date, subject }) => j(await get(`/api/committee/brief?date=${encodeURIComponent(date)}&subject=${encodeURIComponent(subject)}`)));
  server.registerTool("get_session", { description: "A committee session with its takes.", inputSchema: { date: z.string(), subject: z.string() } },
    async ({ date, subject }) => j(await get(`/api/committee/sessions/${encodeURIComponent(date)}/${encodeURIComponent(subject)}`)));
  server.registerTool("get_signing_payload",
    { description: "Canonical bytes to sign for a drafted recommendation.",
      inputSchema: { memberId: z.string(), date: z.string(), subjectId: z.string(), nonce: z.string(), stance: z.string(), confidence: z.number(), body: z.string().optional(), memoUrl: z.string().optional() } },
    async (sub) => j({ canonical: canonicalizeSubmission(sub) }));
  server.registerTool("submit_recommendation",
    { description: "Submit a signed recommendation (ed25519 signature over the canonical payload).",
      inputSchema: { memberId: z.string(), date: z.string(), subjectId: z.string(), nonce: z.string(), stance: z.string(), confidence: z.number(), body: z.string().optional(), memoUrl: z.string().optional(), signature: z.string() } },
    async (sub) => {
      const res = await fetch(`${BACKEND}/api/committee/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(sub),
      });
      return j(await res.json());
    });

  return server;
}

const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
const lastSeen = new Map<string, number>(); // session id → last activity (idle sweep)
const MAX_SESSIONS = 500; // cap concurrent sessions (DoS bound)
const IDLE_MS = 10 * 60_000; // evict sessions idle longer than this

// Periodically close idle sessions so the maps + McpServer instances can't grow
// unboundedly (an unauthenticated client could otherwise open sessions forever).
setInterval(() => {
  const cutoff = Date.now() - IDLE_MS;
  for (const [id, ts] of lastSeen) {
    if (ts >= cutoff) continue;
    try { (transports.get(id) as any)?.close?.(); } catch { /* ignore */ }
    transports.delete(id); sessionTokenHash.delete(id); lastSeen.delete(id);
  }
}, 60_000);

// Per-session hash of the bearer token bound at init. Every follow-up request to
// an existing session must re-present the SAME token; otherwise a leaked/guessed
// mcp-session-id would let an attacker ride a victim's bound identity (the SDK
// routes a known session straight to its transport, ignoring Authorization).
const sessionTokenHash = new Map<string, string>();
const bearerOf = (req: Request) => {
  const auth = req.headers.get("Authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
};
const tokenHash = (token: string | null) => createHash("sha256").update(token ?? "").digest("hex");
const unauthorized = (msg: string) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: msg }, id: null }), {
    status: 401, headers: { "Content-Type": "application/json" },
  });

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ status: "ok", backend: BACKEND });
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });

    const sid = req.headers.get("mcp-session-id");
    if (sid && transports.has(sid)) {
      // Re-validate the bearer on EVERY request to a bound session.
      if (tokenHash(bearerOf(req)) !== sessionTokenHash.get(sid))
        return unauthorized("bearer token does not match the session it was bound to");
      lastSeen.set(sid, Date.now());
      return transports.get(sid)!.handleRequest(req);
    }

    // New session (initialize). Require a real bearer — no anonymous sessions
    // (else a missing token would bind sha256("") and anyone with no token could
    // ride that bucket). Cap concurrent sessions.
    const token = bearerOf(req);
    if (!token) return unauthorized("a bearer token is required to start an MCP session");
    if (transports.size >= MAX_SESSIONS)
      return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32002, message: "server at session capacity" }, id: null }),
        { status: 429, headers: { "Content-Type": "application/json" } });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => { transports.set(id, transport); sessionTokenHash.set(id, tokenHash(token)); lastSeen.set(id, Date.now()); },
      onsessionclosed: (id) => { transports.delete(id); sessionTokenHash.delete(id); lastSeen.delete(id); },
    });
    const server = buildServer(token);
    await server.connect(transport);
    return transport.handleRequest(req);
  },
});

console.log(`MCP server (committee) listening on :${PORT}/mcp  → backend ${BACKEND}`);
