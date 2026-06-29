// Committee REST handlers — thin transport over the domain layer. Used by the web
// frontend (reads) and as the sibling to the MCP write tools (the MCP server
// calls these under the hood). Returns {status, body} for the Bun router to send.
import { canonicalizeSubmission } from "@robotmoney/contract";
import * as ic from "../../committee/domain.ts";
import { config } from "../../config.ts";
import { writeRegimeHistory } from "../../worker/handlers/regime.ts";

function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

// Returns { status, body } or null if the path isn't a committee route.
export async function handleCommittee(req: Request, url: URL): Promise<{ status: number; body: unknown } | null> {
  const p = url.pathname;
  const m = req.method;

  if (m === "GET" && p === "/api/committee/members") return { status: 200, body: { members: await ic.getMembers() } };
  if (m === "GET" && p.startsWith("/api/committee/members/"))
    return { status: 200, body: await ic.getMember(decodeURIComponent(p.split("/").pop()!)) };
  if (m === "GET" && p.startsWith("/api/committee/subjects/")) {
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
    const sub = (await req.json().catch(() => ({}))) as any;
    return { status: 200, body: { canonical: canonicalizeSubmission(sub) } };
  }

  // demo onboarding: member registers its own public key, gets a bearer token.
  if (m === "POST" && p === "/api/committee/register") {
    const b = (await req.json().catch(() => null)) as any;
    if (!b?.memberId || !b?.name || !b?.publicKey) return { status: 400, body: { error: "memberId, name, publicKey required" } };
    return { status: 201, body: await ic.registerMember(b) };
  }

  // dev-only admin lifecycle (disabled in prod). Drives a session for demos/E2E.
  if (m === "POST" && p.startsWith("/api/committee/admin/")) {
    if (config.env === "prod") return { status: 403, body: { error: "admin disabled in prod" } };
    const action = p.split("/").pop();
    const b = (await req.json().catch(() => ({}))) as any;
    switch (action) {
      case "reset": return { status: 200, body: await ic.resetSessions() };
      case "regime": return { status: 200, body: { snapshots: await writeRegimeHistory(b.asof ?? new Date().toISOString().slice(0, 10)) } };
      case "subject": return { status: 200, body: await ic.ensureSubject(b.id, b.name) };
      case "open": return { status: 200, body: await ic.openSession(b.date, b.subjectId) };
      case "brief": return { status: 200, body: await ic.publishBrief(b.sessionId, b.windowMinutes ?? 60) };
      case "close": return { status: 200, body: await ic.closeWindow(b.sessionId) };
      case "aggregate": return { status: 200, body: await ic.aggregateSession(b.sessionId) };
      case "publish": return { status: 200, body: await ic.publishSession(b.sessionId) };
      default: return { status: 404, body: { error: "unknown admin action" } };
    }
  }

  // submit (scoped + signed)
  if (m === "POST" && p === "/api/committee/submit") {
    const token = bearer(req);
    if (!token) return { status: 401, body: { error: "missing bearer token" } };
    const sub = (await req.json().catch(() => null)) as ic.SubmissionInput | null;
    if (!sub) return { status: 400, body: { error: "invalid JSON body" } };
    const res = await ic.submitRecommendation(token, sub);
    return { status: res.status, body: res };
  }

  return null;
}
