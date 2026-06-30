// RM-hosted, member-facing MCP server (docs/ARCHITECTURE.md §9.5). Streamable
// HTTP via the SDK's web-standard transport, served by Bun.serve, with stateful
// sessions (a transport registry keyed by mcp-session-id). Tools wrap the backend
// REST API; the member's bearer token (transport identity) is bound at session
// init and forwarded to the submit endpoint. Members sign client-side; this
// server never holds keys.
//
// Auth: OAuth 2.1 client_credentials grant for machine-to-machine (the §9.5
// design). The MCP server acts as the authorization server: it exposes a token
// endpoint that validates member credentials against the backend and issues
// short-lived access tokens. Legacy direct bearer tokens also work for backward
// compatibility. The hot path (per-request validation of an existing session)
// is a single SHA-256 hash comparison — no HTTP round trips.
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { canonicalizeSubmission } from "@robotmoney/contract";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8787";
const PORT = Number(process.env.MCP_PORT ?? 8788);
// OAuth token lifetimes (in seconds).
const ACCESS_TOKEN_TTL = 3600; // 1 hour
const REFRESH_TOKEN_TTL = 86400; // 24 hours

const j = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
async function get(path: string) { return (await fetch(`${BACKEND}${path}`)).json(); }

interface AccessTokenEntry {
  memberId: string;
  memberToken: string; // the original backend bearer token, forwarded on tool calls
  expiresAt: number;
}
interface RefreshTokenEntry {
  memberId: string;
  memberToken: string;
  accessToken: string; // the access token this refresh token was issued with
  expiresAt: number;
}

const accessTokens = new Map<string, AccessTokenEntry>();
const refreshTokens = new Map<string, RefreshTokenEntry>();

function buildServer(memberId: string, memberToken: string | null) {
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
        headers: { "Content-Type": "application/json", ...(memberToken ? { Authorization: `Bearer ${memberToken}` } : {}) },
        body: JSON.stringify(sub),
      });
      return j(await res.json());
    });
  server.registerTool("post_memo",
    { description: "Publish a long-form analysis memo for a session. Returns a URL that can be passed as memoUrl in submit_recommendation.",
      inputSchema: { sessionId: z.number(), title: z.string().optional(), body: z.string() } },
    async (input) => {
      const res = await fetch(`${BACKEND}/api/committee/memos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(memberToken ? { Authorization: `Bearer ${memberToken}` } : {}) },
        body: JSON.stringify(input),
      });
      return j(await res.json());
    });

  // ── Optional RM analysis helpers ──────────────────────────────────────
  server.registerTool("classify_regime",
    { description: "Classify a composite regime score into a regime label and return the breakdown. If no score is given, uses the latest regime snapshot.",
      inputSchema: { composite: z.number().optional() } },
    async ({ composite }) => {
      const regime = composite !== undefined
        ? { composite, macroRegime: null, onchainRegime: null }
        : (await get(`/api/dashboards/regime-snapshots?range=1`)).latest ?? {};
      const c = Number(regime.composite ?? 0.5);
      const classification = c >= 0.67 ? "risk_on" : c >= 0.45 ? "neutral" : "risk_off";
      const explanation = c >= 0.8 ? "Strong risk-on: broad-based expansion across macro and on-chain panels."
        : c >= 0.67 ? "Risk-on: majority of indicators favor risk assets."
        : c >= 0.55 ? "Lean risk-on: some caution warranted but overall constructive."
        : c >= 0.45 ? "Neutral: mixed signals — no clear directional bias."
        : c >= 0.33 ? "Lean risk-off: early warning flags in select panels."
        : "Risk-off: elevated macro or on-chain stress.";
      return j({ composite: c, classification, explanation, macroRegime: regime.macroRegime, onchainRegime: regime.onchainRegime });
    });
  server.registerTool("concentration_metrics",
    { description: "Compute portfolio concentration metrics (Herfindahl-Hirschman Index, top-3 weight) from the latest subject snapshot.",
      inputSchema: { subjectId: z.string() } },
    async ({ subjectId }) => {
      const snapshots: any = await get(`/api/committee/subjects/${encodeURIComponent(subjectId)}/snapshots`);
      const positions = snapshots?.snapshots?.[0]?.positions;
      if (!positions || !Array.isArray(positions) || positions.length === 0)
        return j({ error: "no positions found for subject" });
      const weights = positions.map((p: any) => Number(p.weight ?? 0));
      const total = weights.reduce((a: number, b: number) => a + b, 0);
      const shares = total > 0 ? weights.map((w: number) => w / total) : weights.map(() => 1 / weights.length);
      const hhi = Number((shares.reduce((a: number, s: number) => a + s * s, 0) * 10000).toFixed(1));
      const sorted = [...shares].sort((a, b) => b - a);
      const top3 = sorted.slice(0, 3).reduce((a, s) => a + s, 0);
      const n = shares.length;
      const effectiveN = hhi > 0 ? Number((10000 / hhi).toFixed(1)) : n;
      const read = hhi >= 2500 ? "highly concentrated" : hhi >= 1500 ? "moderately concentrated" : "well diversified";
      return j({
        subjectId, positionCount: n, herfindahlHirschmanIndex: hhi,
        top3ConcentrationPct: Number((top3 * 100).toFixed(1)),
        effectiveN,
        read,
      });
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
    transports.delete(id); sessionBinding.delete(id); lastSeen.delete(id);
  }
}, 60_000);

// Per-session binding: maps session-id → { memberId, memberToken, tokenHash }.
// TokenHash is the SHA-256 of the presented bearer (OAuth access token or legacy
// token), checked on every follow-up request to the same session.
interface SessionBinding {
  memberId: string;
  memberToken: string | null;
  tokenHash: string;
}
const sessionBinding = new Map<string, SessionBinding>();

const bearerOf = (req: Request) => {
  const auth = req.headers.get("Authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
};
const tokenHash = (token: string | null) => createHash("sha256").update(token ?? "").digest("hex");
const unauthorized = (msg: string) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: msg }, id: null }), {
    status: 401, headers: { "Content-Type": "application/json" },
  });

// ── OAuth endpoint helpers ──────────────────────────────────────────────────
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json" },
  });
}

function oauthError(error: string, description?: string, status = 400): Response {
  return jsonResponse({ error, error_description: description }, status);
}

function isExpired(entry: { expiresAt: number }): boolean {
  return Date.now() > entry.expiresAt;
}

async function validateMemberCredentials(memberId: string, clientSecret: string): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND}/api/committee/verify-token`, {
      headers: { Authorization: `Bearer ${clientSecret}` },
    });
    if (!res.ok) return false;
    const body = await res.json() as { memberId?: string };
    return body.memberId === memberId;
  } catch {
    return false;
  }
}

// Resolve a presented bearer to { memberId, memberToken }.
// Checks the OAuth access token store first, then falls back to direct legacy
// token (validated lazily by downstream backend calls).
function resolveBearer(token: string): { memberId: string; memberToken: string | null } | null {
  // 1. OAuth access token
  const entry = accessTokens.get(token);
  if (entry && !isExpired(entry)) {
    return { memberId: entry.memberId, memberToken: entry.memberToken };
  }
  if (entry) accessTokens.delete(token); // expired — clean up

  // 2. Legacy token — we can't validate it locally (only the backend knows the
  // hash). Return a synthetic memberId based on token hash so the session can
  // bind; actual authorization is enforced by the downstream backend calls.
  // This maintains backward compatibility with non-OAuth clients.
  return { memberId: `token:${tokenHash(token)}`, memberToken: token };
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // ── Health ─────────────────────────────────────────────────────────
    if (url.pathname === "/health") return jsonResponse({ status: "ok", backend: BACKEND });

    // ── OAuth 2.1 metadata (RFC 8414) ──────────────────────────────────
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return jsonResponse({
        issuer: `http://localhost:${PORT}`,
        token_endpoint: `http://localhost:${PORT}/mcp/oauth/token`,
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        response_types_supported: ["token"],
        grant_types_supported: ["client_credentials", "refresh_token"],
        revocation_endpoint: `http://localhost:${PORT}/mcp/oauth/revoke`,
      });
    }

    // ── OAuth token endpoint (client_credentials) ──────────────────────
    if (url.pathname === "/mcp/oauth/token" && req.method === "POST") {
      const body = new URLSearchParams(await req.text());
      const grantType = body.get("grant_type");

      if (grantType === "client_credentials") {
        // Support both POST body and Basic auth for client credentials.
        let clientId = body.get("client_id");
        let clientSecret = body.get("client_secret");
        const authHeader = req.headers.get("Authorization") ?? "";
        if (authHeader.startsWith("Basic ")) {
          const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
          const colon = decoded.indexOf(":");
          if (colon >= 0) { clientId = decoded.slice(0, colon); clientSecret = decoded.slice(colon + 1); }
        }
        if (!clientId || !clientSecret) return oauthError("invalid_request", "client_id and client_secret required");

        const valid = await validateMemberCredentials(clientId, clientSecret);
        if (!valid) return oauthError("invalid_client", "member credentials rejected", 401);

        const accessToken = crypto.randomUUID();
        const refreshToken = crypto.randomUUID();
        const now = Date.now();
        accessTokens.set(accessToken, { memberId: clientId, memberToken: clientSecret, expiresAt: now + ACCESS_TOKEN_TTL * 1000 });
        refreshTokens.set(refreshToken, { memberId: clientId, memberToken: clientSecret, accessToken, expiresAt: now + REFRESH_TOKEN_TTL * 1000 });
        return jsonResponse({
          access_token: accessToken,
          token_type: "bearer",
          expires_in: ACCESS_TOKEN_TTL,
          refresh_token: refreshToken,
        });
      }

      if (grantType === "refresh_token") {
        const rt = body.get("refresh_token");
        if (!rt) return oauthError("invalid_request", "refresh_token required");
        const stored = refreshTokens.get(rt);
        if (!stored || isExpired(stored)) {
          if (stored) refreshTokens.delete(rt);
          return oauthError("invalid_grant", "refresh token expired or invalid", 401);
        }
        const newAccessToken = crypto.randomUUID();
        const newRefreshToken = crypto.randomUUID();
        const now = Date.now();
        accessTokens.set(newAccessToken, { memberId: stored.memberId, memberToken: stored.memberToken, expiresAt: now + ACCESS_TOKEN_TTL * 1000 });
        refreshTokens.set(newRefreshToken, { memberId: stored.memberId, memberToken: stored.memberToken, accessToken: newAccessToken, expiresAt: now + REFRESH_TOKEN_TTL * 1000 });
        refreshTokens.delete(rt);
        return jsonResponse({
          access_token: newAccessToken,
          token_type: "bearer",
          expires_in: ACCESS_TOKEN_TTL,
          refresh_token: newRefreshToken,
        });
      }

      return oauthError("unsupported_grant_type", `grant_type '${grantType}' not supported`);
    }

    // ── OAuth token revocation (RFC 7009) ───────────────────────────────
    if (url.pathname === "/mcp/oauth/revoke" && req.method === "POST") {
      const body = new URLSearchParams(await req.text());
      const token = body.get("token");
      if (token) {
        accessTokens.delete(token);
        // Also delete any refresh token pointing to it
        for (const [rt, entry] of refreshTokens) {
          if (entry.accessToken === token) refreshTokens.delete(rt);
        }
      }
      // RFC 7009: always return 200 (don't reveal if token was valid)
      return jsonResponse({});
    }

    // ── MCP protocol endpoint ──────────────────────────────────────────
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });

    const sid = req.headers.get("mcp-session-id");
    if (sid && transports.has(sid)) {
      // Re-validate the bearer on EVERY request to a bound session.
      const presented = bearerOf(req) ?? "";
      if (tokenHash(presented) !== sessionBinding.get(sid)?.tokenHash)
        return unauthorized("bearer token does not match the session it was bound to");
      lastSeen.set(sid, Date.now());
      return transports.get(sid)!.handleRequest(req);
    }

    // New session (initialize). Require a real bearer — no anonymous sessions.
    const rawToken = bearerOf(req);
    if (!rawToken) return unauthorized("a bearer token is required to start an MCP session");
    if (transports.size >= MAX_SESSIONS)
      return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32002, message: "server at session capacity" }, id: null }),
        { status: 429, headers: { "Content-Type": "application/json" } });

    // Resolve the bearer token to { memberId, memberToken }.
    const resolved = resolveBearer(rawToken);
    if (!resolved) return unauthorized("invalid bearer token");

    const t = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        transports.set(id, t);
        sessionBinding.set(id, { memberId: resolved.memberId, memberToken: resolved.memberToken, tokenHash: tokenHash(rawToken) });
        lastSeen.set(id, Date.now());
      },
      onsessionclosed: (id) => { transports.delete(id); sessionBinding.delete(id); lastSeen.delete(id); },
    });
    const server = buildServer(resolved.memberId, resolved.memberToken);
    await server.connect(t);
    return t.handleRequest(req);
  },
});

console.log(`MCP server (committee) listening on :${PORT}/mcp  → backend ${BACKEND}`);
