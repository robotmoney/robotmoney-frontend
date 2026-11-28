// Issue 1765 (phase 1): one snapshot column table, and one row builder.
// SNAPSHOT_COLUMNS holds one entry per regime snapshot column; its keys are the
// keys of RegimeSnapshotRow (checked by the compiler and at run time), and
// rowToSnapshot, now a loop over it, writes the same JSON bytes as the function
// it replaced (a frozen copy is kept below). publishedRows over the committed
// model-runs copy writes exactly the bytes each run froze, through the run
// runRegime returns, and the prepared inputs it reads change no byte of a run.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openBackupsDir } from "../bin/backups-dir.ts";
import { collectRunInputs } from "../src/archive/reader.ts";
import { requireComplete, runRegime, type RunResult } from "../src/run.ts";
import { canonicalArtifactBytes, type RegimeSnapshotRow } from "../src/report/canonical.ts";
import { rowToSnapshot } from "../src/report/regime-snapshots.ts";
import { SNAPSHOT_COLUMNS, type SnapshotKey } from "../src/report/snapshot-columns.ts";
import { REGIME_ARTIFACT_KIND, REGIME_REGISTRY, regimeArtifactKindOf } from "../src/analyze/regime-versions.ts";
import { COMPARED_FIELDS, historyOfInputs, publishedRows } from "../src/replay/index.ts";

// ── The keys of RegimeSnapshotRow, held equal to the table's by the compiler ──
// `satisfies` refuses a missing or an extra key; Same refuses a table key that is not a row key.
const ROW_KEYS = {
  date: 1, composite: 1, compositePercentile: 1, regime: 1, macroRegime: 1, onchainRegime: 1, factorRegime: 1, macroIndex: 1,
  onchainIndex: 1, factorIndex: 1, macroPercentile: 1, onchainPercentile: 1, factorPercentile: 1, panelWeights: 1, version: 1,
  source: 1, percentiles: 1, indicators: 1, panels: 1, bucketThresholds: 1, backtest: 1, correlations: 1, extras: 1,
} satisfies Record<keyof RegimeSnapshotRow, 1>;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const TABLE_KEYS_ARE_ROW_KEYS: Same<SnapshotKey, keyof RegimeSnapshotRow> = true;

// The function SNAPSHOT_COLUMNS replaced, frozen as it was (src/report/regime-snapshots.ts before issue 1765).
const num = (v: unknown): number | null => (v == null ? null : Number(v));
function frozenRowToSnapshot(r: any) {
  return {
    date: typeof r.date === "string" ? r.date : new Date(r.date).toISOString().slice(0, 10),
    composite: num(r.composite),
    compositePercentile: num(r.composite_percentile),
    regime: r.regime,
    macroRegime: r.macro_regime,
    onchainRegime: r.onchain_regime,
    factorRegime: r.factor_regime,
    macroIndex: num(r.macro_index),
    onchainIndex: num(r.onchain_index),
    factorIndex: num(r.factor_index),
    macroPercentile: num(r.macro_percentile),
    onchainPercentile: num(r.onchain_percentile),
    factorPercentile: num(r.factor_percentile),
    panelWeights: r.panel_weights ?? null,
    version: r.version ?? null,
    source: r.source ?? null,
    percentiles: r.percentiles ?? {},
    indicators: r.indicators ?? [],
    panels: r.panels ?? null,
    bucketThresholds: r.bucket_thresholds ?? null,
    backtest: r.backtest ?? null,
    correlations: r.correlations ?? null,
    extras: r.extras ?? null,
  };
}

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe("SNAPSHOT_COLUMNS (issue 1765)", () => {
  test("its keys are RegimeSnapshotRow's keys, in rowToSnapshot's order, each with its snake_case column", () => {
    expect(TABLE_KEYS_ARE_ROW_KEYS).toBe(true);
    const keys: string[] = SNAPSHOT_COLUMNS.map((c) => c.key);
    expect([...keys].sort()).toEqual(Object.keys(ROW_KEYS).sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(rowToSnapshot({ date: "2026-01-01" }))).toEqual(keys);
    for (const c of SNAPSHOT_COLUMNS) expect(c.column, c.key).toBe(snake(c.key));
  });

  test("only bucketThresholds and extras are not written by the row builder; the compared columns are COMPARED_FIELDS", () => {
    expect(SNAPSHOT_COLUMNS.filter((c) => !c.builderEmits).map((c) => c.key)).toEqual(["bucketThresholds", "extras"]);
    expect(SNAPSHOT_COLUMNS.filter((c) => c.compared).map((c) => c.key).sort()).toEqual([...COMPARED_FIELDS].sort());
    expect(SNAPSHOT_COLUMNS.filter((c) => c.asofOnly).map((c) => c.key)).toEqual(["panelWeights", "indicators", "panels", "bucketThresholds", "backtest", "correlations", "extras"]);
    for (const c of SNAPSHOT_COLUMNS) {
      const sql = { number: "numeric", label: "text", text: "text", json: "jsonb", date: "date" }[c.kind];
      expect(c.sqlType, c.key).toBe(sql as typeof c.sqlType);
    }
  });

  test("rowToSnapshot writes the frozen function's JSON bytes for the committed rows and the edge rows", () => {
    const f = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/report/regime-history-projection.json"), "utf8")) as { sqlRows: Record<string, unknown>[]; snapshots: unknown[] };
    const edge: Record<string, unknown>[] = [
      { date: new Date("2026-09-04T00:00:00Z"), composite: 0.25, regime: undefined, macro_index: "1e-3", percentiles: null, indicators: undefined, extras: { spx: [] } },
      { date: "2026-09-05" },
      { date: "2026-09-06", composite: "0", macro_regime: "risk_on", panel_weights: { macro: { A: 1 } }, panels: ["macro"], bucket_thresholds: { risk_off: 0.3, risk_on: 0.7 }, backtest: {}, correlations: { forward: {} }, version: "v4", source: "live" },
    ];
    for (const row of [...f.sqlRows, ...edge]) expect(JSON.stringify(rowToSnapshot(row))).toBe(JSON.stringify(frozenRowToSnapshot(row)));
    expect(JSON.stringify(f.sqlRows.map(rowToSnapshot))).toBe(JSON.stringify(f.snapshots));
    // An empty cell is a fresh value on each row, never one shared object.
    const [a, b] = [rowToSnapshot({ date: "2026-09-05" }), rowToSnapshot({ date: "2026-09-05" })];
    expect(a.percentiles).not.toBe(b.percentiles);
    expect(a.indicators).not.toBe(b.indicators);
    expect(Object.isFrozen(a.percentiles)).toBe(false);
  });
});

// ── publishedRows over the committed copy ───────────────────────────────────
const MODEL_RUNS = join(import.meta.dir, "fixtures/archive/model-runs");
type Fact = { runKey: string; asof: string; label: string };
const FACTS = JSON.parse(readFileSync(join(MODEL_RUNS, "facts.json"), "utf8")) as { v4: Fact; v5: Fact[] };
const copy = openBackupsDir(MODEL_RUNS);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function published(f: Fact) {
  const run = copy.table("analytics_ledger_runs").find((r) => r.run_key === f.runKey)!;
  const kind = regimeArtifactKindOf(f.label as "v4" | "v5");
  const o = copy.table("analytics_output_snapshots").find((x) => x.run_id === run.id && x.artifact_kind === kind)!;
  return { source: run.source_label, payload: o.payload_json!, sha256: o.payload_sha256! };
}

function runOf(f: Fact): RunResult {
  const inputs = collectRunInputs(copy, f.runKey);
  return requireComplete(runRegime(historyOfInputs(inputs.rows), { asof: f.asof, version: f.label as "v4" | "v5", factor: true }));
}

describe("publishedRows writes the bytes each run froze (issue 1765)", () => {
  const BUILDER_KEYS = SNAPSHOT_COLUMNS.filter((c) => c.builderEmits).map((c) => c.key);

  test("the v4 run: canonicalArtifactBytes(publishedRows(run)) equals its frozen artifact, byte for byte", () => {
    const f = FACTS.v4;
    const run = runOf(f);
    const pub = published(f);
    const rows = publishedRows(run, { source: pub.source });
    const bytes = canonicalArtifactBytes(rows);
    expect(new TextDecoder().decode(bytes) === pub.payload).toBe(true);
    expect(sha256(bytes)).toBe(pub.sha256);
    // Exactly the 21 builder keys, in the table's order; the as-of view only on the as-of row.
    expect(BUILDER_KEYS.length).toBe(21);
    for (const row of rows) expect(Object.keys(row)).toEqual(BUILDER_KEYS);
    const asof = rows.at(-1)!;
    expect(asof.date).toBe(f.asof);
    expect(asof.panelWeights).not.toBeNull();
    expect((asof.indicators as unknown[]).length).toBe(REGIME_REGISTRY.v4.length);
    expect(rows.slice(0, -1).every((r) => r.panelWeights === null && r.panels === null && r.backtest === null && (r.indicators as unknown[]).length === 0)).toBe(true);
  }, 120_000);

  test("the prepared inputs a run carries are not enumerable: no JSON byte of the run changes, and a spread copy needs them passed", () => {
    const run = runOf(FACTS.v4);
    expect(run.prepared).toBeDefined();
    expect(Object.keys(run)).not.toContain("prepared");
    expect(JSON.stringify(run).includes('"prepared"')).toBe(false);
    const spread = { ...run };
    expect(() => publishedRows(spread, { source: "fixture" })).toThrow(RangeError);
    const again = publishedRows(spread, { source: "fixture", prepared: run.prepared });
    expect(canonicalArtifactBytes(again)).toEqual(canonicalArtifactBytes(publishedRows(run, { source: "fixture" })));
    // A run without its factor figures cannot give the factor columns.
    expect(() => publishedRows(requireComplete(runRegime(historyOfInputs(collectRunInputs(copy, FACTS.v4.runKey).rows), { asof: FACTS.v4.asof, version: "v4" })), {})).toThrow(RangeError);
  }, 120_000);

  test("the first v5 run: runRegime's result, carrying its kept run, gives the bytes of its beside artifact", () => {
    const f = FACTS.v5[0]!;
    expect(regimeArtifactKindOf("v5")).toBe(REGIME_ARTIFACT_KIND.beside);
    const run = runOf(f);
    expect(run.keptRun).toBeDefined();
    expect(Object.keys(run)).not.toContain("keptRun");
    const pub = published(f);
    const bytes = canonicalArtifactBytes(publishedRows(run, { source: pub.source }));
    expect(new TextDecoder().decode(bytes) === pub.payload).toBe(true);
    expect(sha256(bytes)).toBe(pub.sha256);
  }, 300_000);
});
