// The operator's maintenance-window routes (issue 1220, scope item (a)).
//
//   POST /api/admin/maintenance                 schedule  { startsAt, expectedEnd, message?, reason }
//   POST /api/admin/maintenance/:id/start       { reason, expectedEnd? }
//   POST /api/admin/maintenance/:id/end         { reason }
//   POST /api/admin/maintenance/:id/cancel      { reason }   (a scheduled window only)
//
// Every route is PRIVILEGED (isPrivileged, 403 before any body is read) and
// writes its event and exactly one audit_log row in one transaction.
import { randomUUID } from "node:crypto";
import { sql } from "../../db/client.ts";
import { recordAudit } from "../../admin/audit.ts";
import { appendWindowEvent, liveWindow, statusOf, windowState, type MaintenanceEvent } from "../../ops/maintenance.ts";
import { isPrivileged } from "../auth.ts";

type Result = { status: number; body: unknown };
const FORBIDDEN: Result = { status: 403, body: { error: "admin authorization required" } };
const bad = (error: string): Result => ({ status: 400, body: { error } });

class Invalid extends Error {}

function fields(body: unknown, allowed: string[]): Record<string, unknown> {
  if (body == null || typeof body !== "object" || Array.isArray(body)) throw new Invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new Invalid(`unknown field(s): ${unknown.join(", ")}`);
  return b;
}

function reasonOf(raw: unknown): string {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length < 10 || reason.length > 500) throw new Invalid("reason must be 10..500 characters");
  return reason;
}

function instantOf(raw: unknown, name: string): Date {
  const d = typeof raw === "string" ? new Date(raw) : new Date(Number.NaN);
  if (Number.isNaN(d.getTime())) throw new Invalid(`${name} must be an ISO-8601 instant`);
  return d;
}

const ID = /^\/api\/admin\/maintenance\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(start|end|cancel)$/;

export async function handleAdminMaintenance(req: Request, url: URL): Promise<Result | null> {
  const p = url.pathname;
  const isSchedule = p === "/api/admin/maintenance";
  const m = ID.exec(p);
  if (req.method !== "POST" || (!isSchedule && !m)) return null;
  if (!await isPrivileged(req)) return FORBIDDEN;
  try {
    const body = await req.json().catch(() => null);
    return isSchedule ? await schedule(body) : await transition(m![1]!, m![2] as "start" | "end" | "cancel", body);
  } catch (e) {
    if (e instanceof Invalid) return bad(e.message);
    throw e;
  }
}

async function schedule(body: unknown): Promise<Result> {
  const b = fields(body, ["startsAt", "expectedEnd", "message", "reason"]);
  const reason = reasonOf(b.reason);
  const startsAt = instantOf(b.startsAt, "startsAt");
  const expectedEnd = instantOf(b.expectedEnd, "expectedEnd");
  if (expectedEnd <= startsAt) throw new Invalid("expectedEnd must be after startsAt");
  if (expectedEnd.getTime() <= Date.now()) throw new Invalid("expectedEnd must be in the future");
  const message = b.message === undefined ? "" : typeof b.message === "string" ? b.message.trim() : null;
  if (message === null || message.length > 500) throw new Invalid("message must be a string of at most 500 characters");

  return await sql.begin(async (tx) => {
    if (await liveWindow(tx)) {
      return { status: 409, body: { error: "a maintenance window is already scheduled or active", code: "window_live" } } as Result;
    }
    const windowId = randomUUID();
    await appendWindowEvent(tx, { windowId, event: "scheduled", startsAt, expectedEnd, message, actor: "admin" });
    const after = { state: "scheduled", startsAt: startsAt.toISOString(), expectedEnd: expectedEnd.toISOString(), message };
    const audit = await recordAudit(tx, {
      actor: "admin", action: "maintenance_schedule", targetType: "maintenance_window", targetId: windowId,
      reason, beforeState: null, afterState: after,
    });
    return { status: 201, body: { windowId, ...after, auditRequestId: audit.request_id } } as Result;
  });
}

const NEXT: Record<"start" | "end" | "cancel", { from: MaintenanceEvent; to: MaintenanceEvent }> = {
  start: { from: "scheduled", to: "started" },
  end: { from: "started", to: "ended" },
  cancel: { from: "scheduled", to: "cancelled" },
};

async function transition(windowId: string, action: "start" | "end" | "cancel", body: unknown): Promise<Result> {
  const b = fields(body, action === "start" ? ["reason", "expectedEnd"] : ["reason"]);
  const reason = reasonOf(b.reason);
  const newEnd = b.expectedEnd === undefined ? null : instantOf(b.expectedEnd, "expectedEnd");

  return await sql.begin(async (tx) => {
    const current = await windowState(tx, windowId);
    if (!current) return { status: 404, body: { error: "maintenance window not found" } } as Result;
    const { from, to } = NEXT[action];
    if (current.event !== from) {
      return {
        status: 409,
        body: { error: `only a ${from} window can be ${action === "end" ? "ended" : action === "start" ? "started" : "cancelled"}`, code: "invalid_transition", current: current.event },
      } as Result;
    }
    const startsAt = action === "start" ? new Date() : new Date(current.starts_at);
    const expectedEnd = newEnd ?? new Date(current.expected_end);
    if (action === "start" && expectedEnd <= startsAt) throw new Invalid("expectedEnd must be in the future");
    await appendWindowEvent(tx, {
      windowId, event: to, startsAt, expectedEnd,
      message: current.message, actor: "admin",
    });
    const before = statusOf(current);
    const audit = await recordAudit(tx, {
      actor: "admin", action: `maintenance_${action}`, targetType: "maintenance_window", targetId: windowId,
      reason, beforeState: before,
      afterState: { state: to === "started" ? "active" : "none", startsAt: startsAt.toISOString(), expectedEnd: expectedEnd.toISOString() },
    });
    return { status: 200, body: { windowId, event: to, auditRequestId: audit.request_id } } as Result;
  });
}
