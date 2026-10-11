// With the api stopped, website-server keeps answering (issue 1220 (b)).
// Real image, real Docker network, a stand-in api under the alias `api`. The
// web directory is mounted at /srv/web as docker-compose.yml mounts it, with a
// `current` site beside maintenance.json. Docker is a hard dependency of this
// harness; everything started here is removed in afterAll.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearMaintenanceFile, writeMaintenanceFile } from "../../lib/maintenance-file.ts";

const repoRoot = join(import.meta.dir, "../../..");
const RUN = `${process.pid}-${Date.now().toString(36)}`;
const IMAGE = `rm-website-server-maint-test:${RUN}`;
const NETWORK = `rm-wsm-net-${RUN}`;
const API_CONTAINER = `rm-wsm-api-${RUN}`;
const WEB_CONTAINER = `rm-wsm-web-${RUN}`;
const UPSTREAM_STATUS = { state: "none", startsAt: null, expectedEnd: null, message: null };
const FILE_STATUS = { state: "active" as const, startsAt: "2030-01-01T10:00:00.000Z", expectedEnd: "2030-01-01T11:00:00.000Z", message: `window-${RUN}` };

const webDir = mkdtempSync(join(tmpdir(), "rm-wsm-web-"));
let webPort = 0;

const docker = (args: string[]): string => execFileSync("docker", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const tryDocker = (args: string[]): void => { try { docker(args); } catch { /* already gone */ } };

function startApi(): void {
  docker([
    "run", "-d", "--name", API_CONTAINER, "--network", NETWORK, "--network-alias", "api",
    "oven/bun:1.3.5", "bun", "-e",
    `Bun.serve({ port: 8787, hostname: "0.0.0.0", fetch(req) {
       const u = new URL(req.url);
       if (u.pathname === "/api/status/maintenance") return Response.json(${JSON.stringify(UPSTREAM_STATUS)});
       return new Response("stand-in: " + u.pathname, { status: 404 });
     } });`,
  ]);
}

beforeAll(() => {
  mkdirSync(join(webDir, "current"));
  writeFileSync(join(webDir, "current", "index.html"), "<!doctype html><title>site</title>");
  chmodSync(webDir, 0o755);
  chmodSync(join(webDir, "current"), 0o755);
  chmodSync(join(webDir, "current", "index.html"), 0o644);
  docker(["build", "-t", IMAGE, "website-server"]);
  docker(["network", "create", NETWORK]);
  startApi();
  docker(["run", "-d", "--name", WEB_CONTAINER, "--network", NETWORK, "-v", `${webDir}:/srv/web:ro`, "-p", "127.0.0.1::8080", IMAGE]);
  webPort = Number(docker(["port", WEB_CONTAINER, "8080/tcp"]).split("\n")[0]!.split(":").pop());
}, 300_000);

afterAll(() => {
  tryDocker(["rm", "-f", "-v", WEB_CONTAINER]);
  tryDocker(["rm", "-f", "-v", API_CONTAINER]);
  tryDocker(["network", "rm", NETWORK]);
  tryDocker(["rmi", "-f", IMAGE]);
  rmSync(webDir, { recursive: true, force: true });
}, 120_000);

async function get(path: string, accept: (r: Response) => boolean, deadlineMs = 30_000): Promise<Response> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${webPort}${path}`);
      if (accept(res)) return res;
    } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error(`no acceptable answer for ${path}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test("api running: the status route is proxied to the api", async () => {
  const res = await get("/api/status/maintenance", (r) => r.status !== 502);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(UPSTREAM_STATUS);
}, 60_000);

test("api stopped: the site answers 200, the status route serves maintenance.json, other /api/ is a 503 maintenance body", async () => {
  writeMaintenanceFile(webDir, FILE_STATUS);
  chmodSync(join(webDir, "maintenance.json"), 0o644);
  docker(["stop", API_CONTAINER]);

  const site = await get("/", () => true);
  expect(site.status).toBe(200);

  const status = await get("/api/status/maintenance", (r) => r.status === 200 && r.headers.get("content-type")!.includes("json"));
  expect(await status.json()).toEqual(FILE_STATUS);

  const other = await get("/api/swarm/anything", () => true);
  expect(other.status).toBe(503);
  expect(other.headers.get("content-type")).toContain("application/json");
  expect((await other.json()).error).toBe("maintenance");

  // Window over: the file is removed and the route stops claiming a window.
  clearMaintenanceFile(webDir);
  const gone = await get("/api/status/maintenance", () => true);
  expect(gone.status).toBe(503);
}, 120_000);

test("api restarted: the proxied answer returns", async () => {
  docker(["rm", "-f", API_CONTAINER]);
  startApi();
  const res = await get("/api/status/maintenance", (r) => r.status === 200);
  expect(await res.json()).toEqual(UPSTREAM_STATUS);
}, 120_000);
