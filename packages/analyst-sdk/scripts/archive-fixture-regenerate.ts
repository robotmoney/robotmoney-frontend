// `bun run archive-fixture:regenerate [--check]` builds the two recorded format 1
// local copies under tests/fixtures/archive/ from the committed SDK fixture
// (tests/fixtures/raw-indicator-history.csv). Dev-only script: it writes local
// files and lives outside src/, so the SDK stays pure. Synthetic, not production
// data: the csv-backups repo is private, and these copies must run with no
// private repository access.
//
// Both copies describe the same state, backup 2026-08-16T000000Z:
//   api-only/              one backup with source "api": what the API-only fill
//                          (`csvb backup --source api` into an empty directory)
//                          writes for an outside analyst.
//   repo-plus-increment/   backup 2026-08-02T000000Z with source "db" (the repo
//                          clone) plus 2026-08-16T000000Z with source "api" (the
//                          increment fetched from the newest watermark).
//
// Content: the fixture rows dated FROM onward as source_value_versions, under
// their storage keys (raw_indicator_history:<id>, backtest:^GSPC/ETH-USD/DTB3),
// two regime runs with frozen vintages, and the run 1 published payload.
//   - Run 1 (as of RUN1_ASOF) freezes the versions known at its cutoff.
//   - After run 1, VIX on REVISED_DATE is revised (a new version id). Run 2's
//     vintage holds the revision; run 1's still names the original, so its
//     input must come from membership, never from the newest value.
//   - Run 2's vintage also names one model-portfolio version (another
//     consumer's key), which is counted and left out of the regime input.
//   - The ratio rows (COPPER_GOLD and the other Yahoo ratios) are stored
//     calculated values with no legs: they replay as kind "calculated".
// `--check` rebuilds in memory and exits 1 if any committed file would change.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const SDK = join(HERE, "..");
const OUT = join(SDK, "tests/fixtures/archive");
const FROM = "2026-05-01";
const RUN1_ASOF = "2026-08-01";
const RUN2_ASOF = "2026-08-15";
const REVISED_DATE = "2026-07-31";
const B1 = "2026-08-02T000000Z";
const B2 = "2026-08-16T000000Z";
const RUN1_KEY = "0f6b6c1e-6a52-4c39-9f4e-1a2b3c4d5e01";
const RUN2_KEY = "0f6b6c1e-6a52-4c39-9f4e-1a2b3c4d5e02";
const BUILD = "4b4414c0e5a1d2f3b4c5d6e7f8091a2b3c4d5e6f";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const EXTRA_KEYS: Record<string, string> = { SPX: "backtest:^GSPC", ETH: "backtest:ETH-USD", TBILL3M: "backtest:DTB3" };

// Postgres COPY CSV: quote a field holding a comma, quote, CR or LF, or the
// empty string; NULL is an empty unquoted field.
const field = (v: string | null) => (v === null ? "" : v === "" || /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const copyCsv = (header: string[], rows: (string | null)[][]) => [header, ...rows].map((r) => r.map(field).join(",")).join("\n") + "\n";

type Svv = { id: number; key: string; date: string; value: string; kt: string; prior: number | null; kind: string };

const lines = readFileSync(join(SDK, "tests/fixtures/raw-indicator-history.csv"), "utf8").split("\n").slice(1).filter(Boolean);
const obs = lines
  .map((l) => l.split(","))
  .filter(([date]) => date! >= FROM)
  .map(([date, id, value]) => ({ date: date!, key: EXTRA_KEYS[id!] ?? `raw_indicator_history:${id}`, value: value! }));
obs.sort((a, b) => cmp(a.key, b.key) || cmp(a.date, b.date));

// Versions known at run 1's cutoff: rows dated on or before its as-of day.
// Everything later was collected after it.
const svv: Svv[] = [];
let nextId = 1;
const early = obs.filter((o) => o.date <= RUN1_ASOF);
const late = obs.filter((o) => o.date > RUN1_ASOF);
for (const o of early) svv.push({ id: nextId++, key: o.key, date: o.date, value: o.value, kt: "2026-08-01 23:00:00+00", prior: null, kind: "initial" });
const run1Ids = svv.map((v) => v.id);
const revisedFrom = svv.find((v) => v.key === "raw_indicator_history:VIX" && v.date === REVISED_DATE)!;
const b1MaxId = nextId - 1;
const revision: Svv = { id: nextId++, key: revisedFrom.key, date: REVISED_DATE, value: String(Number(revisedFrom.value) + 0.25), kt: "2026-08-10 12:00:00+00", prior: revisedFrom.id, kind: "revision" };
svv.push(revision);
for (const o of late) svv.push({ id: nextId++, key: o.key, date: o.date, value: o.value, kt: "2026-08-15 23:00:00+00", prior: null, kind: "initial" });
const foreign: Svv = { id: nextId++, key: "model_portfolio:yahoo:GLD", date: RUN2_ASOF, value: "301.5", kt: "2026-08-15 23:00:00+00", prior: null, kind: "initial" };
svv.push(foreign);
const run2Ids = svv.filter((v) => v.id !== revisedFrom.id).map((v) => v.id);

// Member ranges: consecutive ids under one storage key.
function ranges(ids: number[], vintageId: number, firstMemberId: number): (string | null)[][] {
  const byId = new Map(svv.map((v) => [v.id, v]));
  const out: (string | null)[][] = [];
  let k = 0;
  const sorted = [...ids].sort((a, b) => a - b);
  while (k < sorted.length) {
    let j = k;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1 && byId.get(sorted[j + 1]!)!.key === byId.get(sorted[k]!)!.key) j++;
    out.push([String(firstMemberId + out.length), String(vintageId), String(sorted[k]), byId.get(sorted[k]!)!.key, j > k ? String(sorted[j]) : null]);
    k = j + 1;
  }
  return out;
}

const SVV_H = ["id", "acquisition_id", "source_key", "market_date", "market_instant", "value", "prior_version_id", "revision_kind", "knowledge_time", "provenance"];
const svvRow = (v: Svv) => [String(v.id), `00000000-0000-4000-8000-${String(v.id).padStart(12, "0")}`, v.key, v.date, null, v.value, v.prior === null ? null : String(v.prior), v.kind, v.kt, "live"];
const METH_H = ["id", "tool_id", "version_label", "config", "config_digest", "created_at"];
const methConfig = '{"panels": ["macro", "onchain"]}';
const methRow = ["3", "regime", "regime-v3", methConfig, sha(methConfig), "2026-09-01 00:00:00+00"];
const RUN_H = ["id", "run_key", "asof", "tool_id", "source_label", "methodology_version_id", "build_identity", "job_id", "created_at"];
const run1 = ["101", RUN1_KEY, RUN1_ASOF, "regime", "live", "3", BUILD, null, "2026-08-01 23:30:00+00"];
const run2 = ["102", RUN2_KEY, RUN2_ASOF, "regime", "live", "3", BUILD, null, "2026-08-15 23:30:00+00"];
const VIN_H = ["id", "run_id", "tool_id", "knowledge_time_cutoff", "market_time_cutoff", "methodology_version_id", "build_identity", "manifest", "manifest_digest", "member_count", "created_at"];
const vinRow = (id: string, run: string, kt: string, asof: string, n: number) => {
  const manifest = `{"run_id": ${run}, "members": ${n}}`;
  return [id, run, "regime", kt, asof, "3", BUILD, manifest, sha(manifest), String(n), kt];
};
const vin1 = vinRow("201", "101", "2026-08-01 23:30:00+00", RUN1_ASOF, run1Ids.length);
const vin2 = vinRow("202", "102", "2026-08-15 23:30:00+00", RUN2_ASOF, run2Ids.length);
const MEM_H = ["id", "vintage_id", "source_value_version_id", "source_key", "last_source_value_version_id"];
const mem1 = ranges(run1Ids, 201, 1);
const mem2 = ranges(run2Ids, 202, 1 + mem1.length);
const OUT_H = ["id", "run_id", "artifact_kind", "payload_json", "payload_sha256", "byte_length", "created_at"];
const payload = JSON.stringify([{ date: RUN1_ASOF, regime: "fixture", note: "synthetic published payload, immutable bytes" }]);
const out1 = ["1", "101", "regime_snapshots", payload, sha(payload), String(Buffer.byteLength(payload)), "2026-08-01 23:31:00+00"];

type Table = { name: string; header: string[]; rows: (string | null)[][]; tmin: string; tmax: string; idCol?: number };
type Backup = { id: string; source: "api" | "db"; tables: Table[] };
const stamp = (t: string) => t.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2}).*$/, "$1T$2$3$4Z");

function table(name: string, header: string[], rows: (string | null)[][], timeCol: number, idCol = 0): Table {
  const times = rows.map((r) => r[timeCol]!).sort();
  return { name, header, rows, tmin: times[0]!, tmax: times[times.length - 1]!, idCol };
}

const svvIn = (lo: number, hi: number) => svv.filter((v) => v.id >= lo && v.id <= hi).map(svvRow);
const memTime = (rows: (string | null)[][], kt: string) => rows.map((r) => [...r, kt]);
function tablesFor(part: "all" | "b1" | "b2"): Table[] {
  const t: Table[] = [];
  const lo = part === "b2" ? b1MaxId + 1 : 1;
  const hi = part === "b1" ? b1MaxId : nextId - 1;
  t.push(table("source_value_versions", SVV_H, svvIn(lo, hi), 8));
  if (part !== "b2") t.push(table("analytics_ledger_methodology_versions", METH_H, [methRow], 5));
  const runs = part === "b1" ? [run1] : part === "b2" ? [run2] : [run1, run2];
  t.push(table("analytics_ledger_runs", RUN_H, runs, 8));
  const vins = part === "b1" ? [vin1] : part === "b2" ? [vin2] : [vin1, vin2];
  t.push(table("analytics_data_vintages", VIN_H, vins, 10));
  // analytics_vintage_members carries no time; the file is named by its vintages' time.
  const mems = part === "b1" ? memTime(mem1, vin1[10]!) : part === "b2" ? memTime(mem2, vin2[10]!) : [...memTime(mem1, vin1[10]!), ...memTime(mem2, vin2[10]!)];
  const memTable = table("analytics_vintage_members", MEM_H, mems, 5);
  memTable.rows = memTable.rows.map((r) => r.slice(0, 5));
  t.push(memTable);
  if (part !== "b2") t.push(table("analytics_output_snapshots", OUT_H, [out1], 6));
  return t;
}

// gzip bytes differ between zlib builds, so the committed .gz is kept whenever
// it decompresses to exactly the rows this script would write. A file's identity
// is the hash of its uncompressed bytes (sha256_raw), never of its gzip.
function stableGzip(path: string, raw: string): Buffer {
  if (existsSync(path)) {
    const committed = readFileSync(path);
    try {
      if (gunzipSync(committed).equals(Buffer.from(raw, "utf8"))) return committed;
    } catch {
      // not a readable gzip: rewrite it
    }
  }
  return gzipSync(Buffer.from(raw, "utf8"), { level: 9 });
}

const files = new Map<string, Buffer | string>();
function writeCopy(dir: string, backups: Backup[]) {
  const watermark = new Map<string, string | null>();
  for (const b of backups) {
    const append_only: Record<string, unknown> = {};
    for (const t of b.tables) {
      const name = `${t.name}.${stamp(t.tmin)}_${stamp(t.tmax)}.csv.gz`;
      const path = `csv/${b.id}/data/${name}`;
      const raw = copyCsv(t.header, t.rows);
      const gz = stableGzip(join(dir, path), raw);
      files.set(join(dir, path), gz);
      const ids = t.rows.map((r) => BigInt(r[t.idCol ?? 0]!));
      const max = ids.reduce((m, x) => (x > m ? x : m), 0n);
      const before = watermark.get(t.name) ?? null;
      watermark.set(t.name, String(max));
      append_only[t.name] = {
        watermark_before: before,
        watermark_after: String(max),
        rows_added: t.rows.length,
        files: [{ path, rows: t.rows.length, bytes_raw: Buffer.byteLength(raw), sha256_raw: sha(raw) }],
      };
    }
    const record = { format: 1, backup: b.id, source: b.source, tool: { name: "archive-fixture-regenerate", commit: null }, append_only, revisions: {} };
    files.set(join(dir, `csv/${b.id}/backup.json`), JSON.stringify(record, null, 2) + "\n");
  }
}
writeCopy(join(OUT, "api-only"), [{ id: B2, source: "api", tables: tablesFor("all") }]);
writeCopy(join(OUT, "repo-plus-increment"), [
  { id: B1, source: "db", tables: tablesFor("b1") },
  { id: B2, source: "api", tables: tablesFor("b2") },
]);

// ── revised/: the revised-tables copy (issue 1513) ───────────────────────────
// Three backups, each with its source_value_versions increment and revision
// files for the three revised tables csv-backups writes (a revision row carries
// _backup and _op, then the table's columns; a delete names only its key).
//   R1  first state of every table.
//   R2  an upsert replacing an R1 row in each table, a delete of an R1 row in
//       raw_indicator_history and asset_prices, new rows; a revised
//       backtest:^GSPC version for an R1 date (a higher id).
//   R3  a delete in regime_snapshots, a NULL field, new rows; asset_prices has
//       no changes (its record keeps the key with no file).
// The expected CSVs under revised/expected/ are rosemarys-baby resolveRevised and
// extractBacktestPrices output on this copy, captured once and committed; this
// script never writes them.
const R1 = "2026-09-01T000000Z";
const R2 = "2026-09-08T000000Z";
const R3 = "2026-09-15T000000Z";
type Rev = { table: string; key: string[]; header: string[]; changes: Record<string, (string | null)[][]> };
const del = (header: string[], key: string[], vals: Record<string, string>) => header.map((h) => (key.includes(h) ? vals[h]! : null));
const RIH_H = ["date", "indicator", "value", "source"];
const RIH_K = ["indicator", "date"];
const SNAP_H = ["date", "composite", "regime", "percentiles", "version", "source"];
const SNAP_K = ["date"];
const AP_H = ["price_date", "symbol", "time_basis", "price_usd", "currency", "source"];
const AP_K = ["price_date", "symbol", "time_basis"];
const REVISED_TABLES: Rev[] = [
  {
    table: "regime_snapshots",
    key: SNAP_K,
    header: SNAP_H,
    changes: {
      [R1]: [
        ["2026-08-31", "0.41", "neutral", '{"VIX": 0.5, "DXY": 0.25}', "v3", "live"],
        ["2026-08-28", "0.38", "risk_off", '{"VIX": 0.75, "DXY": 0.5}', "v3", "live"],
      ],
      [R2]: [
        ["2026-08-31", "0.52", "risk_on", '{"VIX": 0.25, "DXY": 0.25}', "v3", "live"],
        ["2026-09-04", "0.55", "risk_on", '{"VIX": 0.2, "DXY": 0.3}', "v3", "live"],
      ],
      [R3]: [del(SNAP_H, SNAP_K, { date: "2026-08-28" }), ["2026-09-11", null, "neutral", "{}", "v3", "live"]],
    },
  },
  {
    table: "raw_indicator_history",
    key: RIH_K,
    header: RIH_H,
    changes: {
      [R1]: [
        ["2026-08-31", "VIX", "15.2", "live"],
        ["2026-08-28", "VIX", "15", "live"],
        ["2026-08-31", "DXY", "101.3", "live"],
        ["2026-08-28", "DXY", "101.1", "live"],
      ],
      [R2]: [
        ["2026-08-31", "VIX", "15.45", "live"],
        del(RIH_H, RIH_K, { indicator: "DXY", date: "2026-08-28" }),
        ["2026-09-04", "VIX", "16", "live"],
      ],
      [R3]: [["2026-09-11", "DXY", "100.9", "live"]],
    },
  },
  {
    table: "asset_prices",
    key: AP_K,
    header: AP_H,
    changes: {
      [R1]: [
        ["2026-08-31", "ETH", "utc-daily-close", "2510.75", "USD", "geckoterminal"],
        ["2026-08-31", "BNKR", "utc-daily-close", "0.000307653898611427", "USD", "geckoterminal"],
      ],
      [R2]: [
        ["2026-08-31", "ETH", "utc-daily-close", "2511", "USD", "geckoterminal"],
        del(AP_H, AP_K, { price_date: "2026-08-31", symbol: "BNKR", time_basis: "utc-daily-close" }),
        ["2026-09-04", "BNKR", "utc-daily-close", "0.00031", "USD", "geckoterminal"],
      ],
      [R3]: [],
    },
  },
];
// source_value_versions per backup: [id, key, date, value, prior].
const REVISED_SVV: Record<string, [number, string, string, string, number | null][]> = {
  [R1]: [
    [1, "backtest:^GSPC", "2026-08-28", "5600.25", null],
    [2, "backtest:^GSPC", "2026-08-31", "5610.5", null],
    [3, "backtest:ETH-USD", "2026-08-30", "2500.1", null],
    [4, "backtest:ETH-USD", "2026-08-31", "2510.75", null],
    [5, "backtest:DTB3", "2026-08-28", "4.12", null],
    [6, "backtest:DTB3", "2026-08-31", "4.1", null],
    [7, "raw_indicator_history:VIX", "2026-08-31", "15.2", null],
  ],
  [R2]: [
    [8, "backtest:^GSPC", "2026-08-31", "5611", 2],
    [9, "backtest:^GSPC", "2026-09-04", "5650", null],
    [10, "backtest:ETH-USD", "2026-09-04", "2600.5", null],
    [11, "backtest:DTB3", "2026-09-04", "4.08", null],
  ],
  [R3]: [
    [12, "backtest:ETH-USD", "2026-09-11", "2650", null],
    [13, "backtest:^GSPC", "2026-09-11", "5700.25", null],
  ],
};
const REVISED_KT: Record<string, string> = { [R1]: "2026-08-31 23:00:00+00", [R2]: "2026-09-07 23:00:00+00", [R3]: "2026-09-14 23:00:00+00" };
function writeRevisedCopy(dir: string) {
  let watermark: string | null = null;
  const inState = new Map<string, Set<string>>();
  for (const b of [R1, R2, R3]) {
    const rows = REVISED_SVV[b]!.map(([id, key, date, value, prior]) =>
      svvRow({ id, key, date, value, kt: REVISED_KT[b]!, prior, kind: prior === null ? "initial" : "revision" }),
    );
    const svvTable = table("source_value_versions", SVV_H, rows, 8);
    const name = `source_value_versions.${stamp(svvTable.tmin)}_${stamp(svvTable.tmax)}.csv.gz`;
    const path = `csv/${b}/data/${name}`;
    const raw = copyCsv(SVV_H, rows);
    files.set(join(dir, path), stableGzip(join(dir, path), raw));
    const after = String(REVISED_SVV[b]!.reduce((m, r) => Math.max(m, r[0]), 0));
    const append_only = {
      source_value_versions: {
        watermark_before: watermark,
        watermark_after: after,
        rows_added: rows.length,
        files: [{ path, rows: rows.length, bytes_raw: Buffer.byteLength(raw), sha256_raw: sha(raw) }],
      },
    };
    watermark = after;
    const revisions: Record<string, unknown> = {};
    for (const t of REVISED_TABLES) {
      const changes = t.changes[b]!;
      const state = inState.get(t.table) ?? new Set<string>();
      inState.set(t.table, state);
      let deletes = 0;
      const out = changes.map((r) => {
        const k = JSON.stringify(t.key.map((c) => r[t.header.indexOf(c)]));
        const isDelete = r.some((v, i) => v === null && !t.key.includes(t.header[i]!)) && t.header.every((h, i) => t.key.includes(h) || r[i] === null);
        if (isDelete) {
          deletes++;
          state.delete(k);
        } else state.add(k);
        return [b, isDelete ? "delete" : "upsert", ...r];
      });
      let file: unknown = null;
      if (out.length > 0) {
        const rpath = `csv/${b}/revisions/${t.table}.csv.gz`;
        const rraw = copyCsv(["_backup", "_op", ...t.header], out);
        files.set(join(dir, rpath), stableGzip(join(dir, rpath), rraw));
        file = { path: rpath, rows: out.length, bytes_raw: Buffer.byteLength(rraw), sha256_raw: sha(rraw) };
      }
      revisions[t.table] = { key: t.key, file, upserts: out.length - deletes, deletes, rows_in_state: state.size };
    }
    const record = { format: 1, backup: b, source: b === R1 ? "db" : "api", tool: { name: "archive-fixture-regenerate", commit: null }, append_only, revisions };
    files.set(join(dir, `csv/${b}/backup.json`), JSON.stringify(record, null, 2) + "\n");
  }
}
writeRevisedCopy(join(OUT, "revised"));

const facts = {
  backup: B2,
  runs: { [RUN1_KEY]: { asof: RUN1_ASOF, members: run1Ids.length }, [RUN2_KEY]: { asof: RUN2_ASOF, members: run2Ids.length } },
  revised: { series: "VIX", date: REVISED_DATE, run1Value: revisedFrom.value, run2Value: revision.value },
  foreignKey: foreign.key,
  build: BUILD,
};
files.set(join(OUT, "facts.json"), JSON.stringify(facts, null, 2) + "\n");

if (process.argv.includes("--check")) {
  let stale = 0;
  for (const [p, b] of files) {
    if (!existsSync(p) || !readFileSync(p).equals(Buffer.from(b as Buffer))) {
      console.error(`stale: ${p}`);
      stale++;
    }
  }
  process.exit(stale ? 1 : 0);
}
// Only the copies this script owns: api-recorded/ is a recording of the real
// routes (backend/tests/analyst-sdk-public-archive-recording.test.ts) and
// revised/expected/ is captured from rosemarys-baby, so neither is touched.
for (const d of ["api-only", "repo-plus-increment", "revised/csv"]) rmSync(join(OUT, d), { recursive: true, force: true });
for (const [p, b] of files) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, b);
}
console.log(`wrote ${files.size} files under ${OUT}`);
