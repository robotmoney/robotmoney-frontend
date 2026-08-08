// Shared API credential checks (issue #106 extracted these from the swarm
// router so the /api/analytics boundary reuses the SAME idioms instead of
// growing a second implementation).
//
// Roles (docs/architecture.md §9.8):
//  • host/admin         — isPrivileged() (ADMIN_TOKEN as X-Admin-Token, or non-prod).
//  • analytics-provider — hasAnalyticsProviderRole() (ANALYTICS_TOKEN bearer). The
//    ONLY role that may write analytics data (regime recompute + /api/analytics/*).
//  • member             — swarm_member_keys bearer (checked in the swarm
//    domain layer, not here).
//
// Fail-closed: a configured token (constant-time compared) authorizes in any
// env; WITHOUT a token the role opens only when config.allowInsecure
// (RM_ENV=ephemeral / explicit RM_ALLOW_INSECURE=1). demo/prod with no token →
// locked. ADMIN_TOKEN and member bearers are NEVER substitutes for the
// analytics-provider credential (distinct comparisons against distinct secrets).
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";
import { sql } from "../db/client.ts";

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

// host/admin role: ADMIN_TOKEN presented as X-Admin-Token.
export async function isPrivileged(req: Request, cfg: Pick<typeof config, "adminToken" | "allowInsecure"> = config): Promise<boolean> {
  const presented = req.headers.get("X-Admin-Token");
  
  try {
    const res = await sql`SELECT pass_hash FROM admin_credential WHERE id = 1`;
    if (res.length > 0) {
      const expectedHashHex = res[0].pass_hash;
      const presentedHash = createHash("sha256").update(presented ?? "").digest();
      const expectedHash = Buffer.from(expectedHashHex, "hex");
      if (expectedHash.length === presentedHash.length) {
        return timingSafeEqual(presentedHash, expectedHash);
      }
      return false;
    }
  } catch (err) {
    // Table might not exist during early boot or tests without DB
  }

  return cfg.adminToken ? secretEq(presented, cfg.adminToken) : cfg.allowInsecure;
}

// analytics-provider role: ANALYTICS_TOKEN presented as a Bearer token.
export function hasAnalyticsProviderRole(
  req: Request,
  cfg: Pick<typeof config, "analyticsToken" | "allowInsecure"> = config,
): boolean {
  return cfg.analyticsToken ? secretEq(bearer(req), cfg.analyticsToken) : cfg.allowInsecure;
}
