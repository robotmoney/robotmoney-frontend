// Issue 1450: why do three published regime runs (ids 73, 111, 133) replay to a
// different composite than the one they published?
//
//   RM_FORMAT1_ARCHIVE=<format 1 local copy> bun run backend/scripts/composite-drift-diagnosis.ts
//
// The only input is a format 1 local copy of the csv-backups data (D72), read
// through the analyst SDK's one archive reader. Nothing is fetched and nothing
// is written except backend/tests/fixtures/composite-drift-diagnosis.json.
//
// For each run it
//   1. replays the run's frozen vintage (what the ledger stored) and takes the
//      composite of the as-of day;
//   2. reads the indicator cards of the run's published as-of row. Each card
//      names the last observation the run computed from (raw_date, raw_value);
//   3. lists every series whose replayed last observation differs from the one
//      the run computed from (input_series, with both values);
//   4. puts the computed observation into the replayed inputs, one series at a
//      time (solo_composite_effect) and all at once (composite_effect), and
//      replays again with the same compute code.
// If the all-at-once replay gives back the published composite exactly, the
// inputs account for the whole gap and the compute code accounts for none of it.
//
// cause is "pre-1421-handoff" when all of these hold: the run predates the fix
// of issue 1421 (it computed from values read before its own ingest was
// committed, and the vintage was frozen after that commit), every replayed value
// of a differing series was committed after the run started, and the inputs
// account for the composite gap exactly. Anything else is "other".
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectRunInputs, openBackupsDir, type Archive } from "../../packages/analyst-sdk/bin/backups-dir.ts";
import { seriesForStorageKey, serializeInputs } from "../../packages/analyst-sdk/src/archive/format1.ts";
import { parseInput } from "../../packages/analyst-sdk/src/input/load.ts";
import { resolveInputHistory } from "../../packages/analyst-sdk/src/series-ids.ts";
import { runRegime } from "../../packages/analyst-sdk/src/run.ts";
import type { Point, RawIndicatorHistory } from "../../packages/analyst-sdk/src/types.ts";
import { poisonNetwork } from "../tests/support/network-poison.ts";

export const DIAGNOSED_RUN_IDS = ["73", "111", "133"] as const;
export const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../tests/fixtures/composite-drift-diagnosis.json");
// Issue 1421's fix merged at this instant (the same constant as regime-replay-archive.test.ts).
const POST_1421 = "2026-10-23 18:32:15+00";
// The composite of the all-at-once replay must equal the published one to this.
const EXACT = 1e-12;

export interface SeriesObservation {
  date: string;
  value: number;
}
export interface DifferingSeries {
  series: string;
  replayed: SeriesObservation & { version_id: number; committed_at: string; committed_after_run_start: boolean };
  // version_id and committed_at are null when no stored version holds the computed value.
  computed: SeriesObservation & { version_id: number | null; committed_at: string | null };
  // Replayed composite minus the composite with only this series' computed observation put in.
  solo_composite_effect: number;
}
export interface Diagnosis {
  input_series: DifferingSeries[];
  replayed_vs_computed_delta: number;
  composite_effect: number;
  cause: "pre-1421-handoff" | "other";
  linked_issue: number | null;
}

interface Card {
  id: string;
  raw_date: string;
  raw_value: number;
}

// Both sides of a series' observation, as the replay reads them.
function lastOnOrBefore(rows: readonly Point[], asof: string): Point | undefined {
  let last: Point | undefined;
  for (const r of rows) if (r.date <= asof && (!last || r.date >= last.date)) last = r;
  return last;
}

// Put the computed observation in: nothing after its date, its value on its date.
function withComputed(history: RawIndicatorHistory, id: string, c: SeriesObservation): RawIndicatorHistory {
  const rows = (history[id] ?? []).filter((r) => r.date < c.date);
  rows.push({ date: c.date, value: c.value });
  return { ...history, [id]: rows };
}

function compositeOf(history: RawIndicatorHistory, asof: string): number {
  const run = runRegime(history, { asof });
  return run.result.composite[run.dateAxis.length - 1]!;
}

export function diagnoseRun(copy: Archive, runId: string): Diagnosis {
  const run = copy.table("analytics_ledger_runs").find((r) => r.id === runId);
  if (!run || run.tool_id !== "regime") throw new Error(`run ${runId} is not a regime run in the copy`);
  const asof = run.asof!;

  // The published as-of row, checked against its stored SHA-256.
  let published: { composite: number; indicators: Card[] } | null = null;
  for (const f of copy.files("analytics_output_snapshots")) {
    for (const o of copy.readRows(f)) {
      if (o.run_id !== runId || o.artifact_kind !== "regime_snapshots") continue;
      if (new Bun.CryptoHasher("sha256").update(o.payload_json!).digest("hex") !== o.payload_sha256) throw new Error(`run ${runId}: published payload does not match its SHA-256`);
      published = (JSON.parse(o.payload_json!) as { date: string; composite: number; indicators: Card[] }[]).find((r) => r.date === asof) ?? null;
    }
  }
  if (!published) throw new Error(`run ${runId} published no as-of row in the copy`);

  const inputs = collectRunInputs(copy, run.run_key!);
  const history = resolveInputHistory(parseInput(serializeInputs(inputs.rows, "csv"), { replay: true }).history);
  const replayed = compositeOf(history, asof);

  // Series whose replayed last observation is not the one the run computed from.
  const differing: { id: string; replay: Point; computed: SeriesObservation }[] = [];
  for (const card of published.indicators) {
    const replay = lastOnOrBefore(history[card.id] ?? [], asof);
    if (!replay) continue;
    if (replay.date !== card.raw_date || replay.value !== card.raw_value) differing.push({ id: card.id, replay, computed: { date: card.raw_date, value: card.raw_value } });
  }
  differing.sort((a, b) => (a.id < b.id ? -1 : 1));

  // Which stored versions hold the replayed and the computed values.
  const wanted = new Map<string, { id: string; date: string; replay: number; computed: number }>();
  for (const d of differing) wanted.set(`${d.id}|${d.replay.date}`, { id: d.id, date: d.replay.date, replay: d.replay.value, computed: d.computed.value });
  const computedAt = new Map(differing.map((d) => [`${d.id}|${d.computed.date}`, d]));
  const replayVersion = new Map<string, { id: number; kt: string }>();
  const computedVersion = new Map<string, { id: number; kt: string }>();
  for (const rows of copy.versions()) {
    for (const v of rows) {
      if (v.market_date === null || v.value === null) continue;
      const series = seriesForStorageKey(v.source_key!);
      if (series === null) continue;
      const k = `${series}|${v.market_date}`;
      const n = Number(v.value);
      const w = wanted.get(k);
      if (w && n === w.replay) replayVersion.set(k, { id: Number(v.id), kt: v.knowledge_time! });
      const c = computedAt.get(k);
      if (c && n === c.computed.value) {
        const prior = computedVersion.get(k);
        if (!prior || Number(v.id) < prior.id) computedVersion.set(k, { id: Number(v.id), kt: v.knowledge_time! });
      }
    }
  }

  let all = history;
  const input_series: DifferingSeries[] = differing.map((d) => {
    all = withComputed(all, d.id, d.computed);
    const rv = replayVersion.get(`${d.id}|${d.replay.date}`);
    if (!rv) throw new Error(`run ${runId}: no stored version holds ${d.id} ${d.replay.date} ${d.replay.value}`);
    const cv = computedVersion.get(`${d.id}|${d.computed.date}`) ?? null;
    return {
      series: d.id,
      replayed: { date: d.replay.date, value: d.replay.value, version_id: rv.id, committed_at: rv.kt, committed_after_run_start: rv.kt > run.created_at! },
      computed: { ...d.computed, version_id: cv?.id ?? null, committed_at: cv?.kt ?? null },
      solo_composite_effect: replayed - compositeOf(withComputed(history, d.id, d.computed), asof),
    };
  });

  const delta = replayed - published.composite;
  const effect = replayed - compositeOf(all, asof);
  const handoff = run.created_at! < POST_1421 && Math.abs(delta - effect) <= EXACT && input_series.length > 0 && input_series.every((s) => s.replayed.committed_after_run_start);
  return { input_series, replayed_vs_computed_delta: delta, composite_effect: effect, cause: handoff ? "pre-1421-handoff" : "other", linked_issue: null };
}

if (import.meta.main) {
  const archive = process.env.RM_FORMAT1_ARCHIVE;
  if (!archive) throw new Error("RM_FORMAT1_ARCHIVE must name a format 1 local copy of the csv-backups data (D72)");
  const poison = poisonNetwork("during the composite drift diagnosis");
  const out: Record<string, Diagnosis> = {};
  try {
    const copy = openBackupsDir(archive);
    // A cause "other" needs a fix issue number: keep one already written for it.
    let kept: Record<string, Diagnosis> = {};
    try {
      kept = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    } catch {
      // first run: no file yet
    }
    for (const id of DIAGNOSED_RUN_IDS) {
      const d = diagnoseRun(copy, id);
      out[id] = d.cause === "other" ? { ...d, linked_issue: kept[id]?.linked_issue ?? null } : d;
    }
  } finally {
    poison.restore();
  }
  if (poison.attempts.length > 0) throw new Error(`network use during the diagnosis: ${poison.attempts.join("; ")}`);
  writeFileSync(FIXTURE_PATH, JSON.stringify(out, null, 2) + "\n");
  for (const id of DIAGNOSED_RUN_IDS) console.log(`run ${id}: ${out[id]!.cause}, delta ${out[id]!.replayed_vs_computed_delta}, explained by inputs ${out[id]!.composite_effect}, series ${out[id]!.input_series.map((s) => s.series).join(",")}`);
}
