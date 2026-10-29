// The hand-built backtest scenario that pins the established compatibility
// behaviours AN-5, AN-6, AN-9, AN-10 and AN-14 (issue 1421). Its pinned values
// were captured from the pre-refactor computeBacktest into
// fixtures/originals/an-behaviours.json.gz; tests in this package and in
// backend/tests/backtest-correlations-fidelity.test.ts assert the current code
// still produces exactly those bytes.
//
//   AN-5  blend_hodl applies fixed target weights daily, never charged for the reset.
//   AN-6  strategies start at the first labelled date; baselines at the first priced date.
//   AN-9  an unlabelled day is skipped, including its market move.
//   AN-10 out-of-sample CAGR starts from the first point after the split, duration from the split.
//   AN-14 Sharpe uses pre-cost daily returns; net values include the rebalance cost.
import type { BacktestPayload, BacktestExtras } from "../../src/analyze/backtest.ts";
import type { RegimeComputeResult } from "../../src/analyze/compute.ts";

const DAYS = [
  "2024-01-25", "2024-01-26", "2024-01-27", "2024-01-28", "2024-01-29", "2024-01-30", "2024-01-31",
  "2024-02-01", "2024-02-02", "2024-02-03", "2024-02-04", "2024-02-05", "2024-02-06", "2024-02-07",
];
// Composite labels: two unlabelled days before the first label (AN-6), one
// unlabelled day inside the run (AN-9, 2024-01-28), and transitions that pay
// the rebalance cost (AN-14).
const COMPOSITE: (string | null)[] = [
  null, null, "risk_on", null, "risk_on", "neutral", "neutral",
  "risk_off", "risk_off", "risk_on", "risk_on", "neutral", "risk_on", "risk_on",
];
const ONCHAIN: (string | null)[] = [
  null, null, "neutral", "neutral", "risk_on", "risk_on", "risk_off",
  "risk_off", "neutral", "neutral", "risk_on", "risk_on", "risk_on", "neutral",
];
const ETH = [2200, 2250, 2310, 2180, 2240, 2290, 2260, 2350, 2330, 2400, 2380, 2450, 2420, 2500];
const SPX = [4850, 4870, 4890, 4880, 4920, 4930, 4910, 4950, 4960, 4990, 4970, 5010, 5000, 5040];

export const AN_SCENARIO_DAYS = DAYS;
export const AN_SKIPPED_DAY = "2024-01-28";

export function anScenario(): { dateAxis: string[]; result: RegimeComputeResult; extras: BacktestExtras } {
  const result = {
    dateAxis: DAYS,
    panels: ["macro", "onchain"],
    panelRegimes: { macro: COMPOSITE, onchain: ONCHAIN },
    regime: COMPOSITE,
  } as unknown as RegimeComputeResult;
  return {
    dateAxis: DAYS,
    result,
    extras: {
      eth: DAYS.map((date, i) => ({ date, value: ETH[i]! })),
      spx: DAYS.map((date, i) => ({ date, value: SPX[i]! })),
      tbill3m: [{ date: DAYS[0]!, value: 5.25 }],
    },
  };
}

/** The named pins, in a fixed order, from one UNSTRIPPED backtest of anScenario(). */
export function anPins(bt: BacktestPayload) {
  const eth = bt.eth!;
  const mixed = bt.mixed!;
  return {
    "AN-5 blend_hodl daily values (mixed)": mixed.blend_hodl!._daily,
    "AN-5 blend_hodl transitions": mixed.blend_hodl!.transitions,
    "AN-6 strategy start (composite)": eth.composite!.start_date,
    "AN-6 baseline start (eth_hodl)": eth.eth_hodl!.start_date,
    "AN-6 baseline start (stables_only)": eth.stables_only!.start_date,
    "AN-9 composite daily values (eth)": eth.composite!._daily,
    "AN-9 composite n_days (eth)": eth.composite!.n_days,
    "AN-10 cagr_in_sample (eth composite)": eth.composite!.cagr_in_sample,
    "AN-10 cagr_out_sample (eth composite)": eth.composite!.cagr_out_sample,
    "AN-10 cagr_out_sample (mixed blend_hodl)": mixed.blend_hodl!.cagr_out_sample,
    "AN-14 sharpe (eth composite)": eth.composite!.sharpe,
    "AN-14 final_value (eth composite)": eth.composite!.final_value,
    "AN-14 transitions (eth composite)": eth.composite!.transitions,
    "AN-14 sharpe (mixed composite)": mixed.composite!.sharpe,
    "AN-14 final_value (mixed composite)": mixed.composite!.final_value,
  };
}
