// AC4 (issue #480) and issue #892 (website-server split): the CUTOVER HOST
// actually executes the prerender in its deploy path, and that deploy path is
// a PLAIN STATIC FILE SERVER — no Bun/Node app layer anywhere in the response
// path. This is the end-to-end half of both claims, and the only one that can
// catch either regression: #480's was every route on the cutover origin
// unfurling as the home page because the serving process answered every
// extensionless path with `STATIC_DIR/index.html`; #892's is a docs route (or
// any other) shipping a bare shell because inlining silently moved back to
// request time, or never ran at all once `serveStatic`/`docsShell` were
// deleted from the api process.
//
// It exercises the REAL deploy path, not a stand-in:
//   1. `scripts/static-assembly.sh` — the same script scripts/stack/stack.ts
//      runs before `docker compose up`, producing what docker-compose.yml
//      bind-mounts into the website-server container at /srv/frontend.
//   2. `website-server/Dockerfile` — the real website-server image, built from
//      this repo's tree and run as a real container with `_static/` bind-
//      mounted read-only, answering over real HTTP. No Bun process anywhere in
//      the serving path (AC2): nginx serves the file directly.
//   3. A plain GET with no JavaScript anywhere — exactly what Slack, X,
//      LinkedIn, iMessage, WhatsApp, Telegram and Discord issue.
//
// LOUD, NEVER SKIPPED. There is no environment gate and no early return: a
// missing assembly, an image that will not build/start, or a route that falls
// back to the home-page shell all fail red. The only external resources are
// `bash`, `bun` and `docker`, all of which the integration job has by
// definition (docker is a hard dependency of this repo's test harness — the
// backend suite boots ephemeral Postgres through it).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metaFor } from "../../../frontend/public/assets/js/app/seo.js";
import { viewFor } from "../../../frontend/public/assets/js/app/routes.js";
import { publishableFragment } from "../../lib/prerender-view.ts";

const repoRoot = join(import.meta.dir, "../../..");
const ORIGIN = "https://robotmoney.network";

// AC2's named case: the exact route measured as broken on the live origin.
const ROUTE = "/research/late-cycle-signals";

let staticDir: string;
let containerId: string | undefined;
let baseUrl: string;
const IMAGE_TAG = "rm-website-server-prerender-test";

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sitemapRoutes(): string[] {
  const sitemap = readFileSync(join(repoRoot, "frontend/public/sitemap.xml"), "utf8");
  return Array.from(sitemap.matchAll(/<loc>https:\/\/robotmoney\.network([^<]*)<\/loc>/g), (m) => m[1] || "/")
    .map((r) => (!r || r === "/" ? "/" : r.replace(/\/+$/, "") || "/"));
}

function assembledRoutePath(route: string): string {
  return route === "/" ? join(staticDir, "index.html") : join(staticDir, route.slice(1), "index.html");
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
      lastErr = new Error(`unexpected status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await Bun.sleep(200);
  }
  throw new Error(`website-server did not answer ${url} within ${timeoutMs}ms: ${String(lastErr)}`);
}

describe("prerendered STATIC_DIR served by the website-server image (no Bun in the serving path)", () => {
  beforeAll(async () => {
    staticDir = mkdtempSync(join(tmpdir(), "rm-static-assembly-"));
    // mkdtempSync's default mode is 0700 — fine for the Bun process that owns
    // it, but the website-server container's nginx worker processes run as an
    // unprivileged, DIFFERENT uid and cannot even traverse a 0700 directory
    // bind-mounted in, which nginx reports as a stat() "Permission denied" on
    // every route (500, not the loud assembly failure this suite means to
    // catch). Open the mount point up; scripts/static-assembly.sh's own
    // `mkdir -p`/`cp -R`/`Bun.write` calls already leave its CONTENTS at the
    // process umask's normal, world-readable modes.
    chmodSync(staticDir, 0o755);
    // Fails loudly (non-zero exit → throw) if the assembly cannot be produced.
    execFileSync("bash", [join(repoRoot, "scripts", "static-assembly.sh"), staticDir], {
      cwd: repoRoot,
      stdio: "pipe",
    });

    // Build the REAL website-server image from the repo tree — not a stand-in
    // static-file server — so a change to nginx.conf that breaks the fallback
    // rule fails here.
    execFileSync("docker", ["build", "-t", IMAGE_TAG, join(repoRoot, "website-server")], { stdio: "pipe" });

    // Host port 0 -> Docker assigns one atomically (this repo's own port
    // convention, docker-compose.yml's header); read it back with `docker
    // port`. No `api` container is started for this test: nginx.conf's /api/
    // and /health locations resolve `api` lazily at request time (see its
    // resolver comment), so the container starts fine without one — this
    // suite never exercises those routes.
    const run = execFileSync("docker", [
      "run", "-d", "--rm",
      "-p", "127.0.0.1::8080",
      "-v", `${staticDir}:/srv/frontend:ro`,
      IMAGE_TAG,
    ]);
    containerId = run.toString().trim();

    const portOut = execFileSync("docker", ["port", containerId, "8080"]).toString().trim();
    const m = portOut.match(/:(\d+)\s*$/);
    if (!m) throw new Error(`could not parse \`docker port\` output: ${portOut}`);
    baseUrl = `http://127.0.0.1:${m[1]}`;

    await waitForReady(`${baseUrl}/`, 20_000);
  }, 120_000);

  afterAll(() => {
    if (containerId) execFileSync("docker", ["stop", containerId], { stdio: "pipe" });
    if (staticDir) rmSync(staticDir, { recursive: true, force: true });
  });

  it("assembles a per-route index.html into STATIC_DIR for every route in sitemap.xml", () => {
    const routes = sitemapRoutes();
    // Zero routes collected is a FAILURE, not a vacuous pass.
    expect(routes.length).toBeGreaterThan(0);

    const missing = routes.filter((r) => !existsSync(assembledRoutePath(r)));
    expect(missing).toEqual([]);
  });

  // Issue #892 AC1: docs routes are prerendered exactly like every other
  // sitemap route now (scripts/prerender.ts's `viewFor`/`prerenderView` loop
  // already covers them — they need no special case), so this asserts the
  // OUTCOME the deliverable actually cares about: each docs route's own
  // fragment is inlined into its own full page at build time, not left as a
  // bare shell for a request-time handler (`docsShell`) that no longer
  // exists. Exact-equality against `publishableFragment`'s own output — the
  // same transform scripts/prerender.ts applies — rather than a substring
  // probe, so a route that silently regressed to someone else's fragment
  // (or a stale one) fails here too, not just an empty-mount check.
  it("inlines every docs route's own fragment into its assembled page, not a bare shell (issue #892 AC1)", async () => {
    const docsRoutes = sitemapRoutes().filter((r) => r === "/docs" || r.startsWith("/docs/"));
    expect(docsRoutes.length).toBeGreaterThan(0);

    for (const route of docsRoutes) {
      const assembled = readFileSync(assembledRoutePath(route), "utf8");
      expect(assembled).not.toContain('<main id="view"></main>');

      const viewPath = viewFor(route).replace(/^\//, "");
      const rawFragment = await Bun.file(join(repoRoot, "frontend/public", viewPath)).text();
      const expectedFragment = await publishableFragment(rawFragment);
      expect(assembled).toContain(`<main id="view">${expectedFragment}</main>`);
    }
  });

  it("returns the route's own title, og:title, og:description and og:url over plain HTTP — never the home-page shell's", async () => {
    const res = await fetch(`${baseUrl}${ROUTE}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    const m = metaFor(ROUTE);
    const home = metaFor("/");
    // Guards the assertion below: if seo.js ever gave this route the home
    // page's title, "not the shell's" would be trivially satisfiable.
    expect(m.title).not.toBe(home.title);
    expect(m.title).toBe("Late-Cycle Signals — How Late in the Rally Are We?");

    expect(html).toContain(`<title>${escapeHtml(m.title)}</title>`);
    expect(html).toContain(`property="og:title" content="${escapeAttr(m.title)}"`);
    expect(html).toContain(`property="og:description" content="${escapeAttr(m.description)}"`);
    expect(html).toContain(`property="og:url" content="${ORIGIN}${ROUTE}"`);
    expect(html).toContain(`href="${ORIGIN}${ROUTE}"`);

    expect(html).not.toContain(`<title>${escapeHtml(home.title)}</title>`);
    expect(html).not.toContain(`property="og:title" content="${escapeAttr(home.title)}"`);
    expect(html).not.toContain(`property="og:url" content="${ORIGIN}/"`);
  });

  it("serves every sitemap route's own metadata, not just the measured one", async () => {
    const routes = sitemapRoutes();
    expect(routes.length).toBeGreaterThan(0);

    const wrong: string[] = [];
    for (const route of routes) {
      const html = await (await fetch(`${baseUrl}${route}`)).text();
      const m = metaFor(route);
      const url = ORIGIN + route;
      if (
        !html.includes(`<title>${escapeHtml(m.title)}</title>`) ||
        !html.includes(`property="og:title" content="${escapeAttr(m.title)}"`) ||
        !html.includes(`property="og:description" content="${escapeAttr(m.description)}"`) ||
        !html.includes(`property="og:url" content="${url}"`)
      ) {
        wrong.push(route);
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it("still answers a client route that is not in the sitemap with the home-page shell", async () => {
    const res = await fetch(`${baseUrl}/swarm/2026-07-30/subject`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<title>${escapeHtml(metaFor("/").title)}</title>`);
  });
});
