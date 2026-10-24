// Required-data coverage for a regime run (issue 1421). Downstream stages run
// from supplied data only: when required data is missing they raise a named
// error, and they never fetch to fill the gap. Pure: no filesystem,
// environment or network.
//
// REQUIRED: at least one composite panel (PANELS: macro, onchain) needs a
// registry indicator with a finite observation on or before the as-of day.
// With none, no day can be labelled, so there is no report to give. One empty
// panel is not an error: the composite is built from the panels that have
// data, as it always was, and a single indicator with no rows stays all-NaN
// with weight 0 (docs/technical/regime-engine.md §8.1).
//
// OPTIONAL, with the documented missing result instead of an error:
//   - the factor panel: display-only, its figures are null;
//   - SPX and ETH: correlations and backtest are null in the SDK report, and
//     carry no pairs or portfolios in the backend snapshot;
//   - TBILL3M: the SDK backtest is null; the backend backtest earns no cash yield.
import type { RawIndicatorHistory } from "./types.ts";
import { INDICATORS, PANELS, type Panel } from "./analyze/indicators.ts";

export class CoverageError extends Error {
  constructor(
    readonly asof: string,
    readonly missingPanels: readonly Panel[],
  ) {
    super(
      `required data missing for as-of ${asof}: no composite panel (${missingPanels.join(", ")}) has an observation on or before it ` +
        "(supply the series; a downstream run never fetches)",
    );
    this.name = "CoverageError";
  }
}

/** Throws CoverageError when no composite panel has a finite observation on or before `asof`. */
export function assertRequiredCoverage(raw: RawIndicatorHistory, asof: string, panels: readonly Panel[] = PANELS): void {
  const missing = panels.filter(
    (panel) => !INDICATORS.some((ind) => ind.panel === panel && (raw[ind.id] ?? []).some((p) => p.date <= asof && Number.isFinite(p.value))),
  );
  if (missing.length === panels.length) throw new CoverageError(asof, missing);
}
