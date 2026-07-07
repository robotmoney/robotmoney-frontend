// Proves the DEMO/e2e analytics data source is HERMETIC: it produces a full,
// deterministic series set for every registry indicator + research input WITHOUT
// touching the network. We assert offline-ness structurally — globalThis.fetch is
// replaced with a throw for the duration, so any accidental live call would blow
// up the test rather than silently succeed. No DB is touched here.
import { test, expect, afterEach } from "bun:test";
import { hermeticDataSource } from "../src/analytics/access/hermetic-source.ts";
import { resolveAnalyticsSource, runAnalytics } from "../src/analytics/index.ts";
import { liveDataSource } from "../src/analytics/access/data-source.ts";
import { INDICATORS } from "../src/analytics/analyze/indicators.ts";
import { sql } from "../src/db/client.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function banNetwork() {
  globalThis.fetch = (() => {
    throw new Error("network call attempted in hermetic demo/e2e path");
  }) as unknown as typeof fetch;
}

test("hermeticDataSource produces every indicator's series with NO network", async () => {
  banNetwork();
  const silent = { warn() {}, log() {}, error() {} };
  const series = await hermeticDataSource.fetchIndicators(INDICATORS, silent);
  for (const ind of INDICATORS) {
    const pts = series[ind.id];
    expect(Array.isArray(pts)).toBe(true);
    expect(pts.length).toBeGreaterThan(1000); // full 2018..today seeded path
    expect(pts.every((p) => typeof p.value === "number" && Number.isFinite(p.value))).toBe(true);
  }
});

test("hermeticDataSource research inputs are offline + complete", async () => {
  banNetwork();
  const silent = { warn() {}, log() {}, error() {} };
  const r = await hermeticDataSource.fetchResearchInputs("2026-06-29", silent);
  for (const key of ["btc", "qqq", "spy", "rsp", "mna", "margin", "conf"] as const) {
    expect(r[key].length).toBeGreaterThan(1000);
  }
  expect(r.top7.length).toBe(7);
  for (const s of r.top7) expect(s.length).toBeGreaterThan(1000);
});

test("hermeticDataSource is deterministic (same series across runs)", async () => {
  const silent = { warn() {}, log() {}, error() {} };
  const a = await hermeticDataSource.fetchIndicators(INDICATORS.slice(0, 3), silent);
  const b = await hermeticDataSource.fetchIndicators(INDICATORS.slice(0, 3), silent);
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

// The demo/e2e proof: the FULL orchestrator run (the exact path the demo drives
// via /committee/admin/regime) completes offline + persists real-shaped rows when
// fed the hermetic source — with the network hard-banned for the whole run.
test("runAnalytics(hermetic) persists regime + research OFFLINE (demo/e2e path)", async () => {
  const ASOF = new Date().toISOString().slice(0, 10);
  await sql`DELETE FROM regime_snapshots`;
  await sql`DELETE FROM raw_indicator_history`;
  await sql`DELETE FROM research_signals WHERE date = ${ASOF}`;

  banNetwork();
  const results = await runAnalytics(ASOF, undefined, hermeticDataSource);
  globalThis.fetch = realFetch;

  expect(Object.keys(results).sort()).toEqual(["channel-divergence", "late-cycle-signals", "regime"]);
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM regime_snapshots`;
  expect(count).toBeGreaterThan(1000); // full seeded 2018..today axis classified
  const [latest] = await sql`SELECT composite, regime, version, panels, factor_index FROM regime_snapshots ORDER BY date DESC LIMIT 1`;
  expect(Number(latest.composite)).toBeGreaterThanOrEqual(0);
  expect(latest.regime).not.toBeNull();
  // The /regime view renders one index card per panel from the asof row's `panels`.
  // The pipeline computes a real Equity factor index, so all THREE panels must be
  // present on the latest row (regression guard for the dropped-`panels` bug that
  // hid the factor panel). `panels` is asof-only — historical rows stay NULL.
  expect(latest.panels).toEqual(["macro", "onchain", "factor"]);
  expect(latest.factor_index).not.toBeNull();
  const [{ nonnull }] = await sql`SELECT COUNT(*)::int AS nonnull FROM regime_snapshots WHERE panels IS NOT NULL`;
  expect(nonnull).toBe(1); // exactly the asof/latest row carries panels
  for (const key of ["channel-divergence", "late-cycle-signals"]) {
    const rows = await sql`SELECT payload FROM research_signals WHERE signal_key = ${key} AND date = ${ASOF}`;
    expect(rows.length).toBe(1);
    expect(Array.isArray((rows[0].payload as any).gauges)).toBe(true);
  }
}, { timeout: 120_000 });

// The single source knob (issue #13): ANALYTICS_SOURCE is authoritative.
//   unset/""/"live" → live (prod default + explicit demo opt-in)
//   "hermetic"      → hermetic (CI + demo default)
//   anything else   → REFUSED loudly (fail-closed; no silent live-network fallthrough)
test("resolveAnalyticsSource: live is default + explicit opt-in, hermetic opt-out, bad value fails closed", () => {
  const prev = process.env.ANALYTICS_SOURCE;
  try {
    // hermetic opt-out (CI/demo default)
    process.env.ANALYTICS_SOURCE = "hermetic";
    expect(resolveAnalyticsSource()).toBe(hermeticDataSource);

    // unset → production live default
    delete process.env.ANALYTICS_SOURCE;
    expect(resolveAnalyticsSource()).toBe(liveDataSource);

    // empty string → live default (compose passes "" when the var is unset)
    process.env.ANALYTICS_SOURCE = "";
    expect(resolveAnalyticsSource()).toBe(liveDataSource);

    // explicit live opt-in (the demo showcase switch)
    process.env.ANALYTICS_SOURCE = "live";
    expect(resolveAnalyticsSource()).toBe(liveDataSource);

    // a typo must NOT silently fall through to the live network — it throws.
    process.env.ANALYTICS_SOURCE = "seeded";
    expect(() => resolveAnalyticsSource()).toThrow(/invalid ANALYTICS_SOURCE/);
  } finally {
    if (prev === undefined) delete process.env.ANALYTICS_SOURCE;
    else process.env.ANALYTICS_SOURCE = prev;
  }
});
