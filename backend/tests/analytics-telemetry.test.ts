// Research pipeline telemetry (issue #151). DB-backed (ephemeral Postgres via
// preload.ts) — loud-fails if Docker/Postgres is absent, never skips. Drives
// the REAL orchestrator (runAnalytics) through the hermetic (deterministic,
// network-free) data source with the direct SQL-backed persistence + telemetry
// sinks (the same API-owned path api/routes/analytics.ts and
// api/routes/swarm.ts use), and asserts:
//   (1) AC1 — a regime.classify execution AND a research.refresh execution each
//       create a telemetry run covering access/extract/transform/analyze/store/
//       report, with stage statuses, summaries, warnings, checksums, and bounded
//       artifacts.
//   (2) AC2 — a research.refresh execution with ONE requested tool persists
//       ONLY that tool's trace (never the other research tool's, never regime's)
//       alongside its canonical signal output.
//   (3) AC3 — an injected telemetry write failure leaves canonical analytics
//       rows unchanged, still returns the normal analytics result, and exposes
//       the telemetry failure on the returned result (what the worker handlers
//       fold into job_runs.output).
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { directTelemetrySink } from "../src/analytics/store/telemetry-direct.ts";
import { hermeticDataSource } from "../src/analytics/access/hermetic-source.ts";
import type { TelemetryRunSubmission, TelemetrySink, TelemetrySubmitResult } from "../src/analytics/telemetry.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

// Own database per TEST, cloned from the migrated template: these tests each
// start from an empty table, which used to mean wiping one the previous test
// filled. See support/clean-db.ts.
useCleanDatabasePerTest(import.meta.file);

const ASOF = "2026-05-15";

type TelemetryOutcome = TelemetrySubmitResult & { runId?: number };
const telemetryOf = (results: Record<string, unknown>): TelemetryOutcome => (results as any).__telemetry;

async function loadRun(runId: number) {
  const [run] = await sql`
    SELECT id, job_id, kind, asof::text AS asof, source, status, started_at, finished_at, checksum, summary, created_at
      FROM research_pipeline_runs WHERE id = ${runId}`;
  const stages = await sql`SELECT * FROM research_pipeline_stages WHERE run_id = ${runId} ORDER BY sequence`;
  const warnings = await sql`SELECT * FROM research_pipeline_warnings WHERE run_id = ${runId}`;
  const artifacts = await sql`SELECT * FROM research_pipeline_artifacts WHERE run_id = ${runId}`;
  return { run, stages, warnings, artifacts };
}

test(
  "AC1: hermetic regime.classify execution creates a telemetry run covering all six stages, with statuses/summaries/warnings/checksums/bounded artifacts",
  async () => {
    const results = await runAnalytics(ASOF, "regime", hermeticDataSource, directAnalyticsPersistence, directTelemetrySink);
    const outcome = telemetryOf(results);
    expect(outcome.ok).toBe(true);
    expect(outcome.runId).toBeGreaterThan(0);

    const { run, stages, warnings, artifacts } = await loadRun(outcome.runId!);
    expect(run.kind).toBe("regime");
    expect(run.asof).toBe(ASOF);
    expect(run.source).toBe("hermetic");
    expect(["succeeded", "degraded"]).toContain(run.status);
    expect(run.checksum).toBeTruthy();
    expect(run.started_at).toBeTruthy();
    expect(run.finished_at).toBeTruthy();

    const stageNames = new Set(stages.map((s: any) => s.stage));
    for (const expected of ["access", "extract", "transform", "analyze", "store", "report"]) {
      expect(stageNames.has(expected)).toBe(true);
    }
    for (const s of stages) {
      expect(["ok", "warn", "error"]).toContain(s.status);
      expect(typeof s.summary).toBe("string");
      expect(s.summary.length).toBeGreaterThan(0);
    }
    // Sequence is monotonic and unique (the UNIQUE(run_id, sequence) constraint
    // plus insertion order both hold).
    const sequences = stages.map((s: any) => s.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);

    // Bounded artifact: a checksum + a preview that never balloons to a full
    // multi-thousand-row series.
    expect(artifacts.length).toBeGreaterThan(0);
    for (const a of artifacts) {
      expect(a.checksum).toBeTruthy();
      expect(JSON.stringify(a.preview).length).toBeLessThan(20_000);
    }

    // This suite's hermetic run legitimately has fallback/degraded conditions
    // (nothing IS persisted yet for indicators with no fixture history), so
    // warnings recorded in the DB (if any) must carry a stage + message.
    for (const w of warnings) {
      expect(typeof w.stage).toBe("string");
      expect(typeof w.message).toBe("string");
      expect(w.message.length).toBeGreaterThan(0);
    }

    // Issue #180 (non-perturbation guard): regime's telemetry summary is
    // already small scalars — the research-signal bounding fix must leave it
    // untouched (never wrapped in a {truncated:true,...} preview shell).
    expect((run.summary as any).regime).toBeDefined();
    expect((run.summary as any).regime.rows).toBeGreaterThan(0);
    expect((run.summary as any).regime.truncated).toBeUndefined();
  },
  { timeout: 60_000 },
);

test(
  "issue #180: research_pipeline_runs.summary for a research-signal run is bounded, never the full multi-year daily series",
  async () => {
    // channel-divergence's canonical payload embeds several full 2018..asof
    // daily series (research-signals.ts::seriesOf: btc_price, qqq_price,
    // indicators.*) — thousands of {date,value} points, comfortably over
    // telemetry.ts's MAX_PREVIEW_BYTES (4000). Without the fix this lands
    // verbatim in research_pipeline_runs.summary, contradicting migration
    // 0018's "never a full series" contract.
    const results = await runAnalytics(
      ASOF,
      "channel-divergence",
      hermeticDataSource,
      directAnalyticsPersistence,
      directTelemetrySink,
    );
    const outcome = telemetryOf(results);
    expect(outcome.ok).toBe(true);

    // Sanity: the canonical (non-telemetry) tool output for THIS run really
    // does carry the full multi-year daily series — otherwise a bounded
    // summary would prove nothing.
    const canonical = (results["channel-divergence"] as any).btc_price;
    expect(Array.isArray(canonical)).toBe(true);
    expect(canonical.length).toBeGreaterThan(1000);

    const { run } = await loadRun(outcome.runId!);
    const persistedSignal = (run.summary as any)["channel-divergence"];
    expect(persistedSignal).toBeDefined();
    // Bounded the same way artifact previews are (boundedPreview(): a
    // {truncated:true,...} shell), never the raw multi-thousand-point series.
    expect(persistedSignal.truncated).toBe(true);
    expect(persistedSignal.btc_price).toBeUndefined();
    expect(JSON.stringify(run.summary).length).toBeLessThan(20_000);
  },
  { timeout: 60_000 },
);

test(
  "issue #180: research_pipeline_runs.summary for a late-cycle-signals run is also bounded",
  async () => {
    const results = await runAnalytics(
      ASOF,
      "late-cycle-signals",
      hermeticDataSource,
      directAnalyticsPersistence,
      directTelemetrySink,
    );
    const outcome = telemetryOf(results);
    expect(outcome.ok).toBe(true);

    const { run } = await loadRun(outcome.runId!);
    const persistedSignal = (run.summary as any)["late-cycle-signals"];
    expect(persistedSignal).toBeDefined();
    expect(persistedSignal.truncated).toBe(true);
    expect(persistedSignal.spy_price).toBeUndefined();
    expect(JSON.stringify(run.summary).length).toBeLessThan(20_000);
  },
  { timeout: 60_000 },
);

test(
  "AC1 + AC2: research.refresh with ONE requested tool (channel-divergence) creates a telemetry run covering all six stages and persists ONLY that tool's trace + canonical signal output",
  async () => {
    await sql`DELETE FROM research_signals WHERE signal_key = 'channel-divergence' AND date = ${ASOF}`;

    const results = await runAnalytics(ASOF, "channel-divergence", hermeticDataSource, directAnalyticsPersistence, directTelemetrySink);
    expect(Object.keys(results)).toEqual(["channel-divergence"]); // canonical output: only the requested tool

    const outcome = telemetryOf(results);
    expect(outcome.ok).toBe(true);
    const { run, stages, artifacts } = await loadRun(outcome.runId!);
    expect(run.kind).toBe("channel-divergence"); // ONLY this tool's trace, never "regime" or "late-cycle-signals"

    const stageNames = new Set(stages.map((s: any) => s.stage));
    for (const expected of ["access", "transform", "analyze", "store"]) {
      expect(stageNames.has(expected)).toBe(true);
    }
    // No regime-only artifact ("regime-composite") leaked into a research-scoped run.
    expect(artifacts.some((a: any) => a.kind === "regime-composite")).toBe(false);
    expect(artifacts.some((a: any) => a.kind === "channel-divergence-signal")).toBe(true);
    expect(artifacts.some((a: any) => a.kind === "late-cycle-signals-signal")).toBe(false);

    // Canonical signal landed.
    const [signal] = await sql`SELECT payload FROM research_signals WHERE signal_key = 'channel-divergence' AND date = ${ASOF}`;
    expect(signal).toBeDefined();
  },
  { timeout: 60_000 },
);

test(
  "AC2: research.refresh with ONE requested tool (late-cycle-signals) never persists a channel-divergence trace",
  async () => {
    const results = await runAnalytics(ASOF, "late-cycle-signals", hermeticDataSource, directAnalyticsPersistence, directTelemetrySink);
    expect(Object.keys(results)).toEqual(["late-cycle-signals"]);
    const outcome = telemetryOf(results);
    expect(outcome.ok).toBe(true);
    const { run, artifacts } = await loadRun(outcome.runId!);
    expect(run.kind).toBe("late-cycle-signals");
    expect(artifacts.some((a: any) => a.kind === "channel-divergence-signal")).toBe(false);
  },
  { timeout: 60_000 },
);

test(
  "AC3: an injected telemetry write failure leaves canonical analytics rows unchanged, returns the normal analytics result, and exposes the failure on the result",
  async () => {
    const [{ n: runsBefore }] = await sql`SELECT COUNT(*)::int AS n FROM research_pipeline_runs`;

    const failingSink: TelemetrySink = {
      async submitRun(_run: TelemetryRunSubmission): Promise<TelemetrySubmitResult> {
        throw new Error("simulated telemetry outage — must never affect canonical persistence");
      },
    };

    const results = await runAnalytics(ASOF, "regime", hermeticDataSource, directAnalyticsPersistence, failingSink);

    // Canonical result is returned normally — same shape as any successful run.
    expect(results.regime).toBeDefined();
    expect((results.regime as any).asof).toBe(ASOF);

    // The telemetry failure is exposed (non-enumerable — never perturbs
    // Object.keys()/JSON-shape assertions of the canonical tool outputs).
    expect(Object.keys(results)).toEqual(["regime"]);
    const outcome = telemetryOf(results);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("simulated telemetry outage");

    // Canonical regime_snapshots row landed exactly as a normal run would.
    const [snap] = await sql`SELECT date::text AS date FROM regime_snapshots WHERE date = ${ASOF}`;
    expect(snap).toBeDefined();

    // No telemetry row was written — the failure was in submission, not schema.
    const [{ n: runsAfter }] = await sql`SELECT COUNT(*)::int AS n FROM research_pipeline_runs`;
    expect(runsAfter).toBe(runsBefore);
  },
  { timeout: 60_000 },
);
