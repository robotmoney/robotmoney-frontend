// Shared plumbing for the `/api/admin/*` surface (issue #176 integration
// seam). The Admin surface phase (docs/plan-admin-surface.md) has five
// implementation issues converging on this dispatcher — #151 (research
// telemetry), #152 (committee admin), #155 (overview/queue/operations), plus
// two frontend issues. Rather than every issue appending `if` blocks to one
// growing `handleAdmin` function (the pre-#176 shape — a guaranteed textual
// merge-conflict magnet across parallel PRs), each domain owns one file in
// this directory that exports a single `AdminRegistrar`. `admin.ts` composes
// them in order; see that file for the composition and canonical docs.
//
// This file has NO feature behavior of its own — it only extracts the
// auth/limit primitives `backend/src/api/routes/admin.ts` already had, so the
// per-domain registrars (below and in sibling files) share one auth guard
// instead of re-implementing constant-time comparison.
import { createHash, timingSafeEqual } from "node:crypto";
import { config as globalConfig } from "../config.ts";

/** Injectable so tests can exercise a prod-mode config against the ephemeral DB. */
export interface AdminAuthConfig {
  adminToken: string | null;
  allowInsecure: boolean;
}

export interface AdminRouteResult {
  status: number;
  body: unknown;
}

/**
 * One domain's slice of `/api/admin/*`. Returns a result if it owns the
 * request, or `null` to let the next registrar (and ultimately index.ts's
 * catch-all 404) try. MUST check auth before doing any body parsing or SQL —
 * every registrar in this directory follows that rule so an unauthenticated
 * caller never causes DB work, no matter which registrar owns the path.
 */
export type AdminRegistrar = (
  req: Request,
  url: URL,
  cfg: AdminAuthConfig,
) => Promise<AdminRouteResult | null>;

export const ADMIN_FORBIDDEN: AdminRouteResult = {
  status: 403,
  body: { error: "admin authorization required" },
} as const;

// Constant-time secret comparison (over fixed-length sha256 hashes so lengths
// always match and timing doesn't leak the secret) — mirrors projects.ts.
function secretEq(presented: string | null, expected: string): boolean {
  const a = createHash("sha256").update(presented ?? "").digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function requireAdmin(req: Request, cfg: AdminAuthConfig = globalConfig): boolean {
  return cfg.adminToken
    ? secretEq(req.headers.get("X-Admin-Token"), cfg.adminToken)
    : cfg.allowInsecure;
}

// Clamp a `?limit=` query param to [1, max] with a default when unset/invalid.
// Note: an absent/empty param must fall back to `def` — `Number(null)`/`Number("")`
// are 0 (not NaN), which would otherwise clamp up to 1 and truncate the result.
export function clampLimit(raw: string | null, def = 100, max = 500): number {
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(1, Math.floor(n)));
}
