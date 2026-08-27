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
import { isPrivileged, hasAutomationRole } from "../auth.ts";
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
    rest === "judge" ||
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
  automationToken?: string | null;
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
  if (!(await isPrivileged(req, cfg) || hasAutomationRole(req, cfg))) return FORBIDDEN;

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
    if (segs.length === 1 && m === "GET") {
      // Issue #563: silenceFlags is a SEPARATE query (getMemberSilenceFlags),
      // not a field on toMemberAdmin()'s per-row projection — it needs the
      // whole session/recommendation history, not one row, and admin.ts's
      // other callers of toMemberAdmin() (manual-add, update, deactivate,
      // reactivate) have no such history to hand it. Run in parallel; they
      // read disjoint tables and neither writes.
      const [members, silenceFlags] = await Promise.all([
        admin.listMembersAdmin(),
        admin.getMemberSilenceFlags(),
      ]);
      return { status: 200, body: { members, silenceFlags } };
    }
    if (segs.length === 1 && m === "POST") {
      // The parser owns the message: a body that names `memberId` is refused
      // with its own sentence (issue #690), never folded into "required".
      const parsed = parseManualMember(await readJsonObject(req));
      if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
      return fromResult(await admin.addMemberAdmin(parsed.data));
    }
    // Avatar upload (issue #626), checked BEFORE the generic segs.length===3
    // branch below: that branch unconditionally calls readJsonObject(req),
    // which would consume the body trying to parse it as JSON — and the raw
    // image bytes this route reads via req.arrayBuffer() ARE the body, not
    // JSON. A Content-Length over the limit is refused before the body is
    // even read, so an oversized upload cannot be used to force this process
    // to buffer it into memory first.
    if (segs.length === 3 && segs[2] === "avatar" && m === "POST") {
      const id = decodeURIComponent(segs[1]!);
      const contentLength = req.headers.get("Content-Length");
      if (contentLength && Number(contentLength) > admin.AVATAR_MAX_BYTES) {
        return { status: 400, body: { error: `avatar exceeds ${admin.AVATAR_MAX_BYTES}-byte limit` } };
      }
      const bytes = new Uint8Array(await req.arrayBuffer());
      return fromResult(
        await admin.uploadMemberAvatarAdmin(id, { contentType: req.headers.get("Content-Type"), bytes }),
      );
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
    if (sessionId && segs.length === 3 && ["cancel", "close", "reopen", "aggregate", "publish", "judge"].includes(segs[2]!) && m === "POST") {
      const b = (await readJsonObject(req)) ?? {};
      const expectedVersion = parseExpectedVersion(b) ?? undefined;
      const fn = {
        cancel: admin.cancelSessionAdmin, close: admin.closeSessionAdmin, reopen: admin.reopenSessionAdmin,
        aggregate: admin.aggregateSessionAdmin, publish: admin.publishSessionAdmin,
        // Issue #752. 409 `judge_disabled` while the runtime mode is off, which
        // is the shipped default — the judge is opt-in on a live swarm.
        judge: admin.judgeSessionAdmin,
      }[segs[2] as "cancel" | "close" | "reopen" | "aggregate" | "publish" | "judge"];
      return fromResult(await fn(sessionId, expectedVersion));
    }
    return { status: 404, body: { error: "unknown sessions admin route" } };
  }

  // ── Consensus judge switch (issue #752) ───────────────────────────────
  // The one control that must work WITHOUT a redeploy: an operator watching the
  // judge misbehave on live sessions needs `mode: "off"` to take effect on the
  // next session, not on the next deploy. Hence a database row behind a POST,
  // rather than an environment variable behind a container restart.
  if (segs[0] === "judge" && segs.length === 1) {
    if (m === "GET") return fromResult(await admin.getJudgeConfigAdmin());
    if (m === "POST") {
      const b = (await readJsonObject(req)) ?? {};
      const patch: { mode?: "off" | "shadow" | "enforce"; minTakes?: number; model?: string | null } = {};
      if (b.mode !== undefined) {
        if (b.mode !== "off" && b.mode !== "shadow" && b.mode !== "enforce") {
          return { status: 400, body: { error: "mode must be off|shadow|enforce" } };
        }
        patch.mode = b.mode;
      }
      if (b.minTakes !== undefined) {
        const minTakes = Number(b.minTakes);
        if (!Number.isInteger(minTakes) || minTakes < 1) return { status: 400, body: { error: "minTakes must be a positive integer" } };
        patch.minTakes = minTakes;
      }
      if (b.model !== undefined) {
        // `null` unsets the model — that is how an operator stops model prose
        // without stopping the judge.
        if (b.model === null) patch.model = null;
        else if (typeof b.model === "string" && b.model.trim() !== "" && b.model.length <= 200) patch.model = b.model.trim();
        else return { status: 400, body: { error: "model must be a non-empty string (max 200 chars), or null" } };
      }
      if (patch.mode === undefined && patch.minTakes === undefined && patch.model === undefined) {
        return { status: 400, body: { error: "mode, minTakes or model required" } };
      }
      return fromResult(await admin.setJudgeConfigAdmin(patch));
    }
    return { status: 404, body: { error: "unknown judge admin route" } };
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
