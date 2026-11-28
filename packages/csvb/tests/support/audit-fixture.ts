// Synthetic backup repos for the audit tests (issue 1477). The audits used to run against a production baseline
// committed in robotmoney/csv-backups; production data is never committed here, so these repos are built at test
// time from facts chosen by hand, and the tests assert those facts.
//
//   ledgerRepo()  the run ledger (regime and research runs with an outage streak, a missed day, an unfinished run),
//                 each regime run's published payload, the regime_snapshots table now, and the revision log.
//   replayRepo()  two regime runs with frozen vintages over the SDK's raw-history fixture, each with the payload the
//                 SDK computes from exactly that vintage (the published record a replay must reproduce): the rows of
//                 the SDK's publishedRows, as the producer freezes them, with their payload_sha256.
//
// Each backup record lists its files with bytes_raw and sha256_raw, as csvb writes them, so the SDK's own archive
// reader (which the audit replay opens the repo with) verifies them. The repos carry no methodology table: every run
// is on the main line and replays under the SDK's current version. A test edits a copy of a repo (a methodology table,
// a missing member, a tampered hash) with readAppendTable and putAppendTable.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { encodeCsvRow, parseCopyCsv } from "@robotmoney/analyst-sdk/src/archive/format1.ts";
import { REGIME_ARTIFACT_KIND } from "@robotmoney/analyst-sdk/src/analyze/regime-versions.ts";

type Cell = string | number | null;
interface AppendTable {
  header: string[];
  rows: Cell[][];
}
interface RevisedTableData {
  key: string[];
  header: string[];
  rows: Cell[][];
}

const text = (v: Cell): string | null => (v === null ? null : String(v));
const csv = (header: string[], rows: Cell[][]): Buffer => Buffer.from(encodeCsvRow(header) + rows.map((r) => encodeCsvRow(r.map(text))).join(""), "utf8");
const sha256 = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");
/** A listed file: its path, rows, uncompressed size and hash. */
const listed = (path: string, raw: Buffer, rows: number) => ({ path, rows, bytes_raw: raw.length, sha256_raw: sha256(raw) });

/** Write one append-only table of a backup as its single data file, and return the table's entry of the backup record. */
function appendFile(root: string, backup: string, table: string, t: AppendTable): Record<string, unknown> {
  const path = `csv/${backup}/data/${table}.2026-01-01T000000Z_2026-01-01T000000Z.csv.gz`;
  const raw = csv(t.header, t.rows);
  writeFileSync(join(root, path), gzipSync(raw));
  return { watermark_before: null, watermark_after: String(t.rows.length), rows_added: t.rows.length, files: [listed(path, raw, t.rows.length)] };
}

/** Write one backup holding these tables, in the format 1 layout the audits read. */
export function writeBackupRepo(root: string, backup: string, append: Record<string, AppendTable>, revised: Record<string, RevisedTableData>): void {
  const dir = join(root, "csv", backup);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "revisions"), { recursive: true });
  const append_only: Record<string, unknown> = {};
  for (const [table, t] of Object.entries(append)) append_only[table] = appendFile(root, backup, table, t);
  const revisions: Record<string, unknown> = {};
  for (const [table, t] of Object.entries(revised)) {
    const path = `csv/${backup}/revisions/${table}.csv.gz`;
    const raw = csv(["_backup", "_op", ...t.header], t.rows.map((r) => [backup, "upsert", ...r]));
    writeFileSync(join(root, path), gzipSync(raw));
    revisions[table] = { key: t.key, file: listed(path, raw, t.rows.length), upserts: t.rows.length, deletes: 0, rows_in_state: t.rows.length };
  }
  const record = { format: 1, backup, snapshot: { exported_at_db: "2026-09-27 00:00:00+00", replica_replay_ts: null, db_user: "test", was_replica: false }, tool: { name: "audit-fixture", commit: null }, append_only, revisions };
  writeFileSync(join(dir, "backup.json"), JSON.stringify(record, null, 2) + "\n");
}

/** One append-only table of a written backup: its header and its rows in file order (a test edits a copy of a repo with it). */
export function readAppendTable(root: string, backup: string, table: string): AppendTable {
  const rec = JSON.parse(readFileSync(join(root, "csv", backup, "backup.json"), "utf8"));
  const files: { path: string }[] = rec.append_only[table]?.files ?? [];
  if (files.length !== 1) throw new Error(`backup ${backup} lists ${files.length} files of ${table}, not 1`);
  const t = parseCopyCsv(gunzipSync(readFileSync(join(root, files[0]!.path))).toString("utf8"));
  return { header: t.header, rows: t.rows };
}

/** Replace, or add, one append-only table of a written backup: its data file and its entry of the backup record, sizes and hash. */
export function putAppendTable(root: string, backup: string, table: string, t: AppendTable): void {
  const recPath = join(root, "csv", backup, "backup.json");
  const rec = JSON.parse(readFileSync(recPath, "utf8"));
  rec.append_only[table] = appendFile(root, backup, table, t);
  writeFileSync(recPath, JSON.stringify(rec, null, 2) + "\n");
}

// ── the run ledger, the payloads and the revision log ─────────────────────────────────────────────

export const LEDGER_BACKUP = "2026-09-27T000000Z";

// [id, tool, asof, outcome]; outcome is the run's last event ("started" means it never finished).
const RUNS: [number, string, string, "succeeded" | "failed" | "started"][] = [
  [1, "regime", "2026-09-20", "succeeded"],
  [2, "regime", "2026-09-21", "succeeded"],
  [3, "regime", "2026-09-22", "failed"],
  [4, "regime", "2026-09-22", "failed"],
  [5, "regime", "2026-09-22", "failed"],
  [6, "regime", "2026-09-22", "failed"],
  [7, "regime", "2026-09-23", "succeeded"],
  [8, "regime", "2026-09-24", "succeeded"],
  [9, "regime", "2026-09-24", "succeeded"],
  [10, "regime", "2026-09-25", "failed"],
  [11, "regime", "2026-09-25", "failed"],
  [12, "regime", "2026-09-25", "succeeded"],
  [13, "regime", "2026-09-26", "started"],
  [14, "regime", "2026-09-26", "succeeded"],
  [15, "research", "2026-09-22", "failed"],
  [16, "research", "2026-09-22", "failed"],
  [17, "research", "2026-09-22", "failed"],
  [18, "research", "2026-09-23", "succeeded"],
];

/** The composite each day would have with no revision; a run publishes it plus 0.001 per earlier successful run. */
const BASE: Record<string, number> = {
  "2026-09-18": 0.4,
  "2026-09-19": 0.42,
  "2026-09-20": 0.44,
  "2026-09-21": 0.49,
  "2026-09-22": 0.47,
  "2026-09-23": 0.52,
  "2026-09-24": 0.488,
  "2026-09-25": 0.55,
  "2026-09-26": 0.56,
};
export const LABEL_AT = 0.495;
const label = (c: number): string => (c >= LABEL_AT ? "risk_on" : "neutral");
const createdAt = (id: number): string => `2026-09-${String(20 + Math.floor((id - 1) / 3)).padStart(2, "0")} ${String(1 + ((id - 1) % 3) * 6).padStart(2, "0")}:00:00+00`;

export function ledgerRepo(root: string): void {
  const runs: Cell[][] = [];
  const events: Cell[][] = [];
  const outputs: Cell[][] = [];
  let ev = 0;
  let published = 0;
  for (const [id, tool, asof, outcome] of RUNS) {
    const at = createdAt(id);
    runs.push([id, `run-${id}`, asof, tool, "live", 1, "build", null, at]);
    events.push([++ev, id, "started", "", at]);
    if (outcome !== "started") events.push([++ev, id, outcome, outcome === "failed" ? (id === 10 ? "rate limited" : "The operation timed out.") : "", at.replace(":00:00+00", ":05:00+00")]);
    if (tool !== "regime" || outcome !== "succeeded") continue;
    const rows = Object.keys(BASE)
      .filter((d) => d <= asof)
      .map((date) => {
        const composite = Math.round((BASE[date]! + 0.001 * published) * 1e6) / 1e6;
        return { date, composite, regime: label(composite) };
      });
    published += 1;
    const payload = JSON.stringify(rows);
    outputs.push([outputs.length + 1, id, REGIME_ARTIFACT_KIND.main, payload, sha256(payload), at]);
  }
  // The table now: every day revised to its base plus 0.010, except the newest, which is its own last run's.
  const regime = Object.keys(BASE).map((date) => {
    const c = date === "2026-09-26" ? Math.round((BASE[date]! + 0.006) * 1e6) / 1e6 : Math.round((BASE[date]! + 0.01) * 1e6) / 1e6;
    return [date, c, label(c)] as Cell[];
  });
  // The revision log: raw indicator restatements (DEFI_TVL mostly noise), regime rewrites (one label change).
  const ovw: Cell[][] = [];
  const add = (table: string, prev: unknown, next: unknown, at: string) => ovw.push([ovw.length + 1, table, "update", "{}", JSON.stringify(prev), JSON.stringify(next), at]);
  const defi = [100, 100.0001, 100.0002, 100.0003, 100.0004, 103];
  for (let i = 1; i < defi.length; i++) add("raw_indicator_history", { indicator: "DEFI_TVL", date: `2026-09-${10 + (i % 3)}`, value: defi[i - 1] }, { value: defi[i] }, `2026-09-2${i % 3} 03:00:00+00`);
  add("raw_indicator_history", { indicator: "VIX", date: "2026-09-15", value: 20 }, { value: 21 }, "2026-09-21 03:00:00+00");
  add("raw_indicator_history", { indicator: "VIX", date: "2026-09-16", value: 18 }, { value: 18.9 }, "2026-09-22 03:00:00+00");
  add("regime_snapshots", { regime: "neutral" }, { regime: "neutral" }, "2026-09-21 04:00:00+00");
  add("regime_snapshots", { regime: "neutral" }, { regime: "risk_on" }, "2026-09-22 04:00:00+00");
  add("regime_snapshots", { regime: "risk_on" }, { regime: "risk_on" }, "2026-09-23 04:00:00+00");
  add("research_signals", { v: 1 }, { v: 2 }, "2026-09-23 05:00:00+00");

  writeBackupRepo(
    root,
    LEDGER_BACKUP,
    {
      analytics_output_snapshots: { header: ["id", "run_id", "artifact_kind", "payload_json", "payload_sha256", "created_at"], rows: outputs },
      analytics_ledger_runs: { header: ["id", "run_key", "asof", "tool_id", "source_label", "methodology_version_id", "build_identity", "job_id", "created_at"], rows: runs },
      analytics_ledger_run_events: { header: ["id", "run_id", "event_type", "detail", "knowledge_time"], rows: events },
      analytics_overwrite_events: { header: ["id", "table_name", "operation", "natural_key", "previous_row", "replacement_row", "recorded_at"], rows: ovw },
    },
    { regime_snapshots: { key: ["date"], header: ["date", "composite", "regime"], rows: regime } },
  );
}

// ── two replayable regime runs ─────────────────────────────────────────────────────────────────────

export const REPLAY_BACKUP = "2026-08-16T000000Z";
export const REPLAY_RUNS = { oldest: { id: 1, asof: "2026-06-30" }, newest: { id: 2, asof: "2026-08-15" }, failed: { id: 3, asof: "2026-08-15" } };
/** Published days per payload: the last days of the run's axis, through its as-of day. */
export const PUBLISHED_DAYS = 45;
const EXTRA: Record<string, string> = { SPX: "backtest:^GSPC", ETH: "backtest:ETH-USD", TBILL3M: "backtest:DTB3" };

export async function replayRepo(root: string, sdkDir: string): Promise<{ members: Record<number, number> }> {
  const sdk = (await import(join(sdkDir, "src/index.ts"))) as {
    runRegime: (raw: unknown, o: unknown) => any;
    inputHistoryFromStorage: (rows: { sourceKey: string; marketDate: string | null; value: number }[]) => Record<string, { date: string; value: number }[]>;
  };
  const { publishedRows } = (await import(join(sdkDir, "src/replay/index.ts"))) as { publishedRows: (run: unknown, o?: { source?: string | null }) => { date: string }[] };
  const lines = readFileSync(join(sdkDir, "tests/fixtures/raw-indicator-history.csv"), "utf8").split("\n").slice(1).filter(Boolean);
  // As on production, the vintage still carries the retired DEFI_GROWTH and STABLES_GROWTH keys (D74 amendment: the
  // growth indicators read DEFI_TVL and STABLES, and their own stored history reaches no consumer). Their stale
  // values differ from the level series here, so a replay that fed them to the growth indicators would not match.
  const RETIRED = new Set(["DEFI_GROWTH", "STABLES_GROWTH"]);
  const obs = lines
    .map((l) => l.split(","))
    .map(([date, id, value], i) => ({ id: id!, key: EXTRA[id!] ?? `raw_indicator_history:${id}`, date: date!, value: RETIRED.has(id!) ? String(Number(value) * (1 + (i % 7) * 1e-3)) : value! }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const svv: Cell[][] = obs.map((o, i) => [i + 1, o.key, o.date, o.value, "2026-08-15 23:00:00+00"]);

  const vintages: Cell[][] = [];
  const memberRows: Cell[][] = [];
  const outputs: Cell[][] = [];
  const members: Record<number, number> = {};
  for (const run of [REPLAY_RUNS.oldest, REPLAY_RUNS.newest]) {
    const inVintage = obs.map((o, i) => ({ ...o, vid: i + 1 })).filter((o) => o.date <= run.asof);
    // Member ranges: runs of consecutive ids under one key.
    for (let i = 0; i < inVintage.length; ) {
      let j = i;
      while (j + 1 < inVintage.length && inVintage[j + 1]!.vid === inVintage[j]!.vid + 1 && inVintage[j + 1]!.key === inVintage[i]!.key) j++;
      memberRows.push([memberRows.length + 1, 100 + run.id, inVintage[i]!.vid, inVintage[i]!.key, j > i ? inVintage[j]!.vid : null]);
      i = j + 1;
    }
    members[run.id] = inVintage.length;
    vintages.push([100 + run.id, run.id, "regime", "2026-08-15 23:00:00+00", run.asof, inVintage.length, "digest", "2026-08-16 00:00:00+00"]);
    // The payload the SDK computes from exactly this vintage, as the pipeline publishes it: the run reads its ledger
    // heads through the SDK's storage mapping (backend/src/analytics/index.ts, loadCommittedInputs), and its rows are
    // the SDK's publishedRows (the one row builder the producer freezes). The payload keeps the last days only.
    const raw = sdk.inputHistoryFromStorage(inVintage.map((o) => ({ sourceKey: o.key, marketDate: o.date, value: Number(o.value) })));
    const rows = publishedRows(sdk.runRegime(raw, { asof: run.asof, factor: true }), { source: "live" }).slice(-PUBLISHED_DAYS);
    if (rows.length !== PUBLISHED_DAYS || rows.at(-1)!.date !== run.asof) throw new Error(`the SDK published ${rows.length} rows through ${rows.at(-1)?.date} for run ${run.id}, not ${PUBLISHED_DAYS} through ${run.asof}`);
    const payload = JSON.stringify(rows);
    outputs.push([outputs.length + 1, run.id, REGIME_ARTIFACT_KIND.main, payload, sha256(payload), "2026-08-16 00:00:00+00"]);
  }
  const runs: Cell[][] = [
    [REPLAY_RUNS.oldest.id, "replay-1", REPLAY_RUNS.oldest.asof, "regime", "live", 1, "build", null, "2026-07-01 00:00:00+00"],
    [REPLAY_RUNS.newest.id, "replay-2", REPLAY_RUNS.newest.asof, "regime", "live", 1, "build", null, "2026-08-16 00:00:00+00"],
    [REPLAY_RUNS.failed.id, "replay-3", REPLAY_RUNS.failed.asof, "regime", "live", 1, "build", null, "2026-08-16 01:00:00+00"],
  ];
  const events: Cell[][] = [
    [1, 1, "started", "", "2026-07-01 00:00:00+00"],
    [2, 1, "succeeded", "", "2026-07-01 00:05:00+00"],
    [3, 2, "started", "", "2026-08-16 00:00:00+00"],
    [4, 2, "succeeded", "", "2026-08-16 00:05:00+00"],
    [5, 3, "started", "", "2026-08-16 01:00:00+00"],
    [6, 3, "failed", "boom", "2026-08-16 01:05:00+00"],
  ];
  writeBackupRepo(
    root,
    REPLAY_BACKUP,
    {
      analytics_output_snapshots: { header: ["id", "run_id", "artifact_kind", "payload_json", "payload_sha256", "created_at"], rows: outputs },
      source_value_versions: { header: ["id", "source_key", "market_date", "value", "knowledge_time"], rows: svv },
      analytics_ledger_runs: { header: ["id", "run_key", "asof", "tool_id", "source_label", "methodology_version_id", "build_identity", "job_id", "created_at"], rows: runs },
      analytics_ledger_run_events: { header: ["id", "run_id", "event_type", "detail", "knowledge_time"], rows: events },
      analytics_data_vintages: { header: ["id", "run_id", "tool_id", "knowledge_time_cutoff", "market_time_cutoff", "member_count", "manifest_digest", "created_at"], rows: vintages },
      analytics_vintage_members: { header: ["id", "vintage_id", "source_value_version_id", "source_key", "last_source_value_version_id"], rows: memberRows },
    },
    {},
  );
  return { members };
}
