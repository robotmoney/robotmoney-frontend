// RM-hosted, member-facing MCP server (docs/architecture.md §9.5). Streamable
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
// compatibility. OAuth access tokens are checked locally on every request;
// legacy member tokens are revalidated by the backend.
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  APPLY_HOW_TO_STEPS,
  canonicalizeApplication,
  canonicalizeSubmission,
  classifyRegime,
  COMMITTEE_ONBOARDING_SKILL_URL,
  path as routePath,
  ROUTES,
} from "@robotmoney/contract";
import { TokenStore } from "./token-store.ts";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8787";
const PORT = Number(process.env.MCP_PORT ?? 8788);
// OAuth token lifetimes (in seconds).
const ACCESS_TOKEN_TTL = 3600; // 1 hour
const REFRESH_TOKEN_TTL = 86400; // 24 hours

const j = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
async function get(path: string) { return (await fetch(`${BACKEND}${path}`)).json(); }

const tokenStore = new TokenStore(ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL);

function buildServer(memberId: string, memberToken: string) {
  const server = new McpServer({ name: "robotmoney-committee", version: "0.1.0" });
  const weightsSchema = z.array(z.object({ bucket: z.string(), weight: z.number().nonnegative() })).optional();

  server.registerTool("get_regime", { description: "Latest regime classification statistics.", inputSchema: {} },
    async () => j((await get(`${ROUTES.dashboards.regimeSnapshots}?range=1`)).latest));
  server.registerTool("get_open_session", { description: "The committee session currently collecting submissions, if any.", inputSchema: {} },
    async () => j(await get(ROUTES.committee.openSession)));
  server.registerTool("list_sessions", { description: "All committee sessions.", inputSchema: {} },
    async () => j(await get(ROUTES.committee.sessions)));
  server.registerTool("get_brief", { description: "The brief for a session.", inputSchema: { date: z.string(), subject: z.string() } },
    async ({ date, subject }) => j(await get(`${ROUTES.committee.brief}?date=${encodeURIComponent(date)}&subject=${encodeURIComponent(subject)}`)));
  server.registerTool("get_subject_snapshot", { description: "Latest snapshot (positions, weights, total value) for a portfolio subject.", inputSchema: { subjectId: z.string() } },
    async ({ subjectId }) => j({ ...(await get(routePath(ROUTES.committee.subjectSnapshots, { id: subjectId }))) }));
  server.registerTool("get_session", { description: "A committee session with its takes.", inputSchema: { date: z.string(), subject: z.string() } },
    async ({ date, subject }) => j(await get(routePath(ROUTES.committee.session, { date, subject }))));
  server.registerTool("get_signing_payload",
    { description: "Canonical bytes to sign for a drafted recommendation.",
      inputSchema: { memberId: z.string(), date: z.string(), subjectId: z.string(), nonce: z.string(), stance: z.string(), confidence: z.number(), body: z.string().optional(), memoUrl: z.string().optional(), weights: weightsSchema } },
    async (sub) => j({ canonical: canonicalizeSubmission(sub) }));
  server.registerTool("submit_recommendation",
    { description: "Submit a signed recommendation (ed25519 signature over the canonical payload).",
      inputSchema: { memberId: z.string(), date: z.string(), subjectId: z.string(), nonce: z.string(), stance: z.string(), confidence: z.number(), body: z.string().optional(), memoUrl: z.string().optional(), weights: weightsSchema, signature: z.string() } },
    async (sub) => {
      const res = await fetch(`${BACKEND}${ROUTES.committee.submit}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(memberToken ? { Authorization: `Bearer ${memberToken}` } : {}) },
        body: JSON.stringify(sub),
      });
      return j(await res.json());
    });
  server.registerTool("post_memo",
    { description: "Publish a long-form analysis memo for a session. Returns a URL that can be passed as memoUrl in submit_recommendation.",
      inputSchema: { sessionId: z.string(), title: z.string().optional(), body: z.string() } },
    async (input) => {
      const res = await fetch(`${BACKEND}${ROUTES.committee.memos}`, {
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
        : (await get(`${ROUTES.dashboards.regimeSnapshots}?range=1`)).latest ?? {};
      const c = Number(regime.composite ?? 0.5);
      // Canonical shared classifier (@robotmoney/contract, 0.33/0.67 rule) —
      // this tool previously re-derived its own diverged 0.45/0.67 thresholds
      // (a composite in [0.33, 0.45) was mislabeled "risk_off"); regime.js
      // forbids local threshold re-derivation. The prose ladder below stays a
      // finer-grained gradient on purpose.
      const classification = classifyRegime(c);
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
      const snapshots: any = await get(routePath(ROUTES.committee.subjectSnapshots, { id: subjectId }));
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

// The canonical application field set, read off `canonicalizeApplication`
// itself (@robotmoney/contract) rather than hand-typed here — if Stage 0 ever
// changes the field set this recomputes automatically instead of silently
// drifting out of sync with what the backend actually verifies.
const APPLICATION_FIELDS = Object.keys(
  JSON.parse(canonicalizeApplication({ name: "", contact: "", lens: "", publicKey: "" })),
);

// Anonymous, pre-credential discovery surface (docs/architecture.md §11 R5/R6).
// Built fresh per anonymous session; registers EXACTLY two tools — no member
// tool (buildServer, above) is ever reachable without a real bearer.
function buildAnonymousServer() {
  const server = new McpServer({ name: "robotmoney-committee-anonymous", version: "0.1.0" });

  server.registerTool("apply-how-to",
    { description: "Discovery tool, callable with no credentials: the current steps to apply to the Investment Committee (§11.2).", inputSchema: {} },
    async () => j({
      steps: APPLY_HOW_TO_STEPS,
      payload: {
        fields: [...APPLICATION_FIELDS, "signature"],
        description:
          "Canonical application payload (name, contact, optional lens, publicKey) signed with an rmpc ed25519 " +
          "signature over canonicalizeApplication(...); POST { ...payload fields, signature } to the apply route.",
      },
      routes: { apply: ROUTES.committee.apply, applyStatus: ROUTES.committee.applyStatus },
      skillUrl: COMMITTEE_ONBOARDING_SKILL_URL,
    }));

  server.registerTool("apply",
    { description: "Submit the signed committee application (name, contact, optional lens, publicKey, and an rmpc signature over the canonical application payload). Preferred over the raw API — this also proves MCP reachability.",
      inputSchema: { name: z.string(), contact: z.string(), lens: z.string().optional(), publicKey: z.string(), signature: z.string() } },
    async (input) => {
      const res = await fetch(`${BACKEND}${ROUTES.committee.apply}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return j(await res.json());
    });

  return server;
}

const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
const lastSeen = new Map<string, number>(); // session id → last activity (idle sweep)
const MAX_SESSIONS = 500; // cap concurrent AUTHENTICATED sessions (DoS bound)
const IDLE_MS = 10 * 60_000; // evict authenticated sessions idle longer than this

// Anonymous discovery sessions (§11 R5, no bearer at init) get their OWN small
// reserved capacity pool and a much shorter idle window — never the shared
// authenticated one. apply-how-to/apply is a single quick request/response
// exchange, not a long-lived interactive session, so there is no legitimate
// reason for an anonymous session to sit open for minutes. Without this
// separation, an unauthenticated client could script bare POST /mcp calls to
// fill the ENTIRE session pool and lock out real applicants and members alike
// (a full, sustainable DoS on the auth boundary this surface introduces) —
// with the reservation, the worst an anonymous flood can do is deny OTHER
// anonymous callers, and only for up to ANONYMOUS_IDLE_MS before eviction.
const anonymousSessions = new Set<string>();
const MAX_ANONYMOUS_SESSIONS = 50;
const ANONYMOUS_IDLE_MS = 60_000;

// Periodically close idle sessions so the maps + McpServer instances can't grow
// unboundedly when clients abandon sessions without closing them. Anonymous
// sessions are swept on their own, much shorter, idle window.
// Exported so hermetic tests that import this module can clearInterval() it on
// teardown instead of leaving a live timer (and open listen socket, see
// `httpServer` below) pinning the test process open.
export const idleSweepInterval = setInterval(() => {
  tokenStore.sweep();
  const now = Date.now();
  for (const [id, ts] of lastSeen) {
    const idleLimit = anonymousSessions.has(id) ? ANONYMOUS_IDLE_MS : IDLE_MS;
    if (now - ts < idleLimit) continue;
    try { (transports.get(id) as any)?.close?.(); } catch { /* ignore */ }
    transports.delete(id); sessionBinding.delete(id); lastSeen.delete(id); anonymousSessions.delete(id);
  }
}, 60_000);

// Per-session binding: maps session-id → { memberId, memberToken, tokenHash }.
// TokenHash is the SHA-256 of the presented bearer (OAuth access token or legacy
// token), checked on every follow-up request to the same session. Anonymous
// discovery sessions (§11 R5, no bearer at init) set isAnonymous instead —
// there is no bearer to pin, and the session's McpServer only ever exposes
// apply-how-to/apply regardless.
interface SessionBinding {
  memberId: string;
  memberToken: string;
  tokenHash: string;
  isAnonymous?: boolean;
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

async function validateMemberCredentials(memberId: string, clientSecret: string): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND}${ROUTES.committee.verifyToken}`, {
      headers: { Authorization: `Bearer ${clientSecret}` },
    });
    if (!res.ok) return false;
    const body = await res.json() as { memberId?: string };
    return body.memberId === memberId;
  } catch {
    return false;
  }
}

// Resolve a presented bearer to { memberId, memberToken }. OAuth access tokens
// are local; direct legacy tokens are validated against the backend.
async function resolveBearer(token: string): Promise<{ memberId: string; memberToken: string } | null> {
  const oauth = tokenStore.resolveAccess(token);
  if (oauth) return oauth;

  // Legacy direct bearers remain supported, but validate them before allocating
  // transport/session state so arbitrary strings cannot consume session capacity.
  try {
    const res = await fetch(`${BACKEND}${ROUTES.committee.verifyToken}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json() as { memberId?: string };
    return body.memberId ? { memberId: body.memberId, memberToken: token } : null;
  } catch {
    return null;
  }
}

// Exported (alongside idleSweepInterval) so hermetic tests can .stop(true) the
// listener on teardown; the standalone entrypoint (`bun run src/server.ts`)
// behaves identically since the export is additive.
export const httpServer = Bun.serve({
  port: PORT,
  idleTimeout: Number(process.env.MCP_IDLE_TIMEOUT_SECONDS ?? 10),
  async fetch(req) {
    const url = new URL(req.url);

    // ── Health ─────────────────────────────────────────────────────────
    if (url.pathname === "/health") return jsonResponse({ status: "ok", backend: BACKEND });

    // ── OAuth 2.1 metadata (RFC 8414) ──────────────────────────────────
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      // Advertise endpoints at the origin the CLIENT used to reach us, not our
      // internal bind (http://localhost:${PORT}). An OAuth client follows these
      // discovered URLs verbatim, so they must be reachable from where the client
      // runs. In the demo the MCP server is published on a host port that differs
      // from its in-container PORT, so a hardcoded localhost:${PORT} is refused.
      const base = url.origin;
      return jsonResponse({
        issuer: base,
        // Required by RFC 8414 and the MCP SDK's metadata schema, which rejects
        // discovery without it. This server only uses the client_credentials
        // grant (no redirect flow), so the endpoint is advertised for schema
        // compliance but never invoked.
        authorization_endpoint: `${base}/mcp/oauth/authorize`,
        token_endpoint: `${base}/mcp/oauth/token`,
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        response_types_supported: ["token"],
        grant_types_supported: ["client_credentials", "refresh_token"],
        revocation_endpoint: `${base}/mcp/oauth/revoke`,
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

        const issued = tokenStore.issue({ memberId: clientId, memberToken: clientSecret });
        if (!issued) return oauthError("temporarily_unavailable", "token capacity reached", 503);
        return jsonResponse({
          access_token: issued.accessToken,
          token_type: "bearer",
          expires_in: issued.expiresIn,
          refresh_token: issued.refreshToken,
        });
      }

      if (grantType === "refresh_token") {
        const rt = body.get("refresh_token");
        if (!rt) return oauthError("invalid_request", "refresh_token required");
        const issued = tokenStore.rotate(rt);
        if (!issued) {
          return oauthError("invalid_grant", "refresh token expired or invalid", 401);
        }
        return jsonResponse({
          access_token: issued.accessToken,
          token_type: "bearer",
          expires_in: issued.expiresIn,
          refresh_token: issued.refreshToken,
        });
      }

      return oauthError("unsupported_grant_type", `grant_type '${grantType}' not supported`);
    }

    // ── OAuth token revocation (RFC 7009) ───────────────────────────────
    if (url.pathname === "/mcp/oauth/revoke" && req.method === "POST") {
      const body = new URLSearchParams(await req.text());
      const token = body.get("token");
      if (token) tokenStore.revoke(token);
      // RFC 7009: always return 200 (don't reveal if token was valid)
      return jsonResponse({});
    }

    // ── Anonymous MCP discovery endpoint (§11 R5) ───────────────────────
    // Deliberately a SEPARATE path from /mcp, not a no-bearer branch of it.
    // /mcp is also used by real member agents connecting via OAuth 2.1
    // client_credentials (ClientCredentialsProvider) — that flow's SDK client
    // sends its FIRST request with NO Authorization header by design (it has
    // no cached token yet) and only performs the token exchange after
    // receiving a 401, per the standard OAuth 2.1 resource-server contract.
    // If /mcp itself ever answered a bearer-less request with 200 instead of
    // 401, that 401-triggers-auth signal would never fire: the client would
    // silently "succeed" into the anonymous 2-tool surface and never
    // authenticate at all — this exact bug shipped once (see git history) and
    // broke every OAuth-based member session. Keeping discovery on its own
    // path makes the two cases unambiguous instead of trying to infer intent
    // from an identical bearer-less request.
    if (url.pathname === "/mcp/apply") {
      const sid = req.headers.get("mcp-session-id");
      if (sid && transports.has(sid)) {
        // Every session reachable via this path is anonymous by construction
        // (see the initialize branch below) — no bearer to re-validate.
        lastSeen.set(sid, Date.now());
        return transports.get(sid)!.handleRequest(req);
      }
      if (anonymousSessions.size >= MAX_ANONYMOUS_SESSIONS)
        return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32002, message: "server at anonymous session capacity" }, id: null }),
          { status: 429, headers: { "Content-Type": "application/json" } });
      const t = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          transports.set(id, t);
          sessionBinding.set(id, { memberId: "", memberToken: "", tokenHash: tokenHash(null), isAnonymous: true });
          lastSeen.set(id, Date.now());
          anonymousSessions.add(id);
        },
        onsessionclosed: (id) => { transports.delete(id); sessionBinding.delete(id); lastSeen.delete(id); anonymousSessions.delete(id); },
      });
      const server = buildAnonymousServer();
      await server.connect(t);
      return t.handleRequest(req);
    }

    // ── Member MCP protocol endpoint ────────────────────────────────────
    // Unconditionally requires a real bearer, exactly as before the anonymous
    // surface existed — see the comment above for why this must never change.
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });

    const sid = req.headers.get("mcp-session-id");
    if (sid && transports.has(sid)) {
      const binding = sessionBinding.get(sid);
      // Re-validate the bearer on EVERY request to a bound session.
      const presented = bearerOf(req) ?? "";
      if (tokenHash(presented) !== binding?.tokenHash)
        return unauthorized("bearer token does not match the session it was bound to");
      const identity = await resolveBearer(presented);
      if (!identity || identity.memberId !== binding?.memberId)
        return unauthorized("bearer token is expired or revoked");
      lastSeen.set(sid, Date.now());
      return transports.get(sid)!.handleRequest(req);
    }

    // New session (initialize). Require a real bearer — no anonymous sessions
    // on this path (anonymous discovery lives at /mcp/apply, above).
    const rawToken = bearerOf(req);
    if (!rawToken) return unauthorized("a bearer token is required to start an MCP session");
    if (transports.size - anonymousSessions.size >= MAX_SESSIONS)
      return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32002, message: "server at session capacity" }, id: null }),
        { status: 429, headers: { "Content-Type": "application/json" } });

    // Resolve the bearer token to { memberId, memberToken }.
    const resolved = await resolveBearer(rawToken);
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
