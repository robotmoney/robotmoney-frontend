// Replay one published regime run from an opened format 1 archive (issue 1765,
// phase 1). Pure: the archive is the reader object (src/archive/reader.ts), and
// every table is read through it (D80). Nothing here touches a filesystem, the
// environment, a database or the network.
//
// replayRun reads the run, picks the version it replays under from the run's
// methodology label, reads the run's frozen inputs (its vintage, through its
// own methodology's storage mapping), reads the kept days its report names
// (a version that keeps its history), reads the rows it published under its
// line's artifact kind (D-b), computes the rows again through the SDK (runModel
// under the run's own model, modelOf(version), with the kept days for a
// version that keeps its history; issue 1765) and compares the as-of rows
// field by field (compareRows, over the run's own registry, D-d). The panel set
// and the kept days are platform facts read from the archive and
// REGIME_PUBLISHED_PANELS, never from a model.
//
// publicationCandidates lists the runs that published, newest first, for the
// release check to pick from (D-c).
import { createHash } from "node:crypto";
import { collectRunInputs, type Archive } from "../archive/reader.ts";
import { ArchiveError, type GeneratedRow, type Row, type RunIdentity } from "../archive/format1.ts";
import { inputHistory, parsePlainDecimal } from "../input/load.ts";
import { requireComplete, runRegime } from "../run.ts";
import { BACKFILL_START, EXTRA_IDS, runModel } from "../engine/run-model.ts";
import type { KeptDay, KeptRegimeRun } from "../engine/history.ts";
import type { Panel } from "../analyze/indicators.ts";
import {
  CURRENT_REGIME_VERSION,
  REGIME_LINE,
  REGIME_PUBLISHED_PANELS,
  REGIME_VERSIONS,
  isRegimeVersion,
  regimeArtifactKindOf,
  type RegimeArtifactKind,
  type RegimeLine,
  type RegimeVersion,
} from "../analyze/regime-versions.ts";
import { computeBacktest, stripDailyFromSnapshot } from "../analyze/backtest.ts";
import { computeCorrelations } from "../analyze/correlations.ts";
import { cutAtAsof } from "../prepare.ts";
import { resolveInputHistory } from "../series-ids.ts";
import { modelOf, type RegimeModel } from "../model/models.ts";
import { ratioDeclarationsFor, ratiosFromLegs } from "../transform/ratios.ts";
import { assertRequiredCoverage } from "../coverage.ts";
import { canonicalStringify, type RegimeSnapshotRow } from "../report/canonical.ts";
import type { RawIndicatorHistory } from "../types.ts";
import { publishedRows } from "./rows.ts";
import { compareRows, type RowComparison } from "./compare.ts";

const RUNS = "analytics_ledger_runs";
const METHODOLOGIES = "analytics_ledger_methodology_versions";
const VINTAGES = "analytics_data_vintages";
const REPORTS = "analytics_report_snapshots";
const OUTPUTS = "analytics_output_snapshots";

/** Thrown when the run key is not in the copy's run ledger: there is no run to replay. */
export class UnknownRunError extends Error {
  constructor(readonly runKey: string) {
    super(`run ${runKey} is not in the local copy's run ledger`);
    this.name = "UnknownRunError";
  }
}

export interface ReplayOptions {
  /** The panels the composite averages. Default REGIME_PUBLISHED_PANELS of the version. */
  included?: readonly Panel[];
  /** The run's input history, in place of its vintage (a database test, the committed sample). */
  history?: RawIndicatorHistory;
  /** The version to replay under, in place of the run's methodology label. */
  version?: RegimeVersion;
  /** The version to replay a run under whose label this SDK does not compute (e.g. "regime-v3"). Without it such a run is a problem. */
  fallbackVersion?: RegimeVersion;
}

export interface ReplayedRun {
  id: string;
  runKey: string;
  asof: string;
  toolId: string;
  /** The run's source label: the provenance its rows carry. */
  source: string | null;
  methodology: { id: string | null; label: string | null };
}

/** The kept days a run of a version that keeps its history read, as its report names them. */
export interface ReplayKept {
  /** The kept days before the as-of day, in date order. */
  days: KeptDay[];
  /** The analytics_output_snapshots ids the days were read from, in the order the report names them. */
  artifactIds: string[];
  /** sha256 of the canonical JSON of the days' date and panel indices, verified against the report. */
  sha256: string;
  /** The days the replay computed: every day of a first run, then 1 for a run with kept days. */
  computedDays: number;
}

export interface ReplayResult {
  run: ReplayedRun;
  /** The version replayed under; null when the run's label is one this SDK does not compute. */
  version: RegimeVersion | null;
  line: RegimeLine | null;
  panels: readonly Panel[];
  notes: string[];
  /** The history replayed, and what the vintage held besides (null without a version). */
  inputs: { history: RawIndicatorHistory; from: "vintage" | "history"; identity: RunIdentity | null; skipped: Record<string, number>; droppedRatios: string[] } | null;
  kept: ReplayKept | null;
  /** The rows the run published under its line's artifact kind (null when missing or not verified), and its as-of row. */
  published: { kind: RegimeArtifactKind | null; artifactId: string | null; rows: RegimeSnapshotRow[] | null; asof: RegimeSnapshotRow | null };
  /** The rows the SDK computes for the run (every day it publishes), and its as-of row. */
  computed: { rows: RegimeSnapshotRow[]; asof: RegimeSnapshotRow | null };
  /** The published as-of row against the computed one; null when the run cannot be replayed (an unknown label, unverified kept days). */
  diff: RowComparison | null;
  /** Why the replay is not a clean comparison: a missing or unverified artifact or report, an unknown label. Empty when none. */
  problems: string[];
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Every row of an append-only table that `keep` selects, one file at a time (the artifact tables are too large to hold whole). */
function scan(archive: Archive, table: string, keep: (r: Row) => boolean): Row[] {
  const out: Row[] = [];
  for (const f of archive.files(table)) for (const r of archive.scanRows(f)) if (keep(r)) out.push(r);
  return out;
}

/** The history a run's generated input rows give: the replay contract's values, as `bun run regime --replay` reads them. */
export function historyOfInputs(rows: readonly GeneratedRow[]): RawIndicatorHistory {
  return inputHistory(rows.map((r) => ({ date: r.date, series: r.series, value: parsePlainDecimal(r.value), kind: r.kind })));
}

/** A version's kept day from a published row: its date and panel indices. */
const keptDayOf = (r: Record<string, any>): KeptDay => ({ date: r.date, panelIndices: { macro: r.macroIndex ?? NaN, onchain: r.onchainIndex ?? NaN, factor: r.factorIndex ?? NaN } });

// The version a run replays under, with the note or problem that explains it.
function versionOf(label: string | null, opts: ReplayOptions): { version: RegimeVersion | null; note?: string; problem?: string } {
  if (opts.version !== undefined) {
    if (!isRegimeVersion(opts.version)) throw new RangeError(`version must be one of ${REGIME_VERSIONS.join(", ")}, got ${JSON.stringify(opts.version)}`);
    return label === opts.version ? { version: opts.version } : { version: opts.version, note: `replayed under ${opts.version} as asked; the run's methodology label is ${JSON.stringify(label)}` };
  }
  if (label !== null && isRegimeVersion(label)) return { version: label };
  if (label === null || label === "") {
    return { version: CURRENT_REGIME_VERSION, note: `the copy records no methodology label for the run; replayed under the current version ${CURRENT_REGIME_VERSION}` };
  }
  if (opts.fallbackVersion !== undefined) {
    if (!isRegimeVersion(opts.fallbackVersion)) throw new RangeError(`fallbackVersion must be one of ${REGIME_VERSIONS.join(", ")}, got ${JSON.stringify(opts.fallbackVersion)}`);
    return { version: opts.fallbackVersion, note: `methodology ${label} is not one this SDK computes; replayed under ${opts.fallbackVersion} as asked` };
  }
  return { version: null, problem: `methodology ${label} is not one this SDK computes` };
}

// An artifact's rows, after its payload_sha256 is checked against its payload bytes. Null with a problem otherwise.
function artifactRows(o: Row, what: string, problems: string[]): RegimeSnapshotRow[] | null {
  if (o.payload_json == null) {
    problems.push(`${what} (artifact ${o.id}) has no payload in the copy`);
    return null;
  }
  if (o.payload_sha256 == null || o.payload_sha256 === "") {
    problems.push(`${what} (artifact ${o.id}) has no payload_sha256: its payload cannot be verified`);
    return null;
  }
  const got = sha256(o.payload_json);
  if (got !== o.payload_sha256) {
    problems.push(`${what} (artifact ${o.id}): the payload's sha256 ${got} does not match its stored payload_sha256 ${o.payload_sha256}`);
    return null;
  }
  const rows = JSON.parse(o.payload_json) as unknown;
  if (!Array.isArray(rows)) {
    problems.push(`${what} (artifact ${o.id}) is not a list of rows`);
    return null;
  }
  return rows as RegimeSnapshotRow[];
}

// The kept record a run's report names (results.regime.kept), read from the
// named artifacts and verified: each payload against its payload_sha256, and the
// days against the report's count and sha256. The days are the named
// artifacts' rows dated before the as-of day, a later artifact's row replacing
// an earlier one's for the same date (backend/src/analytics/index.ts, issue 1753).
function keptOfReport(
  report: Row | null,
  artifacts: ReadonlyMap<string, Row>,
  o: { runKey: string; asof: string; kind: RegimeArtifactKind },
  problems: string[],
): Omit<ReplayKept, "computedDays"> | null {
  if (report === null) {
    problems.push(`run ${o.runKey} has no report in the copy: the kept days it read are not named`);
    return null;
  }
  if (report.report_json == null || report.report_sha256 == null) {
    problems.push(`run ${o.runKey}: its report (${report.id}) has no report_json or report_sha256 in the copy`);
    return null;
  }
  const got = sha256(report.report_json);
  if (got !== report.report_sha256) {
    problems.push(`run ${o.runKey}: its report's sha256 ${got} does not match its stored report_sha256 ${report.report_sha256}`);
    return null;
  }
  const kept = (JSON.parse(report.report_json) as { results?: { regime?: { kept?: { days?: unknown; artifactIds?: unknown; sha256?: unknown } } } }).results?.regime?.kept;
  if (!kept || typeof kept.days !== "number" || !Array.isArray(kept.artifactIds) || typeof kept.sha256 !== "string") {
    problems.push(`run ${o.runKey}: its report names no kept days (results.regime.kept { days, artifactIds, sha256 })`);
    return null;
  }
  const artifactIds = kept.artifactIds.map(String);
  const byDate = new Map<string, Record<string, any>>();
  for (const id of artifactIds) {
    const a = artifacts.get(id);
    if (!a) {
      problems.push(`run ${o.runKey}: the kept artifact ${id} its report names is not in the copy`);
      return null;
    }
    if (a.artifact_kind !== o.kind) {
      problems.push(`run ${o.runKey}: the kept artifact ${id} is a ${a.artifact_kind} artifact, not ${o.kind}`);
      return null;
    }
    const rows = artifactRows(a, `run ${o.runKey}: kept artifact ${id}`, problems);
    if (rows === null) return null;
    for (const row of rows as Record<string, any>[]) if (row.date < o.asof) byDate.set(row.date, row);
  }
  const keptRows = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const keptDays = keptRows.map((r) => ({ date: r.date, macroIndex: r.macroIndex ?? null, onchainIndex: r.onchainIndex ?? null, factorIndex: r.factorIndex ?? null }));
  const digest = sha256(canonicalStringify(keptDays));
  if (keptRows.length !== kept.days || digest !== kept.sha256) {
    problems.push(`run ${o.runKey}: the kept days read from artifacts ${artifactIds.join(", ") || "(none)"} are ${keptRows.length} day(s) with sha256 ${digest}; its report names ${kept.days} with sha256 ${kept.sha256}`);
    return null;
  }
  return { days: keptRows.map(keptDayOf), artifactIds, sha256: digest };
}

// The rows of a kept run, with the correlations and the backtest computed from
// its kept record the way the producer does (backend/src/analytics/index.ts):
// over the composite panels, with the price extras cut at the as-of day, under
// the model's backtest rules.
function keptRunRows(run: KeptRegimeRun, model: RegimeModel, input: RawIndicatorHistory, o: { asof: string; included: readonly Panel[]; source: string | null }, notes: string[]): RegimeSnapshotRow[] {
  const { record, dateAxis } = run;
  const extras = { spx: cutAtAsof(input[EXTRA_IDS.spx] ?? [], o.asof), eth: cutAtAsof(input[EXTRA_IDS.eth] ?? [], o.asof), tbill3m: cutAtAsof(input[EXTRA_IDS.tbill3m] ?? [], o.asof) };
  let backtest: unknown = null;
  let correlations: unknown = null;
  try {
    correlations = computeCorrelations(dateAxis, { composite: record.composite, panelIndices: record.panelIndices, panels: [...o.included] }, extras);
    backtest = stripDailyFromSnapshot(computeBacktest(dateAxis, { regime: record.regime, panelRegimes: record.panelRegimes, panels: [...o.included] }, extras, model.backtest));
  } catch (e) {
    notes.push(`backtest/correlations failed: ${(e as Error).message}`);
  }
  return publishedRows(run, { source: o.source, backtest, correlations });
}

/**
 * Replay the run `runKey` of an opened archive and compare its as-of row with
 * the one it published. Throws UnknownRunError when the run is not in the
 * copy, and ArchiveError when the copy is corrupt or incomplete.
 */
export function replayRun(archive: Archive, runKey: string, opts: ReplayOptions = {}): ReplayResult {
  const runs = archive.table(RUNS).filter((r) => r.run_key === runKey);
  if (runs.length === 0) throw new UnknownRunError(runKey);
  if (runs.length > 1) throw new ArchiveError(`run key ${runKey} names ${runs.length} runs`);
  const r = runs[0]!;
  const meth = archive.table(METHODOLOGIES).find((m) => m.id === r.methodology_version_id) ?? null;
  const label = meth?.version_label ?? null;
  const run: ReplayedRun = { id: r.id!, runKey, asof: r.asof!, toolId: r.tool_id!, source: r.source_label ?? null, methodology: { id: r.methodology_version_id ?? null, label } };
  const notes: string[] = [];
  const problems: string[] = [];
  const empty = { kind: null, artifactId: null, rows: null, asof: null };
  const none = (panels: readonly Panel[] = []): ReplayResult => ({ run, version: null, line: null, panels, notes, inputs: null, kept: null, published: empty, computed: { rows: [], asof: null }, diff: null, problems });
  if (run.toolId !== "regime") {
    problems.push(`run ${runKey} is a ${run.toolId} run, not a regime run`);
    return none();
  }

  const picked = versionOf(label, opts);
  if (picked.note) notes.push(picked.note);
  if (picked.problem || picked.version === null) {
    problems.push(picked.problem!);
    return none();
  }
  const version = picked.version;
  // The run's own model (issue 1765): the version names its preset.
  const model = modelOf(version);
  const line = REGIME_LINE[version];
  const kind = regimeArtifactKindOf(version);
  const panels = opts.included ?? REGIME_PUBLISHED_PANELS[version];
  const keptHistory = model.history === "kept";

  // The run's report (a kept version reads its kept days from it), then one pass
  // over the artifacts for the run's own and the kept ones its report names.
  let report: Row | null = null;
  let namedIds = new Set<string>();
  if (keptHistory) {
    const reports = scan(archive, REPORTS, (x) => x.run_id === run.id);
    if (reports.length > 1) problems.push(`run ${runKey} has ${reports.length} reports in the copy`);
    report = reports[0] ?? null;
    try {
      const ids = (JSON.parse(report?.report_json ?? "null") as { results?: { regime?: { kept?: { artifactIds?: unknown } } } } | null)?.results?.regime?.kept?.artifactIds;
      if (Array.isArray(ids)) namedIds = new Set(ids.map(String));
    } catch {
      // An unreadable report is reported by keptOfReport.
    }
  }
  const artifacts = new Map<string, Row>();
  const own: Row[] = [];
  for (const o of scan(archive, OUTPUTS, (x) => (x.run_id === run.id && x.artifact_kind === kind) || namedIds.has(x.id!))) {
    artifacts.set(o.id!, o);
    if (o.run_id === run.id && o.artifact_kind === kind) own.push(o);
  }

  // The published rows: the run's artifact under its line's kind (D-b), its payload verified.
  let published: ReplayResult["published"] = { kind, artifactId: null, rows: null, asof: null };
  if (own.length === 0) problems.push(`run ${runKey} has no ${kind} artifact in the local copy: the published record of the run is not in the archive`);
  else if (own.length > 1) problems.push(`run ${runKey} has ${own.length} ${kind} artifacts in the local copy`);
  else {
    const rows = artifactRows(own[0]!, `run ${runKey}: the published ${kind} artifact`, problems);
    published = { kind, artifactId: own[0]!.id!, rows, asof: rows?.find((x) => x.date === run.asof) ?? null };
  }

  // The kept days the run read (a version that keeps its history).
  let kept: Omit<ReplayKept, "computedDays"> | null = null;
  if (keptHistory) {
    kept = keptOfReport(report, artifacts, { runKey, asof: run.asof, kind }, problems);
    if (kept === null) return { ...none(panels), version, line, published };
  }

  // The inputs: the run's vintage, or the history given.
  let identity: RunIdentity | null = null;
  let skipped: Record<string, number> = {};
  let history: RawIndicatorHistory;
  if (opts.history !== undefined) history = opts.history;
  else {
    const collected = collectRunInputs(archive, runKey);
    identity = collected.run;
    skipped = collected.skipped;
    history = historyOfInputs(collected.rows);
  }

  // Compute: every day the run publishes, through runModel under the run's model.
  const droppedRatios: string[] = [];
  let computedRows: RegimeSnapshotRow[] = [];
  let computedDays = 0;
  try {
    if (keptHistory) {
      const input = ratiosFromLegs(history, resolveInputHistory(history, model.seriesMapping, model.storedUnder), ratioDeclarationsFor(model.rules), (id) => void droppedRatios.push(id));
      assertRequiredCoverage(input, run.asof, undefined, model.registry);
      // The kept days the run's report names, and only the as-of day computed (a first run walks every day).
      const keptRun = runModel(model, input, { asof: run.asof, start: BACKFILL_START, panels: model.panels.all, included: panels, kept: kept!.days, extras: false }).keptRun!;
      computedDays = keptRun.computed.length;
      computedRows = keptRunRows(keptRun, model, input, { asof: run.asof, included: panels, source: run.source }, notes);
    } else {
      const result = requireComplete(runRegime(history, { asof: run.asof, model, factor: true, panels }));
      droppedRatios.push(...result.droppedRatios);
      computedDays = result.dateAxis.length;
      computedRows = publishedRows(result, { source: run.source });
    }
  } catch (e) {
    if (e instanceof ArchiveError) throw e;
    problems.push(`run ${runKey}: the SDK could not compute the run: ${(e as Error).message}`);
  }
  if (droppedRatios.length > 0) notes.push(`ratios dropped (the input carries the stored ratio and neither leg): ${droppedRatios.join(", ")}`);
  const computedAsof = computedRows.find((x) => x.date === run.asof) ?? null;
  return {
    run,
    version,
    line,
    panels,
    notes,
    inputs: { history, from: opts.history !== undefined ? "history" : "vintage", identity, skipped, droppedRatios },
    kept: kept === null ? null : { ...kept, computedDays },
    published,
    computed: { rows: computedRows, asof: computedAsof },
    diff: compareRows(published.asof, computedAsof),
    problems,
  };
}

/** A run that published, as publicationCandidates lists it. */
export interface PublishedRunCandidate {
  runId: string;
  runKey: string;
  asof: string;
  toolId: string;
  /** The methodology label; null when the copy records none. */
  methodology: string | null;
  /** The line the run published on: a label this SDK does not compute, or none, counts as the main line. */
  line: RegimeLine;
  vintageId: string;
  /** The run's report id, or null when the copy holds none. */
  reportId: string | null;
  /** The kinds of the run's non-failed artifacts, sorted. */
  artifactKinds: string[];
  createdAt: string | null;
  buildIdentity: string | null;
}

// The artifacts a failed run freezes (backend store/output-snapshot-store.ts packageArtifacts).
const FAILED_ARTIFACT_KINDS: ReadonlySet<string> = new Set(["warnings", "logs", "exceptions"]);

const byIdDesc = (a: { runId: string }, b: { runId: string }): number => {
  const x = BigInt(a.runId);
  const y = BigInt(b.runId);
  return x > y ? -1 : x < y ? 1 : 0;
};

/**
 * The runs of a tool that published, newest first (by run id): each has a
 * frozen vintage and a report or a non-failed artifact. `line` keeps the runs of
 * one line, `methodology` the runs with one label. The run events table is
 * never read: the public archive does not serve it.
 *
 * The report and artifact tables are streamed one file at a time
 * (Archive.scanRows), and only each run's report id and artifact kinds are
 * kept, never a row or a payload: a whole archive's payloads do not fit in
 * memory (the release post-seal check runs this over a full filled copy).
 */
export function publicationCandidates(archive: Archive, toolId: string, opts: { line?: RegimeLine; methodology?: string } = {}): PublishedRunCandidate[] {
  const labels = new Map(archive.table(METHODOLOGIES).map((m) => [m.id!, m.version_label ?? null]));
  const vintages = new Map<string, string>();
  for (const v of archive.table(VINTAGES)) if (v.tool_id === toolId || v.tool_id == null) vintages.set(v.run_id!, v.id!);
  // Each kept cell is copied out of its row, one copy per distinct value: the
  // reader's unquoted cells are slices of their file's decoded text, and in Bun
  // a kept slice keeps that whole text alive, payloads included.
  const copies = new Map<string, string>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const kept = <T extends string | null | undefined>(cell: T): T => {
    if (cell == null) return cell;
    let c = copies.get(cell);
    if (c === undefined) copies.set((c = decoder.decode(encoder.encode(cell))), c);
    return c as T;
  };
  const reports = new Map<string, string>();
  for (const f of archive.files(REPORTS)) for (const x of archive.scanRows(f)) reports.set(kept(x.run_id)!, kept(x.id)!);
  const kinds = new Map<string, Set<string>>();
  for (const f of archive.files(OUTPUTS)) {
    for (const o of archive.scanRows(f)) {
      if (FAILED_ARTIFACT_KINDS.has(o.artifact_kind ?? "")) continue;
      const runId = kept(o.run_id)!;
      let s = kinds.get(runId);
      if (!s) kinds.set(runId, (s = new Set()));
      s.add(kept(o.artifact_kind)!);
    }
  }
  const out: PublishedRunCandidate[] = [];
  for (const r of archive.table(RUNS)) {
    if (r.tool_id !== toolId) continue;
    const vintageId = vintages.get(r.id!);
    if (vintageId === undefined) continue;
    const reportId = reports.get(r.id!) ?? null;
    const artifactKinds = [...(kinds.get(r.id!) ?? [])].sort();
    if (reportId === null && artifactKinds.length === 0) continue;
    const methodology = labels.get(r.methodology_version_id ?? "") ?? null;
    const line: RegimeLine = isRegimeVersion(methodology) ? REGIME_LINE[methodology] : "main";
    if (opts.line !== undefined && line !== opts.line) continue;
    if (opts.methodology !== undefined && methodology !== opts.methodology) continue;
    out.push({ runId: r.id!, runKey: r.run_key!, asof: r.asof!, toolId: r.tool_id!, methodology, line, vintageId, reportId, artifactKinds, createdAt: r.created_at ?? null, buildIdentity: r.build_identity ?? null });
  }
  return out.sort(byIdDesc);
}
