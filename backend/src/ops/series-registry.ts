// The series registry (issue #614 AC3) — the single declared inventory of
// "what does a COMPLETE persisted time series look like" for every table this
// pipeline writes on a schedule. Nothing like this existed before #614: gap
// detection had to be invented per series, ad hoc, after the fact (issue #344
// did this once for the AUM series alone, was never generalized, and the fix
// never reached main — see issue #614's Motivation section). One registry +
// one detector (gap-detector.ts) now covers every series below.
//
// Each entry declares exactly enough for the detector to compute
// "which (date/hour) slots are missing between series start and the expected
// head" with one generic query (generate_series LEFT JOIN DISTINCT dates) —
// the EDGAR two-tier planner (analytics/extract/edgar-fetch-plan.ts) is the
// prior art this borrows the shape from, per the issue's "prior art to build
// on" note.
//
// SCOPE OF "gap": detection here is DATE/HOUR-LEVEL (is there at least one row
// for this slot at all), not full (date × every possible key) cross-product
// detection. A day where the sampler wrote 7 of 8 tracked assets is not a
// date-level gap — that is ordinary sparse byAsset behavior various DTOs
// already document (e.g. contract/src/dashboards.d.ts WalletHistoryPoint).
// What actually produced the AUM incident this issue was filed from — and
// what every operational failure mode in the Motivation section produces — is
// a slot with ZERO rows at all (a frozen scheduler, a missed producer tick),
// which date-level detection catches directly. Per-key cross-product
// detection would additionally require a point-in-time "which keys were
// EXPECTED to exist on that day" oracle (e.g. which wallets/adapters were
// configured back then) that does not exist in this codebase and would be
// speculative to construct.
import { QUARANTINED_PROVENANCE } from "../chain/wallet-valuation.ts";

export type RemediationClass = "A" | "B" | "C";
export type Cadence = "daily" | "hourly";

export interface SeriesDef {
  /** Stable id, used as the operator-surface / test key. */
  key: string;
  /** Human label for the operator surface. */
  label: string;
  /** Table the series is persisted in. */
  table: string;
  /** The date/hour column the series' natural cadence is keyed on. */
  dateColumn: string;
  /** One row per calendar day, or one row per UTC hour. */
  cadence: Cadence;
  /** ISO date (or timestamp) the series is expected to begin from. */
  seriesStart: string;
  /** BACKFILLABLE_FROM_SOURCE (re-fetch) | BACKFILLABLE_BY_RECOMPUTE (derive
   *  from the stored floor) | NOT_BACKFILLABLE (forward-only, disclose the gap). */
  remediationClass: RemediationClass;
  /** Rows that EXIST but do not count as coverage.
   *
   *  A series' gap report answers "which slots does this series actually
   *  cover", and a row nothing is allowed to serve covers nothing. Without
   *  this the detector reads presence off the table while the API reads it off
   *  a filtered view of the same table, and the operator surface starts
   *  disagreeing with what a chart draws — the exact drift §6.5.4 unified the
   *  work list to prevent.
   *
   *  Today this carries one case: the samples migration 0036 quarantined. */
  uncounted?: { column: string; values: readonly string[] };
}

// ── Wallet / sleeve / vault samplers (Class C — the LIVE samplers read chain
//    state at "latest" with spot-only prices, so a sampler cannot answer for a
//    past day; issue #614 §Scope).
//
//    "Class C" is NOT "unrepairable" any more (issue #709). #614's scope note
//    read the samplers' latest-pinned transport as a property of the data, and
//    it is a property of the transport: a read at the day's own block answers
//    exactly what the day held, and a daily OHLCV close prices it. The two
//    WALLET series below now have an executor — ops/wallet-backfill.ts, driven
//    by the scheduled ops.repair_gaps dispatcher — which fills a missing day and
//    tags it provenance='backfilled'.
//
//    The rest of the Class C entries below still have no executor: the vault
//    hourly samples and the projects daily rollups are rollups of CURRENT
//    persisted state, with no historical version to re-derive. They stay Class C
//    and stay disclosed. `remediationClass` is a repair ROUTE, not a promise
//    that a route exists for every series carrying the label — the dispatcher
//    reports which series it could not handle, rather than implying it did. ──
export const SERIES_REGISTRY: SeriesDef[] = [
  {
    key: "wallet_balance_samples",
    label: "Wallet balances",
    table: "wallet_balance_samples",
    dateColumn: "sample_date",
    cadence: "daily",
    seriesStart: "2026-03-18", // chain/wallet-history-seed.ts's earliest seeded day
    remediationClass: "C",
    uncounted: { column: "provenance", values: [QUARANTINED_PROVENANCE] },
  },
  {
    key: "wallet_sleeve_samples",
    label: "Wallet sleeves",
    table: "wallet_sleeve_samples",
    dateColumn: "sample_date",
    cadence: "daily",
    seriesStart: "2026-03-18",
    remediationClass: "C",
    uncounted: { column: "provenance", values: [QUARANTINED_PROVENANCE] },
  },
  {
    key: "vault_share_price_history",
    label: "Vault share price",
    table: "vault_share_price_history",
    dateColumn: "sample_hour",
    cadence: "hourly",
    seriesStart: "2026-03-18",
    remediationClass: "C",
  },
  {
    key: "vault_adapter_samples",
    label: "Vault adapters",
    table: "vault_adapter_samples",
    dateColumn: "sample_hour",
    cadence: "hourly",
    seriesStart: "2026-03-18",
    remediationClass: "C",
  },
  // ── Projects "Agentic Economy Ecosystem" daily snapshots (issue #87). Each
  //    is a rollup of CURRENT persisted state (coins/agents/wallets/vaults) —
  //    there is no historical version of those rows to re-derive, so a missed
  //    day is Class C too (see worker/handlers/projects.ts::snapshotDaily's
  //    #614 comment). ──
  {
    key: "daily_coin_snapshots",
    label: "Projects: coin snapshots",
    table: "daily_coin_snapshots",
    dateColumn: "snapshot_date",
    cadence: "daily",
    seriesStart: "2026-01-01",
    remediationClass: "C",
  },
  {
    key: "daily_agent_snapshots",
    label: "Projects: agent snapshots",
    table: "daily_agent_snapshots",
    dateColumn: "snapshot_date",
    cadence: "daily",
    seriesStart: "2026-01-01",
    remediationClass: "C",
  },
  {
    key: "daily_wallet_snapshots",
    label: "Projects: wallet snapshots",
    table: "daily_wallet_snapshots",
    dateColumn: "snapshot_date",
    cadence: "daily",
    seriesStart: "2026-01-01",
    remediationClass: "C",
  },
  {
    key: "daily_tvl_snapshots",
    label: "Projects: TVL snapshots",
    table: "daily_tvl_snapshots",
    dateColumn: "snapshot_date",
    cadence: "daily",
    seriesStart: "2026-01-01",
    remediationClass: "C",
  },
  // ── Research (Class B — deterministic recompute for a past `asof`;
  //    analyze/research-signals.ts:170,:279) ──
  {
    key: "research_signals",
    label: "Research signals",
    table: "research_signals",
    dateColumn: "date",
    cadence: "daily",
    seriesStart: "2026-01-01",
    remediationClass: "B",
  },
  // ── raw_indicator_history (Class A — the persisted-real floor every
  //    historical-source extractor refills; analytics/store/floor-seed.ts) ──
  {
    key: "raw_indicator_history",
    label: "Raw indicator history",
    table: "raw_indicator_history",
    dateColumn: "date",
    cadence: "daily",
    seriesStart: "2018-01-01", // matches analytics/index.ts's BACKFILL_START
    remediationClass: "A",
  },
];

export function getSeriesDef(key: string): SeriesDef | undefined {
  return SERIES_REGISTRY.find((s) => s.key === key);
}
