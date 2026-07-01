// TEST-ONLY provider scaffolding. The PRODUCTION path is analytics/index.ts
// runAnalytics → access/data-source.ts liveDataSource (real fetchers, no synthetic
// fallback). This FetcherProvider is retained solely for the hermetic
// tests/providers.test.ts (it exercises the seeded degradation seam) and is NOT
// referenced by the orchestrator — the old PROVIDER=live proxy behavior is
// superseded now that the default IS real.
//
// It implements the same `Provider` interface as the
// default `seededProvider`, but pulls REAL series from KEYLESS public sources
// (DefiLlama, Yahoo Finance — see extract/sources.ts for the id→source
// map). Series that require keys (FRED: T10Y2Y/HY_OAS/ICSA) or RPC, plus anything
// with no keyless source (MNA/MARGIN/CONF), fall back to the seeded path PER
// SERIES.
//
// This is a composition over the extract + transform stages:
//   - warm()      pulls every mappable series via extract/sources.ts (extract).
//   - getSeries() reshapes a cached series onto the dense grid via
//                 transform/grid.ts `shapeDaily` (transform), or falls back to
//                 access/provider.ts `seededProvider` for that single id.
//
// The `Provider` contract is synchronous, but real fetches are async, so the live
// provider PRE-FETCHES every mappable series once via `warm(asof)` (called from
// access/select.ts before registry.run) and then serves `getSeries` from that
// in-run cache. ANY failure — bad status, network error, timeout, empty/garbage
// payload, or an id we don't map — degrades to `seededProvider.getSeries` for that
// single series. `getSeries` therefore never throws and the suite always runs.
import type { Provider, SeriesSpec, Point } from "./provider.ts";
import { seededProvider } from "./provider.ts";
import { loadSources } from "../extract/sources.ts";
import { shapeDaily } from "../transform/grid.ts";

export class FetcherProvider implements Provider {
  // Per-run cache of REAL series, keyed by the canonical series id. Absent entry
  // (fetch failed or unmapped) ⇒ getSeries falls back to seeded for that id.
  private series = new Map<string, Point[]>();
  private warmed = false;

  // Pre-fetch every mappable series once. Concurrent; every source is isolated so
  // one failure only drops its own series. Safe to call once per analytics run.
  async warm(_asof?: string): Promise<void> {
    if (this.warmed) return;
    this.warmed = true;
    const set = (id: string, pts: Point[]) => {
      if (pts.length) this.series.set(id, pts);
    };
    await Promise.all(loadSources(set));
  }

  getSeries(spec: SeriesSpec, asof: string, lookbackDays: number): Point[] {
    const raw = this.series.get(spec.id);
    if (raw) {
      const shaped = shapeDaily(raw, asof, lookbackDays);
      if (shaped) return shaped;
    }
    // Unmapped id, fetch failure, or no data at/-before asof ⇒ seeded fallback.
    return seededProvider.getSeries(spec, asof, lookbackDays);
  }
}

// Factory used by access/select.ts when PROVIDER=live.
export function createFetcherProvider(): FetcherProvider {
  return new FetcherProvider();
}
