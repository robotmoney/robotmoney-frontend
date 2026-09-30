// The assembled site's JavaScript is cache-busted (docs/technical/static-asset-cache.md, C3): every module import, and
// the entry point in index.html, carries one `?v=<stamp>` derived from the scripts' content.
//
// This runs the REAL thing in Chromium: it stamps a copy of frontend/public with scripts/stamp-assets.ts, serves it
// behind a server that sends Cloudflare's 4-hour `max-age=14400` on scripts and styles (what readers get today), and
// checks what the browser does. The last test is the point of the whole change: release 1 is loaded and cached, one
// script changes, release 2 is stamped, and a reload in the SAME browser must fetch every module fresh, because no
// module URL is one the cache has ever seen.
//
// No network and no Docker: no prerender, no API. The API calls fail against this static server, which the page
// tolerates; only module loading is asserted.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";

const repoRoot = process.cwd();
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".xml": "application/xml", ".txt": "text/plain",
};

let work: string;
let server: Server;
let root: string;
let origin: string;
const hits: string[] = [];

function assemble(name: string, edit?: (dir: string) => void, opts: { stamp?: boolean } = {}): string {
  const dir = join(work, name);
  cpSync(join(repoRoot, "frontend/public"), dir, { recursive: true });
  edit?.(dir);
  if (opts.stamp === false) return dir; // the control: the site as it is served without this change
  const r = spawnSync("bun", ["scripts/stamp-assets.ts", dir], { cwd: repoRoot, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stamping failed: ${r.stdout}${r.stderr}`);
  return dir;
}

const stampOf = (dir: string) => readFileSync(join(dir, "index.html"), "utf8").match(/main\.js\?v=([0-9a-f]{8})/)![1]!;

test.beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "stamped-assets-"));
  root = assemble("release-1");
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(req.url ?? "");
    let file = join(root, normalize(decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (url.pathname.startsWith("/api/") || extname(url.pathname) !== "") { res.writeHead(404).end("not found"); return; }
      file = join(root, "index.html"); // client routes fall back to the shell, as nginx does
    }
    const ext = extname(file);
    // What Cloudflare tells browsers today for scripts and styles (docs/technical/static-asset-cache.md §3); HTML never.
    const cacheable = ext === ".js" || ext === ".css";
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": cacheable ? "public, max-age=14400" : "no-cache",
    });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(work, { recursive: true, force: true });
});

/** Loads a route and returns every application-script request the page made, with its response status. */
async function loadAndCollect(page: Page, route: string) {
  const seen: { url: string; status: number; fromCache: boolean }[] = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("response", (r) => {
    if (new URL(r.url()).pathname.startsWith("/assets/js/app/")) seen.push({ url: r.url(), status: r.status(), fromCache: r.fromServiceWorker() });
  });
  await page.goto(`${origin}${route}`, { waitUntil: "networkidle" });
  return { seen, errors };
}

test("every module of the assembled site loads once, under one stamped URL, with no failed request", async ({ page }) => {
  const stamp = stampOf(root);
  const { seen, errors } = await loadAndCollect(page, "/");

  expect(seen.length, "the page loaded the module graph").toBeGreaterThan(20);
  expect(seen.filter((s) => s.status >= 400), "no module request failed").toEqual([]);
  expect(seen.filter((s) => !s.url.endsWith(`?v=${stamp}`)), `every module URL carries ?v=${stamp}`).toEqual([]);

  // Each module path exactly once: two URLs for one path would be two instances of the module.
  const byPath = new Map<string, string[]>();
  for (const s of seen) {
    const p = new URL(s.url).pathname;
    byPath.set(p, [...(byPath.get(p) ?? []), s.url]);
  }
  const duplicated = [...byPath].filter(([, urls]) => new Set(urls).size > 1);
  expect(duplicated, "no module loaded under two URLs").toEqual([]);

  expect(errors.filter((e) => /module|import|SyntaxError|dynamically imported/i.test(e)), "no module-loading error").toEqual([]);
  expect(await page.evaluate(() => typeof (window as unknown as { Alpine?: unknown }).Alpine), "the app booted").not.toBe("undefined");
});

test("a dynamic import() is stamped too: the vaults page loads its lazy modules under the same stamp", async ({ page }) => {
  const stamp = stampOf(root);
  const { seen, errors } = await loadAndCollect(page, "/vaults");
  const lazy = seen.filter((s) => /\/lib\/vault-(source|data)\.js/.test(s.url));
  expect(lazy.length, "vault-source.js / vault-data.js were loaded").toBeGreaterThan(0);
  expect(lazy.filter((s) => !s.url.endsWith(`?v=${stamp}`) || s.status >= 400)).toEqual([]);
  expect(errors.filter((e) => /dynamically imported|module/i.test(e))).toEqual([]);
});

test("release 2 after release 1, in the same browser, with scripts cached for 4 hours: nothing stale can be served", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const v1 = stampOf(root);

  // Release 1: load it, so every script is now in this browser's HTTP cache with max-age=14400.
  const first = await loadAndCollect(page, "/");
  expect(first.seen.every((s) => s.url.endsWith(`?v=${v1}`))).toBe(true);

  // Release 2: ONE script changes (substrate.js, which main.js imports at the top of the graph).
  const marker = "/* release-2-marker */";
  root = assemble("release-2", (dir) => {
    const f = join(dir, "assets/js/app/alpine/substrate.js");
    writeFileSync(f, `${readFileSync(f, "utf8")}\n${marker}\n`);
  });
  const v2 = stampOf(root);
  expect(v2, "a changed script changes the stamp").not.toBe(v1);

  hits.length = 0;
  const bodies: Record<string, string> = {};
  page.on("response", async (r) => {
    if (r.url().includes("/alpine/substrate.js")) bodies[r.url()] = await r.text().catch(() => "");
  });
  const second = await loadAndCollect(page, "/");

  expect(second.seen.filter((s) => !s.url.endsWith(`?v=${v2}`)), "every module URL is release 2's").toEqual([]);
  const requested = new Set(hits.filter((h) => h.startsWith("/assets/js/app/")));
  const stale = [...requested].filter((h) => h.endsWith(`?v=${v1}`));
  expect(stale, "the browser asked for no release-1 module").toEqual([]);
  expect(second.seen.length, "the whole graph was fetched, none of it served from the cache").toBe(requested.size);
  const substrate = Object.entries(bodies).find(([u]) => u.endsWith(`?v=${v2}`));
  expect(substrate?.[1], "the changed script's new bytes were the ones loaded").toContain(marker);
  await context.close();
});

test("CONTROL: the same release switch WITHOUT stamping serves the old script from the cache (the bug this change fixes)", async ({ browser }) => {
  const marker = "/* release-2-marker */";
  root = assemble("control-1", undefined, { stamp: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await loadAndCollect(page, "/"); // release 1 is now cached for 4 hours

  root = assemble("control-2", (dir) => {
    const f = join(dir, "assets/js/app/alpine/substrate.js");
    writeFileSync(f, `${readFileSync(f, "utf8")}\n${marker}\n`);
  }, { stamp: false });

  hits.length = 0;
  await loadAndCollect(page, "/");
  const asked = hits.filter((h) => h.startsWith("/assets/js/app/"));
  expect(asked, "without a stamp the reload asks the server for none of the cached scripts").toEqual([]);
  // The page is release 2's, the scripts it runs are release 1's: the mixed state that breaks components.
  const served = await page.evaluate(async () => (await (await fetch("/assets/js/app/alpine/substrate.js")).text()));
  expect(served, "the cached (old) script, not release 2's").not.toContain(marker);
  await context.close();
});
