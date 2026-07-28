// Committee REST handlers — thin transport over the domain layer. Used by the web
// frontend (reads) and as the sibling to the MCP write tools (the MCP server
// calls these under the hood). Returns {status, body} for the Bun router to send.
import { canonicalizeSubmission, ROUTES } from "@robotmoney/contract";
import * as ic from "../../committee/domain.ts";
import { handleCommitteeAdmin } from "./committee-admin.ts";
import { isPlausibleKey } from "../../lib/keys.ts";
import { isValidEd25519PublicKey } from "../../lib/signing.ts";
import { resolveAnalyticsSource, runAnalytics } from "../../analytics/index.ts";
import { directAnalyticsPersistence } from "../../analytics/store/direct.ts";
import { bearer, hasAnalyticsProviderRole, isPrivileged } from "../auth.ts";
import { jsonValue, sql } from "../../db/client.ts";
import {
  parseApply,
  parseManualMember,
  parsePositiveNumber,
  parseSigningDraft,
  parseSubmission,
  readJsonObject,
  requiredString,
} from "../validation.ts";
import { COMMITTEE_ROUTE_EXTENSIONS } from "./committee/extensions.ts";

// bearer()/secretEq()/isPrivileged()/hasAnalyticsProviderRole() live in
// api/auth.ts (issue #106) so the /api/analytics boundary reuses the exact same
// constant-time credential idioms as this router.

// The committee endpoint paths come from the shared contract (finding 019 —
// routes.js is the single source of truth for URLs; no literals here). Param
// routes are matched by compiling the contract template into a RegExp with the
// same per-segment strictness the old inline regexes had.
const C = ROUTES.committee;
// ":param" → one path segment (default [^/]+; override for stricter params).
function templateRe(template: string, paramRe: Record<string, string> = {}): RegExp {
  return new RegExp(`^${template.replace(/:([a-zA-Z_]+)/g, (_, k: string) => paramRe[k] ?? "[^/]+")}$`);
}
const RE_SUBJECT_SNAPSHOTS = templateRe(C.subjectSnapshots); // /api/committee/subjects/:id/snapshots
const RE_SUBJECT = templateRe(C.subject); // /api/committee/subjects/:id
const RE_MEMBER_TAKES = templateRe(C.memberTakes); // /api/committee/members/:id/takes — checked before the plain member-detail route below, same reason as RE_SUBJECT_SNAPSHOTS vs RE_SUBJECT
const RE_SESSION = templateRe(C.session); // /api/committee/sessions/:date/:subject
const RE_MEMO = templateRe(C.memo, { id: "\\d+" }); // /api/committee/memos/:id (numeric only, as before)
const ADMIN_PREFIX = C.admin.action.replace(":action", ""); // /api/committee/admin/

// Returns { status, body } or null if the path isn't a committee route.
export async function handleCommittee(req: Request, url: URL): Promise<{ status: number; body: unknown } | null> {
  const p = url.pathname;
  const m = req.method;

  if (m === "GET" && p === C.members) return { status: 200, body: { members: await ic.getMembers() } };
  // Checked BEFORE the single-segment member-detail route below — a bare
  // `.startsWith` there would otherwise swallow `/members/:id/takes` too (its
  // `.split("/").pop()` would read "takes" as the member id).
  if (m === "GET" && RE_MEMBER_TAKES.test(p)) {
    const id = decodeURIComponent(p.split("/")[4] ?? "");
    const limitRaw = url.searchParams.get("limit");
    try {
      return { status: 200, body: await ic.getMemberTakes(id, limitRaw ? Number(limitRaw) : undefined) };
    } catch (e) {
      return { status: 400, body: { error: e instanceof Error ? e.message : "invalid request" } };
    }
  }
  if (m === "GET" && p.startsWith(`${C.members}/`))
    return { status: 200, body: await ic.getMember(decodeURIComponent(p.split("/").pop()!)) };
  if (m === "GET" && RE_SUBJECT_SNAPSHOTS.test(p)) {
    const id = decodeURIComponent(p.split("/")[4] ?? "");
    return { status: 200, body: { snapshots: await ic.getSubjectSnapshots(id) } };
  }
  if (m === "GET" && RE_SUBJECT.test(p)) {
    const id = decodeURIComponent(p.split("/")[4] ?? "");
    return { status: 200, body: await ic.getSubject(id) };
  }
  if (m === "GET" && p === C.sessions) {
    const state = url.searchParams.get("state") ?? undefined;
    const full = url.searchParams.get("full") === "1";
    const limitRaw = url.searchParams.get("limit");
    const cursor = url.searchParams.get("cursor") ?? undefined;
    try {
      return {
        status: 200,
        body: await ic.listSessions({ state, full, limit: limitRaw ? Number(limitRaw) : undefined, cursor }),
      };
    } catch (e) {
      return { status: 400, body: { error: e instanceof Error ? e.message : "invalid request" } };
    }
  }
  if (m === "GET" && p === C.openSession) return { status: 200, body: await ic.getOpenSession() };
  if (m === "GET" && RE_SESSION.test(p)) {
    const [, , , , date, subject] = p.split("/");
    const r = await ic.getSession(decodeURIComponent(date), decodeURIComponent(subject));
    return { status: r ? 200 : 404, body: r ?? { error: "not found" } };
  }
  if (m === "GET" && p === C.brief) {
    const date = url.searchParams.get("date") ?? "";
    const subject = url.searchParams.get("subject") ?? "";
    return { status: 200, body: await ic.getBrief(date, subject) };
  }

  // get_signing_payload: return the exact canonical bytes the member must sign.
  if (m === "POST" && p === C.signingPayload) {
    const sub = parseSigningDraft(await readJsonObject(req));
    if (!sub) return { status: 400, body: { error: "invalid signing draft" } };
    return { status: 200, body: { canonical: canonicalizeSubmission(sub) } };
  }

  // Memo: post (member-authenticated) and get (public read).
  if (m === "POST" && p === C.memos) {
    const token = bearer(req);
    if (!token) return { status: 401, body: { error: "missing bearer token" } };
    const b = await readJsonObject(req);
    const sessionId = b && requiredString(b, "sessionId", 100);
    const body = b && requiredString(b, "body", 50_000);
    if (!b || !sessionId || !body) return { status: 400, body: { error: "sessionId and body required" } };
    const res = await ic.postMemo(token, {
      sessionId,
      title: typeof b.title === "string" ? b.title.slice(0, 300) : undefined,
      body,
    });
    return { status: res.status, body: res };
  }
  if (m === "GET" && RE_MEMO.test(p)) {
    const id = Number(p.split("/").pop());
    const memo = await ic.getMemo(id);
    return { status: memo ? 200 : 404, body: memo ?? { error: "not found" } };
  }

  // Token verification (used by the MCP OAuth token endpoint to validate
  // member credentials). Returns 200 with memberId if the bearer token is
  // valid, 401 otherwise.
  if (m === "GET" && p === C.verifyToken) {
    const token = bearer(req);
    if (!token) return { status: 401, body: { error: "missing bearer token" } };
    const memberId = await ic.memberIdForToken(token);
    if (!memberId) return { status: 401, body: { error: "invalid token" } };
    return { status: 200, body: { memberId } };
  }

  // Member onboarding + admin lifecycle are PRIVILEGED. Guard: if ADMIN_TOKEN is
  // set, require it as X-Admin-Token (works in every env, incl. a public box);
  // if unset, allow only outside prod (demo/ephemeral convenience). This closes
  // the unauthenticated identity-takeover / state-drive holes. Proper
  // per-member onboarding + OAuth is the IC-remainder work.
  // Role definitions + the fail-closed rule live in api/auth.ts (issue #106).
  const privileged = () => isPrivileged(req);

  // PUBLIC onboarding (§11 R1-R6, setup-gated apply): a prospective member
  // submits {name, contact, lens?, publicKey, signature} — an rmpc signature
  // over the canonical application payload, verified against the submitted
  // key before anything is recorded. The server — never the client — mints
  // the member id and returns it. The member is recorded as 'applied' (NOT
  // active) with an INACTIVE key — it cannot submit until an admin activates
  // it. Re-applying with the SAME key refreshes the pending record; it can
  // NEVER overwrite an already-admitted member's key (that's admin).
  if (m === "POST" && p === C.apply) {
    const b = parseApply(await readJsonObject(req));
    // Say what a valid application IS, not just that this one wasn't. This is
    // the first response an unfamiliar client gets — measured live, every
    // real member-agent in the §11 R8 eval probes this endpoint with `{}`
    // before it builds anything — and `apply` is the one committee route whose
    // audience is, by design, a program that has never seen our source.
    // §11.3 E7: the eval reports on our instructions, and an API's own errors
    // are part of them.
    if (!b) {
      return {
        status: 400,
        body: {
          error: "valid name, contact, publicKey, and signature required",
          expects: { name: "string", contact: "string", lens: "string (optional)", publicKey: "base64 ed25519 public key", signature: "base64 ed25519 signature" },
          signatureCovers:
            "the canonical application payload: JSON.stringify of {name, contact, lens?, publicKey} " +
            "with the keys in EXACTLY that order, `lens` omitted entirely when absent, no whitespace and no trailing newline",
        },
      };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.contact)) {
      return { status: 400, body: { error: "valid contact email required for activation notification" } };
    }
    if (!await isValidEd25519PublicKey(b.publicKey)) {
      return {
        status: 400,
        body: { error: "publicKey must be canonical base64 for a 32-byte raw Ed25519 public key" },
      };
    }
    const res = await ic.applyMember(b);
    return { status: res.status, body: res };
  }

  // Role-gated regime write: ONLY the analytics-provider may persist the regime.
  // Narrowed (issue #106): scoped to the regime composite (toolId="regime") — the
  // full research suite is the worker's own scheduled job, not a committee-facing
  // behavior — and the orchestrator persists through the API-OWNED direct
  // persistence service (analytics/store/direct.ts), never ad-hoc SQL: the
  // fetch/compute stages carry no store or db/client imports.
  if (m === "POST" && p === C.regime) {
    if (!hasAnalyticsProviderRole(req)) return { status: 403, body: { error: "analytics-provider role required" } };
    const b = await readJsonObject(req) ?? {};
    const asof = typeof b.asof === "string" ? b.asof : new Date().toISOString().slice(0, 10);
    const tools = Object.keys(await runAnalytics(asof, "regime", resolveAnalyticsSource(), directAnalyticsPersistence));
    return { status: 200, body: { ok: true, tools } };
  }

  // Onboarding (privileged alias): register a member's public key and mint a
  // bearer token in one shot (apply + activate combined). Kept for the demo/E2E
  // harness. Privileged because it can rotate/replace an existing member's key.
  if (m === "POST" && p === C.register) {
    if (!privileged()) return { status: 403, body: { error: "onboarding requires admin authorization" } };
    const b = parseManualMember(await readJsonObject(req));
    if (!b) return { status: 400, body: { error: "valid memberId, name, and publicKey required" } };
    if (!isPlausibleKey(b.publicKey)) return { status: 400, body: { error: "implausible publicKey" } };
    // registerMember now enforces COMMITTEE_ROSTER_CAP; a refused over-cap
    // admission returns { ok:false, status, error } (rolled back, member NOT
    // added) — surface that status instead of a misleading 201, mirroring the
    // admin activate route below.
    const registered = await ic.registerMember(b);
    if ("ok" in registered) return { status: registered.status, body: registered };
    return { status: 201, body: registered };
  }

  // Admin surface (issue #152): topics/members/roster/lifecycle/audit — owns
  // its own sub-resource paths (subjects/members/applications/sessions/audit)
  // under the SAME admin prefix, checked first so it never falls into the
  // single-segment dispatcher below. Returns null (falls through) for any
  // path it doesn't own.
  if (p.startsWith(ADMIN_PREFIX)) {
    const adminSurface = await handleCommitteeAdmin(req, url);
    if (adminSurface) return adminSurface;
  }

  // Admin lifecycle. Drives a session for demos/E2E.
  if (m === "POST" && p.startsWith(ADMIN_PREFIX)) {
    if (!privileged()) return { status: 403, body: { error: "admin authorization required" } };
    const action = p.split("/").pop();
    const b = await readJsonObject(req) ?? {};
    switch (action) {
      case "activate": {
        const memberId = requiredString(b, "memberId", 100);
        if (!memberId) return { status: 400, body: { error: "memberId required" } };
        const res = await ic.activateMember(memberId);
        return { status: res.status, body: res };
      }
      case "reset": return { status: 200, body: await ic.resetSessions() };
      // Scope to the regime composite only (toolId="regime"). The demo-startup
      // and ~2-min committee session cycles hit this repeatedly; recomputing the
      // full suite here re-ran the multi-minute live SEC EDGAR research crawl and
      // hung `bun demo`. The worker refreshes research signals on its own
      // independent schedule, so this route never needs them (issue #59).
      case "regime": return { status: 200, body: { tools: Object.keys(await runAnalytics(typeof b.asof === "string" ? b.asof : new Date().toISOString().slice(0, 10), "regime", resolveAnalyticsSource(), directAnalyticsPersistence)) } };
      case "subject": {
        const id = requiredString(b, "id", 100);
        const name = requiredString(b, "name", 200);
        return id && name
          ? { status: 200, body: await ic.ensureSubject(id, name) }
          : { status: 400, body: { error: "id and name required" } };
      }
      // Seed the reference-shaped demo fixtures (subject row + subject snapshot the
      // portfolio donut reads + trailing regime history for the sparkline) so the
      // LIVE session path renders the same charts as the committed archive. Called
      // by the demo before opening a session. Idempotent.
      case "subject_fixtures": {
        const id = requiredString(b, "id", 100);
        const name = requiredString(b, "name", 200);
        const date = typeof b.date === "string" ? b.date.slice(0, 10) : undefined;
        return id && name
          ? { status: 200, body: await ic.ensureDemoSubjectFixtures(id, name, date) }
          : { status: 400, body: { error: "id and name required" } };
      }
      case "open": {
        const date = requiredString(b, "date", 10);
        const subjectId = requiredString(b, "subjectId", 100);
        return date && subjectId
          ? { status: 200, body: await ic.openSession(date, subjectId) }
          : { status: 400, body: { error: "date and subjectId required" } };
      }
      case "brief":
      case "close":
      case "aggregate":
      case "publish": {
        const sessionId = requiredString(b, "sessionId", 100);
        if (!sessionId) return { status: 400, body: { error: "sessionId required" } };
        if (action === "brief") return { status: 200, body: await ic.publishBrief(sessionId, parsePositiveNumber(b.windowMinutes, 60)) };
        if (action === "close") return { status: 200, body: await ic.closeWindow(sessionId) };
        if (action === "aggregate") return { status: 200, body: await ic.aggregateSession(sessionId) };
        return { status: 200, body: await ic.publishSession(sessionId) };
      }
      case "enqueue-job": {
        const actionMap: Record<string, string> = {
          open_session: "committee.open_session",
          publish_brief: "committee.publish_brief",
          close_window: "committee.close_window",
          aggregate: "committee.aggregate",
          publish: "committee.publish",
        };
        const queueAction = requiredString(b, "action", 100);
        const kind = queueAction ? actionMap[queueAction] : undefined;
        if (!kind) return { status: 400, body: { error: `unknown action: ${b.action}` } };
        const { action: _, ...payload } = b;
        const rows = await sql`
          INSERT INTO jobs (kind, payload) VALUES (${kind}, ${sql.json(jsonValue(payload))})
          RETURNING id, kind`;
        return { status: 200, body: { jobId: rows[0].id, kind: rows[0].kind } };
      }
      default: return { status: 404, body: { error: "unknown admin action" } };
    }
  }

  // submit (scoped + signed)
  if (m === "POST" && p === C.submit) {
    const token = bearer(req);
    if (!token) return { status: 401, body: { error: "missing bearer token" } };
    const sub = parseSubmission(await readJsonObject(req));
    if (!sub) return { status: 400, body: { error: "invalid submission" } };
    const res = await ic.submitRecommendation(token, sub);
    return { status: res.status, body: res };
  }

  // Pre-registered, concern-owned extension points keep the onboarding routes
  // (#205) and public receipt routes (#207) in disjoint modules. Both handlers
  // are no-ops until their owning issues implement the documented contracts.
  for (const handleExtension of COMMITTEE_ROUTE_EXTENSIONS) {
    const result = await handleExtension(req, url);
    if (result) return result;
  }

  return null;
}
