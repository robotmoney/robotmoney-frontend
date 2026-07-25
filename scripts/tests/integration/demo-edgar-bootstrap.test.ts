// Demo-boot EDGAR/MNA seed ordering (issue #108): migrations complete, the
// API becomes healthy, authenticated seed ingestion completes, and ONLY THEN
// may the research schedule become eligible to claim research.refresh. This
// is asserted two ways:
//
//   1. behaviourally — spawn the REAL backend/scripts/edgar-seed-bootstrap.ts
//      CLI (the exact command scripts/lib/demo-main.ts runs after migrations
//      + API readiness) against a minimal in-process stub standing in for
//      the analytics API, and assert the seed-ingestion request always lands
//      BEFORE the research-eligibility request — and, on a rejected/invalid
//      credential, that the eligibility endpoint is NEVER called at all
//      (fail-closed).
//   2. structurally — scripts/lib/demo-main.ts (which spawns docker
//      containers and cannot be safely imported here) is checked at the
//      source-text level for calling this exact command AFTER API health and
//      BEFORE the CI checks / local action loops that could observe a fired
//      research.refresh job.
//
// No live network, no docker: the stub is a local Bun.serve() and the seed
// fixture is a tiny in-temp-dir artifact, not the committed ~200-row one.
import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const backendDir = join(repoRoot, "backend");

// A tiny, self-contained canonical seed pair (mirrors backend's
// extract/edgar-seed.ts format exactly) — avoids importing backend/src from
// this ROOT-suite test (cross-package tsc coupling; see demo-main.ts's own
// comment on why the committee session driver is loaded via subprocess instead of static import).
function writeTinySeedFixture(): { dir: string; gzPath: string; manifestPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "rm-edgar-boot-"));
  const csv = "date,indicator,value\n2021-01-31,MNA,10\n2021-02-28,MNA,11\n";
  const manifest = {
    formatVersion: 1,
    indicator: "MNA",
    source: "sec-edgar-fts-s4",
    startMonth: "2021-01",
    endMonth: "2021-02",
    asOf: "2021-03-01",
    rowCount: 2,
    checksum: createHash("sha256").update(csv, "utf8").digest("hex"),
  };
  const gzPath = join(dir, "seed.csv.gz");
  const manifestPath = join(dir, "seed.manifest.json");
  writeFileSync(gzPath, gzipSync(Buffer.from(csv, "utf8")));
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { dir, gzPath, manifestPath };
}

interface StubRequest { method: string; path: string; auth: string | null }

function startStubApi(expectedToken: string) {
  const requests: StubRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("Authorization");
      requests.push({ method: req.method, path: url.pathname, auth });
      const ok = auth === `Bearer ${expectedToken}`;
      if (url.pathname === "/api/analytics/raw-history/seed" && req.method === "POST") {
        if (!ok) return Response.json({ error: "unauthorized" }, { status: auth ? 403 : 401 });
        return Response.json({ ok: true, seededPoints: 2, existingPoints: 0, indicators: 1 });
      }
      if (url.pathname === "/api/analytics/research-eligibility" && req.method === "POST") {
        if (!ok) return Response.json({ error: "unauthorized" }, { status: auth ? 403 : 401 });
        return Response.json({ ok: true, enabled: 1 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return { server, requests };
}

// MUST be async Bun.spawn (not spawnSync) per demo-frontend-check.test.ts's
// precedent — irrelevant here since the child never calls back into this
// process, but kept consistent for readability.
async function runBootstrapCli(apiUrl: string, token: string | undefined, seedEnv: { gzPath: string; manifestPath: string }) {
  const proc = Bun.spawn(["bun", "run", "scripts/edgar-seed-bootstrap.ts"], {
    cwd: backendDir,
    env: {
      ...process.env,
      ANALYTICS_API_URL: apiUrl,
      ANALYTICS_TOKEN: token ?? "",
      EDGAR_SEED_PATH: seedEnv.gzPath,
      EDGAR_SEED_MANIFEST_PATH: seedEnv.manifestPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

test("edgar-seed-bootstrap.ts: seed ingestion completes BEFORE research-eligibility is called", async () => {
  const TOKEN = "tok_boot_ordering";
  const { server, requests } = startStubApi(TOKEN);
  const seed = writeTinySeedFixture();
  try {
    const { exitCode, stdout, stderr } = await runBootstrapCli(`http://localhost:${server.port}`, TOKEN, seed);
    if (exitCode !== 0) { console.error(stdout); console.error(stderr); }
    expect(exitCode).toBe(0);

    const seedIdx = requests.findIndex((r) => r.path === "/api/analytics/raw-history/seed");
    const eligIdx = requests.findIndex((r) => r.path === "/api/analytics/research-eligibility");
    expect(seedIdx).toBeGreaterThanOrEqual(0);
    expect(eligIdx).toBeGreaterThanOrEqual(0);
    expect(seedIdx).toBeLessThan(eligIdx); // strict ordering
  } finally {
    server.stop(true);
    rmSync(seed.dir, { recursive: true, force: true });
  }
}, 20_000);

test("edgar-seed-bootstrap.ts: a rejected seed call (401/403) NEVER reaches research-eligibility — fail-closed", async () => {
  const TOKEN = "tok_boot_failclosed";
  const { server, requests } = startStubApi(TOKEN);
  const seed = writeTinySeedFixture();
  try {
    // No token presented → the stub's seed endpoint 401s.
    const { exitCode } = await runBootstrapCli(`http://localhost:${server.port}`, undefined, seed);
    expect(exitCode).not.toBe(0);
    const eligibilityCalls = requests.filter((r) => r.path === "/api/analytics/research-eligibility");
    expect(eligibilityCalls).toEqual([]); // never called — the research schedule is left disabled
  } finally {
    server.stop(true);
    rmSync(seed.dir, { recursive: true, force: true });
  }
}, 20_000);

test("edgar-seed-bootstrap.ts: a WRONG token also fails closed (403) before eligibility is ever attempted", async () => {
  const TOKEN = "tok_boot_wrong";
  const { server, requests } = startStubApi(TOKEN);
  const seed = writeTinySeedFixture();
  try {
    const { exitCode } = await runBootstrapCli(`http://localhost:${server.port}`, "not-the-right-token", seed);
    expect(exitCode).not.toBe(0);
    expect(requests.filter((r) => r.path === "/api/analytics/research-eligibility")).toEqual([]);
  } finally {
    server.stop(true);
    rmSync(seed.dir, { recursive: true, force: true });
  }
}, 20_000);

// ── structural: demo-main.ts wires the CLI after migrations+API health, before CI checks ──

test("scripts/lib/demo-main.ts runs edgar-seed-bootstrap.ts AFTER API health and BEFORE the CI checks / local action loops", () => {
  const src = readFileSync(join(repoRoot, "scripts", "lib", "demo-main.ts"), "utf8");
  expect(src).toContain("edgar-seed-bootstrap.ts");

  const apiHealthIdx = src.indexOf('await waitForHttp(`${backendUrl}/health`)');
  const bootstrapIdx = src.indexOf("edgar-seed-bootstrap.ts");
  const ciBranchIdx = src.indexOf("if (process.env.CI) {");

  expect(apiHealthIdx).toBeGreaterThan(-1);
  expect(bootstrapIdx).toBeGreaterThan(-1);
  expect(ciBranchIdx).toBeGreaterThan(-1);
  expect(apiHealthIdx).toBeLessThan(bootstrapIdx); // API must be healthy first
  expect(bootstrapIdx).toBeLessThan(ciBranchIdx); // seed gate resolves before ANY post-boot checks/actions
});
