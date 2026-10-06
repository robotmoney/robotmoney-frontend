// The one place the backtest/correlations "extras" (SPX/ETH price levels and
// the DTB3 T-bill yield) are named. Three layers agree through this map: the
// ledger/tolerance key (backend data-source.ts, SOURCE_TOLERANCES), the SDK
// input pseudo-indicator id (run.ts EXTRA_IDS), and the upstream provider
// symbol. Production rows exist under these ledger keys: never rename them.
// Pure: no fs/env/db.
export interface LedgerExtra {
  readonly ledgerKey: string;
  readonly inputId: string;
  readonly provider: "yahoo" | "fred";
  readonly symbol: string;
}

export const LEDGER_EXTRA_KEYS = {
  spx: { ledgerKey: "backtest:^GSPC", inputId: "SPX", provider: "yahoo", symbol: "^GSPC" },
  eth: { ledgerKey: "backtest:ETH-USD", inputId: "ETH", provider: "yahoo", symbol: "ETH-USD" },
  tbill3m: { ledgerKey: "backtest:DTB3", inputId: "TBILL3M", provider: "fred", symbol: "DTB3" },
} as const satisfies Record<string, LedgerExtra>;
