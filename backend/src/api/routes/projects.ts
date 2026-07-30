// Thin HTTP adapter for the projects directory. All query + aggregation + DTO
// logic lives in the projection layer (projects/projections.ts); this handler
// only forwards. GET /api/projects → { projects: Project[] }.
//
// Overview text (overview_short / overview_long) is ADMIN-MANAGED free text
// (issue #93): there is NO AI/LLM enrichment anywhere on this path. The only
// supported write is the privileged admin route below; the scheduled discovery
// pipeline never clobbers admin-authored overview text.
import { createHash, timingSafeEqual } from "node:crypto";
import { config as globalConfig } from "../../config.ts";
import { sql } from "../../db/client.ts";
import { fetchProjects } from "../../projects/projections.ts";
import { optionalString, readJsonObject } from "../validation.ts";

export async function getProjects() {
  return fetchProjects();
}

// Constant-time secret comparison (over fixed-length sha256 hashes so lengths
// always match and timing doesn't leak the secret) — mirrors committee.ts.
function secretEq(presented: string | null, expected: string): boolean {
  const a = createHash("sha256").update(presented ?? "").digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// Auth surface for the admin write. Injectable so tests can exercise a prod-mode
// config (token required, insecure disallowed) against the ephemeral DB.
export interface AdminAuthConfig {
  adminToken: string | null;
  allowInsecure: boolean;
}

// PATCH the admin-managed overview text for a project by slug. PRIVILEGED with
// the same guard swarm routes use: if ADMIN_TOKEN is set, require it as
// X-Admin-Token (constant-time compared); if unset, allow only outside prod
// (config.allowInsecure). Fail-closed: prod with no token → 403.
export async function updateProjectOverview(
  req: Request,
  slug: string,
  cfg: AdminAuthConfig = globalConfig,
): Promise<{ status: number; body: unknown }> {
  const privileged = cfg.adminToken
    ? secretEq(req.headers.get("X-Admin-Token"), cfg.adminToken)
    : cfg.allowInsecure;
  if (!privileged) return { status: 403, body: { error: "admin authorization required" } };

  const b = await readJsonObject(req);
  if (!b) return { status: 400, body: { error: "invalid JSON body" } };
  const overviewShort = optionalString(b, "overview_short", 2_000);
  const overviewLong = optionalString(b, "overview_long", 50_000);
  const description = optionalString(b, "description", 4_000);
  if (overviewShort === undefined && overviewLong === undefined && description === undefined) {
    return { status: 400, body: { error: "at least one of overview_short, overview_long, description required" } };
  }

  // COALESCE keeps any field the caller omitted untouched; only provided text is
  // written. No LLM call — the text is exactly what the admin supplied.
  const rows = await sql`
    UPDATE projects SET
      overview_short = COALESCE(${overviewShort ?? null}, overview_short),
      overview_long  = COALESCE(${overviewLong ?? null}, overview_long),
      description    = COALESCE(${description ?? null}, description),
      updated_at = now()
    WHERE slug = ${slug}
    RETURNING slug, overview_short, overview_long, description`;
  if (!rows.length) return { status: 404, body: { error: "project not found" } };
  return { status: 200, body: { project: rows[0] } };
}
