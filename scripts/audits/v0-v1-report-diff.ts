#!/usr/bin/env bun
// v0 -> v1 REPORT PARITY DIFF HARNESS
// ===================================
// Deliverable B of the v0->v1 mathematical parity audit.
//
// Loads a v0 production artifact and its v1 counterpart, aligns records by
// date/key, and emits per-field statistics: count compared, count differing,
// max absolute diff, max relative diff, worst-offending key, and first/last
// differing key. Handles .gz, CSV, and arbitrarily nested JSON.
//
// This is deliberately generic: nested JSON is flattened to leaf paths, and
// arrays of objects are keyed by their identity field (date / id / name)
// rather than by position, so a one-row insertion on one side does not
// cascade into a spurious "everything differs" result.
//
// Usage:
//   bun run scripts/audits/v0-v1-report-diff.ts \
//     --v0 /drive2/home/lucas/robotmoney/robotmoney-site \
//     [--pair <name>] [--json out.json] [--tsv out.tsv] [--top N] [--quiet]
//
//   --v0     root of the v0 (robotmoney-site) checkout. REQUIRED. Read-only.
//   --pair   only run the named pair(s); repeatable. Default: all.
//   --json   also write the full machine-readable result set here.
//   --top    how many worst fields to print per artifact (default 25).
//
// Exit code is always 0: this is a measurement tool, not a gate. Read the
// verdict lines.

import { gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Tolerance bands the audit reports against.
// ---------------------------------------------------------------------------
const TOLERANCES = [0, 1e-12, 1e-9, 1e-6, 1e-3] as const;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function readTextMaybeGz(path: string): string {
  const buf = readFileSync(path);
  if (path.endsWith(".gz")) return gunzipSync(buf).toString("utf8");
  return buf.toString("utf8");
}

function readJsonMaybeGz(path: string): unknown {
  return JSON.parse(readTextMaybeGz(path));
}

/** Minimal CSV split. These artifacts contain no quoted commas; assert that. */
function splitCsvLine(line: string): string[] {
  if (line.includes('"')) {
    throw new Error(`quoted CSV field encountered, parser too naive: ${line.slice(0, 120)}`);
  }
  return line.split(",");
}

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split("\n");
  const header = splitCsvLine(lines[0]);
  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    rows.push(splitCsvLine(line));
  }
  return { header, rows };
}

// ---------------------------------------------------------------------------
// Flattening: nested JSON / CSV -> Map<recordKey, Map<fieldPath, leaf>>
//
// recordKey is the aligning identity (usually a date). fieldPath is the
// structural path with the identity segment removed, so the same field across
// 3000 dates aggregates into one row of statistics.
// ---------------------------------------------------------------------------

type Leaf = number | string | boolean | null;
/** field path -> value */
type Record_ = Map<string, Leaf>;
/** record key -> fields */
type Table = Map<string, Record_>;

const IDENTITY_FIELDS = ["date", "id", "key", "name", "ts", "timestamp"];

function identityOf(o: Record<string, unknown>): string | null {
  for (const f of IDENTITY_FIELDS) {
    const v = o[f];
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Walk `node`, emitting (recordKey, fieldPath, leaf) triples.
 *
 * `recordKey` starts as ROOT_KEY and is replaced the first time we descend
 * through an array of identified objects (e.g. history[] keyed by date). Nested
 * identified arrays below that point get their identity folded into the field
 * path instead, so we never lose data but also never re-key.
 */
const ROOT_KEY = "__root__";

function flatten(node: unknown, out: Table): void {
  walk(node, "", ROOT_KEY, out);
}

function emit(out: Table, key: string, path: string, value: Leaf): void {
  let rec = out.get(key);
  if (!rec) {
    rec = new Map();
    out.set(key, rec);
  }
  // Collisions would silently drop data; make them visible.
  if (rec.has(path)) {
    let n = 2;
    while (rec.has(`${path}#${n}`)) n++;
    rec.set(`${path}#${n}`, value);
    return;
  }
  rec.set(path, value);
}

function walk(node: unknown, path: string, key: string, out: Table): void {
  if (node === null || typeof node === "number" || typeof node === "string" || typeof node === "boolean") {
    emit(out, key, path || "(scalar)", node as Leaf);
    return;
  }
  if (Array.isArray(node)) {
    // Array of identified objects -> key each element.
    const identified = node.length > 0 && node.every((e) => isPlainObject(e) && identityOf(e) !== null);
    if (identified) {
      for (const el of node as Record<string, unknown>[]) {
        const id = identityOf(el)!;
        if (key === ROOT_KEY) {
          // This array becomes the record axis.
          for (const [k, v] of Object.entries(el)) {
            walk(v, path ? `${path}.${k}` : k, id, out);
          }
        } else {
          // Already keyed higher up: fold identity into the field path.
          for (const [k, v] of Object.entries(el)) {
            walk(v, `${path}[${id}].${k}`, key, out);
          }
        }
      }
      return;
    }
    // Array of scalars / unidentified objects -> positional.
    for (let i = 0; i < node.length; i++) {
      walk(node[i], `${path}[${i}]`, key, out);
    }
    // Record length so a length mismatch is itself a comparable field.
    emit(out, key, `${path}.__length__`, node.length);
    return;
  }
  if (isPlainObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      walk(v, path ? `${path}.${k}` : k, key, out);
    }
    return;
  }
  // undefined / function: ignore.
}

/** CSV -> Table keyed by the named column(s). */
function csvToTable(text: string, keyCols: string[], opts: { dropCols?: string[] } = {}): Table {
  const { header, rows } = parseCsv(text);
  const keyIdx = keyCols.map((c) => {
    const i = header.indexOf(c);
    if (i < 0) throw new Error(`key column ${c} not in header ${header.join(",")}`);
    return i;
  });
  const drop = new Set(opts.dropCols ?? []);
  const out: Table = new Map();
  for (const row of rows) {
    const key = keyIdx.map((i) => row[i]).join("|");
    let rec = out.get(key);
    if (!rec) {
      rec = new Map();
      out.set(key, rec);
    }
    for (let c = 0; c < header.length; c++) {
      const col = header[c];
      if (keyCols.includes(col) || drop.has(col)) continue;
      const raw = row[c];
      if (raw === undefined || raw === "") {
        rec.set(col, null);
        continue;
      }
      const num = Number(raw);
      rec.set(col, raw !== "" && Number.isFinite(num) ? num : raw);
    }
  }
  return out;
}

/**
 * Long-format CSV (date,indicator,value) -> Table keyed by date, one field per
 * indicator. This turns a tall file into the same wide shape as everything
 * else, so per-indicator statistics fall out of the generic comparator.
 */
function longCsvToTable(text: string, keyCol: string, fieldCol: string, valueCol: string): Table {
  const { header, rows } = parseCsv(text);
  const ki = header.indexOf(keyCol);
  const fi = header.indexOf(fieldCol);
  const vi = header.indexOf(valueCol);
  if (ki < 0 || fi < 0 || vi < 0) throw new Error(`long CSV columns not found in ${header.join(",")}`);
  const out: Table = new Map();
  for (const row of rows) {
    const key = row[ki];
    if (!key) continue;
    let rec = out.get(key);
    if (!rec) {
      rec = new Map();
      out.set(key, rec);
    }
    const num = Number(row[vi]);
    rec.set(row[fi], Number.isFinite(num) ? num : row[vi]);
  }
  return out;
}

function jsonToTable(v: unknown): Table {
  const out: Table = new Map();
  flatten(v, out);
  return out;
}

/** Extract a subtree by dotted path before flattening. */
function subtree(v: unknown, path: string): unknown {
  let cur: unknown = v;
  for (const seg of path.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Columnar JSON (parallel arrays + a dateAxis) -> Table keyed by date.
 * This is the shape of regime-compute-reference.json.gz, which is the only
 * v1 artifact carrying a FULL-HISTORY recomputation from v1's own pipeline.
 * `rename` maps v1 column names onto the v0 CSV's column names so the two
 * become field-comparable.
 */
function columnarToTable(
  v: unknown,
  axisKey: string,
  rename: Record<string, string>,
): Table {
  const o = v as Record<string, unknown>;
  const axis = o[axisKey] as string[];
  if (!Array.isArray(axis)) throw new Error(`columnar: ${axisKey} is not an array`);
  const out: Table = new Map();
  for (let i = 0; i < axis.length; i++) out.set(axis[i], new Map());
  for (const [src, dst] of Object.entries(rename)) {
    const col = o[src];
    if (!Array.isArray(col)) continue;
    for (let i = 0; i < axis.length; i++) {
      const val = col[i];
      if (val === undefined || val === null) continue;
      out.get(axis[i])!.set(dst, val as Leaf);
    }
  }
  return out;
}

/** Wide CSV -> Table keyed by date, renaming columns onto a target vocabulary. */
function renamedCsvToTable(text: string, keyCol: string, rename: Record<string, string>): Table {
  const t = csvToTable(text, [keyCol]);
  const out: Table = new Map();
  for (const [k, rec] of t) {
    const nr: Record_ = new Map();
    for (const [f, v] of rec) {
      const dst = rename[f];
      if (dst) nr.set(dst, v);
    }
    out.set(k, nr);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

interface FieldStat {
  field: string;
  kind: "numeric" | "categorical" | "mixed";
  compared: number;
  differing: number;
  onlyV0: number;
  onlyV1: number;
  maxAbs: number;
  maxAbsKey: string | null;
  maxRel: number;
  maxRelKey: string | null;
  firstDiffKey: string | null;
  lastDiffKey: string | null;
  /** tolerance -> passes? (all compared values within tol) */
  passAt: Record<string, boolean>;
  /** year -> {compared, differing, maxAbs} */
  byEra: Record<string, { compared: number; differing: number; maxAbs: number }>;
  sample: { key: string; v0: Leaf; v1: Leaf } | null;
}

interface PairResult {
  name: string;
  v0Path: string;
  v1Path: string;
  ok: boolean;
  error?: string;
  provenance: Provenance;
  keys: {
    v0: number;
    v1: number;
    intersection: number;
    onlyV0: number;
    onlyV1: number;
    v0Range: [string, string] | null;
    v1Range: [string, string] | null;
    intersectionRange: [string, string] | null;
    /** fraction of v0's records covered by the intersection */
    v0Coverage: number;
  };
  fields: FieldStat[];
  unmappedV0Fields: string[];
  unmappedV1Fields: string[];
  ignoredFields: string[];
}

function eraOf(key: string): string {
  const m = /^(\d{4})-\d{2}-\d{2}/.exec(key);
  if (m) return m[1];
  return "(non-date)";
}

function relDiff(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return 0;
  return Math.abs(a - b) / denom;
}

function compareTables(
  v0: Table,
  v1: Table,
  opts: { ignoreFields?: RegExp[] } = {},
): {
  fields: FieldStat[];
  keys: PairResult["keys"];
  unmappedV0Fields: string[];
  unmappedV1Fields: string[];
  ignoredFields: string[];
} {
  const k0 = [...v0.keys()].sort();
  const k1 = [...v1.keys()].sort();
  const s1 = new Set(k1);
  const inter = k0.filter((k) => s1.has(k));
  const interSorted = [...inter].sort();

  const dateKeys = (ks: string[]) => ks.filter((k) => /^\d{4}-\d{2}-\d{2}/.test(k)).sort();
  const rangeOf = (ks: string[]): [string, string] | null => {
    const d = dateKeys(ks);
    return d.length ? [d[0], d[d.length - 1]] : null;
  };

  // Field universes.
  const f0 = new Set<string>();
  const f1 = new Set<string>();
  for (const rec of v0.values()) for (const f of rec.keys()) f0.add(f);
  for (const rec of v1.values()) for (const f of rec.keys()) f1.add(f);

  const ignore = opts.ignoreFields ?? [];
  const ignored: string[] = [];
  const isIgnored = (f: string) => {
    if (ignore.some((re) => re.test(f))) {
      ignored.push(f);
      return true;
    }
    return false;
  };

  const common = [...f0].filter((f) => f1.has(f) && !isIgnored(f)).sort();
  const unmappedV0 = [...f0].filter((f) => !f1.has(f)).sort();
  const unmappedV1 = [...f1].filter((f) => !f0.has(f)).sort();

  const stats: FieldStat[] = [];
  for (const field of common) {
    const st: FieldStat = {
      field,
      kind: "numeric",
      compared: 0,
      differing: 0,
      onlyV0: 0,
      onlyV1: 0,
      maxAbs: 0,
      maxAbsKey: null,
      maxRel: 0,
      maxRelKey: null,
      firstDiffKey: null,
      lastDiffKey: null,
      passAt: {},
      byEra: {},
      sample: null,
    };
    let sawNumeric = false;
    let sawCategorical = false;

    for (const key of interSorted) {
      const a = v0.get(key)!.get(field);
      const b = v1.get(key)!.get(field);
      const hasA = a !== undefined;
      const hasB = b !== undefined;
      if (!hasA && !hasB) continue;
      if (hasA && !hasB) {
        st.onlyV0++;
        continue;
      }
      if (!hasA && hasB) {
        st.onlyV1++;
        continue;
      }
      st.compared++;
      const era = eraOf(key);
      const e = (st.byEra[era] ??= { compared: 0, differing: 0, maxAbs: 0 });
      e.compared++;

      let differs = false;
      let abs = 0;
      if (typeof a === "number" && typeof b === "number") {
        sawNumeric = true;
        abs = Math.abs(a - b);
        // NaN handling: NaN vs NaN counts as equal, NaN vs number as differing.
        if (Number.isNaN(a) && Number.isNaN(b)) {
          abs = 0;
        } else if (Number.isNaN(a) !== Number.isNaN(b)) {
          differs = true;
          abs = Infinity;
        } else if (abs > 0) {
          differs = true;
        }
        if (abs > st.maxAbs) {
          st.maxAbs = abs;
          st.maxAbsKey = key;
        }
        const rel = Number.isFinite(abs) ? relDiff(a, b) : Infinity;
        if (rel > st.maxRel) {
          st.maxRel = rel;
          st.maxRelKey = key;
        }
        if (abs > e.maxAbs) e.maxAbs = abs;
      } else {
        sawCategorical = true;
        if (a !== b) {
          differs = true;
          st.maxAbs = Infinity;
          st.maxRel = Infinity;
          if (st.maxAbsKey === null) st.maxAbsKey = key;
        }
      }

      if (differs) {
        st.differing++;
        e.differing++;
        if (st.firstDiffKey === null) st.firstDiffKey = key;
        st.lastDiffKey = key;
        if (st.sample === null) st.sample = { key, v0: a as Leaf, v1: b as Leaf };
      }
    }

    st.kind = sawNumeric && sawCategorical ? "mixed" : sawCategorical ? "categorical" : "numeric";
    for (const tol of TOLERANCES) {
      st.passAt[String(tol)] =
        tol === 0 ? st.differing === 0 : Number.isFinite(st.maxAbs) && st.maxRel <= tol;
    }
    stats.push(st);
  }

  return {
    fields: stats,
    keys: {
      v0: k0.length,
      v1: k1.length,
      intersection: inter.length,
      onlyV0: k0.length - inter.length,
      onlyV1: k1.length - inter.length,
      v0Range: rangeOf(k0),
      v1Range: rangeOf(k1),
      intersectionRange: rangeOf(interSorted),
      v0Coverage: k0.length ? inter.length / k0.length : 0,
    },
    unmappedV0Fields: unmappedV0,
    unmappedV1Fields: unmappedV1,
    ignoredFields: [...new Set(ignored)],
  };
}

// ---------------------------------------------------------------------------
// Provenance
//
// A v1 fixture is only a valid v0 baseline if it can be shown to derive from
// v0. PR #464 established that in-repo fixtures had been silently regenerated
// from v1's own pipeline while still being described as independent v0
// references. So every pair carries an explicit provenance verdict.
// ---------------------------------------------------------------------------

type ProvenanceVerdict = "v0-derived" | "v1-derived" | "unknown";
interface Provenance {
  verdict: ProvenanceVerdict;
  note: string;
  /** if the artifact carries a meta.source string, it is captured verbatim */
  metaSource?: string;
}

function probeMetaSource(path: string): string | undefined {
  try {
    const v = readJsonMaybeGz(path) as Record<string, unknown>;
    const meta = v?.meta as Record<string, unknown> | undefined;
    const s = meta?.source ?? (v as Record<string, unknown>)?.source;
    return typeof s === "string" ? s : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Pair specifications
// ---------------------------------------------------------------------------

interface PairSpec {
  name: string;
  v0: string;
  v1: string;
  load0: (path: string) => Table;
  load1: (path: string) => Table;
  provenance: Provenance;
  /** fields excluded from the numeric verdict (timestamps, prose, URLs) */
  ignoreFields?: RegExp[];
  note?: string;
}

/** Non-numeric / regeneration-timestamp noise that must not pollute the verdict. */
const PROSE_FIELDS = [
  /(^|\.)generated_at$/,
  /(^|\.)description$/,
  /(^|\.)interpretation$/,
  /(^|\.)derivation$/,
  /(^|\.)source_url$/,
  /(^|\.)name$/,
  /(^|\.)spec$/,
  /(^|\.)meta\./,
];

function buildPairs(v0Root: string, v1Root: string): PairSpec[] {
  const p0 = (r: string) => join(v0Root, r);
  const p1 = (r: string) => join(v1Root, r);
  const fx = (n: string) => p1(join("backend/tests/fixtures/regime", n));

  const jsonT = (path: string) => jsonToTable(readJsonMaybeGz(path));

  return [
    {
      name: "raw-indicator-history",
      v0: p0("data/regime/raw-indicator-history.csv"),
      v1: fx("raw-indicator-history.csv.gz"),
      load0: (p) => longCsvToTable(readTextMaybeGz(p), "date", "indicator", "value"),
      load1: (p) => longCsvToTable(readTextMaybeGz(p), "date", "indicator", "value"),
      provenance: {
        verdict: "v0-derived",
        note:
          "INPUT floor, not an output. v0's rows are a strict subset of v1's. " +
          "Regenerated by PR #444 to add BTC_MVRV and extend the tail; the shared " +
          "portion is still recognisably the v0 vendored seed.",
      },
    },
    {
      name: "regime-history",
      v0: p0("data/regime/regime-history.csv"),
      v1: fx("regime-history.csv.gz"),
      load0: (p) => csvToTable(readTextMaybeGz(p), ["date"]),
      load1: (p) => csvToTable(readTextMaybeGz(p), ["date"]),
      provenance: {
        verdict: "v1-derived",
        note:
          "Regenerated by backend/scripts/regime-goldens-regenerate.ts in PR #444 " +
          "from v1's own TS pipeline over the BTC_MVRV-inclusive floor.",
      },
    },
    {
      name: "regime-versions",
      v0: p0("data/regime/regime-versions.json"),
      v1: fx("regime-versions.json"),
      load0: jsonT,
      load1: jsonT,
      provenance: { verdict: "v0-derived", note: "Static config, not recomputed." },
    },
    {
      name: "regime-snapshot",
      v0: p0("public/data/regime-snapshot.json"),
      v1: fx("regime-snapshot.json.gz"),
      load0: jsonT,
      load1: jsonT,
      provenance: {
        verdict: "v1-derived",
        note: "Regenerated by regime-goldens-regenerate.ts in PR #444.",
      },
      ignoreFields: PROSE_FIELDS,
    },
    {
      name: "channel-divergence",
      v0: p0("public/data/channel-divergence.json"),
      v1: fx("channel-divergence.json.gz"),
      load0: jsonT,
      load1: jsonT,
      provenance: {
        verdict: "v0-derived",
        note:
          "Untouched since the original v0 import commit df5ee09; NOT rewritten by " +
          "PR #444's regeneration script.",
      },
      ignoreFields: PROSE_FIELDS,
    },
    {
      name: "late-cycle-signals",
      v0: p0("public/data/late-cycle-signals.json"),
      v1: fx("late-cycle-signals.json.gz"),
      load0: jsonT,
      load1: jsonT,
      provenance: {
        verdict: "v0-derived",
        note: "Untouched since original v0 import commit df5ee09.",
      },
      ignoreFields: PROSE_FIELDS,
    },
    {
      name: "regime-eq-snapshot",
      v0: p0("public/data/regime-eq-snapshot.json"),
      v1: fx("regime-eq-snapshot.json.gz"),
      load0: jsonT,
      load1: jsonT,
      provenance: {
        verdict: "v0-derived",
        note: "Untouched since import commit 91b9fbc; not rewritten by PR #444.",
      },
      ignoreFields: PROSE_FIELDS,
    },

    // ── The single most important pair in this audit ────────────────────────
    // regime-compute-reference.json.gz is the ONLY v1 artifact that carries a
    // full-history recomputation straight out of v1's own pipeline. Diffing it
    // against v0's committed regime-history.csv is the true "does v1's math
    // reproduce v0's math over every period" test. Everything else either
    // preserves v0 bytes or only covers the asof row.
    {
      name: "compute-reference-vs-v0-history",
      v0: p0("data/regime/regime-history.csv"),
      v1: fx("regime-compute-reference.json.gz"),
      load0: (p) =>
        renamedCsvToTable(readTextMaybeGz(p), "date", {
          composite: "composite",
          composite_percentile: "compositePercentile",
          macro_index: "macroIndex",
          onchain_index: "onchainIndex",
          macro_percentile: "macroPercentile",
          onchain_percentile: "onchainPercentile",
          regime: "regime",
          macro_regime: "macroRegime",
          onchain_regime: "onchainRegime",
        }),
      load1: (p) =>
        columnarToTable(readJsonMaybeGz(p), "dateAxis", {
          composite: "composite",
          compositePercentile: "compositePercentile",
          macroIndex: "macroIndex",
          onchainIndex: "onchainIndex",
          macroPercentile: "macroPercentile",
          onchainPercentile: "onchainPercentile",
          regime: "regime",
          macroRegime: "macroRegime",
          onchainRegime: "onchainRegime",
        }),
      provenance: {
        verdict: "v1-derived",
        note:
          "meta.source declares in-repo regeneration. Compared against v0's " +
          "committed regime-history.csv, which IS a genuine v0 production output.",
      },
      note: "v0 CSV values are stored at 6dp, so a floor of ~5e-7 is quantisation, not divergence.",
    },

    // The snapshot's embedded history[] array, isolated and compared against
    // v0's committed per-date CSV.
    {
      name: "snapshot-history-vs-v0-history",
      v0: p0("data/regime/regime-history.csv"),
      v1: fx("regime-snapshot.json.gz"),
      load0: (p) =>
        renamedCsvToTable(readTextMaybeGz(p), "date", {
          composite: "composite",
          macro_index: "macro",
          onchain_index: "onchain",
          regime: "regime",
          macro_regime: "macro_regime",
          onchain_regime: "onchain_regime",
        }),
      load1: (p) => jsonToTable(subtree(readJsonMaybeGz(p), "history")),
      provenance: {
        verdict: "v0-derived",
        note:
          "PRESERVED verbatim by regime-goldens-regenerate.ts (spread as part of " +
          "`{...oldSnap}`; `history` is listed among the fields it deliberately " +
          "does NOT recompute). So this is v0 lineage — but it is a COPY, not a " +
          "v1 computation, and it is stale w.r.t. the rest of its own file.",
      },
      ignoreFields: [/(^|\.)date$/],
    },

    {
      name: "backtest-correlations-reference",
      v0: p0("public/data/regime-snapshot.json"),
      v1: fx("regime-backtest-correlations-reference.json.gz"),
      load0: (p) => {
        const v = readJsonMaybeGz(p) as Record<string, unknown>;
        return jsonToTable({ backtest: v.backtest, correlations: v.correlations });
      },
      load1: (p) => {
        const v = readJsonMaybeGz(p) as Record<string, unknown>;
        return jsonToTable({ backtest: v.backtest, correlations: v.correlations });
      },
      provenance: {
        verdict: "v1-derived",
        note: "meta.source declares in-repo regeneration (PR #444).",
      },
      ignoreFields: PROSE_FIELDS,
    },

    // v0 public artifacts that v1 still ships to the browser.
    {
      name: "regime-eq-comparison",
      v0: p0("public/data/regime-eq-comparison.json"),
      v1: p1("frontend/public/data/regime-eq-comparison.json"),
      load0: jsonT,
      load1: jsonT,
      provenance: {
        verdict: "unknown",
        note: "Served statically by v1's frontend; no v1 generator found in-repo.",
      },
      ignoreFields: PROSE_FIELDS,
    },
    {
      name: "weighting-comparison",
      v0: p0("public/data/weighting-comparison.json"),
      v1: p1("frontend/public/data/weighting-comparison.json"),
      load0: jsonT,
      load1: jsonT,
      provenance: {
        verdict: "unknown",
        note: "Served statically by v1's frontend; no v1 generator found in-repo.",
      },
      ignoreFields: PROSE_FIELDS,
    },
  ];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function runPair(spec: PairSpec): PairResult {
  const base: PairResult = {
    name: spec.name,
    v0Path: spec.v0,
    v1Path: spec.v1,
    ok: false,
    provenance: { ...spec.provenance, metaSource: probeMetaSource(spec.v1) },
    keys: {
      v0: 0,
      v1: 0,
      intersection: 0,
      onlyV0: 0,
      onlyV1: 0,
      v0Range: null,
      v1Range: null,
      intersectionRange: null,
      v0Coverage: 0,
    },
    fields: [],
    unmappedV0Fields: [],
    unmappedV1Fields: [],
    ignoredFields: [],
  };
  if (!existsSync(spec.v0)) return { ...base, error: `v0 artifact missing: ${spec.v0}` };
  if (!existsSync(spec.v1)) return { ...base, error: `v1 artifact missing: ${spec.v1}` };
  try {
    const t0 = spec.load0(spec.v0);
    const t1 = spec.load1(spec.v1);
    const cmp = compareTables(t0, t1, { ignoreFields: spec.ignoreFields });
    return { ...base, ok: true, ...cmp };
  } catch (err) {
    return { ...base, error: String((err as Error)?.message ?? err) };
  }
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? "Inf" : "-Inf";
  if (n === 0) return "0";
  if (Math.abs(n) < 1e-4 || Math.abs(n) >= 1e6) return n.toExponential(3);
  return String(Number(n.toPrecision(6)));
}

function bandOf(st: FieldStat): string {
  if (st.differing === 0) return "EXACT";
  for (const tol of TOLERANCES) {
    if (tol === 0) continue;
    if (st.passAt[String(tol)]) return `<=${tol}`;
  }
  return "FAIL";
}

function main(): void {
  const argv = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const getAll = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) if (argv[i] === flag) out.push(argv[i + 1]);
    return out;
  };

  const v0Root = getArg("--v0");
  if (!v0Root) {
    console.error(
      "ERROR: --v0 <path-to-robotmoney-site-checkout> is required.\n" +
        "The v0 checkout is READ-ONLY; this harness never writes to it.",
    );
    process.exit(2);
  }
  const v1Root = getArg("--v1") ?? join(import.meta.dir, "..", "..");
  const only = new Set(getAll("--pair"));
  const top = Number(getArg("--top") ?? 25);
  const quiet = argv.includes("--quiet");
  const eras = argv.includes("--era");
  const eraTop = Number(getArg("--era-top") ?? 8);

  const specs = buildPairs(v0Root, v1Root).filter((s) => only.size === 0 || only.has(s.name));
  const results: PairResult[] = [];

  for (const spec of specs) {
    const res = runPair(spec);
    results.push(res);
    if (quiet) continue;

    console.log(`\n${"=".repeat(100)}`);
    console.log(`PAIR: ${res.name}`);
    console.log(`  v0: ${res.v0Path}`);
    console.log(`  v1: ${res.v1Path}`);
    console.log(`  provenance: ${res.provenance.verdict.toUpperCase()} — ${res.provenance.note}`);
    if (res.provenance.metaSource) console.log(`  meta.source: "${res.provenance.metaSource}"`);
    console.log("=".repeat(100));

    if (res.error) {
      console.log(`  ERROR: ${res.error}`);
      continue;
    }

    const k = res.keys;
    console.log(
      `  keys: v0=${k.v0} v1=${k.v1} intersection=${k.intersection} ` +
        `(v0 coverage ${(k.v0Coverage * 100).toFixed(2)}%) onlyV0=${k.onlyV0} onlyV1=${k.onlyV1}`,
    );
    if (k.v0Range) console.log(`  v0 range: ${k.v0Range[0]} .. ${k.v0Range[1]}`);
    if (k.v1Range) console.log(`  v1 range: ${k.v1Range[0]} .. ${k.v1Range[1]}`);
    if (k.intersectionRange)
      console.log(`  intersection: ${k.intersectionRange[0]} .. ${k.intersectionRange[1]}`);

    const nExact = res.fields.filter((f) => f.differing === 0).length;
    console.log(`  fields compared: ${res.fields.length} (exact: ${nExact}, differing: ${res.fields.length - nExact})`);
    console.log(`  unmapped v0-only fields: ${res.unmappedV0Fields.length}`);
    console.log(`  unmapped v1-only fields: ${res.unmappedV1Fields.length}`);

    const differing = res.fields
      .filter((f) => f.differing > 0)
      .sort((a, b) => (b.maxRel || 0) - (a.maxRel || 0));
    if (differing.length) {
      console.log(
        `\n  ${"field".padEnd(52)} ${"kind".padEnd(6)} ${"n".padStart(6)} ${"ndiff".padStart(6)} ` +
          `${"maxAbs".padStart(12)} ${"maxRel".padStart(11)} ${"band".padStart(8)}  worst/first/last`,
      );
      for (const f of differing.slice(0, top)) {
        console.log(
          `  ${f.field.slice(0, 52).padEnd(52)} ${f.kind.slice(0, 6).padEnd(6)} ` +
            `${String(f.compared).padStart(6)} ${String(f.differing).padStart(6)} ` +
            `${fmt(f.maxAbs).padStart(12)} ${fmt(f.maxRel).padStart(11)} ${bandOf(f).padStart(8)}  ` +
            `${f.maxRelKey ?? f.maxAbsKey ?? "-"} / ${f.firstDiffKey ?? "-"} / ${f.lastDiffKey ?? "-"}`,
        );
      }
      if (differing.length > top) console.log(`  ... and ${differing.length - top} more differing fields`);
    }

    // Per-era (per-year) breakdown, so a divergence confined to one era is
    // visible rather than averaged away across the whole history.
    if (eras) {
      const dated = differing.filter((f) => Object.keys(f.byEra).some((e) => e !== "(non-date)"));
      for (const f of dated.slice(0, eraTop)) {
        const years = Object.keys(f.byEra)
          .filter((e) => e !== "(non-date)")
          .sort();
        if (years.length <= 1) continue;
        console.log(`\n  ERA BREAKDOWN — ${f.field}`);
        console.log(`    ${"year".padEnd(8)} ${"n".padStart(6)} ${"ndiff".padStart(6)} ${"%diff".padStart(7)} ${"maxAbs".padStart(12)}`);
        for (const y of years) {
          const e = f.byEra[y];
          const pct = e.compared ? (100 * e.differing) / e.compared : 0;
          console.log(
            `    ${y.padEnd(8)} ${String(e.compared).padStart(6)} ${String(e.differing).padStart(6)} ` +
              `${pct.toFixed(1).padStart(6)}% ${fmt(e.maxAbs).padStart(12)}`,
          );
        }
      }
    }
  }

  // Roll-up.
  if (!quiet) {
    console.log(`\n${"#".repeat(100)}\nROLL-UP\n${"#".repeat(100)}`);
    console.log(
      `${"pair".padEnd(30)} ${"prov".padEnd(11)} ${"fields".padStart(7)} ${"exact".padStart(6)} ` +
        `${"<=1e-9".padStart(7)} ${"<=1e-6".padStart(7)} ${"<=1e-3".padStart(7)} ${"FAIL".padStart(6)}`,
    );
    for (const r of results) {
      if (!r.ok) {
        console.log(`${r.name.padEnd(30)} ${"-".padEnd(11)} ERROR: ${r.error}`);
        continue;
      }
      const c = { exact: 0, e9: 0, e6: 0, e3: 0, fail: 0 };
      for (const f of r.fields) {
        const b = bandOf(f);
        if (b === "EXACT") c.exact++;
        else if (b === "<=1e-9" || b === "<=1e-12") c.e9++;
        else if (b === "<=0.000001") c.e6++;
        else if (b === "<=0.001") c.e3++;
        else c.fail++;
      }
      console.log(
        `${r.name.padEnd(30)} ${r.provenance.verdict.padEnd(11)} ${String(r.fields.length).padStart(7)} ` +
          `${String(c.exact).padStart(6)} ${String(c.e9).padStart(7)} ${String(c.e6).padStart(7)} ` +
          `${String(c.e3).padStart(7)} ${String(c.fail).padStart(6)}`,
      );
    }
  }

  const jsonOut = getArg("--json");
  if (jsonOut) {
    writeFileSync(
      jsonOut,
      JSON.stringify(
        results,
        (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v),
        2,
      ),
    );
    console.log(`\nwrote ${jsonOut}`);
  }
}

main();
