// Issue 1765 (phase 3, AC 17): one producer regime tick extracts once.
//
// A tick runs the main line (v4) and the methodology published beside it (v5)
// over the real direct persistence and the committed-input fixture source
// (tests/support/committed-inputs.ts poisonedSource, plus the five collected
// series v5 reads). The source records every call and every acquisition, and
// poisons every HTTP client and every further source call once its two
// extract calls (the registry fetch and the backtest extras) return. The
// persistence is wrapped in counting fakes over the real one: the committed
// read, the floor read and the floor write.
//
// It asserts that one tick:
//   - makes ONE acquisition pass (each series acquired once, no source call
//     after extract) and ONE committed read, for both models;
//   - freezes both runs' vintages at the same knowledge_time_cutoff, the read's
//     database clock (red control: two reads of the same keys get two clocks);
//   - writes no raw_indicator_history point when the fetched values equal the
//     floor: every row's xmin is unchanged and the floor write received 0
//     points (red control: the first tick wrote the whole floor);
//   - keeps the main line's run whole when the beside run throws, or cannot
//     begin: its result deep-equals a tick without the beside model, and its
//     regime artifact has the same checksum.
//
// Every test carries its own timeout: a first v5 run walks forward from the
// axis start (CI runs bun test with --timeout=30000).
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { noopTelemetrySink } from "../src/analytics/telemetry.ts";
import { CURRENT_REGIME_VERSION, type RegimeVersion } from "../src/analytics/analyze/regime-versions.ts";
import type { AnalyticsPersistence, CommittedInputs } from "../src/analytics/persistence.ts";
import { runProducerOnce } from "../src/producer/index.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { liveOn, poisonedSource, type Observations, type PoisonedSource } from "./support/committed-inputs.ts";
import { ASOF, FIVE_KEYS, artifactKinds, v5Observations } from "./support/regime-v5.ts";

useCleanDatabasePerTest(import.meta.file);

// The extract calls of a tick: the registry fetch and the backtest extras (the
// fixture source collects no model portfolio inventory).
const EXTRACT_CALLS = ["fetchIndicators", "fetchBacktestExtras"];

interface Counted {
  persistence: AnalyticsPersistence;
  /** Each committed read: what the tick named. */
  committedReads: { asof: string; knownBy?: string; methodology?: string | readonly string[] }[];
  floorReads: number;
  /** The points each floor write received. */
  floorWrites: number[];
}

/** The real persistence (or `base`), with the committed read, the floor read and the floor write counted. */
function counting(base: AnalyticsPersistence = directAnalyticsPersistence): Counted {
  const out: Counted = { persistence: base, committedReads: [], floorReads: 0, floorWrites: [] };
  out.persistence = {
    ...base,
    async loadCommittedInputs(asof, knownBy, methodology): Promise<CommittedInputs> {
      out.committedReads.push({ asof, ...(knownBy === undefined ? {} : { knownBy }), ...(methodology === undefined ? {} : { methodology }) });
      return base.loadCommittedInputs!(asof, knownBy, methodology);
    },
    async loadRawHistory() {
      out.floorReads++;
      return base.loadRawHistory();
    },
    async saveRawHistory(byIndicator, source) {
      out.floorWrites.push(Object.values(byIndicator).reduce((n, pts) => n + pts.length, 0));
      return base.saveRawHistory(byIndicator, source);
    },
  };
  return out;
}

/** One producer regime tick for ASOF, live on that day, with a fresh fixture source that poisons after extract. */
async function tick(obs: Observations, persistence: AnalyticsPersistence, versions?: readonly RegimeVersion[]): Promise<{ result: Record<string, any>; source: PoisonedSource }> {
  const source = poisonedSource(obs, EXTRACT_CALLS.length);
  try {
    const result = await runProducerOnce("regime", ASOF, {
      source,
      persistence,
      tick: { telemetry: noopTelemetrySink, ...liveOn(ASOF), ...(versions ? { versions } : {}) },
    });
    return { result: result as Record<string, any>, source };
  } finally {
    source.restore();
  }
}

interface LedgerRunRow {
  id: string;
  label: string;
}

/** Every ledger run, in begin order, with its methodology label. */
const ledgerRuns = () =>
  sql<LedgerRunRow[]>`
    SELECT r.id::text AS id, m.version_label AS label FROM analytics_ledger_runs r
      JOIN analytics_ledger_methodology_versions m ON m.id = r.methodology_version_id ORDER BY r.id`;

const runEvents = async (runId: string) =>
  (await sql<{ event_type: string }[]>`SELECT event_type FROM analytics_ledger_run_events WHERE run_id = ${runId}::bigint ORDER BY sequence`).map((e) => e.event_type);

/** The checksum of a run's main-line regime artifact. */
async function regimeChecksum(runId: string): Promise<string> {
  const [row] = await sql<{ checksum: string }[]>`SELECT checksum FROM analytics_output_snapshots WHERE run_id = ${runId}::bigint AND artifact_kind = 'regime_snapshots'`;
  return row!.checksum;
}

/** The main-line run of the latest tick (the newest v4 run). */
async function newestMainRun(): Promise<string> {
  const runs = await ledgerRuns();
  return runs.filter((r) => r.label === CURRENT_REGIME_VERSION).at(-1)!.id;
}

const floorRows = () => sql`SELECT indicator, date::text AS date, value, xmin::text AS xmin FROM raw_indicator_history ORDER BY indicator, date`;

let errors: string[] = [];
let errorSpy: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  errors = [];
  errorSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
});
afterEach(() => {
  errorSpy?.mockRestore();
  errorSpy = null;
});

describe("one producer regime tick with v4 on the main line and v5 beside it (issue 1765, AC 17)", () => {
  test("makes one acquisition pass and one committed read, freezes both vintages at one cutoff, and a repeat of the floor writes no raw point", async () => {
    const obs = await v5Observations();
    const first = counting();
    const { result, source } = await tick(obs, first.persistence);

    // Both models ran, each its own ledger run, the main line first.
    const runs = await ledgerRuns();
    expect(runs.map((r) => r.label)).toEqual(["v4", "v5"]);
    const main = runs[0]!;
    const beside = runs[1]!;
    expect(await artifactKinds(main.id)).toEqual(["regime_snapshots", "research_signals"]);
    expect(await artifactKinds(beside.id)).toEqual(["regime_beside_snapshots", "regime_snapshots", "research_signals"]);
    expect((await runEvents(beside.id)).at(-1)).not.toBe("failed");
    // The tick answers with the main-line run.
    expect(result.regime.asof).toBe(ASOF);
    expect(result.regime.methodology).toBeUndefined();
    expect(errors.filter((e) => e.includes("regime failed"))).toEqual([]);

    // ONE acquisition pass: the two extract calls, and every series acquired once.
    expect(source.calls).toEqual(EXTRACT_CALLS);
    expect(source.afterExtract).toEqual([]);
    const keys = source.acquired.map((a) => a.evidence.cacheIdentity);
    expect(keys.length).toBeGreaterThan(30);
    expect(keys.length).toBe(new Set(keys).size);
    for (const key of [...FIVE_KEYS, "raw_indicator_history:VIX", "backtest:^GSPC", "backtest:ETH-USD", "backtest:DTB3"]) expect({ key, acquired: keys.includes(key) }).toEqual({ key, acquired: true });

    // ONE committed read, naming both models, and one floor read.
    expect(first.committedReads).toEqual([{ asof: ASOF, methodology: ["v4", "v5"] }]);
    expect(first.floorReads).toBe(1);

    // Both vintages freeze the read's one database clock.
    const vintages = await sql<{ run_id: string; cutoff: string }[]>`
      SELECT run_id::text AS run_id, knowledge_time_cutoff::text AS cutoff FROM analytics_data_vintages ORDER BY run_id`;
    expect(vintages.map((v) => v.run_id)).toEqual([main.id, beside.id]);
    expect(vintages[0]!.cutoff).toBe(vintages[1]!.cutoff);
    // Red control: two reads of the same keys (the per-run reads of a tick
    // before phase 3) answer two different database clocks.
    const a = await directAnalyticsPersistence.loadCommittedInputs!(ASOF);
    const b = await directAnalyticsPersistence.loadCommittedInputs!(ASOF, undefined, "v5");
    expect(a.knowledgeTimeCutoff).not.toBe(b.knowledgeTimeCutoff);

    // The floor: the first tick wrote it whole (red control for the count below).
    expect(first.floorWrites.length).toBe(1);
    expect(first.floorWrites[0]!).toBeGreaterThan(1000);
    const before = await floorRows();
    expect(before.length).toBe(first.floorWrites[0]!);

    // A second tick whose provider serves the values the floor holds writes nothing.
    const second = counting();
    const again = await tick(obs, second.persistence);
    expect(again.source.calls).toEqual(EXTRACT_CALLS);
    expect(second.committedReads.length).toBe(1);
    expect(second.floorReads).toBe(1);
    expect(second.floorWrites.reduce((n, p) => n + p, 0)).toBe(0);
    expect(await floorRows()).toEqual(before);
    // It still computed both models from the ledger, as the first tick did.
    expect((await ledgerRuns()).map((r) => r.label)).toEqual(["v4", "v5", "v4", "v5"]);
    expect(again.result.regime).toEqual(result.regime);
  }, 900_000);

  test("a beside run that throws leaves the main-line run's result and artifact as a tick without the beside model", async () => {
    const obs = await v5Observations();
    const alone = await tick(obs, directAnalyticsPersistence, [CURRENT_REGIME_VERSION]);
    expect((await ledgerRuns()).map((r) => r.label)).toEqual(["v4"]);
    const aloneChecksum = await regimeChecksum(await newestMainRun());

    // The beside run fails inside its own compute: its kept-days read throws.
    const throwing: AnalyticsPersistence = {
      ...directAnalyticsPersistence,
      loadKeptRegimeDays: async () => {
        throw new Error("beside run failed on purpose");
      },
    };
    const withBeside = await tick(obs, throwing);
    expect(withBeside.result).toEqual(alone.result);
    expect(await regimeChecksum(await newestMainRun())).toBe(aloneChecksum);

    // The beside run really ran and really failed, and was logged as such.
    const runs = await ledgerRuns();
    expect(runs.map((r) => r.label)).toEqual(["v4", "v4", "v5"]);
    expect(await runEvents(runs[2]!.id)).toEqual(["started", "failed"]);
    expect(await artifactKinds(runs[2]!.id)).toEqual(["exceptions", "logs", "warnings"]);
    expect(errors.some((e) => e.includes("regime failed for methodology v5") && e.includes("beside run failed on purpose"))).toBe(true);
    // One extract for the tick, though one of its runs failed.
    expect(withBeside.source.calls).toEqual(EXTRACT_CALLS);
  }, 600_000);

  test("a beside run whose beginRun throws is dropped, and the main-line run's result and artifact are a tick without it", async () => {
    const obs = await v5Observations();
    const alone = await tick(obs, directAnalyticsPersistence, [CURRENT_REGIME_VERSION]);
    const aloneChecksum = await regimeChecksum(await newestMainRun());

    const refusing: AnalyticsPersistence = {
      ...directAnalyticsPersistence,
      async beginRun(input) {
        if (input.methodology.versionLabel !== CURRENT_REGIME_VERSION) throw new Error(`beginRun refused for ${input.methodology.versionLabel}`);
        return directAnalyticsPersistence.beginRun(input);
      },
    };
    const counted = counting(refusing);
    const withBeside = await tick(obs, counted.persistence);
    expect(withBeside.result).toEqual(alone.result);
    expect(await regimeChecksum(await newestMainRun())).toBe(aloneChecksum);

    // No v5 run exists: it never began, and the tick read only the main line's keys.
    expect((await ledgerRuns()).map((r) => r.label)).toEqual(["v4", "v4"]);
    expect(counted.committedReads).toEqual([{ asof: ASOF, methodology: ["v4"] }]);
    expect(errors.some((e) => e.includes("regime failed for methodology v5") && e.includes("beginRun refused for v5"))).toBe(true);
  }, 600_000);
});
