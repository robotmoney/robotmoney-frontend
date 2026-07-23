// Self-test for the "demo readiness" gate (issue #58). scripts/demo-frontend-check.ts
// is the core-surface-missing detector that the required `e2e` workflow runs against
// the LIVE demo boot (see .github/workflows/e2e.yml and docs/architecture.md, which name
// this the "demo readiness" gate; issue #147 removed DEMO_HERMETIC and the hermetic
// path entirely, so there is only one supported demo mode left). Nothing else proves
// the guard's loud-failure path actually fires when a core surface breaks — a change
// that silently weakened its assertions would go unnoticed. This suite proves both
// directions:
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
import { ROUTES } from "@robotmoney/contract";

const repoRoot = join(import.meta.dir, "../..");
const publicDir = join(repoRoot, "frontend", "public");

// A rewrite maps a served pathname to a function that transforms the on-disk
// file's text before it is returned. The negative case uses this to strip a
// core-surface marker from /views/committee.html so the guard must fail.
type Rewrites = Record<string, (text: string) => string>;

// Minimal valid wallet-balances payload (issue #84) whose provenance marker is
// parameterized so the LIVE provenance expectation (issue #134) can be proven,
// plus per-leg degrade overrides.
function walletPayload(provenance: "live" | "stub" = "live", legOverrides: Record<string, string> = {}) {
  const symbols = ["USDC", "ZYFAI-SS1", "GIZA-SS1", "WETH", "ETH", "ROBOTMONEY", "BNKR", "SP500"];
  return {
    asOf: new Date().toISOString(), totalUsd: 1000, source: provenance, priceSource: provenance,
    holdings: symbols.map((s) => ({ symbol: s, chain: "base", group: "Stable", color: "#10b981", amount: 1, priceUsd: 1, valueUsd: 125, priceSource: "pinned", provenance: legOverrides[s] ?? provenance })),
    history: [{ date: "2026-03-18", byAsset: { WETH: 500, ROBOTMONEY: 500 }, totalUsd: 1000 }],
  };
}

function startStubBackend(rewrites: Rewrites = {}, wallet: ReturnType<typeof walletPayload> = walletPayload("live")) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === ROUTES.committee.sessions) {
        return Response.json({ sessions: [] });
      }
      if (url.pathname === ROUTES.dashboards.walletBalances) {
        return Response.json(wallet);
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

// LIVE-only wallet-balances provenance expectation (issue #134; issue #147
// removed the hermetic mode, so 'live' is the only supported expectation
// left): 'stale'/'seed' are allowed degrades, and any OTHER provenance (e.g. a
// stub leaking in) is a loud failure.
describe("wallet-balances provenance (issue #134)", () => {
  test("live-provenanced payload passes", async () => {
    const backend = startStubBackend({}, walletPayload("live"));
    try {
      const { exitCode, stdout, stderr } = await runCheck(backend);
      if (exitCode !== 0) {
        console.error(stdout);
        console.error(stderr);
      }
      expect(exitCode).toBe(0);
      expect(stdout).toContain("returns live-provenanced holdings");
    } finally {
      backend.stop(true);
    }
  }, 20_000);

  test("stub-provenanced payload FAILS loudly (stub data must never present on a LIVE boot)", async () => {
    const backend = startStubBackend({}, walletPayload("stub"));
    try {
      const { exitCode, stdout } = await runCheck(backend);
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain("source=stub (expected live)");
    } finally {
      backend.stop(true);
    }
  }, 20_000);

  test("'stale'/'seed' degraded legs are allowed but loudly logged", async () => {
    const backend = startStubBackend({}, walletPayload("live", { "ZYFAI-SS1": "stale", SP500: "seed" }));
    try {
      const { exitCode, stdout, stderr } = await runCheck(backend);
      if (exitCode !== 0) {
        console.error(stdout);
        console.error(stderr);
      }
      expect(exitCode).toBe(0);
      expect(stdout).toContain("degraded legs (allowed, non-live): ZYFAI-SS1=stale, SP500=seed");
    } finally {
      backend.stop(true);
    }
  }, 20_000);
});
