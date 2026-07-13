// Committee REST handlers — thin transport over the domain layer. Used by the web
// frontend (reads) and as the sibling to the MCP write tools (the MCP server
// calls these under the hood). Returns {status, body} for the Bun router to send.
import { createHash, timingSafeEqual } from "node:crypto";
import { canonicalizeSubmission } from "@robotmoney/contract";
import * as ic from "../../committee/domain.ts";
import { config } from "../../config.ts";
import { isPlausibleKey } from "../../lib/keys.ts";
import { runAnalytics } from "../../analytics/index.ts";
import { jsonValue, sql } from "../../db/client.ts";
import {
  parseApply,
  parsePositiveNumber,
  parseSigningDraft,
  parseSubmission,
  readJsonObject,
  requiredString,
} from "../validation.ts";

function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

// Constant-time secret comparison (over fixed-length sha256 hashes so lengths
// always match and timing doesn't leak the secret).
function secretEq(presented: string | null, expected: string): boolean {
  const a = createHash("sha256").update(presented ?? "").digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// Returns { status, body } or null if the path isn't a committee route.
export async function handleCommittee(req: Request, url: URL): Promise<{ status: number; body: unknown } | null> {
  const p = url.pathname;
  const m = req.method;

  if (m === "GET" && p === "/api/committee/members") return { status: 200, body: { members: await ic.getMembers() } };
  if (m === "GET" && p.startsWith("/api/committee/members/"))
    return { status: 200, body: await ic.getMember(decodeURIComponent(p.split("/").pop()!)) };
  if (m === "GET" && /^\/api\/committee\/subjects\/[^/]+\/snapshots$/.test(p)) {
    const id = decodeURIComponent(p.split("/")[4] ?? "");
    return { status: 200, body: { snapshots: await ic.getSubjectSnapshots(id) } };
  }
  if (m === "GET" && /^\/api\/committee\/subjects\/[^/]+$/.test(p)) {
    const id = decodeURIComponent(p.split("/")[4] ?? "");
    return { status: 200, body: await ic.getSubject(id) };
  }
  if (m === "GET" && p === "/api/committee/sessions") return { status: 200, body: { sessions: await ic.listSessions() } };
  if (m === "GET" && p === "/api/committee/open-session") return { status: 200, body: await ic.getOpenSession() };
  if (m === "GET" && /^\/api\/committee\/sessions\/[^/]+\/[^/]+$/.test(p)) {
    const [, , , , date, subject] = p.split("/");
    const r = await ic.getSession(decodeURIComponent(date), decodeURIComponent(subject));
    return { status: r ? 200 : 404, body: r ?? { error: "not found" } };
  }
  if (m === "GET" && p === "/api/committee/brief") {
    const date = url.searchParams.get("date") ?? "";
    const subject = url.searchParams.get("subject") ?? "";
    return { status: 200, body: await ic.getBrief(date, subject) };
  }

  // get_signing_payload: return the exact canonical bytes the member must sign.
  if (m === "POST" && p === "/api/committee/signing-payload") {
    const sub = parseSigningDraft(await readJsonObject(req));
    if (!sub) return { status: 400, body: { error: "invalid signing draft" } };
    return { status: 200, body: { canonical: canonicalizeSubmission(sub) } };
  }

  // Memo: post (member-authenticated) and get (public read).
  if (m === "POST" && p === "/api/committee/memos") {
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
  if (m === "GET" && /^\/api\/committee\/memos\/\d+$/.test(p)) {
    const id = Number(p.split("/").pop());
    const memo = await ic.getMemo(id);
    return { status: memo ? 200 : 404, body: memo ?? { error: "not found" } };
  }

  // Token verification (used by the MCP OAuth token endpoint to validate
  // member credentials). Returns 200 with memberId if the bearer token is
  // valid, 401 otherwise.
  if (m === "GET" && p === "/api/committee/verify-token") {
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
  // Roles (docs/architecture.md §9.8):
  //  • host/admin     — privileged() (ADMIN_TOKEN or non-prod). Drives lifecycle
  //                     and member activation; can rotate keys.
  //  • analytics-provider — ANALYTICS_TOKEN bearer. May write the regime.
  //  • member         — committee_member_keys bearer. May submit (enforced in
  //                     submitRecommendation).
  // Fail-closed: a token (constant-time compared) authorizes in any env; WITHOUT
  // a token the role opens only when config.allowInsecure (ephemeral / explicit
  // RM_ALLOW_INSECURE). demo/prod with no token → locked.
  const privileged = () =>
    config.adminToken ? secretEq(req.headers.get("X-Admin-Token"), config.adminToken) : config.allowInsecure;
  const analyticsProvider = () =>
    config.analyticsToken ? secretEq(bearer(req), config.analyticsToken) : config.allowInsecure;

  // PUBLIC onboarding: a prospective member submits its public key. The member
  // is recorded as 'applied' (NOT active) with an INACTIVE key — it cannot
  // submit until an admin activates it. Re-applying refreshes the pending
  // record but NEVER overwrites an already-active member's key (that's admin).
  if (m === "POST" && p === "/api/committee/apply") {
    const b = parseApply(await readJsonObject(req));
    if (!b) return { status: 400, body: { error: "valid memberId, name, and publicKey required" } };
    if (!isPlausibleKey(b.publicKey)) return { status: 400, body: { error: "implausible publicKey" } };
    const res = await ic.applyMember(b);
    return { status: res.status, body: res };
  }

  // Role-gated regime write: ONLY the analytics-provider may persist the regime.
  if (m === "POST" && p === "/api/committee/regime") {
    if (!analyticsProvider()) return { status: 403, body: { error: "analytics-provider role required" } };
    const b = await readJsonObject(req) ?? {};
    const asof = typeof b.asof === "string" ? b.asof : new Date().toISOString().slice(0, 10);
    const tools = Object.keys(await runAnalytics(asof));
    return { status: 200, body: { ok: true, tools } };
  }

  // Onboarding (privileged alias): register a member's public key and mint a
  // bearer token in one shot (apply + activate combined). Kept for the demo/E2E
  // harness. Privileged because it can rotate/replace an existing member's key.
  if (m === "POST" && p === "/api/committee/register") {
    if (!privileged()) return { status: 403, body: { error: "onboarding requires admin authorization" } };
    const b = parseApply(await readJsonObject(req));
    if (!b) return { status: 400, body: { error: "valid memberId, name, and publicKey required" } };
    if (!isPlausibleKey(b.publicKey)) return { status: 400, body: { error: "implausible publicKey" } };
    return { status: 201, body: await ic.registerMember(b) };
  }

  // Admin lifecycle. Drives a session for demos/E2E.
  if (m === "POST" && p.startsWith("/api/committee/admin/")) {
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
      case "regime": return { status: 200, body: { tools: Object.keys(await runAnalytics(typeof b.asof === "string" ? b.asof : new Date().toISOString().slice(0, 10), "regime")) } };
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
  if (m === "POST" && p === "/api/committee/submit") {
    const token = bearer(req);
    if (!token) return { status: 401, body: { error: "missing bearer token" } };
    const sub = parseSubmission(await readJsonObject(req));
    if (!sub) return { status: 400, body: { error: "invalid submission" } };
    const res = await ic.submitRecommendation(token, sub);
    return { status: res.status, body: res };
  }

  return null;
}
