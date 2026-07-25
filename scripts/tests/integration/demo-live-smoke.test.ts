// Self-test for the LIVE-path smoke gate (issue #128; issue #147 made this the
// unconditional assertion every CI demo boot runs — required per-PR `e2e.yml`
// AND the nightly demo-live-smoke-nightly.yml sweep). scripts/demo-live-smoke.ts
// is the assertion driver. Its whole value is the loud-failure guarantee —
// starvation, a dead feed, or a LIVE-only provenance regression must turn the
// job red — so this suite proves BOTH directions (test-coverage policy: exit 0
// must never mean "nothing ran"):
//
//   - POSITIVE: against a stub backend serving a healthy LIVE steady state
//     (2 published sessions, fresh regime staleness, live wallet/vault
//     provenance with the documented #120 ZYFAI/GIZA degrades, both research
//     signals) the script exits 0 — the pass path is not vacuously red.
//   - NEGATIVE: forcing each failure mode (single published session = #101
//     starvation; stale regime snapshot; a NEW silently-stale wallet leg;
//     a missing research signal) exits NON-ZERO naming the failed leg/feed.
//
// The pure evaluators are also tested directly for the allowlist edge cases.
// The deadline is shortened via DEMO_LIVE_SMOKE_DEADLINE_MS (test-only hook) so
// the red paths don't poll for the full schedule-derived budget.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ROUTES, path as routePath } from "@robotmoney/contract";
import {
  ALLOWED_STALE_LEGS,
  evaluateRegime,
  evaluateSessions,
  evaluateVaultEconomics,
  evaluateWallet,
  RESEARCH_KEYS,
} from "../../demo-live-smoke.ts";

const repoRoot = join(import.meta.dir, "../../..");

// ── Healthy-LIVE payload builders (each test overrides one surface) ─────────
function sessionsPayload(publishedCount = 2) {
  return {
    sessions: Array.from({ length: publishedCount }, (_, i) => ({
      id: i + 1, date: `2026-07-${14 + i}`, subjectId: i === 0 ? "woon" : "mav", state: "published",
    })),
  };
}
function regimePayload(stale = false) {
  return {
    latest: { regime: "neutral", composite: 0.1 },
    history: [],
    staleness: { asof: "2026-07-15", serverDate: "2026-07-15", ageDays: 0, stale, thresholdDays: 3 },
  };
}
function walletPayload(legOverrides: Record<string, string> = {}) {
  const symbols = ["USDC", "ZYFAI-SS1", "GIZA-SS1", "WETH", "ETH", "ROBOTMONEY", "BNKR", "SP500"];
  return {
    asOf: new Date().toISOString(), totalUsd: 1000, source: "live", priceSource: "live",
    holdings: symbols.map((s) => ({ symbol: s, amount: 1, priceUsd: 1, valueUsd: 125, provenance: legOverrides[s] ?? "live" })),
    history: [{ date: "2026-07-14", byAsset: { WETH: 500 }, totalUsd: 500 }],
  };
}
const vaultPayload = (stale = false) => ({ source: "live", stale, tvlUsd: 100000, sharePriceUsd: 1.01 });
const signalPayload = (key: string) => ({ signalKey: key, date: "2026-07-15", payload: { gauges: [] } });

interface StubOverrides {
  sessions?: unknown; regime?: unknown; wallet?: unknown; vault?: unknown;
  signals?: Partial<Record<(typeof RESEARCH_KEYS)[number], unknown>>;
}
function startStubBackend(o: StubOverrides = {}) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === ROUTES.committee.sessions) return Response.json(o.sessions ?? sessionsPayload());
      if (p === ROUTES.dashboards.regimeSnapshots) return Response.json(o.regime ?? regimePayload());
      if (p === ROUTES.dashboards.walletBalances) return Response.json(o.wallet ?? walletPayload({ "ZYFAI-SS1": "stale", "GIZA-SS1": "seed" }));
      if (p === ROUTES.dashboards.vaultEconomics) return Response.json(o.vault ?? vaultPayload());
      for (const key of RESEARCH_KEYS) {
        if (p === routePath(ROUTES.dashboards.researchSignal, { key })) {
          const sig = o.signals && key in o.signals ? o.signals[key] : signalPayload(key);
          return sig === null ? new Response("not found", { status: 404 }) : Response.json(sig);
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
}

// Async spawn (never spawnSync): the child calls back into this process's
// Bun.serve stub over HTTP; spawnSync would deadlock the shared event loop.
async function runSmoke(backend: ReturnType<typeof startStubBackend>, env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "run", "scripts/demo-live-smoke.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BACKEND_URL: `http://localhost:${backend.port}`,
      // Test-only: shrink the schedule-derived poll budget so red paths finish fast.
      DEMO_LIVE_SMOKE_DEADLINE_MS: "1",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, output: stdout + stderr };
}

describe("demo-live-smoke (nightly LIVE gate self-test, issue #128)", () => {
  test("healthy LIVE steady state → exit 0, logging the documented #120 degrades", async () => {
    const backend = startStubBackend();
    try {
      const r = await runSmoke(backend);
      expect(r.output).toContain("documented-allowed degrade (issue #120)");
      expect(r.output).toContain("LIVE smoke passed");
      expect(r.exitCode).toBe(0);
    } finally {
      backend.stop(true);
    }
  }, 20_000);

  test("only 1 published session (starvation, #101) → exit non-zero naming committee", async () => {
    const backend = startStubBackend({ sessions: sessionsPayload(1) });
    try {
      const r = await runSmoke(backend);
      expect(r.exitCode).not.toBe(0);
      expect(r.output).toContain("committee: only 1/2 sessions published");
    } finally {
      backend.stop(true);
    }
  }, 20_000);

  test("stale regime snapshot → exit non-zero naming regime", async () => {
    const backend = startStubBackend({ regime: regimePayload(true) });
    try {
      const r = await runSmoke(backend);
      expect(r.exitCode).not.toBe(0);
      expect(r.output).toContain("regime: snapshot is STALE");
    } finally {
      backend.stop(true);
    }
  }, 20_000);

  test("NEW silently-stale wallet leg (not in the #120 allowlist) → exit non-zero naming the leg", async () => {
    const backend = startStubBackend({ wallet: walletPayload({ USDC: "stale" }) });
    try {
      const r = await runSmoke(backend);
      expect(r.exitCode).not.toBe(0);
      expect(r.output).toContain("wallet: leg USDC");
    } finally {
      backend.stop(true);
    }
  }, 20_000);

  test("missing research signal → exit non-zero naming the key", async () => {
    const backend = startStubBackend({ signals: { "late-cycle-signals": null } });
    try {
      const r = await runSmoke(backend);
      expect(r.exitCode).not.toBe(0);
      expect(r.output).toContain('research: signal "late-cycle-signals" not served');
    } finally {
      backend.stop(true);
    }
  }, 20_000);
});

describe("pure evaluators (edge cases)", () => {
  test("allowlisted legs may be stale/seed but NOT other provenances", () => {
    // 'stub' on a LIVE boot is a genuine regression even for an allowlisted leg.
    const failures = evaluateWallet(walletPayload({ "ZYFAI-SS1": "stub" }), () => {});
    expect(failures.some((f) => f.includes("ZYFAI-SS1"))).toBe(true);
  });

  test("allowlist is exactly the #120 documented legs", () => {
    expect([...ALLOWED_STALE_LEGS].sort()).toEqual(["GIZA-SS1", "ZYFAI-SS1"]);
  });

  test("wallet top-level non-live source fails even with live legs", () => {
    const wp = { ...walletPayload(), source: "stale" };
    expect(evaluateWallet(wp, () => {}).some((f) => f.includes("top-level source"))).toBe(true);
  });

  test("fetch failures (null payloads) are named failures, never passes", () => {
    expect(evaluateSessions(null).length).toBe(1);
    expect(evaluateRegime(null).length).toBe(1);
    expect(evaluateWallet(null, () => {}).length).toBe(1);
    expect(evaluateVaultEconomics(null).length).toBe(1);
  });

  test("missing staleness object is a failure (cannot certify freshness)", () => {
    expect(evaluateRegime({ latest: {} }).some((f) => f.includes("no staleness"))).toBe(true);
  });
});
