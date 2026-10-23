// Issue 1421: every downstream SDK path runs from supplied data only. With
// every HTTP client poisoned by the preload (tests/no-network.ts) AND the
// extractors' injectable seam (extract/http.ts) replaced by a recorder, the
// complete, incomplete and error paths below make zero acquisition attempts:
//   - complete input: the full report, correlations, backtest and daily values;
//   - a missing REQUIRED series (a whole composite panel): the named CoverageError;
//   - a missing OPTIONAL series: the documented missing result (src/coverage.ts).
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import { configureHttp } from "../src/extract/http.ts";
import { parseRawHistory, toHistory } from "../src/input/load.ts";
import { buildReport, runRegime } from "../src/run.ts";
import { CoverageError, assertRequiredCoverage } from "../src/coverage.ts";
import { INDICATORS } from "../src/analyze/indicators.ts";
import { computeBacktest } from "../src/analyze/backtest.ts";
import { prepareRegimeInputs } from "../src/prepare.ts";
import type { RawIndicatorHistory } from "../src/types.ts";
import { variantCsv } from "./support/originals.ts";

setDefaultTimeout(180_000);

const attempts: string[] = [];
const previous = configureHttp({
  fetch: (async (input: string) => {
    attempts.push(`fetch ${input}`);
    throw new Error("acquisition attempted after extract");
  }) as unknown as typeof fetch,
  recordFetch: (r) => attempts.push(`record ${r.url}`),
  cache: async (_kind, url) => {
    attempts.push(`cache ${url}`);
    throw new Error("acquisition attempted after extract");
  },
});
afterAll(() => configureHttp(previous));

const full = toHistory(parseRawHistory(variantCsv("production")));
const without = (ids: (id: string) => boolean): RawIndicatorHistory => {
  const out: RawIndicatorHistory = {};
  for (const [id, pts] of Object.entries(full)) if (!ids(id)) out[id] = pts;
  return out;
};
const panelIds = (panel: string) => new Set(INDICATORS.filter((i) => i.panel === panel).map((i) => i.id));

describe("every HTTP client is poisoned", () => {
  test("fetch, node:http, node:https, WebSocket, EventSource and XMLHttpRequest all throw", () => {
    expect(() => fetch("http://localhost")).toThrow(/must not use the network/);
    expect(() => http.request("http://localhost")).toThrow(/must not use the network/);
    expect(() => https.get("https://localhost")).toThrow(/must not use the network/);
    for (const name of ["WebSocket", "EventSource", "XMLHttpRequest"]) {
      const Ctor = (globalThis as Record<string, any>)[name];
      expect(() => new Ctor("ws://localhost"), name).toThrow(/must not use the network/);
    }
  });
});

describe("downstream paths make zero acquisition attempts", () => {
  test("complete input: report, correlations, backtest and daily values", () => {
    const run = runRegime(full, { factor: true });
    const report = buildReport(run, { full: true });
    expect(report.regime.label).not.toBeNull();
    expect(report.correlations).not.toBeNull();
    expect(report.backtest).not.toBeNull();
    const daily = computeBacktest(run.dateAxis, run.result, { spx: full.SPX!, eth: full.ETH!, tbill3m: full.TBILL3M! });
    expect(daily.eth!.composite!._daily!.length).toBeGreaterThan(100);
    expect(attempts).toEqual([]);
  });

  test("missing required series: no composite panel with data raises CoverageError", () => {
    const composite = new Set([...panelIds("macro"), ...panelIds("onchain")]);
    let err: unknown;
    try {
      runRegime(without((id) => composite.has(id)));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CoverageError);
    expect((err as CoverageError).name).toBe("CoverageError");
    expect((err as CoverageError).missingPanels).toEqual(["macro", "onchain"]);
    // Rows only AFTER the as-of day do not count as coverage.
    const late: RawIndicatorHistory = { ...without((id) => composite.has(id)), BTC_MVRV: [{ date: "2030-01-01", value: 1 }] };
    expect(() => assertRequiredCoverage(late, "2026-08-15")).toThrow(CoverageError);
    // One empty panel is not an error: the composite uses the panel with data.
    const onchain = panelIds("onchain");
    expect(() => assertRequiredCoverage(without((id) => onchain.has(id)), "2026-08-15")).not.toThrow();
    expect(attempts).toEqual([]);
  });

  test("missing optional SPX/ETH: correlations and backtest are null; the regime is still reported", () => {
    const report = buildReport(runRegime(without((id) => id === "SPX" || id === "ETH")));
    expect(report.correlations).toBeNull();
    expect(report.backtest).toBeNull();
    expect(report.regime.label).not.toBeNull();
    expect(attempts).toEqual([]);
  });

  test("missing optional TBILL3M: the backtest is null, correlations are still computed", () => {
    const report = buildReport(runRegime(without((id) => id === "TBILL3M")));
    expect(report.backtest).toBeNull();
    expect(report.correlations).not.toBeNull();
    expect(attempts).toEqual([]);
  });

  test("missing optional factor panel: the factor figures are null, the composite is unchanged", () => {
    const ids = panelIds("factor");
    const base = buildReport(runRegime(full));
    const run = runRegime(without((id) => ids.has(id)), { factor: true });
    const report = buildReport(run);
    // The report is JSON: a NaN figure serialises to null, the documented missing result.
    const serialised = JSON.parse(JSON.stringify(report)) as { factor: { index: number | null; percentile: number | null } };
    expect(serialised.factor.index).toBeNull();
    expect(serialised.factor.percentile).toBeNull();
    expect(report.regime).toEqual(base.regime);
    expect(attempts).toEqual([]);
  });

  test("one empty registry indicator stays all-NaN with weight 0, not an error", () => {
    const p = prepareRegimeInputs(without((id) => id === "VIX"), { start: "2018-01-01", asof: "2026-08-15" });
    expect(p.transformed.VIX!.every((v) => Number.isNaN(v))).toBe(true);
    expect(() => runRegime(without((id) => id === "VIX"))).not.toThrow();
    expect(attempts).toEqual([]);
  });
});
