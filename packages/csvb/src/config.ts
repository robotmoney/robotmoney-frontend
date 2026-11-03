// What gets backed up, and how each table behaves over time.
//
// Two kinds of table, and the difference is the whole design:
//
//   APPEND-ONLY: rows are only ever inserted, never changed (the analytics ledger, frozen run outputs, source
//   value versions, revision events). Each backup adds only the rows whose `id` is above the last backup's highest
//   id, as files named by id range. A file, once written, is never touched again.
//
//   REVISED: rows the database rewrites in place (regime_snapshots is recomputed on every run, raw indicator
//   history is revised when a provider restates a value). The backup never overwrites a file either: each backup
//   adds a REVISION file holding only the rows that are new or changed since the previous backup (and a delete
//   marker for rows that vanished). The state at any backup is the replay of the revision files up to it.
//
// The tables, their order, their time columns and their revision keys are format 1's table catalog
// (packages/analyst-sdk/src/archive/format1.ts, shared with the public archive routes; issue 1477). This file adds
// only what csvb needs to read them from a replica: the select list and the page size.
//
// Every `select` is a trusted constant. Columns that hold bytea payloads (JSON text in practice) are decoded to
// UTF-8 text beside a SHA-256 of the STORED bytes, so the text is provably the stored value.
import { APPEND_ONLY_TABLES, REVISED_TABLES, type TimeSpec } from "@robotmoney/analyst-sdk/src/archive/format1.ts";

export type { TimeSpec };

export interface AppendOnlyTable {
  name: string;
  /** Which timestamp says when a row happened; files are named by the earliest and latest in them (UTC). */
  time: TimeSpec;
  /** Select list (a trusted constant). `*` means every column in table order. */
  select: string;
  /** Rows per keyset page, sized to a few MB per statement. */
  pageRows: number;
  /** Decoded payload columns: text must hash to the paired sha256 column on every row. */
  hashed?: { text: string; sha256: string }[];
}

export interface RevisedTable {
  name: string;
  select: string;
  /** Columns that identify a row. */
  key: string[];
  orderBy: string;
}

const PAYLOAD = "id, run_id, artifact_kind, checksum, byte_length, created_at, convert_from(payload_bytes, 'UTF8') AS payload_json, encode(sha256(payload_bytes), 'hex') AS payload_sha256";
const REPORT = "id, run_id, asof, checksum, byte_length, created_at, convert_from(report_bytes, 'UTF8') AS report_json, encode(sha256(report_bytes), 'hex') AS report_sha256";

// How csvb reads each catalog table: its select list, page size and hashed payload columns.
const READ: Record<string, Pick<AppendOnlyTable, "select" | "pageRows" | "hashed">> = {
  analytics_output_snapshots: { select: PAYLOAD, pageRows: 4, hashed: [{ text: "payload_json", sha256: "payload_sha256" }] },
  analytics_report_snapshots: { select: REPORT, pageRows: 10, hashed: [{ text: "report_json", sha256: "report_sha256" }] },
  source_value_versions: { select: "*", pageRows: 20000 },
  analytics_ledger_runs: { select: "*", pageRows: 5000 },
  analytics_ledger_run_events: { select: "*", pageRows: 5000 },
  analytics_ledger_methodology_versions: { select: "*", pageRows: 5000 },
  analytics_data_vintages: { select: "*", pageRows: 1000 },
  analytics_vintage_members: { select: "*", pageRows: 50000 },
  analytics_overwrite_events: { select: "*", pageRows: 1500 },
  analytics_parity_observations: { select: "*", pageRows: 2000 },
};
const REVISED_ORDER: Record<string, string> = {
  regime_snapshots: "date",
  raw_indicator_history: "indicator, date",
  asset_prices: "price_date, symbol, time_basis",
  analytics_read_mode: "1",
};

export const APPEND_ONLY: readonly AppendOnlyTable[] = APPEND_ONLY_TABLES.map((t) => {
  const r = READ[t.name];
  if (!r) throw new Error(`csvb has no select list for the catalog table ${t.name}`);
  return { name: t.name, time: t.time, ...r };
});

export const REVISED: readonly RevisedTable[] = REVISED_TABLES.map((t) => {
  const orderBy = REVISED_ORDER[t.name];
  if (!orderBy) throw new Error(`csvb has no order for the catalog table ${t.name}`);
  return { name: t.name, select: "*", key: [...t.key], orderBy };
});

export const appendOnly = (name: string): AppendOnlyTable | undefined => APPEND_ONLY.find((t) => t.name === name);
export const revised = (name: string): RevisedTable | undefined => REVISED.find((t) => t.name === name);
export const ALL_TABLE_NAMES = [...APPEND_ONLY.map((t) => t.name), ...REVISED.map((t) => t.name)];
