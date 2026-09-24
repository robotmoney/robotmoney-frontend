// D54 (issue #1026 W7, criterion 159): GET /api/version answers `{api, commit}`
// with no auth and no database access.
//
// THREE LAYERS, each able to fail on its own:
//   1. the body builder — exactly two keys, `api` IS contract/package.json's
//      version (read from the file here, not from the module under test), and
//      `commit` is the baked build commit or null, never a stand-in;
//   2. the REAL entrypoint (`bun run src/api/index.ts`, what the compose api
//      service runs) asked over HTTP — once against the test database, and once
//      against a database URL nothing listens on, where every query the process
//      makes throws. /api/version must still answer there, while a
//      database-backed route beside it answers 503 (the control that proves the
//      database really was unreachable for that process);
//   3. the handler module's import graph — no db module and no config.ts, so no
//      later edit can make the answer depend on a connection without this going
//      red.
//
// What this does NOT prove: that website-server proxies the route. That is a
// property of the nginx image and is graded against a real container in
// scripts/tests/integration/website-server-api-version.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES } from "@robotmoney/contract";
import { API_CONTRACT_VERSION, apiVersionBody, apiVersionResponse } from "../src/ops/api-version.ts";
import { BUILD_COMMIT_ENV } from "../src/ops/build-identity.ts";

const backendDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_VERSION = (JSON.parse(readFileSync(join(backendDir, "..", "contract", "package.json"), "utf8")) as { version: string }).version;
const COMMIT = "ebc588b4542de4d5a61aecdba0a967af35afcd6b";

// ── 1. The body ─────────────────────────────────────────────────────────────
describe("apiVersionBody", () => {
  test("the route is /api/version, under the prefix website-server already proxies", () => {
    expect(ROUTES.apiVersion).toBe("/api/version");
  });

  test("api is contract/package.json's version, read from the file", () => {
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(API_CONTRACT_VERSION).toBe(CONTRACT_VERSION);
    expect(apiVersionBody({}).api).toBe(CONTRACT_VERSION);
  });

  test("exactly {api, commit}: the baked commit when present, null when not", () => {
    expect(apiVersionBody({ [BUILD_COMMIT_ENV]: ` ${COMMIT} ` })).toEqual({ api: CONTRACT_VERSION, commit: COMMIT });
    expect(apiVersionBody({})).toEqual({ api: CONTRACT_VERSION, commit: null });
    expect(apiVersionBody({ [BUILD_COMMIT_ENV]: "   " })).toEqual({ api: CONTRACT_VERSION, commit: null });
  });

  test("the Response is a 200 application/json carrying that body", async () => {
    const res = apiVersionResponse({ [BUILD_COMMIT_ENV]: COMMIT });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ api: CONTRACT_VERSION, commit: COMMIT });
  });
});

// ── 2. The real process, over HTTP ──────────────────────────────────────────
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

const spawned: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => { for (const p of spawned) p.kill(); });

async function bootApi(extraEnv: Record<string, string>): Promise<number> {
  const port = await freePort();
  const proc = Bun.spawn(["bun", "run", "src/api/index.ts"], {
    cwd: backendDir,
    env: { ...process.env, API_PORT: String(port), ...extraEnv },
    stdout: "ignore",
    stderr: "pipe",
  });
  spawned.push(proc);
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`api exited with ${proc.exitCode}:\n${await new Response(proc.stderr as ReadableStream).text()}`);
    }
    try {
      // /health answers 200 whatever the database state (its body says `db`),
      // so it is the readiness probe in both boots below.
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return port;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`api never served /health on :${port}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("GET /api/version on the running api", () => {
  test("answers 200 with exactly {api, commit}, with no credential of any kind", async () => {
    const port = await bootApi({ [BUILD_COMMIT_ENV]: COMMIT });

    // No Authorization, no cookie, no admin token.
    const res = await fetch(`http://127.0.0.1:${port}${ROUTES.apiVersion}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body).toEqual({ api: CONTRACT_VERSION, commit: COMMIT });
    expect(Object.keys(body).sort()).toEqual(["api", "commit"]);

    // A credential that means nothing is ignored, not refused: the route has
    // no auth branch to reject it in.
    const withJunk = await fetch(`http://127.0.0.1:${port}${ROUTES.apiVersion}`, {
      headers: { Authorization: "Bearer not-a-token", "X-Admin-Token": "wrong" },
    });
    expect(withJunk.status).toBe(200);
    expect(await withJunk.json()).toEqual({ api: CONTRACT_VERSION, commit: COMMIT });

    // Control: the bare /version route (AC-ID-03) is untouched and still
    // reports build identity, not the contract version.
    const identity = await (await fetch(`http://127.0.0.1:${port}${ROUTES.version}`)).json();
    expect(identity.commit).toBe(COMMIT);
    expect(identity).not.toHaveProperty("api");
  });

  test("still answers while every database query throws, and a database route beside it does not", async () => {
    // Nothing listens on port 1, so every query this process attempts fails
    // with a connection error — the "sql handle that throws on any query". The
    // boot guards are bounded and report `unchecked` rather than refusing
    // (api-boot-handle-namespace-guard.test.ts), so the process serves.
    const port = await bootApi({
      DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
      PG_NAMESPACE_GUARD_TIMEOUT_MS: "1000",
      [BUILD_COMMIT_ENV]: "",
    });

    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(health.db).toBe("down");

    const res = await fetch(`http://127.0.0.1:${port}${ROUTES.apiVersion}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ api: CONTRACT_VERSION, commit: null });

    // The control: a route that reads the database answers the outage, so the
    // 200 above is not an artefact of a database that happened to be up.
    // (/api/projects, not /api/comments: the comments list degrades to an
    // empty page on a query error rather than surfacing it.)
    const projects = await fetch(`http://127.0.0.1:${port}${ROUTES.projects.list}`);
    expect(projects.status).toBe(503);
    expect(await projects.json()).toEqual({ error: "database unavailable" });
  });
});

// ── 3. The import graph ─────────────────────────────────────────────────────
/** Every backend source file `entry` reaches through relative imports. */
function relativeImportClosure(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/gm)) {
      stack.push(resolve(dirname(file), m[1]!));
    }
  }
  return [...seen].map((f) => f.slice(backendDir.length + 1)).sort();
}

describe("the handler module imports no database or config module", () => {
  const entry = join(backendDir, "src/ops/api-version.ts");

  test("its closure is itself and build-identity.ts, nothing under src/db/ and not config.ts", () => {
    const closure = relativeImportClosure(entry);
    expect(closure).toEqual(["src/ops/api-version.ts", "src/ops/build-identity.ts"]);
    expect(closure.filter((f) => f.startsWith("src/db/") || f === "src/config.ts")).toEqual([]);
  });

  test("red control: the closure walker does see a db import when there is one", () => {
    // index.ts imports db/client.ts directly; if the walker could not see that,
    // the assertion above would be vacuous.
    const closure = relativeImportClosure(join(backendDir, "src/api/index.ts"));
    expect(closure).toContain("src/db/client.ts");
    expect(closure).toContain("src/config.ts");
  });

  test("index.ts answers the route before its first database-touching branch", () => {
    const src = readFileSync(join(backendDir, "src/api/index.ts"), "utf8");
    const body = src.slice(src.indexOf("async function route("));
    const versionBranch = body.indexOf("pathname === ROUTES.apiVersion");
    const healthBranch = body.indexOf("pathname === ROUTES.health");
    expect(versionBranch).toBeGreaterThan(0);
    expect(versionBranch).toBeLessThan(healthBranch);
    expect(body.indexOf("sql`")).toBeGreaterThan(versionBranch);
  });
});
