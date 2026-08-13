// AC4 (issue #480), api-process branch: the CUTOVER HOST actually executes the
// prerender in its deploy path. This is the end-to-end half of that claim, and
// the only one that can catch the regression the issue reports — every route on
// the cutover origin unfurled as the home page because the api answered every
// extensionless path with `STATIC_DIR/index.html`.
//
// It exercises the REAL deploy path, not a stand-in:
//   1. `scripts/static-assembly.sh` — the same script scripts/stack/stack.ts
//      runs before `docker compose up`, producing what docker-compose.yml
//      bind-mounts at /srv/frontend.
//   2. `backend/src/api/index.ts` — the real api entrypoint (Bun.serve), booted
//      with STATIC_DIR pointed at that assembly, answering over real HTTP.
//   3. A plain GET with no JavaScript anywhere — exactly what Slack, X,
//      LinkedIn, iMessage, WhatsApp, Telegram and Discord issue.
//
// LOUD, NEVER SKIPPED. There is no environment gate and no early return: a
// missing assembly, an api that will not boot, or a route that falls back to
// the home-page shell all fail red. The only external resources are `bash` and
// `bun`, both of which the integration job has by definition.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metaFor } from "../../../frontend/public/assets/js/app/seo.js";

const repoRoot = join(import.meta.dir, "../../..");
const ORIGIN = "https://robotmoney.network";

// AC2's named case: the exact route measured as broken on the live origin.
const ROUTE = "/research/late-cycle-signals";

let staticDir: string;
let api: ReturnType<typeof Bun.spawn> | undefined;
let baseUrl: string;

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// The api prints `api listening on :<port>` once Bun.serve has bound. API_PORT=0
// makes the kernel choose, so the port is READ BACK from the process rather than
// drawn in advance — the same reason docker-compose.yml lets Docker assign.
async function readListeningPort(proc: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  const decoder = new TextDecoder();
  let seen = "";
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      Bun.sleep(deadline - Date.now()).then(() => ({ done: true, value: undefined as Uint8Array | undefined })),
    ]);
    if (chunk.value) seen += decoder.decode(chunk.value, { stream: true });
    const m = seen.match(/api listening on :(\d+)/);
    if (m) {
      reader.releaseLock();
      return Number(m[1]);
    }
    if (chunk.done) break;
  }
  reader.releaseLock();
  const stderr = proc.stderr instanceof ReadableStream ? await Bun.readableStreamToText(proc.stderr) : "";
  throw new Error(
    `api did not report a listening port within ${timeoutMs}ms.\nstdout: ${seen}\nstderr: ${stderr}`,
  );
}

describe("prerendered STATIC_DIR served by the api process", () => {
  beforeAll(async () => {
    staticDir = mkdtempSync(join(tmpdir(), "rm-static-assembly-"));
    // Fails loudly (non-zero exit → throw) if the assembly cannot be produced.
    execFileSync("bash", [join(repoRoot, "scripts", "static-assembly.sh"), staticDir], {
      cwd: repoRoot,
      stdio: "pipe",
    });

    api = Bun.spawn([process.execPath, join(repoRoot, "backend", "src", "api", "index.ts")], {
      cwd: join(repoRoot, "backend"),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // No database is reached: /health degrades to db:"down" and the static
        // path never touches SQL. config.ts still REQUIRES the var to exist.
        DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
        RM_ENV: "ephemeral",
        API_PORT: "0",
        STATIC_DIR: staticDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    baseUrl = `http://127.0.0.1:${await readListeningPort(api, 30_000)}`;
  }, 120_000);

  afterAll(() => {
    api?.kill();
    if (staticDir) rmSync(staticDir, { recursive: true, force: true });
  });

  it("assembles a per-route index.html into STATIC_DIR for every route in sitemap.xml", () => {
    const sitemap = readFileSync(join(repoRoot, "frontend/public/sitemap.xml"), "utf8");
    const routes = Array.from(sitemap.matchAll(/<loc>https:\/\/robotmoney\.network([^<]*)<\/loc>/g), (m) => m[1] || "/");
    // Zero routes collected is a FAILURE, not a vacuous pass.
    expect(routes.length).toBeGreaterThan(0);

    const missing = routes
      .map((r) => (!r || r === "/" ? "/" : r.replace(/\/+$/, "") || "/"))
      .filter((r) => !existsSync(r === "/" ? join(staticDir, "index.html") : join(staticDir, r.slice(1), "index.html")));
    expect(missing).toEqual([]);
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
    const sitemap = readFileSync(join(repoRoot, "frontend/public/sitemap.xml"), "utf8");
    const routes = Array.from(sitemap.matchAll(/<loc>https:\/\/robotmoney\.network([^<]*)<\/loc>/g), (m) => m[1] || "/")
      .map((r) => (!r || r === "/" ? "/" : r.replace(/\/+$/, "") || "/"));
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
