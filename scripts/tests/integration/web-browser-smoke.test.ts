// W08's browser smoke is read only, executed (issue 1606, D81 live-check amendment).
//
// A real headless Chromium (scripts/release/web-browser-smoke.ts runBrowserSmoke,
// launched with the sandbox on, as W01 and W08 launch it) loads a page from a
// tiny local server. The page POSTs to the api and loads Cloudflare edge
// scripts under /cdn-cgi/. The server records every request it receives: the
// POST must be answered 204 inside the browser and never reach it, no
// /cdn-cgi/ request may reach it, and the page's own GET must.
//
// Needs Playwright's Chromium (bunx playwright install chromium) and a host
// that can start Chromium's sandbox; integration.yml installs it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { judgeLoad, type PageReport } from "../../release/web-release-lib.ts";
import { runBrowserSmoke } from "../../release/web-browser-smoke.ts";

const PAGE = `<!doctype html><html><head><script src="/cdn-cgi/zaraz/i.js"></script></head><body><div id="view"></div><script>
(async () => {
  const data = await (await fetch("/data.json")).json();
  const post = await fetch("/api/swarm/apply", { method: "POST", body: "{}" });
  await fetch("/cdn-cgi/rum", { method: "POST", body: "x" });
  document.getElementById("view").textContent = data.ok + " " + post.status;
  document.documentElement.dataset.routed = location.pathname;
})();
</script></body></html>`;

const seen: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let origin = "";
let report: PageReport;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      seen.push(`${req.method} ${u.pathname}`);
      if (u.pathname === "/data.json") return Response.json({ ok: "served" });
      if (u.pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html" } });
      return new Response("reached the origin", { status: 418 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  [report] = await runBrowserSmoke(origin, ["/"], 60_000);
}, 120_000);

afterAll(() => server?.stop(true));

describe("the browser smoke never writes to the origin", () => {
  test("the page loaded, reached its ready signal and has no problem", () => {
    expect(report.ready).toBe(true);
    expect(judgeLoad(origin, report).problems).toEqual([]);
  });

  test("the page's POST was answered inside the browser and never reached the server", () => {
    expect(report.blocked).toContain(`POST ${origin}/api/swarm/apply`);
    expect(seen.filter((s) => !s.startsWith("GET "))).toEqual([]);
  });

  test("no /cdn-cgi/ request reached the server; each was stubbed in the browser", () => {
    expect(seen.some((s) => s.includes("/cdn-cgi/"))).toBe(false);
    expect(report.stubbed).toEqual(expect.arrayContaining(["GET /cdn-cgi/zaraz/i.js", "POST /cdn-cgi/rum"]));
  });

  test("the page's own GETs did reach the server", () => {
    expect(seen).toEqual(expect.arrayContaining(["GET /", "GET /data.json"]));
  });
});
