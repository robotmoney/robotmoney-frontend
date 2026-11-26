// One snapshot column table feeds every backend row mapper (issue 1765, phase 1).
//
// SNAPSHOT_COLUMNS (packages/analyst-sdk/src/report/snapshot-columns.ts, through
// the shim report/published-rows.ts) states every regime snapshot column once.
// The backend mappers loop over it: toDbRow (report/regime-eq-map.ts), which
// is also the regime store's upsert document, ledgerRowToSnapshot
// (report/projections.ts), and parseSnapshotRow (api/routes/analytics.ts).
// Two SQL statements cannot be generated, because a registered statement is a
// literal tagged template (db/registry.ts): the regime store's upsert and the
// parity sweep's regime comparison (cutover/parity.ts). This file is their
// guard. It captures each statement's text through a fake database handle and
// holds every column list in it equal to the table.
//
// The mappers' bytes are frozen: the expected JSON below is what the mappers
// wrote before they were derived from the table (captured at a627f3ab3), for a
// full as-of row, a builder history row, and a sparse stored row (an older
// row or an eq-snapshot history row: no percentile columns, no blobs, no
// factorRegime key).
//
// RED CONTROL: the statement checks run against planted statements (a column
// dropped from the guard, two columns swapped, a parity key misspelled) and
// must name each defect.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "../src/db/client.ts";
import { registeredSites } from "../src/db/registry.ts";
import { SNAPSHOT_COLUMNS, type SnapshotColumn } from "../src/analytics/report/published-rows.ts";
import { mapEqSnapshotToDto, toDbRow, type EqSnapshot } from "../src/analytics/report/regime-eq-map.ts";
import { ledgerRowToSnapshot } from "../src/analytics/report/projections.ts";
import { rowToSnapshot, type RegimeSnapshotRow } from "../src/analytics/report/regime-projection.ts";
import { saveRegimeSnapshots } from "../src/analytics/store/regime-store.ts";
import { checkRegimeSnapshotsParity } from "../src/analytics/cutover/parity.ts";
import { parseSnapshots } from "../src/api/routes/analytics.ts";
import type { DbHandle } from "../src/db/client.ts";
import { loadJsonGz } from "./fixtures/regime/load.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const COLUMNS = SNAPSHOT_COLUMNS.map((c) => c.column);
const KEYS = SNAPSHOT_COLUMNS.map((c) => c.key);
const NON_KEY = SNAPSHOT_COLUMNS.filter((c) => c.column !== "date");

// ── the golden rows ─────────────────────────────────────────────────────────

const ASOF_ROW = {
  date: "2026-08-15",
  composite: 0.4123456789,
  compositePercentile: 0.61,
  regime: "neutral",
  macroRegime: "risk_on",
  onchainRegime: "neutral",
  factorRegime: "risk_off",
  macroIndex: 0.52,
  onchainIndex: -0.13,
  factorIndex: 0.07,
  macroPercentile: 0.7,
  onchainPercentile: 0.4,
  factorPercentile: 0.55,
  panelWeights: { macro: { HY_OAS: 0.25, T10Y2Y: 0.75 }, onchain: { BTC_ACTIVE: 1 }, factor: { VIX: 1 }, weightFitDate: "2026-08-01" },
  version: "v4",
  source: "fixture",
  percentiles: { HY_OAS: 0.123456, VIX: -0.5 },
  indicators: [
    { id: "HY_OAS", name: "HY OAS", panel: "macro", raw_value: 3.1, raw_date: "2026-08-14", transformed_value: 0.2, percentile: 0.6, signed_percentile: -0.6, panel_weight: 0.25, forward_fill_age_days: 1, forward_fill_expired: false, sparkline: [0.1, null, 0.3] },
  ],
  panels: ["macro", "onchain", "factor"],
  bucketThresholds: { risk_off: 0.33, risk_on: 0.67 },
  backtest: { mixed: { sp500: { final_value: 1.2, transitions: 4, equity_curve: [{ date: "2026-08-14", value: 1.2 }] } } },
  correlations: { "90d": { composite: { spx: 0.1, n: 90 } } },
  extras: { spx: [{ date: "2026-08-14", value: 6400 }] },
};

// What the row builder writes for a day before the as-of day: every builder key, no blob.
const HISTORY_ROW = {
  date: "2026-08-14",
  composite: -0.25,
  compositePercentile: 0.3,
  regime: "risk_off",
  macroRegime: "risk_off",
  onchainRegime: "neutral",
  factorRegime: null,
  macroIndex: -0.4,
  onchainIndex: 0.01,
  factorIndex: null,
  macroPercentile: 0.2,
  onchainPercentile: 0.5,
  factorPercentile: null,
  panelWeights: null,
  version: "v4",
  source: "live",
  percentiles: { HY_OAS: 0.5 },
  indicators: [],
  panels: null,
  backtest: null,
  correlations: null,
};

const SPARSE_ROW = {
  date: "2019-03-01",
  composite: 0.1,
  compositePercentile: null,
  regime: "neutral",
  macroRegime: "neutral",
  onchainRegime: "risk_on",
  macroIndex: 0.2,
  onchainIndex: 0.3,
  factorIndex: null,
  source: "seed",
  percentiles: {},
  indicators: [],
};

const GOLDEN: Record<string, RegimeSnapshotRow> = { ASOF_ROW, HISTORY_ROW, SPARSE_ROW } as unknown as Record<string, RegimeSnapshotRow>;

// The bytes each mapper wrote before it was derived from the table (a627f3ab3).
const FROZEN: Record<string, { ledger: string; toDbRow: string; parsed: string }> = {
  ASOF_ROW: {
    ledger:
      '{"date":"2026-08-15","composite":0.4123456789,"compositePercentile":0.61,"regime":"neutral","macroRegime":"risk_on","onchainRegime":"neutral","factorRegime":"risk_off","macroIndex":0.52,"onchainIndex":-0.13,"factorIndex":0.07,"macroPercentile":0.7,"onchainPercentile":0.4,"factorPercentile":0.55,"panelWeights":{"macro":{"HY_OAS":0.25,"T10Y2Y":0.75},"onchain":{"BTC_ACTIVE":1},"factor":{"VIX":1},"weightFitDate":"2026-08-01"},"version":"v4","source":"fixture","percentiles":{"HY_OAS":0.123456,"VIX":-0.5},"indicators":[{"id":"HY_OAS","name":"HY OAS","panel":"macro","raw_value":3.1,"raw_date":"2026-08-14","transformed_value":0.2,"percentile":0.6,"signed_percentile":-0.6,"panel_weight":0.25,"forward_fill_age_days":1,"forward_fill_expired":false,"sparkline":[0.1,null,0.3]}],"panels":["macro","onchain","factor"],"bucketThresholds":{"risk_off":0.33,"risk_on":0.67},"backtest":{"mixed":{"sp500":{"final_value":1.2,"transitions":4,"equity_curve":[{"date":"2026-08-14","value":1.2}]}}},"correlations":{"90d":{"composite":{"spx":0.1,"n":90}}},"extras":{"spx":[{"date":"2026-08-14","value":6400}]}}',
    toDbRow:
      '{"date":"2026-08-15","composite":0.4123456789,"composite_percentile":0.61,"regime":"neutral","macro_regime":"risk_on","onchain_regime":"neutral","factor_regime":"risk_off","macro_index":0.52,"onchain_index":-0.13,"factor_index":0.07,"macro_percentile":0.7,"onchain_percentile":0.4,"factor_percentile":0.55,"panel_weights":{"macro":{"HY_OAS":0.25,"T10Y2Y":0.75},"onchain":{"BTC_ACTIVE":1},"factor":{"VIX":1},"weightFitDate":"2026-08-01"},"version":"v4","source":"fixture","percentiles":{"HY_OAS":0.123456,"VIX":-0.5},"indicators":[{"id":"HY_OAS","name":"HY OAS","panel":"macro","raw_value":3.1,"raw_date":"2026-08-14","transformed_value":0.2,"percentile":0.6,"signed_percentile":-0.6,"panel_weight":0.25,"forward_fill_age_days":1,"forward_fill_expired":false,"sparkline":[0.1,null,0.3]}],"panels":["macro","onchain","factor"],"bucket_thresholds":{"risk_off":0.33,"risk_on":0.67},"backtest":{"mixed":{"sp500":{"final_value":1.2,"transitions":4,"equity_curve":[{"date":"2026-08-14","value":1.2}]}}},"correlations":{"90d":{"composite":{"spx":0.1,"n":90}}},"extras":{"spx":[{"date":"2026-08-14","value":6400}]}}',
    parsed:
      '[{"date":"2026-08-15","composite":0.4123456789,"compositePercentile":0.61,"regime":"neutral","macroRegime":"risk_on","onchainRegime":"neutral","factorRegime":"risk_off","macroIndex":0.52,"onchainIndex":-0.13,"factorIndex":0.07,"macroPercentile":0.7,"onchainPercentile":0.4,"factorPercentile":0.55,"panelWeights":{"macro":{"HY_OAS":0.25,"T10Y2Y":0.75},"onchain":{"BTC_ACTIVE":1},"factor":{"VIX":1},"weightFitDate":"2026-08-01"},"version":"v4","source":"fixture","percentiles":{"HY_OAS":0.123456,"VIX":-0.5},"indicators":[{"id":"HY_OAS","name":"HY OAS","panel":"macro","raw_value":3.1,"raw_date":"2026-08-14","transformed_value":0.2,"percentile":0.6,"signed_percentile":-0.6,"panel_weight":0.25,"forward_fill_age_days":1,"forward_fill_expired":false,"sparkline":[0.1,null,0.3]}],"panels":["macro","onchain","factor"],"bucketThresholds":{"risk_off":0.33,"risk_on":0.67},"backtest":{"mixed":{"sp500":{"final_value":1.2,"transitions":4,"equity_curve":[{"date":"2026-08-14","value":1.2}]}}},"correlations":{"90d":{"composite":{"spx":0.1,"n":90}}},"extras":{"spx":[{"date":"2026-08-14","value":6400}]}}]',
  },
  HISTORY_ROW: {
    ledger:
      '{"date":"2026-08-14","composite":-0.25,"compositePercentile":0.3,"regime":"risk_off","macroRegime":"risk_off","onchainRegime":"neutral","factorRegime":null,"macroIndex":-0.4,"onchainIndex":0.01,"factorIndex":null,"macroPercentile":0.2,"onchainPercentile":0.5,"factorPercentile":null,"panelWeights":null,"version":"v4","source":"live","percentiles":{"HY_OAS":0.5},"indicators":[],"panels":null,"bucketThresholds":null,"backtest":null,"correlations":null,"extras":null}',
    toDbRow:
      '{"date":"2026-08-14","composite":-0.25,"composite_percentile":0.3,"regime":"risk_off","macro_regime":"risk_off","onchain_regime":"neutral","factor_regime":null,"macro_index":-0.4,"onchain_index":0.01,"factor_index":null,"macro_percentile":0.2,"onchain_percentile":0.5,"factor_percentile":null,"panel_weights":null,"version":"v4","source":"live","percentiles":{"HY_OAS":0.5},"indicators":[],"panels":null,"bucket_thresholds":null,"backtest":null,"correlations":null,"extras":null}',
    parsed:
      '[{"date":"2026-08-14","composite":-0.25,"compositePercentile":0.3,"regime":"risk_off","macroRegime":"risk_off","onchainRegime":"neutral","factorRegime":null,"macroIndex":-0.4,"onchainIndex":0.01,"factorIndex":null,"macroPercentile":0.2,"onchainPercentile":0.5,"factorPercentile":null,"panelWeights":null,"version":"v4","source":"live","percentiles":{"HY_OAS":0.5},"indicators":[],"panels":null,"backtest":null,"correlations":null}]',
  },
  SPARSE_ROW: {
    ledger:
      '{"date":"2019-03-01","composite":0.1,"compositePercentile":null,"regime":"neutral","macroRegime":"neutral","onchainRegime":"risk_on","macroIndex":0.2,"onchainIndex":0.3,"factorIndex":null,"macroPercentile":null,"onchainPercentile":null,"factorPercentile":null,"panelWeights":null,"version":null,"source":"seed","percentiles":{},"indicators":[],"panels":null,"bucketThresholds":null,"backtest":null,"correlations":null,"extras":null}',
    toDbRow:
      '{"date":"2019-03-01","composite":0.1,"composite_percentile":null,"regime":"neutral","macro_regime":"neutral","onchain_regime":"risk_on","macro_index":0.2,"onchain_index":0.3,"factor_index":null,"macro_percentile":null,"onchain_percentile":null,"factor_percentile":null,"panel_weights":null,"version":null,"source":"seed","percentiles":{},"indicators":[],"panels":null,"bucket_thresholds":null,"backtest":null,"correlations":null,"extras":null}',
    parsed:
      '[{"date":"2019-03-01","composite":0.1,"compositePercentile":null,"regime":"neutral","macroRegime":"neutral","onchainRegime":"risk_on","factorRegime":null,"macroIndex":0.2,"onchainIndex":0.3,"factorIndex":null,"macroPercentile":null,"onchainPercentile":null,"factorPercentile":null,"panelWeights":null,"version":null,"source":"seed","percentiles":{},"indicators":[],"panels":null,"backtest":null,"correlations":null}]',
  },
};

// The sha256 of JSON.stringify(mapEqSnapshotToDto(vendored eq snapshot)) at a627f3ab3:
// the DTO the Playwright stub serves.
const FROZEN_EQ_DTO_SHA256 = "76453678c26624aad6248b9acc9c1ec7dfe8a61a60f87c44421b19e090ca65be";

// ── statement capture ───────────────────────────────────────────────────────

interface Captured {
  text: string;
  values: unknown[];
}

const STOP = new Error("snapshot-columns test: statement captured, not run");

/** A database handle that records each statement it is handed (placeholders $1..$n) and answers `answer()`. */
function capturingDb(answer: () => Promise<unknown>): { db: DbHandle; statements: Captured[] } {
  const statements: Captured[] = [];
  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push({ text: strings.reduce((acc, s, i) => (i === 0 ? s : `${acc}$${i}${s}`), ""), values });
    return answer();
  }) as unknown as DbHandle;
  return { db, statements };
}

const squash = (s: string): string => s.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
const list = (s: string): string[] => s.split(",").map((x) => x.trim());

// ── the regime store's upsert ────────────────────────────────────────────────

interface UpsertLists {
  insert: string[];
  select: string[];
  recordTypes: string[];
  set: string[];
  guardOld: string[];
  guardNew: string[];
}

function upsertLists(statement: string): UpsertLists {
  const m =
    /^INSERT INTO regime_snapshots \(([^)]*)\) SELECT (.*?) FROM jsonb_to_recordset\(\$1::text::jsonb\) AS x\(([^)]*)\) ON CONFLICT \(date\) DO UPDATE SET (.*?) WHERE \(([^)]*)\) IS DISTINCT FROM \(([^)]*)\)$/.exec(
      squash(statement),
    );
  if (!m) throw new Error(`not the regime upsert shape: ${squash(statement).slice(0, 200)}`);
  return { insert: list(m[1]!), select: list(m[2]!), recordTypes: list(m[3]!), set: list(m[4]!), guardOld: list(m[5]!), guardNew: list(m[6]!) };
}

/** Every way the upsert's lists differ from the column table, or [] when they agree. */
function upsertProblems(l: UpsertLists, columns: readonly SnapshotColumn[] = SNAPSHOT_COLUMNS): string[] {
  const nonKey = columns.filter((c) => c.column !== "date");
  const expected: Record<keyof UpsertLists, string[]> = {
    insert: columns.map((c) => c.column),
    select: columns.map((c) => c.column),
    recordTypes: columns.map((c) => `${c.column} ${c.sqlType}`),
    set: nonKey.map((c) => `${c.column} = EXCLUDED.${c.column}`),
    guardOld: nonKey.map((c) => `regime_snapshots.${c.column}`),
    guardNew: nonKey.map((c) => `EXCLUDED.${c.column}`),
  };
  const out: string[] = [];
  for (const k of Object.keys(expected) as (keyof UpsertLists)[]) {
    if (JSON.stringify(l[k]) !== JSON.stringify(expected[k])) out.push(`${k}: ${JSON.stringify(l[k])} is not ${JSON.stringify(expected[k])}`);
  }
  return out;
}

async function captureUpsert(rows: RegimeSnapshotRow[]): Promise<Captured> {
  const { db, statements } = capturingDb(async () => []);
  await saveRegimeSnapshots(rows, db);
  expect(statements.length).toBe(1);
  return statements[0]!;
}

describe("the regime store's upsert statement is the column table (literal SQL, test-guarded)", () => {
  test("its INSERT, SELECT, record type, SET and both IS DISTINCT FROM lists are SNAPSHOT_COLUMNS' columns, in order", async () => {
    const { text } = await captureUpsert([ASOF_ROW as unknown as RegimeSnapshotRow]);
    const lists = upsertLists(text);
    expect(lists.insert).toEqual(COLUMNS);
    expect(lists.guardNew).toEqual(NON_KEY.map((c) => `EXCLUDED.${c.column}`));
    expect(upsertProblems(lists)).toEqual([]);
  });

  test("the registered probe (built from the table) is the same statement as the literal", async () => {
    const { text } = await captureUpsert([ASOF_ROW as unknown as RegimeSnapshotRow]);
    const site = registeredSites().find((d) => d.site === "src/analytics/store/regime-store:saveRegimeSnapshots");
    expect(site?.probe?.statement).toBeDefined();
    expect(squash(site!.probe!.statement)).toBe(squash(text));
  });

  test("its documents are toDbRow's, keyed by the table's columns in order: the bytes the store sent before", async () => {
    const rows = Object.values(GOLDEN);
    const { values } = await captureUpsert(rows);
    expect(values.length).toBe(1);
    const sent = values[0] as string;
    expect(sent).toBe(`[${Object.keys(GOLDEN).map((k) => FROZEN[k]!.toDbRow).join(",")}]`);
    const [asof, history, sparse] = JSON.parse(sent) as Record<string, unknown>[];
    expect(Object.keys(asof!)).toEqual(COLUMNS);
    expect(Object.keys(history!)).toEqual(COLUMNS);
    // A label the row does not carry is read as absent, as before (NULL in the table either way).
    expect(Object.keys(sparse!)).toEqual(COLUMNS.filter((c) => c !== "factor_regime"));
  });

  describe("red control: a planted statement that drifts from the table is named", () => {
    test("a column dropped from the no-op guard", async () => {
      const { text } = await captureUpsert([ASOF_ROW as unknown as RegimeSnapshotRow]);
      const planted = text.replace("EXCLUDED.correlations, EXCLUDED.extras)", "EXCLUDED.correlations)");
      expect(planted).not.toBe(text);
      const problems = upsertProblems(upsertLists(planted));
      expect(problems.length).toBe(1);
      expect(problems[0]).toStartWith("guardNew:");
    });

    test("two columns swapped in the SELECT list, and a column whose type changed", async () => {
      const { text } = await captureUpsert([ASOF_ROW as unknown as RegimeSnapshotRow]);
      const swapped = text.replace("SELECT date, composite, composite_percentile", "SELECT date, composite_percentile, composite");
      expect(upsertProblems(upsertLists(swapped)).map((p) => p.split(":")[0])).toEqual(["select"]);
      const retyped = text.replace("factor_index numeric", "factor_index text");
      expect(upsertProblems(upsertLists(retyped)).map((p) => p.split(":")[0])).toEqual(["recordTypes"]);
    });

    test("a column added to the table but not to the statement", async () => {
      const { text } = await captureUpsert([ASOF_ROW as unknown as RegimeSnapshotRow]);
      const wider = [...SNAPSHOT_COLUMNS, { ...SNAPSHOT_COLUMNS[SNAPSHOT_COLUMNS.length - 1]!, key: "planted", column: "planted" }];
      expect(upsertProblems(upsertLists(text), wider).map((p) => p.split(":")[0])).toEqual(["insert", "select", "recordTypes", "set", "guardOld", "guardNew"]);
    });
  });
});

// ── the parity sweep's regime comparison ─────────────────────────────────────

/** The `'key', expression` pairs of the first jsonb_build_object(...) after `anchor`, whitespace squashed. */
function buildObjectPairs(statement: string, anchor: string): [string, string][] {
  const from = statement.indexOf(anchor);
  if (from < 0) throw new Error(`no ${anchor} in the statement`);
  const open = statement.indexOf("jsonb_build_object(", from) + "jsonb_build_object(".length;
  const args: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = open;
  for (let i = open; ; i++) {
    const ch = statement[i];
    if (ch === undefined) throw new Error("unbalanced jsonb_build_object");
    if (ch === "'") quoted = !quoted;
    if (quoted) continue;
    if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
    else if ((ch === "," && depth === 0) || (ch === ")" && depth === 0)) {
      args.push(squash(statement.slice(start, i)));
      start = i + 1;
      if (ch === ")") break;
    }
  }
  if (args.length % 2 !== 0) throw new Error(`odd jsonb_build_object argument count ${args.length}`);
  const pairs: [string, string][] = [];
  for (let i = 0; i < args.length; i += 2) pairs.push([args[i]!.replace(/^'(.*)'$/, "$1"), args[i + 1]!]);
  return pairs;
}

// The expression each side of the parity comparison reads a column with, by its kind: a number
// rounded to 1e-9, a label or text as is, a nullable blob with null for absent, and a blob with
// an empty value as that value for null or absent (the defaults rowToSnapshot serves).
function ledgerExpression(c: SnapshotColumn): string {
  const cell = `d.doc -> '${c.key}'`;
  if (c.kind === "number") return `to_jsonb(floor((d.doc ->> '${c.key}')::float8 * 1e9 + 0.5) / 1e9)`;
  if (c.kind === "label" || c.kind === "text") return cell;
  if (c.empty === null) return `coalesce(${cell}, 'null'::jsonb)`;
  return `coalesce(nullif(${cell}, 'null'::jsonb), '${JSON.stringify(c.empty)}'::jsonb)`;
}

function legacyExpression(c: SnapshotColumn): string {
  const cell = `rs.${c.column}`;
  if (c.kind === "number") return `to_jsonb(floor(${cell}::float8 * 1e9 + 0.5) / 1e9)`;
  if (c.kind === "label" || c.kind === "text") return `to_jsonb(${cell})`;
  if (c.empty === null) return `coalesce(${cell}, 'null'::jsonb)`;
  return `coalesce(nullif(${cell}, 'null'::jsonb), '${JSON.stringify(c.empty)}'::jsonb)`;
}

/** Every way one side's jsonb_build_object differs from the table, or [] when it agrees. */
function parityProblems(pairs: [string, string][], expression: (c: SnapshotColumn) => string): string[] {
  const out: string[] = [];
  const got = new Map(pairs);
  if (got.size !== pairs.length) out.push(`a key is listed twice: ${pairs.map(([k]) => k).join(", ")}`);
  const expectedKeys = NON_KEY.map((c) => c.column).sort();
  const keys = [...got.keys()].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) out.push(`keys ${keys.join(", ")} are not the table's ${expectedKeys.join(", ")}`);
  for (const c of NON_KEY) {
    const e = got.get(c.column);
    if (e !== undefined && e !== expression(c)) out.push(`${c.column}: ${e} is not ${expression(c)}`);
  }
  return out;
}

async function captureParity(): Promise<string> {
  const { db, statements } = capturingDb(async () => {
    throw STOP;
  });
  await expect(checkRegimeSnapshotsParity(db)).rejects.toBe(STOP);
  expect(statements.length).toBe(1);
  return statements[0]!.text;
}

describe("the parity sweep's regime comparison reads the column table's columns (literal SQL, test-guarded)", () => {
  test("the ledger side's jsonb_build_object has one key per non-date column, each read from the row's key by its kind", async () => {
    const pairs = buildObjectPairs(await captureParity(), "ledger_rows AS (");
    expect(pairs.length).toBe(NON_KEY.length);
    expect(parityProblems(pairs, ledgerExpression)).toEqual([]);
  });

  test("the legacy side's jsonb_build_object has the same keys, each read from its column by its kind", async () => {
    const text = await captureParity();
    const pairs = buildObjectPairs(text, "legacy AS (");
    expect(pairs.length).toBe(NON_KEY.length);
    expect(parityProblems(pairs, legacyExpression)).toEqual([]);
    // Both sides build the same key list, so a row is compared field for field.
    expect(pairs.map(([k]) => k)).toEqual(buildObjectPairs(text, "ledger_rows AS (").map(([k]) => k));
    // The date is the join key on both sides.
    expect(squash(text)).toContain("e.elem ->> 'date' AS date");
    expect(squash(text)).toContain("SELECT rs.date::text AS date, jsonb_build_object(");
  });

  test("red control: a misspelled row key, a dropped key and an unrounded number are named", async () => {
    const text = await captureParity();
    const misspelled = text.replace("d.doc -> 'macroRegime'", "d.doc -> 'macro_regime'");
    expect(parityProblems(buildObjectPairs(misspelled, "ledger_rows AS ("), ledgerExpression)).toEqual([
      "macro_regime: d.doc -> 'macro_regime' is not d.doc -> 'macroRegime'",
    ]);
    const dropped = text.replace("'extras', coalesce(rs.extras, 'null'::jsonb),", "");
    expect(dropped).not.toBe(text);
    expect(parityProblems(buildObjectPairs(dropped, "legacy AS ("), legacyExpression)).toHaveLength(1);
    const unrounded = text.replace("to_jsonb(floor(rs.factor_index::float8 * 1e9 + 0.5) / 1e9)", "to_jsonb(rs.factor_index)");
    expect(parityProblems(buildObjectPairs(unrounded, "legacy AS ("), legacyExpression).map((p) => p.split(":")[0])).toEqual(["factor_index"]);
  });
});

// ── the row mappers ─────────────────────────────────────────────────────────

describe("the row mappers write the bytes they wrote before the column table", () => {
  for (const [name, row] of Object.entries(GOLDEN)) {
    test(`${name}: ledgerRowToSnapshot, toDbRow and parseSnapshots`, () => {
      expect(JSON.stringify(ledgerRowToSnapshot(row))).toBe(FROZEN[name]!.ledger);
      expect(JSON.stringify(toDbRow(row))).toBe(FROZEN[name]!.toDbRow);
      expect(JSON.stringify(parseSnapshots({ snapshots: [row] }))).toBe(FROZEN[name]!.parsed);
    });
  }

  test("key order: toDbRow writes the table's columns, ledgerRowToSnapshot its keys, parseSnapshots its keys less the unsent builder-free ones", () => {
    expect(Object.keys(toDbRow(GOLDEN.ASOF_ROW!))).toEqual(COLUMNS);
    expect(Object.keys(toDbRow(GOLDEN.SPARSE_ROW!))).toEqual(COLUMNS);
    expect(Object.keys(ledgerRowToSnapshot(GOLDEN.ASOF_ROW!))).toEqual(KEYS);
    const parsed = parseSnapshots({ snapshots: [HISTORY_ROW] }) as unknown as Record<string, unknown>[];
    expect(Object.keys(parsed[0]!)).toEqual(SNAPSHOT_COLUMNS.filter((c) => c.builderEmits).map((c) => c.key));
  });

  test("ledgerRowToSnapshot is rowToSnapshot of the row as the table holds it: the ledger and compatibility read modes serve the same DTO", async () => {
    const rows = [GOLDEN.ASOF_ROW!, GOLDEN.HISTORY_ROW!];
    await saveRegimeSnapshots(rows);
    const stored = await sql`SELECT * FROM regime_snapshots ORDER BY date DESC`;
    expect(stored.length).toBe(2);
    const fromTable = stored.map(rowToSnapshot);
    // jsonb reorders object keys, so this is deep equality, not bytes.
    expect(fromTable).toEqual([ledgerRowToSnapshot(GOLDEN.ASOF_ROW!), ledgerRowToSnapshot(GOLDEN.HISTORY_ROW!)]);
  });

  test("the eq-snapshot DTO the Playwright stub serves is byte for byte what it was", async () => {
    const snap = (await loadJsonGz("regime-eq-snapshot.json.gz")) as EqSnapshot;
    const bytes = JSON.stringify(mapEqSnapshotToDto(snap));
    expect(bytes.length).toBeGreaterThan(1_000_000);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(FROZEN_EQ_DTO_SHA256);
  });
});
