// The scheduler stream's HTTP surface — issue #1026 W4.4.
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §6.3 and §7, and
// docs/technical/smoke-production-spec.md §3.
//
// Thin transport, like every other router in this directory: it checks the
// caller's RIGHTS, parses what little there is to parse, and hands off to
// backend/src/swarm/domain.ts's stream-serving section. No decision about what to serve is made here.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT IN swarm-admin.ts
// ─────────────────────────────────────────────────────────────────────────────
//
// Two reasons, and the second is the real one.
//
//   1. `handleSwarmAdmin` returns `{status, body}`. A subscription is a live
//      `Response` with a body that never ends, and the extension contract
//      (backend/src/api/routes/swarm/types.ts) already admits a raw `Response`.
//
//   2. These are not admin routes. Every route in swarm-admin.ts is reachable
//      by an operator's admin credential; §7 says `system-scheduler` holds "an
//      API credential, an automation token with the rights to read subjects and
//      sessions and to perform lifecycle transitions", and nothing more. The
//      stream is that token's surface, so it asks for those named rights and
//      nothing else opens it — not `isPrivileged`, and not the legacy unscoped
//      env automation token except as the unscoped credential it already is
//      (see `hasAutomationRight`'s header in backend/src/api/auth.ts).
//
// THE READ ROUTES ASK FOR BOTH READ RIGHTS. §3's full read returns subjects AND
// sessions in one answer; a token holding only one of the two would otherwise
// receive the other half anyway, which would make the split meaningless.
import { ROUTES } from "@robotmoney/contract";
import { config as globalConfig } from "../../config.ts";
import { hasAutomationRight } from "../auth.ts";
import * as stream from "../../swarm/domain.ts";
import { readJsonObject } from "../validation.ts";
import type { SwarmRouteResult } from "./swarm/types.ts";

type AuthConfig = Pick<typeof globalConfig, "allowInsecure"> & { automationToken?: string | null };

const FORBIDDEN: SwarmRouteResult = { status: 403, body: { error: "forbidden" } };

const S = ROUTES.swarm.scheduler;

/**
 * Parse the subscription's cursor.
 *
 * A MISSING cursor is refused rather than defaulted to 0 or to the head. Both
 * defaults are silently wrong in opposite directions — 0 replays the whole log,
 * the head skips everything committed since the caller's snapshot — and §6.3's
 * handoff only works when the cursor is the one the full read returned. So the
 * caller says which, or gets a 400.
 */
function parseCursor(url: URL): number | null {
  const raw = url.searchParams.get("cursor");
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export async function handleSchedulerStream(
  req: Request,
  url: URL,
  cfg: AuthConfig = globalConfig,
): Promise<SwarmRouteResult | Response | null> {
  const p = url.pathname;
  const m = req.method;

  if (p === S.fullRead && m === "GET") {
    if (!(await hasAutomationRight(req, "read_subjects", cfg)) || !(await hasAutomationRight(req, "read_sessions", cfg))) {
      return FORBIDDEN;
    }
    return { status: 200, body: await stream.fullRead() };
  }

  if (p === S.subscribe && m === "GET") {
    if (!(await hasAutomationRight(req, "read_subjects", cfg)) || !(await hasAutomationRight(req, "read_sessions", cfg))) {
      return FORBIDDEN;
    }
    const cursor = parseCursor(url);
    if (cursor === null) return { status: 400, body: { error: "cursor required" } };
    return stream.openSchedulerStream(cursor);
  }

  if (p === S.jobAck && m === "POST") {
    // Acking is not a read: it retires work the API is holding for this
    // subscriber, so it asks for the transition right the scheduler's token
    // carries and a read-only token does not.
    if (!(await hasAutomationRight(req, "lifecycle_transitions", cfg))) return FORBIDDEN;
    const body = (await readJsonObject(req)) ?? {};
    const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;
    if (!key) return { status: 400, body: { error: "idempotencyKey required" } };
    const result = await stream.ackJob(key);
    if (!result.known) return { status: 404, body: { error: "unknown_job" } };
    return { status: 200, body: result };
  }

  return null;
}
