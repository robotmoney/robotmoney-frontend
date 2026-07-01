// PROD HONESTY: the guarantee this whole feature exists to protect — on the LIVE
// production path there is NO synthetic (seeded) data. This test drives the REAL
// orchestrator (runAnalytics) through the REAL `liveDataSource` with EVERY network
// fetch forced to fail, a small REAL persisted floor seeded in the DB, and asserts:
//   (a) the run degrades to the persisted-REAL floor via append-only merge — the
//       seeded rows are preserved exactly, nothing is erased;
//   (b) an indicator with NO history at all is EXCLUDED (weight 0 → not in the
//       panel weight map) and a LOUD warn is emitted;
//   (c) the seededProvider is NEVER invoked on this path (behavioral spy = 0 calls);
//   (d) statically, the live data-source import graph never pulls in seededProvider.
//
// A future regression that reintroduces synthetic fallback on the live path MUST
// fail (b)/(c)/(d) here. DB-backed (ephemeral Postgres via preload.ts) — loud-fails
// if Docker/Postgres is absent, never skips.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sql } from "../src/db/client.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import { liveDataSource } from "../src/analytics/access/data-source.ts";
import { seededProvider } from "../src/analytics/access/provider.ts";
import { saveRawIndicatorHistory } from "../src/analytics/store/raw-history-store.ts";

const ASOF = "2026-06-29";

// ── (d) STATIC: the live orchestration DATA path never imports seededProvider ──
// Transitively walk the import graph from the live data source and assert none of
// the reachable modules is access/provider.ts or references `seededProvider`. This
// is intentionally scoped to the LIVE path (data-source.ts) — index.ts itself may
// legitimately import hermetic-source.ts for the offline demo opt-in, but the REAL
// fetch seam must be seed-free.
function importGraph(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [resolve(entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    const re = /(?:from|import)\s+["'](\.[^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      let spec = m[1];
      if (!spec.endsWith(".ts")) spec += ".ts";
      stack.push(resolve(dirname(file), spec));
    }
  }
  return [...seen];
}

test("prod honesty (STATIC): the live data-source import graph never imports seededProvider", () => {
  const graph = importGraph("src/analytics/access/data-source.ts");
  expect(graph.length).toBeGreaterThan(3); // sanity: it actually walked the tree
  const providerPath = resolve("src/analytics/access/provider.ts");
  expect(graph).not.toContain(providerPath);
  for (const file of graph) {
    const src = readFileSync(file, "utf8");
    expect(src.includes("seededProvider"), `${file} must not reference seededProvider on the live path`).toBe(false);
  }
});

test(
  "prod honesty (BEHAVIORAL): live path degrades to the persisted-real floor, excludes no-history indicators, and NEVER seeds",
  async () => {
    // Reset the raw floor + snapshots so this run is deterministic.
    await sql`DELETE FROM raw_indicator_history`;
    await sql`DELETE FROM regime_snapshots`;

    // Seed a SMALL, REAL persisted floor for two indicators only. Every OTHER
    // registry indicator has NO history at all → must be excluded + warned.
    const T10 = "T10Y2Y";
    const STB = "STABLES";
    const t10Floor = [
      { date: "2026-06-24", value: 0.31 },
      { date: "2026-06-25", value: 0.29 },
      { date: "2026-06-26", value: 0.3 },
      { date: "2026-06-27", value: 0.28 },
      { date: "2026-06-28", value: 0.27 },
    ];
    const stbFloor = [
      { date: "2026-06-26", value: 160_000_000_000 },
      { date: "2026-06-27", value: 161_000_000_000 },
      { date: "2026-06-28", value: 162_000_000_000 },
    ];
    await saveRawIndicatorHistory({ [T10]: t10Floor, [STB]: stbFloor });

    // ── (c) instrument seededProvider (module singleton; every importer shares
    // this object). A live run must never call it. ──
    const origGetSeries = seededProvider.getSeries;
    let seededCalls = 0;
    seededProvider.getSeries = function (...args: Parameters<typeof origGetSeries>) {
      seededCalls++;
      return origGetSeries.apply(this, args);
    };

    // Force EVERY network fetch to fail — the ONLY honest fallback is the floor.
    const origFetch = globalThis.fetch;
    let fetchAttempts = 0;
    (globalThis as any).fetch = () => {
      fetchAttempts++;
      return Promise.reject(new Error("network disabled for prod-honesty test"));
    };

    // Capture loud warnings emitted by the orchestrator's default `console` logger.
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };

    try {
      // DEFAULT/LIVE source explicitly — NOT the hermetic or a fixture source.
      await runAnalytics(ASOF, "regime", liveDataSource);
    } finally {
      console.warn = origWarn;
      (globalThis as any).fetch = origFetch;
      seededProvider.getSeries = origGetSeries;
    }

    // The live fetchers actually tried to hit the network (proves we exercised the
    // real path, not a stub) and every attempt failed.
    expect(fetchAttempts).toBeGreaterThan(0);

    // ── (c) seededProvider was NEVER invoked on the live path ──
    expect(seededCalls).toBe(0);

    // ── (a) append-only merge preserved the REAL floor exactly (nothing erased) ──
    const t10Rows = await sql`SELECT date::text AS date, value FROM raw_indicator_history WHERE indicator = ${T10} ORDER BY date`;
    expect(t10Rows.map((r: any) => [r.date, Number(r.value)])).toEqual(t10Floor.map((p) => [p.date, p.value]));
    const stbRows = await sql`SELECT date::text AS date, value FROM raw_indicator_history WHERE indicator = ${STB} ORDER BY date`;
    expect(stbRows.length).toBe(stbFloor.length);

    // Indicators with no history were never fabricated into the floor.
    const [{ n: vixRows }] = await sql`SELECT COUNT(*)::int AS n FROM raw_indicator_history WHERE indicator = 'VIX'`;
    expect(vixRows).toBe(0);

    // ── (b) LOUD exclusion + degradation warnings fired ──
    const joined = warns.join("\n");
    // a specific no-history indicator was excluded (weight 0 → all-NaN)
    expect(warns.some((w) => /NO history at all — excluded/.test(w))).toBe(true);
    // the aggregate exclusion summary fired for many indicators (24 of 26 here)
    expect(joined).toMatch(/indicator\(s\) excluded entirely/);

    // ── (b, cont.) the persisted snapshot never assigns a no-history indicator a
    // non-zero weight. If classified rows landed, the latest row's rich indicator
    // objects must show excluded ids with null/0 panel_weight. ──
    const [latest] = await sql`SELECT indicators FROM regime_snapshots ORDER BY date DESC LIMIT 1`;
    if (latest?.indicators) {
      const inds = latest.indicators as any[];
      const vix = inds.find((i) => i.id === "VIX");
      if (vix) expect(vix.panel_weight == null || vix.panel_weight === 0).toBe(true);
    }
  },
  { timeout: 120_000 },
);
