// Self-test for the "demo readiness" gate (issue #58). scripts/demo-frontend-check.ts
// is the core-surface-missing detector that the required `e2e` workflow runs under
// DEMO_HERMETIC=1 (see .github/workflows/e2e.yml and docs/demo-spec.md, which name
// this the "demo readiness" gate). Nothing else proves the guard's loud-failure path
// actually fires when a core surface breaks — a change that silently weakened its
// assertions would go unnoticed. This suite proves both directions:
//
//   - POSITIVE: against the REAL, unmodified frontend/public content the script
//     exits 0, so the guard's pass path is not vacuously red.
//   - NEGATIVE: with the `x-data="committeeView()"` marker deliberately stripped
//     from the served /views/committee.html, the script exits NON-ZERO, so the
//     loud-failure guarantee is verified rather than assumed.
//
// scripts/demo-frontend-check.ts only ever runs against a live backend (docker-compose
// demo stack or `bun run demo`), which this "root" test job (`bun run test`, wired in
// .github/workflows/integration.yml) does not have. So this file stands up a minimal
// in-process static file + API stub server that serves frontend/public content plus a
// stub /api/committee/sessions response, then spawns the real script against it.
import { describe, expect, test } from "bun:test";
import { join, normalize } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const publicDir = join(repoRoot, "frontend", "public");

// A rewrite maps a served pathname to a function that transforms the on-disk
// file's text before it is returned. The negative case uses this to strip a
// core-surface marker from /views/committee.html so the guard must fail.
type Rewrites = Record<string, (text: string) => string>;

function startStubBackend(rewrites: Rewrites = {}) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/committee/sessions") {
        return Response.json({ sessions: [] });
      }
      // Live prop-wallet feed (issue #84): a minimal valid hermetic payload so
      // the guard's wallet-balances assertion passes on the POSITIVE path.
      if (url.pathname === "/api/dashboards/wallet-balances") {
        const symbols = ["USDC", "ZYFAI-SS1", "GIZA-SS1", "WETH", "ETH", "ROBOTMONEY", "BNKR", "SP500"];
        return Response.json({
          asOf: new Date().toISOString(), totalUsd: 1000, source: "stub", priceSource: "stub",
          holdings: symbols.map((s) => ({ symbol: s, chain: "base", group: "Stable", color: "#10b981", amount: 1, priceUsd: 1, valueUsd: 125, priceSource: "pinned", provenance: "stub" })),
          history: [{ date: "2026-03-18", byAsset: { WETH: 500, ROBOTMONEY: 500 }, totalUsd: 1000 }],
        });
      }
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const safe = normalize(decodeURIComponent(rel)).replace(/^(\.\.(\/|\\|$))+/, "");
      const file = Bun.file(join(publicDir, safe));
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      const rewrite = rewrites[url.pathname];
      if (rewrite) return new Response(rewrite(await file.text()));
      return new Response(file);
    },
  });
}

// MUST be the async Bun.spawn, not spawnSync: the child calls back into this same
// process's Bun.serve stub over HTTP, and spawnSync blocks the JS event loop that
// stub needs to answer those requests — a same-thread deadlock that only resolves
// via the bun:test timeout.
async function runCheck(backend: ReturnType<typeof startStubBackend>) {
  const proc = Bun.spawn(["bun", "run", "scripts/demo-frontend-check.ts"], {
    cwd: repoRoot,
    env: { ...process.env, BACKEND_URL: `http://localhost:${backend.port}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

describe("scripts/demo-frontend-check.ts (demo readiness gate self-test)", () => {
  test("exits 0 against the real, unmodified view content", async () => {
    const backend = startStubBackend();
    try {
      const { exitCode, stdout, stderr } = await runCheck(backend);
      if (exitCode !== 0) {
        console.error(stdout);
        console.error(stderr);
      }
      expect(exitCode).toBe(0);
    } finally {
      backend.stop(true);
    }
  }, 20_000);

  test("exits non-zero when a core surface marker is stripped from /views/committee.html", async () => {
    const marker = 'x-data="committeeView()"';
    const backend = startStubBackend({
      "/views/committee.html": (text) => {
        // Guard against a silently-vacuous negative: the marker MUST be present
        // in the real content for stripping it to mean anything.
        expect(text).toContain(marker);
        return text.replaceAll(marker, "");
      },
    });
    try {
      const { exitCode, stdout } = await runCheck(backend);
      expect(exitCode).not.toBe(0);
      // Prove the failure is the stripped marker, not incidental noise.
      expect(stdout).toContain(marker);
    } finally {
      backend.stop(true);
    }
  }, 20_000);
});
