// Swarm ADMIN REST surface (issue #152): topics, members, session
// scheduling + roster, guarded lifecycle transitions, and audit filtering.
// Thin transport over swarm/admin.ts — every route here is PRIVILEGED
// (X-Admin-Token / isPrivileged(), the same fail-closed guard the rest of the
// swarm admin dispatcher and /api/admin use) and every owned route checks
// that guard BEFORE parsing the request body or touching the database, so an
// unauthenticated caller never causes SQL work (issue #152 AC7).
import * as admin from "../../swarm/admin.ts";
import { getAgentHealthEvents } from "../../swarm/domain.ts";
import { config as globalConfig } from "../../config.ts";
import { isPrivileged } from "../auth.ts";
import {
  parseExpectedVersion,
  parseManualMember,
  parseSessionCreate,
  parseSubjectCreate,
  readJsonObject,
  requiredString,
  validateMemberAdminPatch,
} from "../validation.ts";

const PREFIX = "/api/swarm/admin/";
const FORBIDDEN = { status: 403, body: { error: "admin authorization required" } } as const;

function ownsPath(p: string): boolean {
  if (!p.startsWith(PREFIX)) return false;
  const rest = p.slice(PREFIX.length);
  return (
    rest === "subjects" || rest.startsWith("subjects/") ||
    rest === "members" || rest.startsWith("members/") ||
    rest === "applications" ||
    rest === "sessions" || rest.startsWith("sessions/") ||
    rest === "audit" ||
    rest === "agent-health"
  );
}

// Result envelope from swarm/admin.ts already carries {ok, status, error,
// ...}; map it straight through so 200/201/404/409 responses stay consistent.
function fromResult(r: { status: number; [k: string]: unknown }) {
  return { status: r.status, body: r };
}

export interface AdminAuthConfig {
  adminToken: string | null;
  allowInsecure: boolean;
}

// `cfg` is injectable (mirrors routes/admin.ts's handleAdmin) so tests can
// exercise a prod-mode config (token required, insecure disallowed) against
// the ephemeral test DB, which otherwise runs with RM_ENV=ephemeral →
// allowInsecure=true. swarm.ts's live mount omits it (defaults to the
// real global config).
export async function handleSwarmAdmin(
  req: Request,
  url: URL,
  cfg: AdminAuthConfig = globalConfig,
): Promise<{ status: number; body: unknown } | null> {
  const p = url.pathname;
  const m = req.method;
  if (!ownsPath(p)) return null;

  // Auth FIRST — before any body parsing or DB query (AC7).
  if (!await isPrivileged(req, cfg)) return FORBIDDEN;

  const rest = p.slice(PREFIX.length);
  const segs = rest.split("/").filter(Boolean);

  // ── Topics ────────────────────────────────────────────────────────────
  if (segs[0] === "subjects") {
    if (segs.length === 1 && m === "GET") return { status: 200, body: { subjects: await admin.listSubjectsAdmin() } };
    if (segs.length === 1 && m === "POST") {
      const parsed = parseSubjectCreate(await readJsonObject(req));
      if (!parsed) return { status: 400, body: { error: "id and name required" } };
      return fromResult(await admin.createSubjectAdmin(parsed));
    }
    if (segs.length === 3 && (segs[2] === "update" || segs[2] === "deactivate")) {
      const id = decodeURIComponent(segs[1]!);
      const b = (await readJsonObject(req)) ?? {};
      const expectedVersion = parseExpectedVersion(b);
      if (expectedVersion == null) return { status: 400, body: { error: "expectedVersion (integer >= 1) required" } };
      if (segs[2] === "deactivate") return fromResult(await admin.deactivateSubjectAdmin(id, expectedVersion));
      const { expectedVersion: _ev, ...patch } = b as Record<string, unknown>;
      return fromResult(await admin.updateSubjectAdmin(id, expectedVersion, patch as any));
    }
    return { status: 404, body: { error: "unknown subjects admin route" } };
  }

  // ── Members ───────────────────────────────────────────────────────────
  if (segs[0] === "members") {
    if (segs.length === 1 && m === "GET") return { status: 200, body: { members: await admin.listMembersAdmin() } };
    if (segs.length === 1 && m === "POST") {
      const parsed = parseManualMember(await readJsonObject(req));
      if (!parsed) return { status: 400, body: { error: "memberId, name, and publicKey required" } };
      return fromResult(await admin.addMemberAdmin(parsed));
    }
    if (segs.length === 3) {
      const id = decodeURIComponent(segs[1]!);
      const b = (await readJsonObject(req)) ?? {};
      if (segs[2] === "review") {
        const decision = requiredString(b, "decision", 20);
        if (decision !== "approve" && decision !== "reject") return { status: 400, body: { error: "decision must be approve|reject" } };
        return fromResult(await admin.reviewApplicationAdmin(id, decision, "admin"));
      }
      if (segs[2] === "update") {
        const expectedVersion = parseExpectedVersion(b);
        if (expectedVersion == null) return { status: 400, body: { error: "expectedVersion (integer >= 1) required" } };
        // `reason` is operator context, not a member column: pulled out before
        // a validator that rejects unknown keys, and threaded to the audit row.
        const { expectedVersion: _ev, reason: _reason, ...fields } = b as Record<string, unknown>;
        const parsed = validateMemberAdminPatch(fields);
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
        return fromResult(await admin.updateMemberAdmin(
          id, expectedVersion, parsed.data, "admin", requiredString(b, "reason", 500) ?? undefined,
        ));
      }
      if (segs[2] === "deactivate" || segs[2] === "reactivate") {
        const expectedVersion = parseExpectedVersion(b);
        if (expectedVersion == null) return { status: 400, body: { error: "expectedVersion (integer >= 1) required" } };
        return fromResult(
          segs[2] === "deactivate"
            ? await admin.deactivateMemberAdmin(id, expectedVersion)
            : await admin.reactivateMemberAdmin(id, expectedVersion),
        );
      }
      if (segs[2] === "rotate-key") {
        const publicKey = typeof b.publicKey === "string" && b.publicKey.trim() ? b.publicKey.trim() : undefined;
        return fromResult(await admin.rotateMemberKeyAdmin(id, { publicKey }));
      }
    }
    return { status: 404, body: { error: "unknown members admin route" } };
  }

  // ── Applications ──────────────────────────────────────────────────────
  if (segs[0] === "applications" && m === "GET") {
    const status = url.searchParams.get("status") ?? undefined;
    return { status: 200, body: { applications: await admin.listApplicationsAdmin(status) } };
  }

  // ── Sessions: creation, roster, guarded lifecycle ───────────────────────
  if (segs[0] === "sessions") {
    if (segs.length === 1 && m === "POST") {
      const parsed = parseSessionCreate(await readJsonObject(req));
      if (!parsed) return { status: 400, body: { error: "date and subjectId required" } };
      return fromResult(await admin.createSessionAdmin(parsed));
    }
    const sessionId = segs[1] ? decodeURIComponent(segs[1]) : undefined;
    if (sessionId && segs.length === 3 && segs[2] === "roster" && m === "GET") {
      return { status: 200, body: { roster: await admin.getSessionRoster(sessionId) } };
    }
    if (sessionId && segs.length === 4 && segs[2] === "roster" && ["add", "excuse", "restore"].includes(segs[3]!) && m === "POST") {
      const b = (await readJsonObject(req)) ?? {};
      const memberId = requiredString(b, "memberId", 100);
      if (!memberId) return { status: 400, body: { error: "memberId required" } };
      const fn = { add: admin.rosterAddAdmin, excuse: admin.rosterExcuseAdmin, restore: admin.rosterRestoreAdmin }[segs[3] as "add" | "excuse" | "restore"];
      return fromResult(await fn(sessionId, memberId));
    }
    if (sessionId && segs.length === 3 && ["cancel", "close", "reopen", "aggregate", "publish"].includes(segs[2]!) && m === "POST") {
      const b = (await readJsonObject(req)) ?? {};
      const expectedVersion = parseExpectedVersion(b) ?? undefined;
      const fn = {
        cancel: admin.cancelSessionAdmin, close: admin.closeSessionAdmin, reopen: admin.reopenSessionAdmin,
        aggregate: admin.aggregateSessionAdmin, publish: admin.publishSessionAdmin,
      }[segs[2] as "cancel" | "close" | "reopen" | "aggregate" | "publish"];
      return fromResult(await fn(sessionId, expectedVersion));
    }
    return { status: 404, body: { error: "unknown sessions admin route" } };
  }

  // ── Audit ─────────────────────────────────────────────────────────────
  if (segs[0] === "audit" && m === "GET") {
    const limitRaw = url.searchParams.get("limit");
    return {
      status: 200,
      body: {
        entries: await admin.listAuditLog({
          actor: url.searchParams.get("actor") ?? undefined,
          action: url.searchParams.get("action") ?? undefined,
          since: url.searchParams.get("since") ?? undefined,
          until: url.searchParams.get("until") ?? undefined,
          limit: limitRaw ? Number(limitRaw) : undefined,
        }),
      },
    };
  }

  // ── Agent health (issue #208) ────────────────────────────────────────────
  if (segs[0] === "agent-health" && m === "GET") {
    const limitRaw = url.searchParams.get("limit");
    const eventTypeRaw = url.searchParams.get("eventType") ?? undefined;
    if (eventTypeRaw !== undefined && eventTypeRaw !== "absent" && eventTypeRaw !== "rejected_signature") {
      return { status: 400, body: { error: "eventType must be absent|rejected_signature" } };
    }
    return {
      status: 200,
      body: await getAgentHealthEvents({
        sessionId: url.searchParams.get("sessionId") ?? undefined,
        memberId: url.searchParams.get("memberId") ?? undefined,
        eventType: eventTypeRaw,
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  }

  return { status: 404, body: { error: "unknown swarm admin route" } };
}
