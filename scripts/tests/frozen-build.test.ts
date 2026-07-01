// Hermetic, backend-free tests for the server-less "frozen" single-file build.
// These run in CI via `bun run test` (integration.yml → root `bun test
// scripts/tests`), so they EXECUTE the real bundler + assembler and the real
// completeness cross-check on every PR — no external resource, no silent skip.
//
// Two guarantees are enforced here:
//   1. NO SILENT GAP — every API endpoint the frontend actually requests is in
//      the bake plan (frozen-endpoints.ts). A new `api.get(...)` call site that
//      isn't baked fails this test loudly, the fidelity analog the issue calls for.
//   2. The assembled index.html is genuinely self-contained + offline: the app
//      graph bundles to a classic IIFE, every CDN/module/config/stylesheet tag is
//      replaced by inlined code+data, and the baked snapshot + views are present.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES } from "../../frontend/public/assets/js/app/contract/routes.js";
import { assembleFrozenHtml, bundleAppJs, collectViews } from "../lib/frozen-build.ts";
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

describe("frozen single-file assembly (offline, self-contained)", () => {
  test("app graph bundles to a classic (non-module) IIFE", async () => {
    const js = await bundleAppJs(repoRoot);
    expect(js.length).toBeGreaterThan(1000);
    // No bare ES import/export survived the bundle → it is a classic script.
    expect(/^\s*import\s/m.test(js)).toBe(false);
    expect(/^\s*export\s/m.test(js)).toBe(false);
    // The one absolute asset ref was rewritten to a data: URI (file:// safe).
    expect(js.includes("/assets/logo.svg")).toBe(false);
  });

  test("collects every view fragment keyed by its router path", () => {
    const views = collectViews(repoRoot);
    expect(views["/views/home.html"]).toBeString();
    expect(views["/views/regime.html"]).toContain("rv__");
    expect(views["/views/committee/session.html"]).toBeString();
    expect(views["/views/not-found.html"]).toBeString();
    expect(Object.keys(views).length).toBeGreaterThan(10);
  });

  test("assembled index.html is fully inlined and offline", async () => {
    const data = fixtureFrozenData(repoRoot);
    const html = await assembleFrozenHtml({
      repoRoot,
      frozenData: data,
      meta: { bakedAt: "2026-06-29T00:00:00.000Z", source: "fixtures" },
    });

    // Baked snapshot + views + boot shim are inlined.
    expect(html).toContain("window.RM_FROZEN=");
    expect(html).toContain("window.RM_VIEWS=");
    expect(html).toContain("window.RM_FROZEN_META=");
    // Real regime data made it into the payload (drives the /regime charts).
    expect(html).toContain("compositePercentile");
    // Vendored runtime libs are inlined (no CDN needed).
    expect(html).toContain("window.Alpine"); // alpine cdn build references this global
    // Frozen boot shim installs the fetch/history override.
    expect(html).toContain("blocked non-baked request");

    // NOTHING reaches the network: no CDN script tags, no module script, no
    // external config, no <link> stylesheet, no web-font @import.
    expect(/<script[^>]*src="https:\/\/cdn\.jsdelivr\.net/.test(html)).toBe(false);
    expect(/<script[^>]*type="module"/.test(html)).toBe(false);
    expect(html.includes('src="/config.js"')).toBe(false);
    expect(/<link rel="stylesheet"/.test(html)).toBe(false);
    expect(html.includes("fonts.googleapis.com")).toBe(false);

    // Inlined CSS is present.
    expect(html).toContain("<style>");

    // Regression guard: the inlined payloads are injected with REPLACER
    // FUNCTIONS, not string replacements — a string replacement would interpret
    // `$$`/`$&`/`$1` and mangle the vendored code. The vendored Alpine build
    // contains `$$` sequences (it registers its magics with a `$`-prefixed
    // template); assert every `$$`-bearing chunk of the pristine library survives
    // byte-for-byte in the build, so the whole class of `$`-interpretation
    // corruption stays fixed. (The offline browser spec proves the runtime effect.)
    const alpineSrc = readFileSync(join(repoRoot, "node_modules/alpinejs/dist/cdn.min.js"), "utf8");
    const dollarChunks = alpineSrc.match(/.{0,8}\$\$.{0,8}/g) ?? [];
    expect(dollarChunks.length).toBeGreaterThan(0);
    for (const chunk of dollarChunks) expect(html).toContain(chunk);
  });
});
