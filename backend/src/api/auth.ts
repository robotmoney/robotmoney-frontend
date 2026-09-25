// Shared API credential checks (issue #106 extracted these from the swarm
// router so the /api/analytics boundary reuses the SAME idioms instead of
// growing a second implementation).
//
// Roles (docs/architecture.md §9.8), after D52 (1) retired every env-held
// service secret into the API's automation-token store (issue #1026, smoke
// spec §3):
//  • admin              — isPrivileged(): an unexpired admin session, the
//    operator's store token (right `admin`), or the claimed admin_credential
//    password (D32). There is no `ADMIN_TOKEN` any more.
//  • system-scheduler   — hasAutomationRight(read_subjects | read_sessions |
//    lifecycle_transitions). The epoch lifecycle routes accept this and
//    nothing else (D55 (4)).
//  • analytics-provider — hasAnalyticsProviderRole(): the producer's store
//    token (right `analytics_ingestion`). The ONLY role that may write
//    analytics data (regime submission + /api/analytics/*). There is no shared
//    `ANALYTICS_TOKEN` any more.
//  • member             — swarm_member_keys bearer (checked in the swarm
//    domain layer, not here).
//
// FAIL-CLOSED, WITH NO OPT-OUT. A service token is valid when, and only when,
// its hash is a row in `automation_tokens` carrying the right asked for. No env
// value is consulted, and no deployment flag (`RM_ALLOW_INSECURE`,
// `RM_ENV=ephemeral`) stands in for a missing or wrong credential: "a file on
// disk establishes nothing by itself" (smoke spec §3), and neither does the
// absence of one. Each check asks for ONE right, so no holder's token
// substitutes for another's — the scheduler's cannot administer, the
// operator's cannot drive an epoch, the producer's can do neither.
import { timingSafeEqual } from "node:crypto";
import { sql } from "../db/client.ts";
import { hashKey } from "../lib/keys.ts";
import { lookupAutomationToken, type AutomationGrant, type AutomationRight } from "../db/automation-tokens.ts";

export type { AutomationGrant, AutomationRight } from "../db/automation-tokens.ts";

export function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

/**
 * The grant behind a presented service token, or null.
 *
 * A service token is presented as `X-Automation-Token` (what system-scheduler
 * sends) or as a Bearer (what the analytics producer sends). The store is read
 * and nothing else: a token that matches no row is refused.
 */
export async function automationTokenGrant(req: Request): Promise<AutomationGrant | null> {
  return lookupAutomationToken(req.headers.get("X-Automation-Token") ?? bearer(req));
}

/** Does the caller's store token hold `right`? No row, no right. */
export async function hasAutomationRight(req: Request, right: AutomationRight): Promise<boolean> {
  const grant = await automationTokenGrant(req);
  return grant !== null && grant.rights.includes(right);
}

/**
 * The operator's service token (smoke spec §3: "the admin routes; this
 * replaces the `ADMIN_TOKEN` environment variable").
 *
 * Accepted where `ADMIN_TOKEN` was presented, as `X-Admin-Token`, and where
 * every other service token is presented, so an operator command needs no
 * header of its own. Either way it is the store row's `admin` right that
 * authorizes, never the header it arrived in.
 */
async function hasOperatorRight(req: Request): Promise<boolean> {
  const asAdminHeader = await lookupAutomationToken(req.headers.get("X-Admin-Token"));
  if (asAdminHeader?.rights.includes("admin")) return true;
  return hasAutomationRight(req, "admin");
}

// admin role (issue #553 / D32, D52 (1)).
//
// Three credentials open it, each a durable server-side record:
//  • an unexpired admin_session (a passkey login), as X-Admin-Token;
//  • the operator's store token with the `admin` right. This is also the
//    UNCLAIMED-setup credential: on a fresh instance with no admin_credential
//    row it is what `POST /api/admin/claim` accepts, where an env
//    `ADMIN_TOKEN` used to be;
//  • once claimed, the admin_credential password, as X-Admin-Token.
// Nothing else, in any env.
//
// Fail-closed AND loud: a database failure propagates to the router's
// sanitized 500 — never a silent grant.
export async function isPrivileged(req: Request): Promise<boolean> {
  const presented = req.headers.get("X-Admin-Token");
  if (presented) {
    const session = await sql`SELECT 1 FROM admin_session WHERE token = ${hashKey(presented)} AND expires_at > now()`;
    if (session.length > 0) return true;
  }
  if (await hasOperatorRight(req)) return true;
  if (!presented) return false;
  const claimed = await sql<{ pass_hash: string }[]>`SELECT pass_hash FROM admin_credential WHERE id = 1`;
  if (claimed.length === 0) return false;
  const expected = Buffer.from(claimed[0].pass_hash, "hex");
  const got = Buffer.from(hashKey(presented), "hex");
  return expected.length === got.length && timingSafeEqual(got, expected);
}

// analytics-provider role: the producer's store token, `analytics_ingestion`.
export async function hasAnalyticsProviderRole(req: Request): Promise<boolean> {
  return hasAutomationRight(req, "analytics_ingestion");
}
