// The regime snapshot columns, stated once (issue 1765, phase 1). Pure.
//
// One entry per column of a stored regime snapshot row, in the key order the
// served snapshot carries them (rowToSnapshot, src/report/regime-snapshots.ts).
// Every row mapper reads this table: rowToSnapshot loops over it, the replay
// comparison takes its compared fields from it (src/replay/compare.ts), and a
// test holds its keys equal to RegimeSnapshotRow's (src/report/canonical.ts).
//
//   key          the camelCase key of the row and the served snapshot.
//   column       the snake_case column of the regime_snapshots table.
//   kind         how a stored cell is read: `number` (numeric text to a number,
//                num()), `label` and `text` (as read), `json` (jsonb, as read),
//                `date` (YYYY-MM-DD, a Date normalised to its UTC day).
//   sqlType      the column's type in the regime_snapshots table.
//   empty        what rowToSnapshot writes for an empty cell (null, {} or []). A
//                label or date cell has no default: it is written as read.
//   asofOnly     carries data only on a run's as-of row (null or [] on the others).
//   compared     a field the replay recomputes and compares (COMPARED_FIELDS).
//   builderEmits the row builder (publishedRows) writes it. Only the eq-snapshot
//                importer sets bucketThresholds and extras.

export type SnapshotColumnKind = "number" | "label" | "json" | "text" | "date";

export interface SnapshotColumn<K extends string = string> {
  readonly key: K;
  readonly column: string;
  readonly kind: SnapshotColumnKind;
  readonly sqlType: "date" | "numeric" | "text" | "jsonb";
  readonly empty: null | Readonly<Record<string, never>> | readonly never[];
  readonly asofOnly: boolean;
  readonly compared: boolean;
  readonly builderEmits: boolean;
}

const col = <K extends string>(
  key: K,
  column: string,
  kind: SnapshotColumnKind,
  sqlType: SnapshotColumn["sqlType"],
  o: { empty?: SnapshotColumn["empty"]; asofOnly?: boolean; compared?: boolean; builderEmits?: boolean } = {},
): SnapshotColumn<K> =>
  Object.freeze({ key, column, kind, sqlType, empty: o.empty ?? null, asofOnly: o.asofOnly ?? false, compared: o.compared ?? false, builderEmits: o.builderEmits ?? true });

/** Every regime snapshot column, in the served key order. */
export const SNAPSHOT_COLUMNS = Object.freeze([
  col("date", "date", "date", "date"),
  col("composite", "composite", "number", "numeric", { compared: true }),
  col("compositePercentile", "composite_percentile", "number", "numeric", { compared: true }),
  col("regime", "regime", "label", "text", { compared: true }),
  col("macroRegime", "macro_regime", "label", "text", { compared: true }),
  col("onchainRegime", "onchain_regime", "label", "text", { compared: true }),
  col("factorRegime", "factor_regime", "label", "text", { compared: true }),
  col("macroIndex", "macro_index", "number", "numeric", { compared: true }),
  col("onchainIndex", "onchain_index", "number", "numeric", { compared: true }),
  col("factorIndex", "factor_index", "number", "numeric", { compared: true }),
  col("macroPercentile", "macro_percentile", "number", "numeric", { compared: true }),
  col("onchainPercentile", "onchain_percentile", "number", "numeric", { compared: true }),
  col("factorPercentile", "factor_percentile", "number", "numeric", { compared: true }),
  col("panelWeights", "panel_weights", "json", "jsonb", { asofOnly: true }),
  col("version", "version", "text", "text"),
  col("source", "source", "text", "text"),
  col("percentiles", "percentiles", "json", "jsonb", { empty: Object.freeze({}) as Readonly<Record<string, never>>, compared: true }),
  col("indicators", "indicators", "json", "jsonb", { empty: Object.freeze([]) as readonly never[], asofOnly: true }),
  col("panels", "panels", "json", "jsonb", { asofOnly: true }),
  col("bucketThresholds", "bucket_thresholds", "json", "jsonb", { asofOnly: true, builderEmits: false }),
  col("backtest", "backtest", "json", "jsonb", { asofOnly: true, compared: true }),
  col("correlations", "correlations", "json", "jsonb", { asofOnly: true, compared: true }),
  col("extras", "extras", "json", "jsonb", { asofOnly: true, builderEmits: false }),
] as const);

/** The key of a regime snapshot column (the keys of RegimeSnapshotRow, tests/snapshot-columns.test.ts). */
export type SnapshotKey = (typeof SNAPSHOT_COLUMNS)[number]["key"];
