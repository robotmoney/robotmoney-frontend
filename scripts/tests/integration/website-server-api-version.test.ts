// D54 (issue #1026 W7, criterion 159, second half): website-server proxies
// GET /api/version to the api.
//
// The site checks the API's version at load from its own origin, so the route
// has to reach the api THROUGH the nginx image every deployment puts in front
// of it. Nothing in website-server/nginx.conf names /api/version: it rides on
// the existing `location ^~ /api/` proxy to `api:8787`. That is exactly why it
// is graded against a real container rather than by reading the config — a
// future location block that shadowed it (a static `/api/` stub, a
// regex location matched first) would keep every textual check green.
//
// Real image (built from website-server/Dockerfile), real Docker network, and a
// stand-in upstream on it under the network alias `api` answering /api/version
// with a body only it could produce. The request goes host → website-server's
// published port → nginx → `api`. The stand-in is a two-line Bun server, not
// the backend image: this grades the proxy, and
// backend/tests/api-version-endpoint.test.ts grades the real handler.
//
// LOUD, NEVER SKIPPED: Docker is already a hard dependency of this repo's test
// harness. Everything started here is removed in afterAll with `rm -f -v`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const RUN = `${process.pid}-${Date.now().toString(36)}`;
const IMAGE = `rm-website-server-api-version-test:${RUN}`;
const NETWORK = `rm-wsav-net-${RUN}`;
const API_CONTAINER = `rm-wsav-api-${RUN}`;
const WEB_CONTAINER = `rm-wsav-web-${RUN}`;
// Distinctive, so a body that came from anywhere but the stand-in cannot match.
const UPSTREAM_BODY = { api: "9.8.7", commit: `upstream-${RUN}` };

const siteDir = mkdtempSync(join(tmpdir(), "rm-wsav-site-"));

function docker(args: string[]): string {
  return execFileSync("docker", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

function tryDocker(args: string[]): void {
  try { docker(args); } catch { /* already gone */ }
}

let webPort = 0;

beforeAll(() => {
  // A minimal assembled site, bind-mounted at the root nginx serves
  // (`root /srv/web/current`; docker-compose.yml mounts the instance's web/ dir
  // at /srv/web, and `current` is the live site inside it).
  writeFileSync(join(siteDir, "index.html"), "<!doctype html><title>site</title>");
  writeFileSync(join(siteDir, "version.json"), JSON.stringify({ name: "@robotmoney/web-client", version: "0.1.0", commit: "x", apiRange: "^9.8.0" }));
  // mkdtemp makes the directory 0700; the nginx worker runs as its own user.
  chmodSync(siteDir, 0o755);
  for (const f of ["index.html", "version.json"]) chmodSync(join(siteDir, f), 0o644);

  docker(["build", "-t", IMAGE, "website-server"]);
  docker(["network", "create", NETWORK]);
  docker([
    "run", "-d", "--name", API_CONTAINER, "--network", NETWORK, "--network-alias", "api",
    "oven/bun:1.3.5", "bun", "-e",
    `Bun.serve({ port: 8787, hostname: "0.0.0.0", fetch(req) {
       const u = new URL(req.url);
       if (u.pathname === "/api/version") return Response.json(${JSON.stringify(UPSTREAM_BODY)});
       return new Response("stand-in: " + u.pathname, { status: 404 });
     } });`,
  ]);
  docker([
    "run", "-d", "--name", WEB_CONTAINER, "--network", NETWORK,
    "-v", `${siteDir}:/srv/web/current:ro`,
    "-p", "127.0.0.1::8080",
    IMAGE,
  ]);
  const mapping = docker(["port", WEB_CONTAINER, "8080/tcp"]);
  webPort = Number(mapping.split("\n")[0]!.split(":").pop());
  expect(webPort).toBeGreaterThan(0);
}, 300_000);

afterAll(() => {
  tryDocker(["rm", "-f", "-v", WEB_CONTAINER]);
  tryDocker(["rm", "-f", "-v", API_CONTAINER]);
  tryDocker(["network", "rm", NETWORK]);
  tryDocker(["rmi", "-f", IMAGE]);
  rmSync(siteDir, { recursive: true, force: true });
});

async function getThroughNginx(path: string, deadlineMs = 30_000): Promise<Response> {
  const deadline = Date.now() + deadlineMs;
  let last: unknown;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${webPort}${path}`);
      // 502 while the stand-in is still starting; anything else is the answer.
      if (res.status !== 502) return res;
      last = `502 from nginx`;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) throw new Error(`no answer for ${path} through website-server: ${String(last)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test("GET /api/version through website-server returns the upstream api's body", async () => {
  const res = await getThroughNginx("/api/version");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(await res.json()).toEqual(UPSTREAM_BODY);
}, 60_000);

test("control: the site's own /version.json is served by nginx itself, not proxied", async () => {
  // The other half of the handshake lives on the static side. If the proxy
  // swallowed it, the page could never read its own range.
  const res = await getThroughNginx("/version.json");
  expect(res.status).toBe(200);
  expect((await res.json()).apiRange).toBe("^9.8.0");
}, 60_000);

test("control: an /api/ path the stand-in does not serve comes back as the stand-in's 404", async () => {
  // Proves the 200 above came from the upstream, not from an nginx rule that
  // answers /api/version on its own.
  const res = await getThroughNginx("/api/not-a-route");
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("stand-in: /api/not-a-route");
}, 60_000);
