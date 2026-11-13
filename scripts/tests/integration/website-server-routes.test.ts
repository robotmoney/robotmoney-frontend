// The route and header contract (issue 1624, docs/technical/web-serving-
// architecture.md §3.3): the table in scripts/tests/support/website-routes-
// table.ts passes against today's website-server image, and against a stub
// server on another port, through the same runner and with no edits. The runner
// reads its target from ROUTES_TARGET_URL alone.
//
// Real image, real Docker network, and a stand-in api under the alias `api`
// that echoes the path and headers it received. The web directory is mounted at
// /srv/web as docker-compose.yml mounts it: the site in `current`, with
// maintenance.json beside it. The api is stopped for the maintenance rows by
// the helper bun smoke:down --keep-web uses (stopProjectExcept).
//
// Red control (CI, integration.yml): ROUTES_SERVER_DIR points the image build at
// a scratch copy of website-server/ with one rule changed, and this file must
// then exit non-zero (scripts/tests/support/website-routes-red-control.sh).
//
// LOUD, NEVER SKIPPED: Docker is a hard dependency of this tier. Everything
// started here is removed in afterAll.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAINTENANCE_FILE, writeMaintenanceFile } from "../../lib/maintenance-file.ts";
import { KEPT_WEB_SERVICE, makeDockerRunner, stopProjectExcept } from "../../lib/smoke-volumes.ts";
import { MAINTENANCE_STATUS, SECURITY_HEADERS, SITE_FILES } from "../support/website-routes-table.ts";

const repoRoot = join(import.meta.dir, "../../..");
const RUNNER = join(repoRoot, "scripts/tests/support/website-routes-runner.ts");
const SERVER_DIR = process.env.ROUTES_SERVER_DIR ?? join(repoRoot, "website-server");
const RUN = `${process.pid}-${Date.now().toString(36)}`;
const IMAGE = `rm-website-server-routes-test:${RUN}`;
const NETWORK = `rm-wsr-net-${RUN}`;
const UNTRUSTED_NET = `rm-wsr-untrusted-${RUN}`;
const API_CONTAINER = `rm-wsr-api-${RUN}`;
const WEB_CONTAINER = `rm-wsr-web-${RUN}`;
const BUN_IMAGE = "oven/bun:1.4.4";
const PROJECT = `rm_wsr_${RUN.replace(/-/g, "_")}`;
const labels = (service: string) => ["--label", `com.docker.compose.project=${PROJECT}`, "--label", `com.docker.compose.service=${service}`];

const ECHO_API = `Bun.serve({ port: 8787, hostname: "0.0.0.0", fetch(req) {
  return Response.json({ path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers) });
} });`;

const webDir = mkdtempSync(join(tmpdir(), "rm-wsr-web-"));
const siteDir = join(webDir, "current");
let webPort = 0;

const docker = (args: string[]): string => execFileSync("docker", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const tryDocker = (args: string[]): void => {
  try {
    docker(args);
  } catch {
    /* already gone */
  }
};

/** Run the table's runner as its own process, as any caller would. Async: a stub served by this process must keep answering. */
async function runTable(origin: string, phase: "api-up" | "api-down"): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", RUNNER, phase], { env: { ...process.env, ROUTES_TARGET_URL: origin }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  console.log(out + err);
  return { code, out };
}

async function waitFor(url: string, ok: (r: Response) => boolean, deadlineMs = 60_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const res = await fetch(url).catch(() => null);
    if (res && ok(res)) return;
    if (Date.now() > deadline) throw new Error(`no acceptable answer from ${url}`);
    await Bun.sleep(250);
  }
}

beforeAll(() => {
  for (const [rel, body] of Object.entries(SITE_FILES)) {
    mkdirSync(dirname(join(siteDir, rel)), { recursive: true, mode: 0o755 });
    writeFileSync(join(siteDir, rel), body, { mode: 0o644 });
  }
  writeMaintenanceFile(webDir, MAINTENANCE_STATUS);
  // mkdtemp makes the directory 0700; the nginx worker runs as its own user.
  chmodSync(webDir, 0o755);
  docker(["build", "-t", IMAGE, SERVER_DIR]);
  docker(["network", "create", NETWORK]);
  docker(["network", "create", "--subnet", "198.51.100.0/24", UNTRUSTED_NET]);
  docker(["run", "-d", "--name", API_CONTAINER, "--network", NETWORK, "--network-alias", "api", ...labels("api"), BUN_IMAGE, "bun", "-e", ECHO_API]);
  docker(["run", "-d", "--name", WEB_CONTAINER, "--network", NETWORK, "--network-alias", "web", ...labels(KEPT_WEB_SERVICE), "-v", `${webDir}:/srv/web:ro`, "-p", "127.0.0.1::8080", IMAGE]);
  docker(["network", "connect", "--alias", "web", UNTRUSTED_NET, WEB_CONTAINER]);
  webPort = Number(docker(["port", WEB_CONTAINER, "8080/tcp"]).split("\n")[0]!.split(":").pop());
  expect(webPort).toBeGreaterThan(0);
}, 300_000);

afterAll(() => {
  tryDocker(["rm", "-f", "-v", WEB_CONTAINER]);
  tryDocker(["rm", "-f", "-v", API_CONTAINER]);
  tryDocker(["network", "rm", UNTRUSTED_NET]);
  tryDocker(["network", "rm", NETWORK]);
  tryDocker(["rmi", "-f", IMAGE]);
  rmSync(webDir, { recursive: true, force: true });
}, 120_000);

test("the table passes against the website-server image (api up)", async () => {
  const origin = `http://127.0.0.1:${webPort}`;
  await waitFor(`${origin}/health`, (r) => r.status === 200);
  const { code, out } = await runTable(origin, "api-up");
  expect(out).not.toContain("FAIL");
  expect(code).toBe(0);
}, 120_000);

test("a caller-sent X-Client-IP from an untrusted peer never reaches the stub api", () => {
  // A request from a container on TEST-NET-2, which nginx's geo block does not trust.
  const script = `const r = await fetch("http://web:8080/api/routes-echo", { headers: { "X-Client-IP": "6.6.6.6", "CF-Connecting-IP": "7.7.7.7" } });
    const ip = (await Bun.file("/etc/hosts").text()).split("\\n").map((l) => l.trim().split(/\\s+/)).find((p) => p[1] === require("os").hostname())?.[0];
    console.log(JSON.stringify({ status: r.status, body: await r.json(), peer: ip }));`;
  const r = JSON.parse(docker(["run", "--rm", "--network", UNTRUSTED_NET, BUN_IMAGE, "bun", "-e", script]));
  expect(r.status).toBe(200);
  expect(r.peer).toMatch(/^198\.51\.100\./);
  expect(r.body.headers["x-client-ip"]).toBe(r.peer);
  expect(r.body.headers["cf-connecting-ip"]).toBe(r.peer);
  const received = JSON.stringify(r.body.headers);
  expect(received).not.toContain("6.6.6.6");
  expect(received).not.toContain("7.7.7.7");
}, 120_000);

test("the container health check command from docker-compose.yml exits 0", () => {
  const compose = Bun.YAML.parse(readFileSync(join(repoRoot, "docker-compose.yml"), "utf8")) as {
    services: Record<string, { healthcheck?: { test: string[] } }>;
  };
  const check = compose.services["website-server"]!.healthcheck!.test;
  expect(check[0]).toBe("CMD");
  // execFileSync throws on a non-zero exit, which fails this test.
  docker(["exec", WEB_CONTAINER, ...check.slice(1)]);
}, 60_000);

test("the table passes against the website-server image with the api stopped (maintenance)", async () => {
  // What bun smoke:down --keep-web does to the instance (issue 1501).
  const stopped = stopProjectExcept(makeDockerRunner(), PROJECT, [KEPT_WEB_SERVICE]);
  expect(stopped).toEqual({ removed: [API_CONTAINER], kept: [WEB_CONTAINER] });
  const origin = `http://127.0.0.1:${webPort}`;
  await waitFor(`${origin}/api/anything`, (r) => r.status === 503);
  const { code, out } = await runTable(origin, "api-down");
  expect(out).not.toContain("FAIL");
  expect(code).toBe(0);
}, 120_000);

const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();

// A stub of the contract on another port: the same runner, the same table, a
// different ROUTES_TARGET_URL. It proves the runner is bound to no server.
function stubServer(apiDown: boolean) {
  const json = (body: unknown, status: number, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (path === "/health" || path === "/version" || path.startsWith("/api/")) {
        if (apiDown) {
          const file = join(webDir, MAINTENANCE_FILE);
          if (path === "/api/status/maintenance" && existsSync(file)) return json(JSON.parse(readFileSync(file, "utf8")), 200, { "Cache-Control": "no-store" });
          return json({ error: "maintenance" }, 503, { "Cache-Control": "no-store", "Retry-After": "60" });
        }
        // The peer is loopback, a trusted peer: Cloudflare's value passes through.
        const client = req.headers.get("cf-connecting-ip") ?? server.requestIP(req)?.address ?? "";
        const headers = { ...Object.fromEntries(req.headers), "x-client-ip": client, "cf-connecting-ip": client };
        return json({ path, headers }, 200);
      }
      if (/\.(?!html$)[a-z0-9]+$/i.test(path)) {
        const f = join(siteDir, path);
        if (!isFile(f)) return new Response("not found", { status: 404 });
        return new Response(Bun.file(f), { headers: { "Cache-Control": "public, max-age=300" } });
      }
      const page = [path, join(path, "index.html"), "/_shell.html", "/index.html"].map((p) => join(siteDir, p)).find(isFile)!;
      return new Response(Bun.file(page), {
        headers: { "Content-Type": "text/html", "Cache-Control": "no-cache", ...SECURITY_HEADERS },
      });
    },
  });
}

test("the same table passes against a stub server on another port", async () => {
  const up = stubServer(false);
  const down = stubServer(true);
  try {
    expect(up.port).not.toBe(webPort);
    const a = await runTable(`http://127.0.0.1:${up.port}`, "api-up");
    const b = await runTable(`http://127.0.0.1:${down.port}`, "api-down");
    expect(a.out + b.out).not.toContain("FAIL");
    expect([a.code, b.code]).toEqual([0, 0]);
  } finally {
    up.stop(true);
    down.stop(true);
  }
}, 120_000);
