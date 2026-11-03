// Issue 1514 (part "Restatement noise tolerance"): measure how far each stored
// revision of a source key moved from the version before it, and choose that
// key's D56 tolerance from the measurement by one pinned rule.
//
//   ssh rm-frontend-stage-2 'zcat ~/csv-backups/csv/<backup>/data/source_value_versions.*.csv.gz ...' \
//     | bun run backend/scripts/analytics/measure-tolerance.ts --backup <backup id> [--file <data file read>]... [--out <fixture.json>] [--command "<how the CSV was produced>"]
//
// INPUT. A source_value_versions CSV export (csv-backups, the header
// `id,acquisition_id,source_key,market_date,market_instant,value,prior_version_id,revision_kind,knowledge_time,provenance`)
// on stdin, or as a path argument. The table is append-only and each backup
// holds only the rows it added, so the whole ledger as of a backup is every
// data file of that backup and of every backup before it, concatenated: a
// repeated header line is skipped. Nothing is fetched and no database is read.
//
// WHAT A REVISION IS. A version that is not the first for its
// (source_key, market_date). Each coordinate's versions are put in
// (knowledge_time, id) order, the order the writer's own head lookup uses
// (store/source-ledger-store.ts priorDated), and each version after the first is
// compared with the one before it: |next − prior| / max(|next|, |prior|), the
// quantity withinTolerance() bounds (src/analytics/source-tolerance.ts). A
// version whose prior_version_id is not the version before it in that order is
// counted in `chain_mismatches`, a check that the order is the writer's.
//
// OUTPUT. Per key: the number of revisions and their counts in half-decade log
// bins from 1e-9 to 1e-1. Changes under 1e-9 (a relabel of an equal value, from
// before D56's 2026-09-29 amendment, is 0) count in the lowest bin; changes of
// 1e-1 or more count in `above`. Only these counts are written
// (backend/tests/fixtures/defillama-revision-distribution.json); no value of
// the source data is.
//
// THE RULE (issue 1514 Scope, the same one D56 used for the Yahoo ratios) is
// selectTolerance() below. It is pure, so backend/tests/
// analytics-source-tolerance.test.ts runs it on the committed fixture and
// checks that SOURCE_TOLERANCES holds exactly what it returns.
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

export const DEFILLAMA_KEYS = ["raw_indicator_history:DEFI_TVL", "raw_indicator_history:STABLES"] as const;

/** The rule fails when the chosen tolerance is above this (issue 1514 Scope). */
export const MAX_TOLERANCE = 1e-4;
/** A bin holding under this share of a key's revisions counts as empty. */
export const SPARSE_SHARE = 0.001;

// Half-decade edges 1e-9, 10^-8.5, 1e-8, ..., 1e-1: 17 edges, 16 bins. An even
// edge is an exact power of ten, written as a decimal literal so it is the same
// double the table uses.
export const BIN_EDGES: readonly number[] = Array.from({ length: 17 }, (_, i) => {
  const decade = Number(`1e${-9 + Math.floor(i / 2)}`);
  return i % 2 === 0 ? decade : decade * Math.sqrt(10);
});
export const BIN_COUNT = BIN_EDGES.length - 1;

export interface KeyDistribution {
  /** Every revision of the key, in the bins and in `above`. */
  revisions: number;
  /** bins[i] counts changes in [BIN_EDGES[i], BIN_EDGES[i+1]); bins[0] also holds every change under 1e-9. */
  bins: number[];
  /** Changes of 1e-1 or more. */
  above: number;
}

/** Which bin a relative change falls in: 0..BIN_COUNT-1, or BIN_COUNT for `above`. */
export function binOf(relative: number): number {
  for (let i = 1; i < BIN_EDGES.length; i++) if (relative < BIN_EDGES[i]!) return i - 1;
  return BIN_COUNT;
}

/** The relative change withinTolerance() bounds. Two zeros are no change. */
export function relativeChange(prior: number, next: number): number {
  const scale = Math.max(Math.abs(prior), Math.abs(next));
  return scale === 0 ? 0 : Math.abs(next - prior) / scale;
}

/** x rounded DOWN to one significant digit: 3.1622776601683795e-6 → 3e-6, 1e-5 → 1e-5. */
export function roundDownOneDigit(x: number): number {
  const [mantissa, exponent] = x.toExponential().split("e");
  return Number(`${mantissa![0]}e${exponent}`);
}

export interface KeySelection {
  /** Index of the bin after the noise band that ends it: empty, or under SPARSE_SHARE of the key's revisions. */
  gapBin: number;
  /** BIN_EDGES[gapBin + 1], rounded down to one significant digit. */
  relative: number;
}

export type ToleranceSelection =
  | { ok: true; relative: number; perKey: Record<string, KeySelection> }
  | { ok: false; error: string };

/**
 * One key's tolerance. The noise band is the run of bins starting at the
 * lowest bin. It ends at the first bin above the lowest that is empty or holds
 * under 0.1 percent of the key's revisions (a bin that thin is not part of the
 * band). The tolerance is that bin's upper edge, rounded down to one
 * significant digit. An empty lowest bin is a band of nothing, and the lowest
 * bin is then the gap.
 */
export function selectKeyTolerance(d: KeyDistribution): KeySelection | { error: string } {
  if (d.bins.length !== BIN_COUNT) return { error: `expected ${BIN_COUNT} bins, got ${d.bins.length}` };
  const thin = (j: number) => d.bins[j] === 0 || d.bins[j]! < SPARSE_SHARE * d.revisions;
  for (let j = d.bins[0] === 0 ? 0 : 1; j < BIN_COUNT; j++) {
    if (thin(j)) return { gapBin: j, relative: roundDownOneDigit(BIN_EDGES[j + 1]!) };
  }
  return { error: "no empty or sparse bin above the noise band below 1e-1" };
}

/**
 * The shared tolerance of `keys`: each key's value by selectKeyTolerance(), and
 * the larger of them for all. Fails when a key has no distribution or no gap,
 * or when the value is above MAX_TOLERANCE (1e-4).
 */
export function selectTolerance(
  distributions: Readonly<Record<string, KeyDistribution>>,
  keys: readonly string[] = DEFILLAMA_KEYS,
): ToleranceSelection {
  const perKey: Record<string, KeySelection> = {};
  for (const key of keys) {
    const d = distributions[key];
    if (!d) return { ok: false, error: `${key}: no distribution` };
    const s = selectKeyTolerance(d);
    if ("error" in s) return { ok: false, error: `${key}: ${s.error}` };
    perKey[key] = s;
  }
  const relative = Math.max(...Object.values(perKey).map((s) => s.relative));
  if (!(relative <= MAX_TOLERANCE)) {
    return { ok: false, error: `the rule chose ${relative}, above ${MAX_TOLERANCE}: no empty band below 1e-4, so the noise is not separable from real revisions` };
  }
  return { ok: true, relative, perKey };
}

// ── CSV → distributions ─────────────────────────────────────────────────────

/** One CSV line's fields. csv-backups quotes a field that holds a comma or quote; no field spans lines. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    if (line[i] === '"') {
      let v = "";
      i++;
      for (;;) {
        const q = line.indexOf('"', i);
        if (q === -1) throw new Error(`unterminated quoted field: ${line.slice(0, 120)}`);
        v += line.slice(i, q);
        if (line[q + 1] === '"') { v += '"'; i = q + 2; continue; }
        i = q + 1;
        break;
      }
      out.push(v);
    } else {
      const c = line.indexOf(",", i);
      out.push(line.slice(i, c === -1 ? undefined : c));
      i = c === -1 ? line.length : c;
    }
    if (i >= line.length) return out;
    i++; // the comma
    if (i === line.length) { out.push(""); return out; }
  }
}

interface Version { id: bigint; knowledgeTime: string; value: number; priorId: string }

export interface Measurement {
  distributions: Record<string, KeyDistribution>;
  /** Rows read per key (every version, first ones included). */
  versions: Record<string, number>;
  /** Revisions whose prior_version_id is not the version before them in (knowledge_time, id) order. */
  chainMismatches: Record<string, number>;
  /** Rows of a measured key with no market_date (an intraday market_instant): not measured. */
  undated: Record<string, number>;
}

/** Reads a source_value_versions CSV (header lines may repeat) and bins each key's revisions. */
export async function measure(lines: AsyncIterable<string>, keys: readonly string[] = DEFILLAMA_KEYS): Promise<Measurement> {
  const wanted = new Set(keys);
  const byCoordinate = new Map<string, Version[]>();
  const versions: Record<string, number> = {};
  const undated: Record<string, number> = {};
  for (const k of keys) { versions[k] = 0; undated[k] = 0; }
  let header: string | null = null;
  let col: Record<string, number> = {};
  for await (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") continue;
    if (header === null || line === header) {
      if (header === null) {
        header = line;
        col = Object.fromEntries(parseCsvLine(line).map((name, i) => [name, i]));
        for (const c of ["id", "source_key", "market_date", "value", "prior_version_id", "knowledge_time"]) {
          if (col[c] === undefined) throw new Error(`the CSV has no ${c} column: ${line}`);
        }
      }
      continue;
    }
    // Cheap prefilter before parsing: the key appears verbatim in its row.
    let hit = false;
    for (const k of wanted) if (line.includes(k)) { hit = true; break; }
    if (!hit) continue;
    const f = parseCsvLine(line);
    const key = f[col.source_key!]!;
    if (!wanted.has(key)) continue;
    versions[key]!++;
    const date = f[col.market_date!]!;
    if (date === "") { undated[key]!++; continue; }
    const coordinate = `${key}|${date}`;
    let list = byCoordinate.get(coordinate);
    if (!list) byCoordinate.set(coordinate, (list = []));
    list.push({ id: BigInt(f[col.id!]!), knowledgeTime: f[col.knowledge_time!]!, value: Number(f[col.value!]!), priorId: f[col.prior_version_id!]! });
  }
  if (header === null) throw new Error("empty input: no CSV header");

  const distributions: Record<string, KeyDistribution> = {};
  const chainMismatches: Record<string, number> = {};
  for (const k of keys) { distributions[k] = { revisions: 0, bins: new Array(BIN_COUNT).fill(0), above: 0 }; chainMismatches[k] = 0; }
  for (const [coordinate, list] of byCoordinate) {
    const key = coordinate.slice(0, coordinate.lastIndexOf("|"));
    // Postgres prints timestamptz in one fixed-width-prefix format with the
    // fraction's trailing zeros dropped; '+' sorts before '.' and every digit,
    // so plain string order is time order.
    list.sort((a, b) => (a.knowledgeTime < b.knowledgeTime ? -1 : a.knowledgeTime > b.knowledgeTime ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const d = distributions[key]!;
    for (let i = 1; i < list.length; i++) {
      const prior = list[i - 1]!;
      const next = list[i]!;
      if (next.priorId !== String(prior.id)) chainMismatches[key]!++;
      const b = binOf(relativeChange(prior.value, next.value));
      d.revisions++;
      if (b === BIN_COUNT) d.above++;
      else d.bins[b]!++;
    }
  }
  return { distributions, versions, chainMismatches, undated };
}

/** The bin labels the fixture carries next to its counts, for a reader. */
export function binLabels(): string[] {
  const fmt = (x: number) => x.toExponential(2);
  return BIN_EDGES.slice(0, -1).map((lo, i) => `[${i === 0 ? "0" : fmt(lo)}, ${fmt(BIN_EDGES[i + 1]!)})`);
}

async function main(argv: string[]): Promise<number> {
  let backup: string | null = null;
  let out: string | null = null;
  let command: string | null = null;
  let input: string | null = null;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--backup") backup = argv[++i] ?? null;
    else if (a === "--out") out = argv[++i] ?? null;
    else if (a === "--command") command = argv[++i] ?? null;
    else if (a === "--file") files.push(argv[++i] ?? "");
    else if (a.startsWith("--")) { console.error(`unknown flag ${a}`); return 2; }
    else input = a;
  }
  const stream = input === null || input === "-" ? process.stdin : createReadStream(input);
  const m = await measure(createInterface({ input: stream, crlfDelay: Infinity }));
  const selection = selectTolerance(m.distributions);
  const fixture = {
    issue: 1514,
    source: {
      backup,
      table: "source_value_versions",
      files,
      why_these_files:
        "csv-backups stores source_value_versions append-only and each backup holds only the rows it added, so the ledger as of this backup is the data files of this backup and of every backup before it, read in order",
      command,
      producer: "bun run backend/scripts/analytics/measure-tolerance.ts",
    },
    rule:
      "half-decade log bins from 1e-9 to 1e-1 of each revision's |next - prior| / max(|next|, |prior|); the noise band is the run of non-empty bins starting at the lowest bin; the tolerance is the upper edge of the first bin above the band that is empty or holds under 0.1 percent of that key's revisions, rounded down to one significant digit; the keys share the larger value; it must be at most 1e-4",
    bin_edges: BIN_EDGES,
    bin_labels: binLabels(),
    keys: Object.fromEntries(
      Object.entries(m.distributions).map(([k, d]) => [k, { versions: m.versions[k], undated: m.undated[k], chain_mismatches: m.chainMismatches[k], ...d }]),
    ),
  };
  const text = `${JSON.stringify(fixture, null, 2)}\n`;
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
  for (const [k, d] of Object.entries(m.distributions)) {
    console.error(`${k}: ${m.versions[k]} versions, ${d.revisions} revisions, ${m.chainMismatches[k]} chain mismatches, ${m.undated[k]} undated`);
    binLabels().forEach((l, i) => console.error(`  ${l.padEnd(24)} ${d.bins[i]}`));
    console.error(`  ${"[1e-1, ∞)".padEnd(24)} ${d.above}`);
  }
  if (!selection.ok) { console.error(`rule failed: ${selection.error}`); return 1; }
  for (const [k, s] of Object.entries(selection.perKey)) console.error(`${k}: gap bin ${binLabels()[s.gapBin]}, tolerance ${s.relative}`);
  console.error(`shared tolerance: ${selection.relative}`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
