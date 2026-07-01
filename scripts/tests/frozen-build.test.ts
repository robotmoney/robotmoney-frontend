// Hermetic, backend-free tests for the server-less "frozen" static distribution.
// These run in CI via `bun run test` (integration.yml → root `bun test
// scripts/tests`), so they EXECUTE the real static-dist writer and the real
// completeness cross-check on every PR — no external resource, no silent skip.
//
// Two guarantees are enforced here:
//   1. NO SILENT GAP — every API endpoint the frontend actually requests is in
//      the bake plan (frozen-endpoints.ts). A new `api.get(...)` call site that
//      isn't baked fails this test loudly, the fidelity analog the issue calls for.
//   2. The written dist is a genuinely self-contained + offline static SPA: the
//      shell keeps its module script but pulls vendored libs locally (no CDN), the
//      web-font @import is dropped, each API snapshot is a static /data/*.json
//      file, index.html is mirrored to 404.html, and scanning the WHOLE tree
//      (every .html/.css) finds zero external resource references.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES } from "../../frontend/public/assets/js/app/contract/routes.js";
import { scanFrozenDir } from "../check-frozen-selfcontained.ts";
import { STATIC_DATA_BASE, writeFrozenDist } from "../lib/frozen-build.ts";
import {
  GET_ROUTE_TEMPLATES,
  WRITE_ROUTE_TEMPLATES,
  requiredFrozenKeys,
} from "../lib/frozen-endpoints.ts";
import { fixtureFrozenData } from "../lib/frozen-fixtures.ts";

const repoRoot = join(dirname(), "..", "..");
function dirname(): string {
  return join(fileURLToPath(import.meta.url), "..");
}

/** Resolve a dotted ROUTES path ("committee.session") to its template string. */
function resolveRoute(dotted: string): string | undefined {
  let node: unknown = ROUTES;
  for (const seg of dotted.split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return typeof node === "string" ? node : undefined;
}

/**
 * Extract every route template the frontend actually calls, by scanning the API
 * call sites (api.get / api.post / request(...) / path(ROUTES...)) in the app JS
 * for `ROUTES.<dotted>` references. This is the ground truth the bake plan must
 * cover — the source of the "no silent gap" assertion.
 */
function frontendRequestedTemplates(): Set<string> {
  const files = [
    "frontend/public/assets/js/app/lib/api.js",
    "frontend/public/assets/js/app/alpine/views.js",
    "frontend/public/assets/js/app/alpine/static-views.js",
  ];
  const referenced = new Set<string>();
  for (const rel of files) {
    const src = readFileSync(join(repoRoot, rel), "utf8");
    for (const line of src.split("\n")) {
      // Only lines that make an API request — ROUTES is used for nothing else here.
      if (!/\b(api\.(get|post|health)\b|request\(|path\(ROUTES)/.test(line)) continue;
      for (const m of line.matchAll(/ROUTES\.([A-Za-z][\w.]*)/g)) {
        const template = resolveRoute(m[1]);
        if (template) referenced.add(template);
      }
    }
  }
  return referenced;
}

describe("frozen bake plan completeness (no silent gap)", () => {
  test("every endpoint the frontend requests is in the bake plan", () => {
    const plan = new Set<string>([...GET_ROUTE_TEMPLATES, ...WRITE_ROUTE_TEMPLATES]);
    const requested = frontendRequestedTemplates();

    // Guard the scanner itself: if this ever finds nothing, the regex rotted and
    // the whole guarantee would silently pass. Require real coverage.
    expect(requested.size).toBeGreaterThan(5);

    const unbaked = [...requested].filter((r) => !plan.has(r));
    expect(unbaked).toEqual([]);
  });

  test("fixture bake satisfies every required frozen key", () => {
    const data = fixtureFrozenData(repoRoot);
    const missing = requiredFrozenKeys().filter((k) => !(k in data));
    expect(missing).toEqual([]);
  });

  test("plan GET templates all resolve to real contract routes", () => {
    // A stale template (typo / removed route) would bake nothing — catch it here.
    for (const t of GET_ROUTE_TEMPLATES) expect(typeof t).toBe("string");
    expect(GET_ROUTE_TEMPLATES).toContain(ROUTES.dashboards.regimeSnapshots);
    expect(GET_ROUTE_TEMPLATES).toContain(ROUTES.committee.brief);
  });
});

describe("frozen static distribution (offline, self-contained)", () => {
  let outDir: string;

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "frozen-dist-"));
    writeFrozenDist({
      repoRoot,
      outDir,
      frozenData: fixtureFrozenData(repoRoot),
      meta: { bakedAt: "2026-06-29T00:00:00.000Z", source: "fixtures" },
    });
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  test("index.html keeps the real SPA (module script, local vendor, nothing inlined)", () => {
    const indexPath = join(outDir, "index.html");
    expect(existsSync(indexPath)).toBe(true);
    const html = readFileSync(indexPath, "utf8");
    // The real static SPA is served over HTTP → the module entry point stays.
    expect(html).toContain('type="module"');
    // Vendored libs are pulled locally instead of from a CDN.
    expect(html).toContain("/assets/vendor/alpinejs.cdn.min.js");
    expect(html).not.toContain("cdn.jsdelivr.net");
    // Nothing is inlined into a global — the app fetches its data at runtime.
    expect(html).not.toContain("window.RM_FROZEN");
  });

  test("config.js points the SPA at its static data base", () => {
    const cfg = readFileSync(join(outDir, "config.js"), "utf8");
    expect(cfg).toContain("STATIC_DATA_BASE");
    expect(cfg).toContain(STATIC_DATA_BASE); // "/data"
  });

  test("regime snapshot is emitted as a static JSON file with the real data", () => {
    const regimePath = join(outDir, "data/api/dashboards/regime-snapshots.json");
    expect(existsSync(regimePath)).toBe(true);
    const text = readFileSync(regimePath, "utf8");
    const parsed = JSON.parse(text) as { latest?: unknown };
    expect(parsed.latest).toBeDefined();
    // Real regime data made it into the snapshot (drives the /regime charts).
    expect(text).toContain("compositePercentile");
  });

  test("health snapshot maps /health → /data/health.json", () => {
    expect(existsSync(join(outDir, "data/health.json"))).toBe(true);
  });

  test("404.html mirrors index.html for SPA deep-link refreshes", () => {
    const index = readFileSync(join(outDir, "index.html"), "utf8");
    const notFound = readFileSync(join(outDir, "404.html"), "utf8");
    expect(notFound).toBe(index);
  });

  test("web-font @import is dropped from tokens.css (fully offline)", () => {
    const css = readFileSync(join(outDir, "assets/css/tokens.css"), "utf8");
    expect(css).not.toContain("fonts.googleapis");
  });

  test("the deleted frozen-boot.js shim is not present anywhere in the dist", () => {
    const all = readdirSync(outDir, { recursive: true, encoding: "utf8" }) as string[];
    expect(all.some((rel) => rel.endsWith("frozen-boot.js"))).toBe(false);
  });

  test("scanning the WHOLE tree finds zero external resource references", () => {
    const { inspected, filesScanned, violations } = scanFrozenDir(outDir);
    // Real coverage over the whole dist: many files, many resource refs, none external.
    expect(violations).toHaveLength(0);
    expect(inspected).toBeGreaterThan(0);
    expect(filesScanned).toBeGreaterThan(1);
  });
});
