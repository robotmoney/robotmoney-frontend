// Issue 1421 (with issue 1182): every published regime run replays to its own
// published record. The ledger keeps each run's frozen inputs (its data
// vintage) and its published output (the regime_snapshots artifact) from
// 2026-09-21, when the run ledger began (migrations 0058/0059;
// docs/technical/regime-engine.md §8.1). For EVERY regime run in the database
// with an as-of day on or after 2026-09-21, this test rebuilds the analyst SDK
// input from that run's vintage ALONE, through the SDK's storage mapping
// (inputHistoryFromStorage, D74), replays it through runRegime with the
// network poisoned, and asserts every field of the as-of row (COMPARED_FIELDS,
// exactly: both sides are computed under D78) and the label and composite of
// every row the run published (TEST-4, analytics requirements 6).
//
// The runs here are made by the production orchestrator over real persistence,
// from committed fixtures only (no archive, no network): a base day, a day
// whose provider serves within-tolerance jitter plus material revisions, a day
// back on the base values, and the raw-versus-ledger mismatch of AN-16: a seed
// wrote S for a date, the first provider observation F was within the D56
// tolerance of S, so the raw floor keeps S while the ledger (and the vintage)
// holds F. The fixture writes the D74 amendment keys only: no DEFI_GROWTH or
// STABLES_GROWTH row.
//
// The production record itself (every run since 2026-09-21) is not in CI: no
// test may reach the production database. Issue 1431 replays it from the
// format 1 backups (D72): every run in regime-replay-archive.test.ts against a
// local copy, and a committed sample of runs in the second describe below.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { sql } from "../src/db/client.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { loadFrozenVintage, type FrozenVintage } from "../src/analytics/store/run-ledger-store.ts";
import { loadRawIndicatorHistory, saveRawIndicatorHistory } from "../src/analytics/store/raw-history-store.ts";
import { noopTelemetrySink } from "../src/analytics/telemetry.ts";
import { INDICATORS } from "../src/analytics/analyze/indicators.ts";
import { STORED_UNDER, inputHistoryFromStorage } from "../src/analytics/extras.ts";
import { withinTolerance } from "../src/analytics/source-tolerance.ts";
import { runRegime } from "../../packages/analyst-sdk/src/run.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { baseObservations, poisonedSource, secondObservations, type Observations } from "./support/committed-inputs.ts";
import { poisonNetwork } from "./support/network-poison.ts";
import { COMPARED_FIELDS, replayPublishedHistory, replayPublishedRun, type PublishedAsofRow, type ReplayOutcome } from "./support/published-replay.ts";
import { numericDiff } from "../../packages/analyst-sdk/tests/support/numeric-diff.ts";
import { canonicalStringify } from "../src/analytics/run-ledger.ts";
import { serializeInputs } from "../../packages/analyst-sdk/src/archive/format1.ts";

useCleanDatabase(import.meta.file);

const LEDGER_START = "2026-09-21";
const GROWTH_KEYS = Object.keys(STORED_UNDER).map((id) => `raw_indicator_history:${id}`);
// AN-16: the as-of day of the mismatch run, and the date the seed and the provider disagree on.
const MISMATCH_ASOF = "2026-09-24";

async function publish(asof: string, obs: Observations): Promise<void> {
  const source = poisonedSource(obs, 2);
  try {
    await runAnalytics(asof, "regime", source, directAnalyticsPersistence, noopTelemetrySink);
  } finally {
    source.restore();
  }
}

interface PublishedRun {
  id: string;
  asof: string;
  vintage: FrozenVintage;
  rows: (PublishedAsofRow & { date: string })[];
  asofRow: PublishedAsofRow;
}

describe("regime replay of every published run from 2026-09-21", () => {
  let runs: PublishedRun[] = [];
  let S = 0;
  let F = 0;

  beforeAll(async () => {
    const base = await baseObservations();
    await publish("2026-09-21", base);
    await publish("2026-09-22", secondObservations(base));
    await publish("2026-09-23", base);
    // The AN-16 sequence. S is a VIX close the window already holds (closes
    // repeat to the cent), so F, a relative 5e-7 above it, breaks a tie and
    // moves VIX's rank: the run computed from S would publish other numbers.
    S = base.registry.VIX!.at(-1)!.value;
    F = S * (1 + 5e-7);
    await saveRawIndicatorHistory({ VIX: [{ date: MISMATCH_ASOF, value: S }] }, sql, "seed");
    await publish(MISMATCH_ASOF, { ...base, registry: { ...base.registry, VIX: [...base.registry.VIX!, { date: MISMATCH_ASOF, value: F }] } });

    const found = await sql<{ id: string; asof: string; vintage_id: string; payload_bytes: Uint8Array }[]>`
      SELECT r.id::text AS id, r.asof::text AS asof, v.id::text AS vintage_id, o.payload_bytes
      FROM analytics_ledger_runs r
      JOIN analytics_data_vintages v ON v.run_id = r.id AND v.tool_id = r.tool_id
      JOIN analytics_output_snapshots o ON o.run_id = r.id AND o.artifact_kind = 'regime_snapshots'
      WHERE r.tool_id = 'regime' AND r.asof >= ${LEDGER_START}::date
      ORDER BY r.asof, r.id`;
    runs = [];
    for (const r of found) {
      const rows = JSON.parse(new TextDecoder().decode(r.payload_bytes)) as PublishedRun["rows"];
      const asofRow = rows.find((row) => row.date === r.asof);
      if (!asofRow) throw new Error(`run ${r.id} published no row for its as-of day ${r.asof}`);
      runs.push({ id: r.id, asof: r.asof, vintage: (await loadFrozenVintage(r.vintage_id))!, rows, asofRow });
    }
  }, 600_000);

  const inputOf = (run: PublishedRun) => inputHistoryFromStorage(run.vintage.members);

  test("every field of each run's as-of row, and the label and composite of every published row, replay exactly from its vintage", () => {
    expect(runs.map((r) => r.asof)).toEqual(["2026-09-21", "2026-09-22", "2026-09-23", MISMATCH_ASOF]);
    const poison = poisonNetwork("during replay");
    try {
      for (const run of runs) {
        const input = inputOf(run);
        expect(Object.keys(input).length).toBe(INDICATORS.length + 3);
        expect(run.asofRow.regime).not.toBeNull();
        const outcome = replayPublishedHistory(input, run.asof, run.asofRow);
        expect({ run: run.id, asof: run.asof, differing: outcome.differing }).toEqual({ run: run.id, asof: run.asof, differing: [] });
        expect(Object.keys(outcome.fields)).toEqual([...COMPARED_FIELDS]);

        const replay = runRegime(input, { asof: run.asof });
        const at = new Map(replay.dateAxis.map((d, i) => [d, i]));
        expect(run.rows.length).toBeGreaterThan(1000);
        for (const row of run.rows) {
          const i = at.get(row.date);
          expect({ run: run.id, date: row.date, found: i !== undefined }).toEqual({ run: run.id, date: row.date, found: true });
          expect({ date: row.date, regime: replay.result.regime[i!] ?? null, composite: replay.result.composite[i!] }).toEqual({ date: row.date, regime: row.regime, composite: row.composite! });
        }
      }
    } finally {
      poison.restore();
    }
    expect(poison.attempts).toEqual([]);
  }, 300_000);

  test("the fixture writes no DEFI_GROWTH or STABLES_GROWTH row, and no run's vintage holds one (D74 amendment)", async () => {
    const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM source_value_versions WHERE source_key = ANY(${GROWTH_KEYS}::text[])`;
    expect(n).toBe(0);
    const raw = await loadRawIndicatorHistory();
    for (const id of Object.keys(STORED_UNDER)) expect(raw[id]).toBeUndefined();
    expect(runs.length).toBe(4);
    for (const run of runs) expect(run.vintage.members.filter((m) => GROWTH_KEYS.includes(m.sourceKey))).toEqual([]);
  });

  test("the raw-versus-ledger mismatch run replays to its published as-of row in every field, and the raw value would not", async () => {
    expect(withinTolerance("raw_indicator_history:VIX", S, F)).toBe(true);
    expect((await loadRawIndicatorHistory()).VIX!.find((p) => p.date === MISMATCH_ASOF)!.value).toBe(S);
    const run = runs.find((r) => r.asof === MISMATCH_ASOF)!;
    const pinned = run.vintage.members.find((m) => m.sourceKey === "raw_indicator_history:VIX" && m.marketDate === MISMATCH_ASOF)!;
    expect(pinned.value).toBe(F);
    const input = inputOf(run);
    expect(replayPublishedHistory(input, run.asof, run.asofRow).differing).toEqual([]);
    // Non-vacuity: computed from the raw floor's S, the as-of row differs, so
    // a run that computed from raw would fail the assertion above.
    const fromRaw = { ...input, VIX: input.VIX!.map((p) => (p.date === MISMATCH_ASOF ? { date: p.date, value: S } : p)) };
    expect(replayPublishedHistory(fromRaw, run.asof, run.asofRow).differing.length).toBeGreaterThan(0);
  }, 120_000);

  test("negative control: a deliberately altered macroIndex in a published payload fails the comparison", () => {
    const run = runs[0]!;
    const altered = { ...run.asofRow, macroIndex: run.asofRow.macroIndex! + 0.001 };
    const outcome = replayPublishedHistory(inputOf(run), run.asof, altered);
    expect(outcome.differing).toEqual(["macroIndex"]);
    expect(() => expect(outcome.differing).toEqual([])).toThrow();
  }, 120_000);
});

// Issue 1431: the same replay against the PUBLISHED PRODUCTION record, for a
// committed sample of production runs (tests/fixtures/published-replay/,
// written by scripts/published-replay-sample.ts from the format 1 backups,
// D72). The sample holds only data the public API already serves (D58, D73):
// each run's frozen vintage values as stored, and the as-of row of its
// published regime_snapshots artifact. Every run of the record is replayed by
// regime-replay-archive.test.ts against a local copy of the backups; required
// CI has no copy, so it runs this sample. Each run's rebuilt input must hash to
// the input `bun run inputs` writes for it, its replayed as-of label must equal
// the published label, and every other field must give the outcome recorded
// from the full record. The record was made before decision D78
// (compensated arithmetic), which moves numbers in their last bits, so the
// recorded outcome is matched up to rounding: the same fields differ beyond
// rounding as recorded, the recorded first difference reproduces up to
// rounding, and every other field equals the published one up to rounding.
const SAMPLE_DIR = join(import.meta.dir, "fixtures/published-replay");

interface SampleRun {
  index: number;
  runKey: string;
  runId: string;
  asof: string;
  inputRows: number;
  inputSha256: string;
  publishedPayloadSha256: string;
  publishedAsofRow: PublishedAsofRow;
  replayDiffering: string[];
  replayFirstDiff: { field: string; published: string; replay: string } | null;
  replaySha256: string;
}

const sample = JSON.parse(readFileSync(join(SAMPLE_DIR, "runs.json"), "utf8")) as { backup: string; inputsSha256Gz: string; runs: SampleRun[] };
const sampleGz = readFileSync(join(SAMPLE_DIR, "inputs.csv.gz"));
const sampleLines = new TextDecoder().decode(gunzipSync(sampleGz)).trimEnd().split("\n");
const sampleRows = sampleLines.slice(1).map((l) => {
  const [date, series, value, kind, runs] = l.split(",") as [string, string, string, "source" | "calculated", string];
  return { date, series, value, kind, runs: new Set(runs.split(";").map(Number)) };
});

// One field of the replayed row and of the published row, as canonical JSON.
const replayedField = (o: ReplayOutcome, field: string): string => o.fields[field]!;
const publishedField = (row: PublishedAsofRow, field: string): string => canonicalStringify((row as unknown as Record<string, unknown>)[field] ?? null);

describe("regime replay of a committed sample of published production runs (issue 1431)", () => {
  test("the sample fixture is the one its record names", () => {
    expect(new Bun.CryptoHasher("sha256").update(sampleGz).digest("hex")).toBe(sample.inputsSha256Gz);
    expect(sampleLines[0]).toBe("date,series,value,kind,runs");
    expect(sample.runs.length).toBeGreaterThanOrEqual(2);
    for (const r of sample.runs) expect(r.asof >= LEDGER_START).toBe(true);
  });

  for (const run of sample.runs) {
    test(`run ${run.runKey} (as of ${run.asof}) replays to its published as-of row`, () => {
      const mine = sampleRows
        .filter((r) => r.runs.has(run.index))
        .map(({ date, series, value, kind }) => ({ date, series, value, kind }))
        .sort((a, b) => (a.series < b.series ? -1 : a.series > b.series ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      expect(mine.length).toBe(run.inputRows);
      const text = serializeInputs(mine, "csv");
      expect(new Bun.CryptoHasher("sha256").update(text).digest("hex")).toBe(run.inputSha256);

      const poison = poisonNetwork("during replay");
      let outcome;
      try {
        outcome = replayPublishedRun(text, run.asof, run.publishedAsofRow);
      } finally {
        poison.restore();
      }
      expect(poison.attempts).toEqual([]);
      expect({ run: run.runKey, asof: run.asof, label: outcome.replayLabel }).toEqual({ run: run.runKey, asof: run.asof, label: run.publishedAsofRow.regime });
      // Every other field: the outcome recorded from the full record. A pre-1421
      // run's numbers can differ from what it published (fresh Yahoo values,
      // packages/analyst-sdk/README.md); those differences are named in the
      // fixture. Since D78 the comparison is up to rounding: the fields that
      // differ beyond rounding are exactly the recorded ones, the recorded first
      // difference reproduces (its published side exactly, its replay side up to
      // rounding), and any other differing field moved only by rounding. The
      // recorded replaySha256 pinned the pre-D78 arithmetic; it is no longer
      // reproducible and a re-recorded sample (scripts/published-replay-sample.ts)
      // would pin the new one.
      expect({ run: run.runKey, beyondRounding: outcome.beyondRounding }).toEqual({ run: run.runKey, beyondRounding: run.replayDiffering });
      if (run.replayFirstDiff === null) {
        expect(outcome.beyondRounding).toEqual([]);
      } else {
        const recorded = run.replayFirstDiff;
        expect(outcome.differing).toContain(recorded.field);
        const firstMaterial = outcome.beyondRounding[0]!;
        expect(firstMaterial).toBe(recorded.field);
        expect(numericDiff(recorded.replay, replayedField(outcome, recorded.field)).differences).toEqual([]);
        expect(publishedField(run.publishedAsofRow, recorded.field)).toBe(recorded.published);
      }
      if (run.replayDiffering.length > 0) console.log(`run ${run.runKey} as of ${run.asof}: label matches; recorded pre-1421 differences in ${run.replayDiffering.join(", ")}`);
    }, 120_000);
  }
});
