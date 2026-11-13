// Issue 1422 §4.8: website-server (nginx) is the one way in to the public
// analytics API, and it sets the client identity the api keys its limits on.
// Issue 1629: it stores no api response. The api keeps its own answers in
// process (backend/tests/api/public-analytics-cache.test.ts), so every request
// reaches the api and the api's own X-Cache-Status reaches the client.
//
// Real image (built from website-server/Dockerfile), real Docker networks, and
// a stand-in upstream under the network alias `api` that echoes the identity
// headers it received and counts the requests that reach it. Two client
// networks: a private one (a trusted peer, as the cloudflared tunnel and this
// host are) and one in TEST-NET-2, 198.51.100.0/24, which nginx's geo block
// does not trust. The stand-in grades the proxy, not the api's handler: the
// api's own Cache-Control, ETag and 429/503 answers are graded by
// backend/tests/api/public-analytics*.test.ts.
//
// LOUD, NEVER SKIPPED: Docker is a hard dependency of this tier. Everything
// started here is removed in afterAll with `rm -f -v`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const RUN = `${process.pid}-${Date.now().toString(36)}`;
const IMAGE = `rm-public-archive-proxy-test:${RUN}`;
const NET = `rm-pap-net-${RUN}`;
const UNTRUSTED_NET = `rm-pap-untrusted-${RUN}`;
const API_CONTAINER = `rm-pap-api-${RUN}`;
const WEB_CONTAINER = `rm-pap-web-${RUN}`;
const BUN_IMAGE = "oven/bun:1.4.4";
const BASE = "/api/public/analytics";

const siteDir = mkdtempSync(join(tmpdir(), "rm-pap-site-"));

function docker(args: string[]): string {
  return execFileSync("docker", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}
function tryDocker(args: string[]): void {
  try {
    docker(args);
  } catch {
    /* already gone */
  }
}

// The stand-in api. Every answer echoes the identity headers it saw; the
// response's caching headers are chosen per path the way the real api chooses
// them (a list for 5 minutes, an archive immutable, refusals no-store), and a
// list names its own X-Cache-Status, which nginx must pass through untouched.
const STUB = `
const hits = {};
Bun.serve({ port: 8787, hostname: "0.0.0.0", async fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/__hits") return Response.json(hits);
  hits[u.pathname] = (hits[u.pathname] || 0) + 1;
  const ae = req.headers.get("accept-encoding") || "";
  const echo = { path: u.pathname, n: hits[u.pathname], xClientIp: req.headers.get("x-client-ip"),
    cf: req.headers.get("cf-connecting-ip"), auth: req.headers.get("authorization") };
  if (u.pathname.endsWith("/list")) {
    const body = JSON.stringify({ ...echo, variant: ae.includes("gzip") ? "gzip" : "identity" });
    const h = { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", Vary: "Accept-Encoding",
      "X-Cache-Status": hits[u.pathname] === 1 ? "MISS" : "HIT" };
    if (ae.includes("gzip")) return new Response(Bun.gzipSync(body), { headers: { ...h, "Content-Encoding": "gzip" } });
    return new Response(body, { headers: h });
  }
  if (u.pathname.endsWith(".csv.gz")) {
    await Bun.sleep(1500);
    return new Response("archive-bytes-" + hits[u.pathname], { headers: { "Content-Type": "application/gzip",
      "Cache-Control": "public, max-age=31536000, immutable", ETag: '"abc"' } });
  }
  if (u.pathname.endsWith("/limited")) return new Response('{"error":"rate limit exceeded"}', { status: 429,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "30" } });
  if (u.pathname.endsWith("/busy")) return new Response('{"error":"public analytics is busy"}', { status: 503,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "1" } });
  return Response.json(echo);
} });`;

let webPort = 0;

beforeAll(() => {
  writeFileSync(join(siteDir, "index.html"), "<!doctype html><title>site</title>");
  chmodSync(siteDir, 0o755);
  chmodSync(join(siteDir, "index.html"), 0o644);
  docker(["build", "-t", IMAGE, "website-server"]);
  docker(["network", "create", NET]);
  docker(["network", "create", "--subnet", "198.51.100.0/24", UNTRUSTED_NET]);
  docker(["run", "-d", "--name", API_CONTAINER, "--network", NET, "--network-alias", "api", BUN_IMAGE, "bun", "-e", STUB]);
  docker(["run", "-d", "--name", WEB_CONTAINER, "--network", NET, "--network-alias", "web", "-v", `${siteDir}:/srv/web/current:ro`, "-p", "127.0.0.1::8080", IMAGE]);
  docker(["network", "connect", "--alias", "web", UNTRUSTED_NET, WEB_CONTAINER]);
  webPort = Number(docker(["port", WEB_CONTAINER, "8080/tcp"]).split("\n")[0]!.split(":").pop());
  expect(webPort).toBeGreaterThan(0);
}, 300_000);

afterAll(() => {
  tryDocker(["rm", "-f", "-v", WEB_CONTAINER]);
  tryDocker(["rm", "-f", "-v", API_CONTAINER]);
  tryDocker(["network", "rm", UNTRUSTED_NET]);
  tryDocker(["network", "rm", NET]);
  tryDocker(["rmi", "-f", IMAGE]);
  rmSync(siteDir, { recursive: true, force: true });
}, 120_000);

async function through(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${webPort}${path}`, init);
}

async function hits(): Promise<Record<string, number>> {
  const out = docker(["exec", API_CONTAINER, "bun", "-e", "console.log(await (await fetch('http://127.0.0.1:8787/__hits')).text())"]);
  return JSON.parse(out);
}

/** A request from a container on `network`, so nginx sees that container's own address as the peer. */
function fromContainer(network: string, path: string, headers: Record<string, string>): { status: number; body: any; peer: string } {
  const script = `const r = await fetch("http://web:8080${path}", { headers: ${JSON.stringify(headers)} });
    const ip = (await Bun.file("/etc/hosts").text()).split("\\n").map((l) => l.trim().split(/\\s+/)).find((p) => p[1] === require("os").hostname())?.[0];
    console.log(JSON.stringify({ status: r.status, body: await r.json(), peer: ip }));`;
  return JSON.parse(docker(["run", "--rm", "--network", network, BUN_IMAGE, "bun", "-e", script]));
}

describe("the stand-in is reachable through website-server", () => {
  test("warm up", async () => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const res = await fetch(`http://127.0.0.1:${webPort}${BASE}/warmup`).catch(() => null);
      if (res && res.status === 200) break;
      if (Date.now() > deadline) throw new Error("the stand-in api never answered through website-server");
      await Bun.sleep(250);
    }
  }, 90_000);
});

describe("one way in, and an identity the caller cannot choose", () => {
  test("from an untrusted peer, X-Client-IP and CF-Connecting-IP are overwritten with the peer's own address", () => {
    const r = fromContainer(UNTRUSTED_NET, `${BASE}/echo-untrusted`, { "X-Client-IP": "6.6.6.6", "CF-Connecting-IP": "7.7.7.7" });
    expect(r.status).toBe(200);
    expect(r.peer).toMatch(/^198\.51\.100\./);
    expect(r.body.xClientIp).toBe(r.peer);
    expect(r.body.cf).toBe(r.peer);
  }, 120_000);

  test("every proxied path overwrites the identity: /health, /version and an encoded-slash public path", () => {
    for (const path of ["/health", "/version", `${BASE}/x%2Fy`]) {
      const r = fromContainer(UNTRUSTED_NET, path, { "X-Client-IP": "6.6.6.6", "CF-Connecting-IP": "7.7.7.7" });
      expect(r.status, path).toBe(200);
      expect(r.body.xClientIp, path).toBe(r.peer);
      expect(r.body.cf, path).toBe(r.peer);
    }
  }, 180_000);

  test("from a trusted peer, Cloudflare's CF-Connecting-IP becomes X-Client-IP; a sent X-Client-IP is still replaced", () => {
    const r = fromContainer(NET, `${BASE}/echo-trusted`, { "CF-Connecting-IP": "203.0.113.9", "X-Client-IP": "6.6.6.6" });
    expect(r.status).toBe(200);
    expect(r.body.xClientIp).toBe("203.0.113.9");
    expect(r.body.cf).toBe("203.0.113.9");
  }, 120_000);

  test("every /api/ route gets the header too, and an authenticated producer request passes through uncached", async () => {
    const res = await through("/api/analytics/runs", { headers: { Authorization: "Bearer producer-token", "X-Client-IP": "6.6.6.6" } });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.auth).toBe("Bearer producer-token");
    expect(body.xClientIp).not.toBe("6.6.6.6");
    expect(res.headers.get("x-cache-status")).toBeNull();
  });

  test("the api publishes no port on a public interface: docker-compose.yml binds it to loopback", () => {
    expect(docker(["port", API_CONTAINER])).toBe("");
    const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");
    const apiBlock = compose.slice(compose.indexOf("\n  api:\n"), compose.indexOf("\n  website-server:\n"));
    expect([...apiBlock.matchAll(/^\s+- "([^"]*8787)"$/gm)].map((m) => m[1])).toEqual(["127.0.0.1::8787"]);
  });
});

describe("no edge cache: every public analytics request reaches the api (issue 1629)", () => {
  test("the running config has no proxy_cache directive", () => {
    const conf = docker(["exec", WEB_CONTAINER, "nginx", "-T"]);
    expect(conf).not.toMatch(/proxy_cache/);
  });

  test("a repeated list reaches the api every time, its gzip and identity variants intact, and the api's X-Cache-Status passes through", async () => {
    // Bun's fetch asks for gzip unless told otherwise.
    const identity = { headers: { "Accept-Encoding": "identity" } };
    const id1 = await through(`${BASE}/list?x=1`, identity);
    expect(id1.headers.get("x-cache-status")).toBe("MISS");
    expect(((await id1.json()) as any).variant).toBe("identity");
    const gz1 = await through(`${BASE}/list?x=1`, { headers: { "Accept-Encoding": "gzip" } });
    expect(gz1.headers.get("x-cache-status")).toBe("HIT");
    expect(gz1.headers.get("cache-control")).toBe("public, max-age=300");
    expect(((await gz1.json()) as any).variant).toBe("gzip");
    const id2 = await through(`${BASE}/list?x=1`, identity);
    expect(((await id2.json()) as any).n).toBe(3);
    expect((await hits())[`${BASE}/list`]).toBe(3);
  });

  test("concurrent identical requests for an immutable archive each reach the api, and a conditional request is the api's to answer", async () => {
    const path = `${BASE}/archive/csv/2001-01-02T000000Z/data/t.2001-01-01T000000Z_2001-01-01T000000Z.csv.gz`;
    const answers = await Promise.all(Array.from({ length: 3 }, () => through(path)));
    for (const res of answers) {
      expect(res.status).toBe(200);
      expect(await res.text()).toMatch(/^archive-bytes-[123]$/);
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    }
    expect((await hits())[path]).toBe(3);
    await through(path, { headers: { "If-None-Match": '"abc"' } });
    expect((await hits())[path]).toBe(4);
  }, 60_000);

  test("refusals reach the client unchanged: a 429 and the api's own 503, with Retry-After, every time", async () => {
    for (let i = 0; i < 2; i++) {
      const limited = await through(`${BASE}/limited`);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("30");
      const busy = await through(`${BASE}/busy`);
      expect(busy.status).toBe(503);
      expect(busy.headers.get("retry-after")).toBe("1");
      // The api's 503 is passed through, not replaced by nginx's maintenance body.
      expect(((await busy.json()) as any).error).toBe("public analytics is busy");
    }
    const h = await hits();
    expect(h[`${BASE}/limited`]).toBe(2);
    expect(h[`${BASE}/busy`]).toBe(2);
  });
});
