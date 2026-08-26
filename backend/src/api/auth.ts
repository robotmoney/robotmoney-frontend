// Shared API credential checks (issue #106 extracted these from the swarm
// router so the /api/analytics boundary reuses the SAME idioms instead of
// growing a second implementation).
//
// Roles (docs/architecture.md §9.8):
//  • host/admin         — isPrivileged() (claimed admin_credential hash or
//    ADMIN_TOKEN as X-Admin-Token before setup is claimed; see D32 / issue #584).
//  • automation         — hasAutomationRole() (AUTOMATION_TOKEN as
//    X-Automation-Token), for stack-internal drivers only.
//  • analytics-provider — hasAnalyticsProviderRole() (ANALYTICS_TOKEN bearer). The
//    ONLY role that may write analytics data (regime recompute + /api/analytics/*).
//  • member             — swarm_member_keys bearer (checked in the swarm
//    domain layer, not here).
//
// Fail-closed: a configured token (constant-time compared) authorizes in any
// env; WITHOUT a token the role opens only when config.allowInsecure
// (RM_ENV=ephemeral / explicit RM_ALLOW_INSECURE=1). smoke/prod with no token →
// locked. ADMIN_TOKEN and member bearers are NEVER substitutes for the
// analytics-provider credential (distinct comparisons against distinct secrets).
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";
import { sql } from "../db/client.ts";
import { hashKey } from "../lib/keys.ts";

export function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

// Constant-time secret comparison (over fixed-length sha256 hashes so lengths
// always match and timing doesn't leak the secret).
export function secretEq(presented: string | null, expected: string): boolean {
  const a = createHash("sha256").update(presented ?? "").digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// host/admin role, presented as X-Admin-Token (issue #553 / D32).
//
// Two-tier credential:
//  • CLAIMED (admin_credential row present): the persisted hash is the durable
//    operator credential — it survives restarts, so the per-boot mint can no
//    longer rotate the operator out. The per-boot ADMIN_TOKEN setup value is
//    revoked unconditionally; stack-internal drivers use the separate
//    AUTOMATION_TOKEN role. allowInsecure stops opening this gate once a claim
//    exists: a claim is an explicit security opt-in.
//  • UNCLAIMED (no row): exactly the historical behaviour — ADMIN_TOKEN if
//    configured, else allowInsecure.
//
// Fail-closed AND loud: a database failure propagates to the router's
// sanitized 500 — never silently fall back to the env token while a claim
// might exist.
export async function isPrivileged(req: Request, cfg: Pick<typeof config, "adminToken" | "allowInsecure"> = config): Promise<boolean> {
  const presented = req.headers.get("X-Admin-Token");
  if (presented) {
    const session = await sql`SELECT 1 FROM admin_session WHERE token = ${hashKey(presented)} AND expires_at > now()`;
    if (session.length > 0) return true;
  }
  const claimed = await sql<{ pass_hash: string }[]>`SELECT pass_hash FROM admin_credential WHERE id = 1`;
  if (claimed.length > 0) {
    const expected = Buffer.from(claimed[0].pass_hash, "hex");
    const got = Buffer.from(hashKey(presented ?? ""), "hex");
    if (expected.length === got.length && timingSafeEqual(got, expected)) return true;
    return false;
  }
  return cfg.adminToken ? secretEq(presented, cfg.adminToken) : cfg.allowInsecure;
}

// automation role: AUTOMATION_TOKEN presented as X-Automation-Token or Bearer.
export function hasAutomationRole(
  req: Request,
  cfg: Pick<typeof config, "allowInsecure"> & { automationToken?: string | null } = config,
): boolean {
  const presented = req.headers.get("X-Automation-Token") ?? bearer(req);
  return cfg.automationToken ? secretEq(presented, cfg.automationToken) : cfg.allowInsecure;
}

// analytics-provider role: ANALYTICS_TOKEN presented as a Bearer token.
export function hasAnalyticsProviderRole(
  req: Request,
  cfg: Pick<typeof config, "analyticsToken" | "allowInsecure"> = config,
): boolean {
  return cfg.analyticsToken ? secretEq(bearer(req), cfg.analyticsToken) : cfg.allowInsecure;
}
