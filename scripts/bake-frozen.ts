// Bake + build the server-less "frozen" single-file SPA.
//
//   bun run scripts/bake-frozen.ts            # bake from a live backend (BACKEND_URL)
//   bun run scripts/bake-frozen.ts --fixtures # bake from committed fixtures (no backend)
//
// It snapshots every API endpoint the frontend requests (regime, research per
// key, committee members/sessions/brief, comments) into RM_FROZEN, then inlines
// the app + views + vendored libs into one dist/frozen/index.html a non-technical
// user can double-click (file://) to browse every view OFFLINE. A manifest is
// emitted; any endpoint the frontend requests that the bake could NOT satisfy
// fails the build loudly (the "no silent gap" guarantee).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleFrozenHtml, type FrozenData } from "./lib/frozen-build.ts";
import {
  memberBakeTargets,
  requiredFrozenKeys,
  sessionBakeTargets,
  staticBakeTargets,
  type BakeTarget,
} from "./lib/frozen-endpoints.ts";
import { fixtureFrozenData } from "./lib/frozen-fixtures.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const outDir = join(repoRoot, "dist", "frozen");

const useFixtures = process.argv.includes("--fixtures");
const backendUrl = (process.env.BACKEND_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");

async function fetchJson(url: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const res = await fetch(url);
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    throw new Error(`request failed for ${url}: ${e instanceof Error ? e.message : e}`);
  }
}

// Bake against a live backend: static targets first, then expand the member /
// session detail targets from the discovered list bodies.
async function bakeFromBackend(): Promise<FrozenData> {
  const data: FrozenData = {};
  const bake = async (t: BakeTarget): Promise<void> => {
    const { ok, status, body } = await fetchJson(backendUrl + t.url);
    if (!ok) throw new Error(`bake: ${t.url} returned HTTP ${status} — cannot freeze a broken endpoint`);
    data[t.key] = body;
  };

  for (const t of staticBakeTargets()) await bake(t);

  // Discover parameterised targets from the list responses just baked.
  const members = (data["/api/committee/members"] as { members?: { id: string }[] } | undefined)?.members ?? [];
  const sessions = (data["/api/committee/sessions"] as { sessions?: { date: string; subjectId: string }[] } | undefined)?.sessions ?? [];
  for (const t of memberBakeTargets(members.map((m) => m.id))) await bake(t);
  for (const t of sessionBakeTargets(sessions.map((s) => ({ date: s.date, subject: s.subjectId })))) await bake(t);

  return data;
}

async function main(): Promise<void> {
  const source = useFixtures ? "fixtures" : "backend";
  console.log(`[frozen] baking from ${source}${useFixtures ? "" : ` (${backendUrl})`}…`);

  const frozenData = useFixtures ? fixtureFrozenData(repoRoot) : await bakeFromBackend();

  // No silent gap: every endpoint the frontend requires must be present.
  const missing = requiredFrozenKeys().filter((k) => !(k in frozenData));
  if (missing.length > 0) {
    throw new Error(`[frozen] bake incomplete — missing required endpoints:\n  ${missing.join("\n  ")}`);
  }

  const bakedAt = new Date().toISOString();
  const html = await assembleFrozenHtml({
    repoRoot,
    frozenData,
    meta: { bakedAt, source, backendUrl: useFixtures ? undefined : backendUrl },
  });

  mkdirSync(outDir, { recursive: true });
  const htmlPath = join(outDir, "index.html");
  writeFileSync(htmlPath, html);

  const keys = Object.keys(frozenData).sort();
  const manifest = {
    bakedAt,
    source,
    backendUrl: useFixtures ? null : backendUrl,
    endpointCount: keys.length,
    endpoints: keys,
    bytes: Buffer.byteLength(html),
  };
  writeFileSync(join(outDir, "frozen-manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`[frozen] baked ${keys.length} endpoints → ${htmlPath} (${(manifest.bytes / 1_048_576).toFixed(2)} MB)`);
  console.log(`[frozen] frozen as-of ${bakedAt}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
