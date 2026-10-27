// Issue 1421 (with issue 1182): every published regime run replays to its own
// published record. The ledger keeps each run's frozen inputs (its data
// vintage) and its published output (the regime_snapshots artifact) from
// 2026-09-21, when the run ledger began (migrations 0058/0059;
// docs/technical/regime-engine.md §8.1). For EVERY regime run in the database
// with an as-of day on or after 2026-09-21, this test rebuilds the analyst SDK
// input from that run's vintage ALONE, replays it through runRegime with the
// network poisoned, and asserts the as-of label (and composite, exactly) equal
// the run's published row.
//
// The runs here are made by the production orchestrator over real persistence:
// a base day, a day whose provider serves within-tolerance jitter plus material
// revisions, and a day back on the base values. Before the AN-15 fix the jitter
// day published figures computed from values no vintage holds, so its replay
// could not reproduce its composite.
//
// The production record itself (every run since 2026-09-21) is not in CI: no
// test may reach the production database. Issue 1431 replays it from the
// format 1 backups (D72): every run in regime-replay-archive.test.ts against a
// local copy, and a committed sample of runs in the second describe below.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { sql } from "../src/db/client.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { loadFrozenVintage } from "../src/analytics/store/run-ledger-store.ts";
import { noopTelemetrySink } from "../src/analytics/telemetry.ts";
import { INDICATORS } from "../src/analytics/analyze/indicators.ts";
import { LEDGER_EXTRA_KEYS } from "../src/analytics/extras.ts";
import type { RawIndicatorHistory } from "../src/analytics/types.ts";
import { runRegime } from "../../packages/analyst-sdk/src/run.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { baseObservations, poisonedSource, secondObservations, type Observations } from "./support/committed-inputs.ts";
import { poisonNetwork } from "./support/network-poison.ts";
import { replayPublishedRun, type PublishedAsofRow } from "./support/published-replay.ts";
import { serializeInputs } from "../../packages/analyst-sdk/src/archive/format1.ts";

useCleanDatabase(import.meta.file);

const LEDGER_START = "2026-09-21";
const REGISTRY_KEYS = new Map(INDICATORS.map((i) => [`raw_indicator_history:${i.id}`, i.id]));
const EXTRA_KEYS = new Map<string, string>(Object.values(LEDGER_EXTRA_KEYS).map((x) => [x.ledgerKey, x.inputId]));

/** The analyst SDK input a vintage's members describe: registry indicators and the backtest extras. */
function sdkInputFromVintage(members: { sourceKey: string; marketDate: string | null; value: number }[]): RawIndicatorHistory {
  const out: RawIndicatorHistory = {};
  for (const m of members) {
    const id = REGISTRY_KEYS.get(m.sourceKey) ?? EXTRA_KEYS.get(m.sourceKey);
    if (!id || m.marketDate === null) continue;
    (out[id] ??= []).push({ date: m.marketDate, value: m.value });
  }
  for (const id in out) out[id]!.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

async function publish(asof: string, obs: Observations): Promise<void> {
  const source = poisonedSource(obs, 2);
  try {
    await runAnalytics(asof, "regime", source, directAnalyticsPersistence, noopTelemetrySink);
  } finally {
    source.restore();
  }
}

describe("regime replay of every published run from 2026-09-21", () => {
  test("as-of labels and composites replayed from each run's frozen vintage equal its published record", async () => {
    const base = await baseObservations();
    await publish("2026-09-21", base);
    await publish("2026-09-22", secondObservations(base));
    await publish("2026-09-23", base);

    const runs = await sql<{ id: string; asof: string; vintage_id: string; payload_bytes: Uint8Array }[]>`
      SELECT r.id::text AS id, r.asof::text AS asof, v.id::text AS vintage_id, o.payload_bytes
      FROM analytics_ledger_runs r
      JOIN analytics_data_vintages v ON v.run_id = r.id AND v.tool_id = r.tool_id
      JOIN analytics_output_snapshots o ON o.run_id = r.id AND o.artifact_kind = 'regime_snapshots'
      WHERE r.tool_id = 'regime' AND r.asof >= ${LEDGER_START}::date
      ORDER BY r.asof, r.id`;
    expect(runs.map((r) => r.asof)).toEqual(["2026-09-21", "2026-09-22", "2026-09-23"]);

    const poison = poisonNetwork("during replay");
    try {
      for (const run of runs) {
        const published = (JSON.parse(new TextDecoder().decode(run.payload_bytes)) as { date: string; regime: string | null; composite: number | null }[])
          .find((row) => row.date === run.asof);
        expect(published, `run ${run.id} published no row for its as-of day ${run.asof}`).toBeDefined();
        expect(published!.regime).not.toBeNull();

        const vintage = await loadFrozenVintage(run.vintage_id);
        const input = sdkInputFromVintage(vintage!.members);
        expect(Object.keys(input).length).toBe(INDICATORS.length + 3);
        const replay = runRegime(input, { asof: run.asof });
        const last = replay.dateAxis.length - 1;
        expect(replay.dateAxis[last]).toBe(run.asof);
        expect({ run: run.id, asof: run.asof, label: replay.result.regime[last] }).toEqual({ run: run.id, asof: run.asof, label: published!.regime });
        expect(replay.result.composite[last]).toBe(published!.composite!);
      }
    } finally {
      poison.restore();
    }
    expect(poison.attempts).toEqual([]);
  }, 300_000);
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
// the published label, and every other field must give exactly the outcome
// recorded from the full record (no tolerance).
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
      // Every other field: exactly the outcome recorded from the full record. A
      // pre-1421 run's numbers can differ from what it published (fresh Yahoo
      // values, packages/analyst-sdk/README.md); those differences are named in
      // the fixture and the whole replayed row is pinned by hash, so nothing is
      // tolerated: any changed value, or a different set of differing fields, fails.
      expect({ run: run.runKey, differing: outcome.differing, firstDiff: outcome.firstDiff, replaySha256: outcome.replaySha256 }).toEqual({
        run: run.runKey,
        differing: run.replayDiffering,
        firstDiff: run.replayFirstDiff,
        replaySha256: run.replaySha256,
      });
      if (run.replayDiffering.length > 0) console.log(`run ${run.runKey} as of ${run.asof}: label matches; recorded pre-1421 differences in ${run.replayDiffering.join(", ")}`);
    }, 120_000);
  }
});
