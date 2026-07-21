// Preview server — the thin, backend-free way to view the marketing surface
// (the buildless SPA under frontend/public) while developing it.
//
//   bun run preview            # → binds a RANDOM free port (printed on start)
//   PORT=8080 bun run preview  # pin a port explicitly
//
// It serves the LIVE frontend/public tree (edits show on refresh — no build) and
// MOCKS every /api/* route from the committed goldens (goldens/api-goldens.json),
// so no backend, database, or workers are needed. The SPA is unmodified: it still
// requests same-origin /api/*, and this server answers from the goldens.
//
// DATA FIDELITY: the goldens carry REAL field shapes but MOCK / point-in-time
// VALUES. Use preview to build and review layout, copy, and components — NOT to
// trust the numbers. For realistic, evolving data run the full stack:
//   bun run demo   (see docs/demo-spec.md)
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { injectSiteMeta, SITE_REDIRECTS } from "@robotmoney/contract";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(repoRoot, "frontend/public");
const GOLDENS = join(repoRoot, "goldens/api-goldens.json");
// Default to a random free port (0) so concurrent previews never collide; an
// explicit PORT pins it.
const PORT = process.env.PORT ? Number(process.env.PORT) : 0;

if (!existsSync(GOLDENS)) {
  console.error(`no goldens at ${GOLDENS} — capture them with \`bun run goldens:update\` first`);
  process.exit(1);
}
const goldens = (await Bun.file(GOLDENS).json()) as { routes: Record<string, unknown> };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);

    const redirect = SITE_REDIRECTS[path];
    if (redirect && (req.method === "GET" || req.method === "HEAD")) {
      return new Response(null, { status: 301, headers: { Location: `${redirect}${url.search}` } });
    }

    // Mock the API from the goldens: GETs by pathname (query dropped — a golden
    // is one point in time); writes are accepted no-ops (no mutable state here).
    if (path.startsWith("/api/") || path === "/health") {
      if (req.method !== "GET") return json({ ok: true, mocked: true });
      if (path in goldens.routes) return json(goldens.routes[path]);
      return json({ error: "no golden for route", path }, 404);
    }

    // Live static SPA, with an index.html fallback for client routes (/regime …).
    const file = Bun.file(join(PUBLIC, path === "/" ? "/index.html" : path));
    if (await file.exists()) {
      if (path === "/") {
        return new Response(injectSiteMeta(await file.text(), path), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response(file);
    }
    const shell = Bun.file(join(PUBLIC, "index.html"));
    return new Response(injectSiteMeta(await shell.text(), path), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

console.log(`preview:  http://127.0.0.1:${server.port}/  (serving live frontend/public, /api/* mocked from goldens)`);
console.log(`fidelity: real shapes, mock values — run \`bun run demo\` for realistic data.  Ctrl-C to stop.`);
