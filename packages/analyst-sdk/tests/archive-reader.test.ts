// The archive reader exported from the package (issues 1513, 1544): openArchive over an
// injected ArchiveFiles reader, the revised-table replay and the latest values.
// Every copy under tests/fixtures/archive/ is opened twice, through an in-memory
// ArchiveFiles and through the bin/ node:fs adapter, and must read the same.
// The revised copy (scripts/archive-fixture-regenerate.ts) is replayed against
// committed expected CSVs: rosemarys-baby resolveRevised and extractBacktestPrices
// output on the same copy, captured once (tests/fixtures/archive/revised/expected/).
// The model-runs copy (issue 1765) is a v4 run and three chained v5 runs that
// the backend recorded through its public archive routes
// (backend/tests/analyst-sdk-model-runs-recording.test.ts).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { openBackupsDir, collectRunInputs as binCollectRunInputs } from "../bin/backups-dir.ts";
import * as binExports from "../bin/backups-dir.ts";
import * as sdkIndex from "../src/index.ts";
import { runVintageMembers } from "../src/archive/reader.ts";
import { sha256 } from "../src/hash.ts";
import { sha256 as nodeSha256 } from "../node/hash.ts";
import * as nodeEdge from "../node/index.ts";
import { RunInputCollector, seriesForStorageKey, type RunInputs } from "../src/archive/format1.ts";
import { SERIES_MAPPING, V5_ONLY_STORAGE_KEYS, V5_SERIES_MAPPING } from "../src/series-ids.ts";
import { ArchiveError, INPUT_TABLES, collectRunInputs, openArchive, selectBackups, type ArchiveFiles, type Archive, type ArchiveRow as Row } from "../src/index.ts";

const ARCHIVE = join(import.meta.dir, "fixtures/archive");
const REVISED = join(ARCHIVE, "revised");
const EXPECTED = join(REVISED, "expected");
const COPIES = ["api-only", "api-recorded", "repo-plus-increment", "revised"] as const;
const R1 = "2026-09-01T000000Z";
const R2 = "2026-09-08T000000Z";
const R3 = "2026-09-15T000000Z";
const TABLES = ["regime_snapshots", "raw_indicator_history", "asset_prices"] as const;
const BACKTEST_KEYS = ["backtest:^GSPC", "backtest:ETH-USD", "backtest:DTB3"];
const FACTS = JSON.parse(readFileSync(join(ARCHIVE, "facts.json"), "utf8"));

const sha = (b: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

// Every file under a directory, by its path relative to it ("/" separators).
function loadTree(root: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const walk = (rel: string) => {
    for (const n of readdirSync(join(root, rel)).sort()) {
      const r = rel === "" ? n : `${rel}/${n}`;
      if (statSync(join(root, r)).isDirectory()) walk(r);
      else out.set(r, new Uint8Array(readFileSync(join(root, r))));
    }
  };
  walk("");
  return out;
}

// An in-memory ArchiveFiles: no filesystem behind it.
function memoryFiles(tree: Map<string, Uint8Array>, root = "memory"): ArchiveFiles {
  return {
    root,
    backupDirs: () => {
      const dirs = new Set<string>();
      for (const p of tree.keys()) {
        const m = /^csv\/([^/]+)\//.exec(p);
        if (m) dirs.add(m[1]!);
      }
      return dirs.size === 0 ? null : [...dirs];
    },
    read: (path) => tree.get(path) ?? null,
  };
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const editRecord = (tree: Map<string, Uint8Array>, backup: string, edit: (rec: any) => void) => {
  const path = `csv/${backup}/backup.json`;
  const rec = JSON.parse(dec(tree.get(path)!));
  edit(rec);
  tree.set(path, enc(JSON.stringify(rec)));
};

// The rosemarys-baby CSV writer (src/lib/csv.ts formatCsv): LF ends, a field quoted
// only when it holds a comma, quote or line break; NULL is written empty.
function formatCsv(rows: readonly (readonly (string | null)[])[]): string {
  const field = (f: string | null) => (f === null ? "" : /[",\r\n]/.test(f) ? `"${f.replaceAll('"', '""')}"` : f);
  return rows.map((r) => (r.length === 1 && (r[0] ?? "") === "" ? '""' : r.map(field).join(",")) + "\n").join("");
}
const tableCsv = (t: { header: string[]; rows: Row[] }) => formatCsv([t.header, ...t.rows.map((r) => t.header.map((h) => r[h] ?? null))]);
const expected = (name: string, asOf?: string) => readFileSync(join(EXPECTED, `${name}${asOf ? `.asof-${asOf}` : ""}.csv`), "utf8");
const openRevised = (asOf?: string) => openArchive(memoryFiles(loadTree(REVISED)), asOf);

describe("the reader is exported from the package", () => {
  test("openArchive, collectRunInputs, ArchiveFiles and Archive come from src/index.ts and open the revised copy in memory", () => {
    expect(typeof openArchive).toBe("function");
    expect(typeof collectRunInputs).toBe("function");
    const copy: Archive = openRevised();
    expect(copy.records.map((r) => r.backup)).toEqual([R1, R2, R3]);
    expect(copy.asOf.backup).toBe(R3);
    expect(copy.root).toBe("memory");
    // The bin adapter hands out the same collectRunInputs, so existing callers keep working.
    expect(binCollectRunInputs).toBe(collectRunInputs);
  });

  test("a copy with no csv/ directory is refused", () => {
    expect(() => openArchive(memoryFiles(new Map(), "empty"))).toThrow(/empty is not a format 1 local copy \(no csv\/ directory\)/);
  });
});

describe("openArchive in memory and openBackupsDir on disk read the same", () => {
  for (const name of COPIES) {
    test(`${name}: records, tables and versions() are deep-equal, as of each backup`, () => {
      const root = join(ARCHIVE, name);
      const tree = loadTree(root);
      const ids = [...new Set([...tree.keys()].map((p) => /^csv\/([^/]+)\//.exec(p)?.[1]).filter((x): x is string => !!x))].sort();
      expect(ids.length).toBeGreaterThan(0);
      for (const asOf of [undefined, ...ids]) {
        const mem = openArchive(memoryFiles(tree, root), asOf);
        const disk = openBackupsDir(root, asOf);
        expect(mem.records).toEqual(disk.records);
        expect(mem.asOf).toEqual(disk.asOf);
        for (const t of INPUT_TABLES) expect(mem.table(t)).toEqual(disk.table(t));
        expect(mem.versions()).toEqual(disk.versions());
        for (const t of TABLES) expect(mem.revisedTable(t)).toEqual(disk.revisedTable(t));
      }
    });
  }

  test("collectRunInputs reads the same run from both readers", () => {
    const run = Object.keys(FACTS.runs)[1]!;
    const root = join(ARCHIVE, "repo-plus-increment");
    expect(collectRunInputs(openArchive(memoryFiles(loadTree(root), root)), run)).toEqual(collectRunInputs(openBackupsDir(root), run));
  });
});

describe("revisedTable replays every selected backup's revisions", () => {
  test("each table equals its committed expected CSV (rosemarys-baby resolveRevised on the same copy)", () => {
    const copy = openRevised();
    for (const t of TABLES) expect(tableCsv(copy.revisedTable(t)), t).toBe(expected(t));
  });

  test("an upsert in a later backup replaces the earlier row, a later delete removes it, _backup and _op are absent", () => {
    const copy = openRevised();
    const rih = copy.revisedTable("raw_indicator_history");
    expect(rih.header).toEqual(["date", "indicator", "value", "source"]);
    for (const t of TABLES) {
      const { header, rows } = copy.revisedTable(t);
      expect(header).not.toContain("_backup");
      expect(header).not.toContain("_op");
      for (const r of rows) expect(Object.keys(r)).toEqual(header);
    }
    // R2 upserts VIX 2026-08-31 (15.2 -> 15.45) and deletes DXY 2026-08-28.
    expect(rih.rows.find((r) => r.indicator === "VIX" && r.date === "2026-08-31")!.value).toBe("15.45");
    expect(rih.rows.some((r) => r.indicator === "DXY" && r.date === "2026-08-28")).toBe(false);
    // asset_prices: ETH replaced, BNKR 2026-08-31 deleted, R3 has no asset_prices file.
    const ap = copy.revisedTable("asset_prices").rows;
    expect(ap.find((r) => r.symbol === "ETH")!.price_usd).toBe("2511");
    expect(ap.some((r) => r.symbol === "BNKR" && r.price_date === "2026-08-31")).toBe(false);
    // regime_snapshots: R3 deletes 2026-08-28; a NULL field stays NULL.
    const snaps = copy.revisedTable("regime_snapshots").rows;
    expect(snaps.map((r) => r.date)).toEqual(["2026-08-31", "2026-09-04", "2026-09-11"]);
    expect(snaps.find((r) => r.date === "2026-09-11")!.composite).toBeNull();
    // A table no backup revises is empty.
    expect(copy.revisedTable("analytics_read_mode")).toEqual({ header: [], rows: [] });
  });

  test("rows sort by key column by column (indicator, then date), not by insertion order", () => {
    const rows = openRevised().revisedTable("raw_indicator_history").rows;
    const keys = rows.map((r) => [r.indicator!, r.date!]);
    expect(keys).toEqual([
      ["DXY", "2026-08-31"],
      ["DXY", "2026-09-11"],
      ["VIX", "2026-08-28"],
      ["VIX", "2026-08-31"],
      ["VIX", "2026-09-04"],
    ]);
  });

  test("as of the first backup, the state before the second backup's revisions; with no as-of, the newest", () => {
    const first = openRevised(R1);
    const rih = first.revisedTable("raw_indicator_history").rows;
    expect(rih.find((r) => r.indicator === "VIX" && r.date === "2026-08-31")!.value).toBe("15.2");
    expect(rih.some((r) => r.indicator === "DXY" && r.date === "2026-08-28")).toBe(true);
    for (const asOf of [R1, R2]) {
      const copy = openRevised(asOf);
      for (const t of TABLES) expect(tableCsv(copy.revisedTable(t)), `${t} as of ${asOf}`).toBe(expected(t, asOf));
    }
    const newest = openRevised();
    for (const t of TABLES) expect(tableCsv(newest.revisedTable(t))).toBe(tableCsv(openRevised(R3).revisedTable(t)));
    expect(tableCsv(newest.revisedTable("raw_indicator_history"))).not.toBe(tableCsv(first.revisedTable("raw_indicator_history")));
  });
});

describe("a revision with no usable key is refused when the record is read", () => {
  const bad: [string, unknown][] = [
    ["no key", undefined],
    ["an empty key", []],
    ["a non-string key column", ["indicator", 7]],
    ["an empty key column", ["indicator", ""]],
    ["a key that is not an array", "indicator"],
  ];
  const message = (backup: string, table: string) => new RegExp(`csv/${backup}/backup\\.json: the ${table} revision`);

  test("selectBackups refuses it, naming csv/<id>/backup.json and the table", () => {
    const tree = loadTree(REVISED);
    for (const [what, key] of bad) {
      const texts: Record<string, string> = {};
      for (const id of [R1, R2, R3]) texts[id] = dec(tree.get(`csv/${id}/backup.json`)!);
      const rec = JSON.parse(texts[R2]!);
      if (key === undefined) delete rec.revisions.asset_prices.key;
      else rec.revisions.asset_prices.key = key;
      texts[R2] = JSON.stringify(rec);
      expect(() => selectBackups(texts), what).toThrow(ArchiveError);
      expect(() => selectBackups(texts), what).toThrow(message(R2, "asset_prices"));
      // A backup past the as-of cut is never read.
      expect(selectBackups(texts, R1).length).toBe(1);
    }
    // A revision with a key and no file is fine (R3 asset_prices).
    expect(selectBackups({ [R3]: JSON.stringify({ format: 1, backup: R3, append_only: {}, revisions: { t: { key: ["id"], file: null } } }) }).length).toBe(1);
  });

  test("openArchive refuses it, naming csv/<id>/backup.json and the table", () => {
    for (const [what, key] of bad) {
      const tree = loadTree(REVISED);
      editRecord(tree, R3, (rec) => {
        if (key === undefined) delete rec.revisions.regime_snapshots.key;
        else rec.revisions.regime_snapshots.key = key;
      });
      let err: unknown;
      try {
        openArchive(memoryFiles(tree));
      } catch (e) {
        err = e;
      }
      expect(err, what).toBeInstanceOf(ArchiveError);
      expect((err as Error).message, what).toMatch(message(R3, "regime_snapshots"));
    }
  });
});

describe("latestValues", () => {
  test("keeps the highest id per (source_key, market_date), tags SPX, ETH and TBILL3M, sorts by date then source key", () => {
    const vals = openRevised().latestValues(BACKTEST_KEYS);
    // R2 revises backtest:^GSPC on 2026-08-31 (id 2 -> id 8).
    const spx = vals.find((v) => v.sourceKey === "backtest:^GSPC" && v.date === "2026-08-31")!;
    expect(spx).toEqual({ series: "SPX", sourceKey: "backtest:^GSPC", date: "2026-08-31", id: "8", value: "5611" });
    const tags = new Map(vals.map((v) => [v.sourceKey, v.series]));
    expect(Object.fromEntries(tags)).toEqual({ "backtest:^GSPC": "SPX", "backtest:ETH-USD": "ETH", "backtest:DTB3": "TBILL3M" });
    // A key not asked for (raw_indicator_history:VIX) is left out.
    expect(vals.length).toBe(11);
    const order = vals.map((v) => `${v.date}|${v.sourceKey}`);
    expect(order).toEqual([...order].sort());
    // Equal to rosemarys-baby extractBacktestPrices on the same copy, as of each backup.
    for (const asOf of [undefined, R1, R2]) {
      const got = openRevised(asOf).latestValues(BACKTEST_KEYS);
      expect(formatCsv([["date", "series", "value"], ...got.map((v) => [v.date, v.series, v.value])])).toBe(expected("backtest_prices", asOf));
    }
    expect(openRevised(R1).latestValues(["backtest:^GSPC"]).find((v) => v.date === "2026-08-31")!.value).toBe("5610.5");
    expect(openRevised().latestValues([])).toEqual([]);
  });

  test("ids are compared as BigInt: two versions above 2^53 that differ in their last digit keep the larger", () => {
    const small = "9007199254740992";
    const large = "9007199254740993";
    // Equal as doubles: a Number comparison would keep the first one read.
    expect(Number(small)).toBe(Number(large));
    const id = "2026-01-01T000000Z";
    const raw = `id,source_key,market_date,value\n${small},backtest:^GSPC,2026-01-02,100\n${large},backtest:^GSPC,2026-01-02,101\n`;
    const path = `csv/${id}/data/source_value_versions.2026-01-01T000000Z_2026-01-01T000000Z.csv.gz`;
    const rec = {
      format: 1,
      backup: id,
      append_only: { source_value_versions: { watermark_before: null, watermark_after: large, files: [{ path, rows: 2, bytes_raw: enc(raw).length, sha256_raw: sha(raw) }] } },
      revisions: {},
    };
    const tree = new Map<string, Uint8Array>([
      [`csv/${id}/backup.json`, enc(JSON.stringify(rec))],
      [path, gzipSync(enc(raw))],
    ]);
    expect(openArchive(memoryFiles(tree)).latestValues(["backtest:^GSPC"])).toEqual([{ series: "SPX", sourceKey: "backtest:^GSPC", date: "2026-01-02", id: large, value: "101" }]);
  });

  test("a key no input id is read under is refused, naming the key", () => {
    const copy = openRevised();
    for (const key of ["model_portfolio:yahoo:GLD", "backtest:NOPE"]) {
      expect(() => copy.latestValues(["backtest:^GSPC", key])).toThrow(ArchiveError);
      expect(() => copy.latestValues(["backtest:^GSPC", key])).toThrow(key);
    }
  });
});

describe("revision files get the same checks as data files", () => {
  const revPath = `csv/${R2}/revisions/raw_indicator_history.csv.gz`;
  const dataPath = (tree: Map<string, Uint8Array>) => [...tree.keys()].find((p) => p.startsWith(`csv/${R2}/data/source_value_versions.`))!;
  const errorOf = (f: () => unknown): Error => {
    try {
      f();
    } catch (e) {
      expect(e).toBeInstanceOf(ArchiveError);
      return e as Error;
    }
    throw new Error("expected an ArchiveError");
  };

  test("a hash or row-count mismatch is the corrupt-local-copy ArchiveError, a missing file the incomplete one", () => {
    // Content that is not what the record hashed: refused when the file is first read, as a data file is.
    for (const [target, read] of [
      [revPath, (c: Archive) => c.revisedTable("raw_indicator_history")],
      [dataPath(loadTree(REVISED)), (c: Archive) => c.latestValues(BACKTEST_KEYS)],
    ] as const) {
      const tree = loadTree(REVISED);
      tree.set(target, gzipSync(enc(dec(gunzipSync(tree.get(target)!)).replace("live", "LIVE"))));
      const e = errorOf(() => read(openArchive(memoryFiles(tree))));
      expect(e.message).toMatch(new RegExp(`^corrupt local copy: ${target.replace(/[.^$]/g, "\\$&")} content sha256 \\w+ does not match the record's`));
    }
    // A row count that is not the record's: refused when the file is read, as a data file is.
    const counted = loadTree(REVISED);
    editRecord(counted, R2, (rec) => {
      rec.revisions.raw_indicator_history.file.rows += 1;
      rec.append_only.source_value_versions.files[0].rows += 1;
    });
    const copy = openArchive(memoryFiles(counted));
    expect(errorOf(() => copy.revisedTable("raw_indicator_history")).message).toMatch(new RegExp(`^corrupt local copy: csv/${R2}/revisions/raw_indicator_history\\.csv\\.gz has 3 rows, the record says 4$`));
    expect(errorOf(() => copy.latestValues(BACKTEST_KEYS)).message).toMatch(/^corrupt local copy: csv\/2026-09-08T000000Z\/data\/source_value_versions\.\S+ has 4 rows, the record says 5$/);
    // Missing.
    const missing = loadTree(REVISED);
    missing.delete(revPath);
    expect(errorOf(() => openArchive(memoryFiles(missing)).revisedTable("raw_indicator_history")).message).toBe(`incomplete local copy: ${revPath} is listed in its backup record but missing`);
    // Not a gzip.
    const garbled = loadTree(REVISED);
    garbled.set(revPath, enc("not a gzip"));
    expect(errorOf(() => openArchive(memoryFiles(garbled, "copy")).revisedTable("raw_indicator_history")).message).toMatch(new RegExp(`^corrupt local copy: copy/${revPath.replace(/[.^$]/g, "\\$&")} is not a readable gzip`));
  });
});

// ── Issue 1544: lazy verification, strict rows, strict UTF-8, no retired names ──

// An ArchiveFiles that records every path read.
function countingFiles(tree: Map<string, Uint8Array>): ArchiveFiles & { reads: string[] } {
  const base = memoryFiles(tree);
  const reads: string[] = [];
  return { ...base, reads, read: (p) => (reads.push(p), base.read(p)) };
}
const isBackupJson = (p: string) => /^csv\/[^/]+\/backup\.json$/.test(p);
const tableOfPath = (p: string) => p.split("/").pop()!.split(".")[0]!;

describe("the reader verifies lazily", () => {
  test("open reads only backup.json; each call reads only the files it needs; a second call reads nothing new", () => {
    const files = countingFiles(loadTree(REVISED));
    const archive = openArchive(files);
    expect(files.reads.length).toBeGreaterThan(0);
    expect(files.reads.every(isBackupJson)).toBe(true);
    const steps: [string, () => unknown, (p: string) => boolean][] = [
      ["revisedTable", () => archive.revisedTable("regime_snapshots"), (p) => p.includes("/revisions/regime_snapshots.")],
      ["latestValues", () => archive.latestValues(BACKTEST_KEYS), (p) => tableOfPath(p) === "source_value_versions"],
    ];
    for (const [name, call, ok] of steps) {
      const before = files.reads.length;
      const first = call();
      const fresh = files.reads.slice(before);
      expect(fresh.length, name).toBeGreaterThan(0);
      expect(fresh.every(ok), `${name} read ${fresh.join(", ")}`).toBe(true);
      const afterFirst = files.reads.length;
      expect(call(), name).toEqual(first);
      expect(files.reads.length, `${name} second call`).toBe(afterFirst);
    }
  });

  test("table(name) reads only that table's files, once", () => {
    const files = countingFiles(loadTree(join(ARCHIVE, "repo-plus-increment")));
    const archive = openArchive(files);
    const before = files.reads.length;
    const rows = archive.table("analytics_ledger_runs");
    const fresh = files.reads.slice(before);
    expect(rows.length).toBeGreaterThan(0);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((p) => tableOfPath(p) === "analytics_ledger_runs")).toBe(true);
    expect(archive.table("analytics_ledger_runs")).toBe(rows);
    expect(files.reads.length).toBe(before + fresh.length);
  });

  test("a corrupt file of a table never read never throws; the first call that reads it throws the same text as before", () => {
    const tree = loadTree(REVISED);
    const target = [...tree.keys()].find((p) => tableOfPath(p) === "source_value_versions")!;
    tree.set(target, gzipSync(enc(dec(gunzipSync(tree.get(target)!)).replace("live", "LIVE"))));
    const archive = openArchive(memoryFiles(tree));
    expect(() => archive.table("analytics_ledger_runs")).not.toThrow();
    expect(() => archive.revisedTable("regime_snapshots")).not.toThrow();
    for (const call of [() => archive.versions(), () => archive.latestValues(BACKTEST_KEYS)]) {
      expect(call).toThrow(ArchiveError);
      expect(call).toThrow(new RegExp(`^corrupt local copy: ${target.replace(/[.^$]/g, "\\$&")} content sha256`));
    }
    // A missing file also opens, and fails the call that reads it.
    const missing = loadTree(REVISED);
    missing.delete(target);
    const m = openArchive(memoryFiles(missing));
    expect(() => m.versions()).toThrow(`incomplete local copy: ${target} is listed in its backup record but missing`);
    const withRun = svvTree(SVV_HEAD + "1,backtest:^GSPC,2026-01-02,,100\n", undefined, LEDGER(1, 1));
    withRun.delete(SVV_PATH);
    expect(() => collectRunInputs(openArchive(memoryFiles(withRun)), "r")).toThrow(/incomplete local copy/);
  });
});

// A one-backup archive whose source_value_versions file holds the given CSV text.
const SVV_ID = "2026-01-01T000000Z";
const SVV_PATH = `csv/${SVV_ID}/data/source_value_versions.${SVV_ID}_${SVV_ID}.csv.gz`;
const SVV_HEAD = "id,source_key,market_date,market_instant,value\n";
function svvTree(body: string | Uint8Array, rows?: number, extra: Record<string, string> = {}): Map<string, Uint8Array> {
  const raw = typeof body === "string" ? enc(body) : body;
  const n = rows ?? (typeof body === "string" ? body.split("\n").length - 2 : 1);
  const entry = (path: string, bytes: Uint8Array, count: number) => ({ path, rows: count, bytes_raw: bytes.length, sha256_raw: sha(bytes) });
  const append_only: Record<string, unknown> = {
    source_value_versions: { watermark_before: null, watermark_after: "9", files: [entry(SVV_PATH, raw, n)] },
  };
  const tree = new Map<string, Uint8Array>([[SVV_PATH, gzipSync(raw)]]);
  for (const [table, text] of Object.entries(extra)) {
    const path = `csv/${SVV_ID}/data/${table}.${SVV_ID}_${SVV_ID}.csv.gz`;
    append_only[table] = { watermark_before: null, watermark_after: "1", files: [entry(path, enc(text), text.split("\n").length - 2)] };
    tree.set(path, gzipSync(enc(text)));
  }
  tree.set(`csv/${SVV_ID}/backup.json`, enc(JSON.stringify({ format: 1, backup: SVV_ID, append_only, revisions: {} })));
  return tree;
}
// The run-ledger tables of run "r": one regime run whose vintage covers ids 0..9 of backtest:^GSPC.
const LEDGER = (lo = 0, hi = 9): Record<string, string> => ({
  analytics_ledger_runs: "id,run_key,tool_id,asof,vintage_id,methodology_version_id,build_identity\nrun1,r,regime,2026-01-02,v1,m1,b\n",
  analytics_ledger_methodology_versions: "id,version_label,config_digest\nm1,x,d\n",
  analytics_data_vintages: `id,run_id,member_count\nv1,run1,${hi - lo + 1}\n`,
  analytics_vintage_members: `vintage_id,source_value_version_id,last_source_value_version_id,source_key\nv1,${lo},${hi},backtest:^GSPC\n`,
});

describe("a bad source_value_versions row is refused with its file and row", () => {
  const good = "1,backtest:^GSPC,2026-01-02,,100\n";
  const cases: [string, string][] = [
    ["an empty id", ",backtest:^GSPC,2026-01-03,,101\n"],
    ["a non-integer id", "abc,backtest:^GSPC,2026-01-03,,101\n"],
    ["an empty source_key", "2,,2026-01-03,,101\n"],
    ["an empty value", "2,backtest:^GSPC,2026-01-03,,\n"],
    ["an empty quoted value", '2,backtest:^GSPC,2026-01-03,,""\n'],
    ["both dates", "2,backtest:^GSPC,2026-01-03,2026-01-03 10:00:00+00,101\n"],
    ["neither date", "2,backtest:^GSPC,,,101\n"],
  ];
  for (const [name, bad] of cases) {
    test(`${name}: latestValues and collectRunInputs throw ArchiveError naming the file and row 2`, () => {
      const archive = withLedger(SVV_HEAD + good + bad);
      for (const call of [() => archive.latestValues(["backtest:^GSPC"]), () => addAll(archive)]) {
        let err: unknown;
        try {
          call();
        } catch (e) {
          err = e;
        }
        expect(err, name).toBeInstanceOf(ArchiveError);
        expect((err as Error).message).toContain(SVV_PATH);
        expect((err as Error).message).toContain("row 2");
      }
    });
  }

  const addAll = (archive: Archive) => collectRunInputs(archive, "r");
  const withLedger = (body: string, lo = 0, hi = 9) => openArchive(memoryFiles(svvTree(body, undefined, LEDGER(lo, hi))));

  test("a bad id 0 row inside a range covering id 0 is refused, not read as version 0", () => {
    const archive = withLedger(SVV_HEAD + ",backtest:^GSPC,2026-01-03,,101\n");
    expect(() => addAll(archive)).toThrow(/row 1/);
  });

  test("a market_instant row of a requested key makes latestValues throw; as a vintage member it is counted in skipped", () => {
    const body = SVV_HEAD + good + "2,backtest:^GSPC,,2026-01-03 10:00:00+00,101\n";
    const archive = withLedger(body, 1, 2);
    expect(() => archive.latestValues(["backtest:^GSPC"])).toThrow(ArchiveError);
    expect(() => archive.latestValues(["backtest:^GSPC"])).toThrow(/market_instant/);
    // Another key's instant row is not requested, so latestValues leaves it.
    expect(archive.latestValues(["backtest:ETH-USD"])).toEqual([]);
    const out = collectRunInputs(archive, "r");
    expect(out.skipped).toEqual({ "backtest:^GSPC": 1 });
    expect(out.rows.map((r) => r.value)).toEqual(["100"]);
  });
});

describe("files are decoded as strict UTF-8 with no byte order mark", () => {
  const withByte = (head: Uint8Array, tail: Uint8Array) => new Uint8Array([...head, ...tail]);
  test("a CSV holding 0xFF, or starting with EF BB BF, throws ArchiveError naming the file from the first read", () => {
    const body = enc(SVV_HEAD + "1,backtest:^GSPC,2026-01-02,,10");
    for (const [what, raw] of [
      ["0xFF", withByte(body, new Uint8Array([0xff, 0x0a]))],
      ["a byte order mark", withByte(new Uint8Array([0xef, 0xbb, 0xbf]), withByte(body, new Uint8Array([0x0a])))],
    ] as const) {
      const archive = openArchive(memoryFiles(svvTree(raw, 1)));
      let err: unknown;
      try {
        archive.versions();
      } catch (e) {
        err = e;
      }
      expect(err, what).toBeInstanceOf(ArchiveError);
      expect((err as Error).message, what).toContain(SVV_PATH);
    }
  });

  test("backup.json holding 0xFF, or starting with EF BB BF, throws ArchiveError naming the file when it opens", () => {
    for (const [what, edit] of [
      ["0xFF", (b: Uint8Array) => withByte(b, new Uint8Array([0xff]))],
      ["a byte order mark", (b: Uint8Array) => withByte(new Uint8Array([0xef, 0xbb, 0xbf]), b)],
    ] as const) {
      const tree = svvTree(SVV_HEAD + good());
      const path = `csv/${SVV_ID}/backup.json`;
      tree.set(path, edit(tree.get(path)!));
      let err: unknown;
      try {
        openArchive(memoryFiles(tree));
      } catch (e) {
        err = e;
      }
      expect(err, what).toBeInstanceOf(ArchiveError);
      expect((err as Error).message, what).toContain(path);
    }
  });
  const good = () => "1,backtest:^GSPC,2026-01-02,,100\n";
});

// ── Issue 1751 (gap 9): collectRunInputs reads only the run's vintage members ──

describe("collectRunInputs reads the vintage members one file at a time (issue 1751)", () => {
  const MEMBERS = "analytics_vintage_members";
  // collectRunInputs as 0.8.0 shipped it, frozen: the whole member table through table().
  const collect080 = (archive: Archive, runKey: string): RunInputs => {
    const collector = new RunInputCollector(runKey, {
      runs: archive.table("analytics_ledger_runs"),
      methodologies: archive.table("analytics_ledger_methodology_versions"),
      vintages: archive.table("analytics_data_vintages"),
      members: archive.table("analytics_vintage_members"),
    });
    const vfiles = archive.files("source_value_versions");
    archive.versions().forEach((rows, i) => collector.addVersions(rows, `${archive.root.replace(/\/+$/, "")}/${vfiles[i]!.path}`));
    return collector.finish();
  };
  // An archive whose table() refuses the member table.
  const noMemberTable = (archive: Archive): Archive => ({
    ...archive,
    table: (name) => {
      if (name === MEMBERS) throw new Error(`table(${MEMBERS}) was called`);
      return archive.table(name);
    },
  });
  const outcome = (f: () => RunInputs) => {
    try {
      return { inputs: f() };
    } catch (e) {
      return { error: `${(e as Error).name}: ${(e as Error).message}` };
    }
  };
  const open = (name: string) => openArchive(memoryFiles(loadTree(join(ARCHIVE, name)), join(ARCHIVE, name)));
  const runKeys = (name: string) => open(name).table("analytics_ledger_runs").map((r) => r.run_key!);

  for (const name of COPIES) {
    test(`${name}: every run's RunInputs equal the 0.8.0 result, and table(${MEMBERS}) is never called`, () => {
      let collected = 0;
      for (const key of runKeys(name)) {
        const now = outcome(() => collectRunInputs(noMemberTable(open(name)), key));
        expect(now, key).toEqual(outcome(() => collect080(open(name), key)));
        if ("inputs" in now) collected++;
      }
      // revised holds no run ledger; every other copy has a run that collects
      expect(collected > 0, name).toBe(name !== "revised");
    });
  }

  test("the fixture's two runs collect, and the wrapping archive does throw on the 0.8.0 path", () => {
    const keys = runKeys("repo-plus-increment");
    for (const key of Object.keys(FACTS.runs)) {
      expect(keys).toContain(key);
      expect(collectRunInputs(noMemberTable(open("repo-plus-increment")), key).run.memberCount).toBe(FACTS.runs[key].members);
    }
    expect(() => collect080(noMemberTable(open("repo-plus-increment")), keys[0]!)).toThrow(`table(${MEMBERS}) was called`);
  });

  test("RunInputCollector is handed only the rows of the run's vintage, in the table's order", () => {
    let handed = 0;
    for (const name of COPIES) {
      const archive = open(name);
      const all = open(name).table(MEMBERS);
      for (const run of archive.table("analytics_ledger_runs")) {
        const vintages = archive.table("analytics_data_vintages").filter((v) => v.run_id === run.id);
        if (vintages.length !== 1) continue;
        const members = runVintageMembers(noMemberTable(archive), run.run_key!);
        expect(members.length).toBeGreaterThan(0);
        expect(members.every((m) => m.vintage_id === vintages[0]!.id)).toBe(true);
        expect(members).toEqual(all.filter((m) => m.vintage_id === vintages[0]!.id));
        expect(members.length).toBeLessThan(all.length); // the copy holds other vintages' rows too
        handed++;
      }
    }
    expect(handed).toBeGreaterThan(1);
    expect(runVintageMembers(open("repo-plus-increment"), "no-such-run")).toEqual([]);
  });

  test("the member files are read one at a time and never kept: scanRows hands out fresh rows, table() still memoizes", () => {
    const files = countingFiles(loadTree(join(ARCHIVE, "repo-plus-increment")));
    const archive = openArchive(files);
    const memberFiles = archive.files(MEMBERS);
    expect(memberFiles.length).toBeGreaterThan(1);
    const key = Object.keys(FACTS.runs)[0]!;
    const memberReads = () => files.reads.filter((p) => tableOfPath(p) === MEMBERS);
    const first = collectRunInputs(archive, key);
    expect(memberReads()).toEqual(memberFiles.map((f) => f.path));
    // nothing was kept: a second run reads each member file again, and returns the same
    expect(collectRunInputs(archive, key)).toEqual(first);
    expect(memberReads()).toEqual([...memberFiles, ...memberFiles].map((f) => f.path));
    const a = archive.scanRows(memberFiles[0]!);
    expect(archive.scanRows(memberFiles[0]!)).not.toBe(a);
    expect(archive.scanRows(memberFiles[0]!)).toEqual(a);
    expect(archive.readRows(memberFiles[0]!)).toBe(archive.readRows(memberFiles[0]!));
    expect(archive.table(MEMBERS)).toBe(archive.table(MEMBERS));
  });
});

describe("the retired reader names are gone", () => {
  test("openBackupsDir and openArchive read the same, and none of the retired opener, type or file remains in the package", () => {
    const pkg = join(import.meta.dir, "..");
    expect(Object.keys(binExports)).toContain("openBackupsDir");
    // Spelled in pieces so this file itself holds none of the retired names.
    const retired = ["open", "Local", "Copy"].join("");
    const retiredType = ["Local", "Copy"].join("");
    const retiredFile = ["local", "copy.ts"].join("-");
    expect(Object.keys(binExports)).not.toContain(retired);
    expect(Object.keys(sdkIndex)).not.toContain(retired);
    expect(readdirSync(join(pkg, "bin"))).not.toContain(retiredFile);
    expect(readdirSync(join(pkg, "bin"))).toContain("backups-dir.ts");
    // node/ is the package's fs edge (issue 1765), where the folder reader now lives.
    expect(readdirSync(join(pkg, "node"))).not.toContain(retiredFile);
    expect(readdirSync(join(pkg, "node"))).toContain("backups-dir.ts");
    for (const dir of ["bin", "node", "src"]) {
      const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
      const walked = walk(join(pkg, dir));
      expect(walked.length, dir).toBeGreaterThan(0);
      for (const f of walked) {
        const text = readFileSync(f, "utf8");
        expect(text, f).not.toMatch(new RegExp(`${retired}|\\b${retiredType}\\b|${retiredFile.replace(".", "\\.")}`));
      }
    }
  });
});

// ── Issue 1765: one sha256 ───────────────────────────────────────────────────
// The reader's file digests, the supplementary check, the replay comparison and
// the manifests the node edge writes all hash through src/hash.ts.
describe("one sha256 (issue 1765)", () => {
  test("src/hash.ts is the one definition, node/ re-exports it, and a string hashes as its UTF-8 bytes", () => {
    expect(nodeSha256).toBe(sha256);
    expect(nodeEdge.sha256).toBe(sha256);
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const text = "caf\u00e9 \u2014 \u00fc";
    const bytes = new TextEncoder().encode(text);
    expect(sha256(text)).toBe(sha256(bytes));
    // The same hex the Bun hasher node/ used before gave.
    expect(sha256(bytes)).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
    expect(sha256(bytes)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Issue 1765 (D-a): every v5 storage key has an input id, read per run ──

describe("the archive reader maps every v5 storage key, through each run's own methodology (issue 1765, D-a)", () => {
  const MODEL_RUNS = join(ARCHIVE, "model-runs");
  const MODEL_FACTS = JSON.parse(readFileSync(join(MODEL_RUNS, "facts.json"), "utf8")) as {
    v4: { runKey: string; asof: string; label: string };
    v5: { runKey: string; asof: string; label: string }[];
  };
  const FIVE = ["FED_SURPLUS_MONTHLY", "US_GDP", "CBOE_VIX3M", "CBOE_SKEW", "SPX_VOLUME"] as const;
  const FIVE_KEYS = FIVE.map((id) => `raw_indicator_history:${id}`);

  test("the five keys are the storage keys only a v5 run reads", () => {
    expect([...V5_ONLY_STORAGE_KEYS].sort()).toEqual([...FIVE_KEYS].sort());
  });

  test("seriesForStorageKey returns an input id for every storage key in V5_SERIES_MAPPING; a main-line key keeps its main-line id", () => {
    for (const m of V5_SERIES_MAPPING) expect(seriesForStorageKey(m.storageKey), m.storageKey).not.toBeNull();
    for (const key of FIVE_KEYS) expect(seriesForStorageKey(key), key).toBe(key.slice("raw_indicator_history:".length));
    // First id wins: V5_SERIES_MAPPING starts with SERIES_MAPPING.
    const first = new Map<string, string>();
    for (const m of SERIES_MAPPING) if (!first.has(m.storageKey)) first.set(m.storageKey, m.inputId);
    for (const [key, id] of first) expect(seriesForStorageKey(key), key).toBe(id);
    expect(seriesForStorageKey("raw_indicator_history:VIX")).toBe("VIX");
  });

  test("the committed copy holds a v4 run and three v5 runs, by their methodology labels", () => {
    const copy = openBackupsDir(MODEL_RUNS);
    expect(MODEL_FACTS.v4.label).toBe("v4");
    expect(MODEL_FACTS.v5.map((f) => f.label)).toEqual(["v5", "v5", "v5"]);
    for (const f of [MODEL_FACTS.v4, ...MODEL_FACTS.v5]) {
      const { run } = collectRunInputs(copy, f.runKey);
      expect({ label: run.methodology.label, asof: run.asof }, f.runKey).toEqual({ label: f.label, asof: f.asof });
    }
  });

  test("collectRunInputs on each committed v5 run skips none of the five keys, and reads each under its input id", () => {
    const v4 = collectRunInputs(openBackupsDir(MODEL_RUNS), MODEL_FACTS.v4.runKey);
    for (const f of MODEL_FACTS.v5) {
      const out = collectRunInputs(openBackupsDir(MODEL_RUNS), f.runKey);
      for (const key of FIVE_KEYS) expect(Object.keys(out.skipped), `${f.asof} ${key}`).not.toContain(key);
      expect(out.skipped, f.asof).toEqual({});
      const series = new Set(out.rows.map((r) => r.series));
      for (const id of FIVE) expect(series.has(id), `${f.asof} ${id}`).toBe(true);
      // The v5 run of the v4 run's as-of day reads the same versions: each key's rows are the ones the v4 run skips.
      if (f.asof === MODEL_FACTS.v4.asof) {
        for (const id of FIVE) expect(out.rows.filter((r) => r.series === id).length, id).toBe(v4.skipped[`raw_indicator_history:${id}`]!);
      }
    }
  });

  test("red control: the v4 run still lists all five keys in skipped, so its generated input is what it was", () => {
    const out = collectRunInputs(openBackupsDir(MODEL_RUNS), MODEL_FACTS.v4.runKey);
    expect(Object.keys(out.skipped).sort()).toEqual([...FIVE_KEYS].sort());
    for (const key of FIVE_KEYS) expect(out.skipped[key], key).toBeGreaterThan(0);
    const series = new Set(out.rows.map((r) => r.series));
    for (const id of FIVE) expect(series.has(id), id).toBe(false);
    // Every member is either generated or counted.
    const skipped = Object.values(out.skipped).reduce((a, b) => a + b, 0);
    expect(out.rows.length + skipped).toBeLessThanOrEqual(out.run.memberCount);
    expect(skipped).toBeGreaterThan(0);
  });

  test("latestValues over the model-runs copy reads every V5_SERIES_MAPPING storage key without throwing", () => {
    const keys = [...new Set(V5_SERIES_MAPPING.map((m) => m.storageKey))];
    let vals: ReturnType<Archive["latestValues"]> = [];
    expect(() => (vals = openBackupsDir(MODEL_RUNS).latestValues(keys))).not.toThrow();
    for (const id of FIVE) {
      const got = vals.filter((v) => v.sourceKey === `raw_indicator_history:${id}`);
      expect(got.length, id).toBeGreaterThan(0);
      expect(got.every((v) => v.series === id), id).toBe(true);
    }
  });
});

// Issue 1766: latestStoredSeries reads any storage key's newest stored version per market date.
describe("latestStoredSeries (issue 1766)", () => {
  const B1 = "2026-01-01T000000Z";
  const B2 = "2026-01-08T000000Z";
  const head = "id,source_key,market_date,market_instant,value\n";
  // Two backups: the second revises research:BTC-USD on 2026-01-02 and adds days.
  function twoBackups(body1: string, body2: string): Map<string, Uint8Array> {
    const tree = new Map<string, Uint8Array>();
    let before: string | null = null;
    for (const [id, body, after] of [[B1, body1, "20"], [B2, body2, "9007199254740993"]] as const) {
      const raw = enc(head + body);
      const path = `csv/${id}/data/source_value_versions.${id}_${id}.csv.gz`;
      const files = [{ path, rows: body.split("\n").length - 1, bytes_raw: raw.length, sha256_raw: sha(raw) }];
      tree.set(path, gzipSync(raw));
      tree.set(`csv/${id}/backup.json`, enc(JSON.stringify({ format: 1, backup: id, append_only: { source_value_versions: { watermark_before: before, watermark_after: after, files } }, revisions: {} })));
      before = after;
    }
    return tree;
  }
  const body1 = [
    "1,research:BTC-USD,2026-01-02,,40000",
    "2,yahoo:GLD,2026-01-02,,190.5",
    "3,backtest:DTB3,2026-01-02,,4.05",
    "4,research:BTC-USD,2026-01-03,,41000",
    "5,backtest:DTB3,2026-01-05,,-0.02",
    "6,backtest:ETH-USD,2026-01-02,,3000",
    "",
  ].join("\n");
  const body2 = [
    "9007199254740993,research:BTC-USD,2026-01-02,,40500",
    "9007199254740992,research:BTC-USD,2026-01-02,,40400",
    "21,yahoo:GLD,2026-01-05,,191",
    "22,research:BTC-USD,2026-01-06,,42000",
    "23,yahoo:GLD,2026-01-07,,192",
    "",
  ].join("\n");
  const archive = () => openArchive(memoryFiles(twoBackups(body1, body2)));

  test("the highest id per market date, compared as BigInt, in date order, cut at notAfter", async () => {
    const { latestStoredSeries } = await import("../src/archive/reader.ts");
    expect(Number("9007199254740992")).toBe(Number("9007199254740993"));
    const got = latestStoredSeries(archive(), ["research:BTC-USD", "yahoo:GLD", "backtest:DTB3"], { notAfter: "2026-01-06" });
    expect(got).toEqual({
      "research:BTC-USD": [{ date: "2026-01-02", value: 40500 }, { date: "2026-01-03", value: 41000 }, { date: "2026-01-06", value: 42000 }],
      "yahoo:GLD": [{ date: "2026-01-02", value: 190.5 }, { date: "2026-01-05", value: 191 }],
      "backtest:DTB3": [{ date: "2026-01-02", value: 4.05 }, { date: "2026-01-05", value: -0.02 }],
    });
    expect(latestStoredSeries(archive(), ["yahoo:GLD"])["yahoo:GLD"]!.at(-1)).toEqual({ date: "2026-01-07", value: 192 });
    // As of the first backup the revision is not there yet.
    expect(latestStoredSeries(openArchive(memoryFiles(twoBackups(body1, body2)), B1), ["research:BTC-USD"])["research:BTC-USD"]![0]!.value).toBe(40000);
  });

  test("a key with no rows, a market_instant row, a non-finite value, and under positive a value at or below 0 are ArchiveErrors naming the key", async () => {
    const { latestStoredSeries } = await import("../src/archive/reader.ts");
    const refuses = (call: () => unknown, key: string) => {
      expect(call).toThrow(ArchiveError);
      expect(call).toThrow(key);
    };
    refuses(() => latestStoredSeries(archive(), ["yahoo:GLD", "yahoo:NOPE"]), "yahoo:NOPE");
    const instant = openArchive(memoryFiles(twoBackups(body1, "24,yahoo:GLD,,2026-01-05T16:00:00Z,191\n")));
    refuses(() => latestStoredSeries(instant, ["yahoo:GLD"]), "yahoo:GLD");
    const nan = openArchive(memoryFiles(twoBackups(body1, "24,yahoo:GLD,2026-01-05,,NaN\n")));
    refuses(() => latestStoredSeries(nan, ["yahoo:GLD"]), "yahoo:GLD");
    refuses(() => latestStoredSeries(archive(), ["backtest:DTB3"], { positive: true }), "backtest:DTB3");
    const zero = openArchive(memoryFiles(twoBackups(body1, "24,yahoo:GLD,2026-01-05,,0\n")));
    refuses(() => latestStoredSeries(zero, ["yahoo:GLD"], { positive: true }), "yahoo:GLD");
    expect(latestStoredSeries(zero, ["yahoo:GLD"])["yahoo:GLD"]!.at(-1)!.value).toBe(0);
  });

  test("latestValues still refuses a key no input id maps to", () => {
    expect(() => archive().latestValues(["yahoo:GLD"])).toThrow(ArchiveError);
    expect(archive().latestValues(["backtest:DTB3"]).length).toBe(2);
  });
});
