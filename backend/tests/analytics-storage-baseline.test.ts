// Issue 1765 storage S0 (AC 15): scripts/ops/analytics-storage-baseline.ts runs
// its queries on a proven read-only session as rm_readonly, here against this
// file's own clean test database. It is never run against production from CI.
//
//   * every named table gets one entry with sizes, an exact row count, dead
//     tuples and its counters, and the report says the server is not a standby;
//   * jsonb column sizes are reported for regime_snapshots (a sampled table) and
//     analytics_overwrite_events (a windowed one);
//   * a seeded regime artifact reports an as-of versus history split in [0, 1];
//   * a write on the session fails with SQLSTATE 25006 (read-only transaction);
//   * proveReadOnly refuses a session whose SHOW transaction_read_only is not
//     `on`, closes it, and runs no further query.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import { REGIME_ARTIFACT_KIND } from "../src/analytics/output-snapshots.ts";
import { saveRawIndicatorHistory } from "../src/analytics/store/raw-history-store.ts";
import { beginRun, freezeVintage } from "../src/analytics/store/run-ledger-store.ts";
import { openReadOnly, proveReadOnly, type ReadOnlySession } from "../../scripts/release/db-read.ts";
import {
  STORAGE_TABLES,
  collectBaseline,
  parseArgs,
  type StorageBaseline,
  type TableBaseline,
} from "../../scripts/ops/analytics-storage-baseline.ts";
import { ROLE_PASSWORD } from "./support/cluster.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { publishNow, researchSignal, richRegimeRow } from "./support/regime-publications.ts";

useCleanDatabase(import.meta.file);

let home = "";
let db: ReadOnlySession | undefined;
let report: StorageBaseline;

/** One acquisition with two values, frozen into one vintage of a run of its own. */
async function seedVintage(): Promise<void> {
  const acquisitionId = randomUUID();
  await sql`
    INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity, knowledge_time)
    VALUES (${acquisitionId}::uuid, 'fixture', 'test:1', 'storage-baseline', '2024-01-01T00:00:00Z'::timestamptz)`;
  await sql`
    INSERT INTO source_acquisition_events (acquisition_id, sequence, event_type)
    VALUES (${acquisitionId}::uuid, 1, 'succeeded')`;
  for (const [day, value] of [["2024-01-01", 1], ["2024-01-02", 2]] as const) {
    await sql`
      INSERT INTO source_value_versions
        (acquisition_id, source_key, market_date, value, prior_version_id, revision_kind, knowledge_time)
      VALUES (${acquisitionId}::uuid, 'storage-baseline:key', ${day}::date, ${value}, NULL, 'initial',
              '2024-01-01T00:00:00Z'::timestamptz)`;
  }
  const { runId, methodologyVersionId } = await beginRun({
    runKey: randomUUID(), asof: "2024-05-31", toolId: "storage-baseline", sourceLabel: "fixture",
    methodology: { toolId: "storage-baseline", versionLabel: "v-test", config: { issue: 1765 } },
    buildIdentity: "storage-baseline-test",
  });
  const vintage = await freezeVintage({
    runId, toolId: "storage-baseline", knowledgeTimeCutoff: "2024-06-01T00:00:00Z", marketTimeCutoff: "2024-05-31",
    methodologyVersionId, buildIdentity: "storage-baseline-test",
  });
  expect(vintage.memberCount).toBeGreaterThan(0);
}

beforeAll(async () => {
  // Every named table gets rows. A published run writes the output artifacts
  // and the regime_snapshots and research_signals rows; a second run changes
  // one regime row, which records an overwrite event.
  const days = ["2041-03-01", "2041-03-02", "2041-03-03"];
  await publishNow({
    asof: days.at(-1)!,
    regime: days.map((d, i) => richRegimeRow(d, 0.4 + i / 10)),
    research: [researchSignal("storage-baseline", days.at(-1)!, "S0 fixture")],
  });
  await publishNow({
    asof: days.at(-1)!,
    regime: days.map((d, i) => richRegimeRow(d, i === 2 ? 0.9 : 0.4 + i / 10)),
    research: [researchSignal("storage-baseline", days.at(-1)!, "S0 fixture, revised")],
  });
  await saveRawIndicatorHistory({ STORAGE_BASELINE: [{ date: "2041-03-01", value: 1 }, { date: "2041-03-02", value: 2 }] }, undefined, "live");
  await seedVintage();

  // The script's session: rm_readonly from $HOME/.env, as on stage-2, with
  // HOME pointed at a temp directory whose .env names this test database.
  const [{ database }] = (await sql`SELECT current_database() AS database`) as unknown as { database: string }[];
  const port = new URL(process.env.DATABASE_URL!).port;
  home = mkdtempSync(join(tmpdir(), "rm-storage-baseline-"));
  writeFileSync(
    join(home, ".env"),
    [`host = localhost`, `port = ${port}`, `database = ${database}`, `sslmode = disable`, `rm_readonly = ${ROLE_PASSWORD()}`, ""].join("\n"),
    { mode: 0o600 },
  );
  db = await openReadOnly({ HOME: home });
  report = await collectBaseline(db, { exactCounts: true, samplePercent: 100 });
});

afterAll(async () => {
  await db?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

function entry(table: string): TableBaseline {
  const found = report.tables.find((t) => t.table === table);
  if (!found) throw new Error(`no baseline entry for ${table}`);
  return found;
}

describe("issue 1765 storage S0: the analytics storage baseline", () => {
  test("it reads as rm_readonly on a primary, not a standby", () => {
    expect(db!.target).toMatch(/^rm_readonly@localhost:\d+\//);
    expect(report.target).toBe(db!.target);
    expect(report.in_recovery).toBe(false);
    expect(report.options).toMatchObject({ exact_counts: true, sample_percent: 100, days: 7 });
  });

  test("one entry per named table, each with sizes, an exact row count and dead tuples", () => {
    expect(report.tables.map((t) => t.table)).toEqual([...STORAGE_TABLES]);
    for (const t of report.tables) {
      expect(t.exists).toBe(true);
      for (const figure of [t.total_bytes, t.heap_bytes, t.index_bytes, t.toast_bytes, t.n_live_tup, t.n_dead_tup, t.n_tup_ins, t.n_tup_upd, t.n_tup_hot_upd, t.n_tup_del]) {
        expect(typeof figure).toBe("number");
      }
      expect(t.total_bytes!).toBeGreaterThan(0);
      expect(t.total_bytes!).toBeGreaterThanOrEqual(t.heap_bytes! + t.index_bytes!);
      expect(typeof t.exact_count).toBe("number");
      expect(t.exact_count!).toBeGreaterThan(0);
      expect(t.counters_unavailable).toBeNull();
      expect(t.column_sizes).not.toBeNull();
      expect(t.growth).not.toBeNull();
    }
  });

  test("jsonb column sizes for regime_snapshots (sampled) and analytics_overwrite_events (windowed)", () => {
    const regime = entry("regime_snapshots").column_sizes!;
    expect(regime.scan).toEqual({ mode: "sample", sample_percent: 100 });
    const indicators = regime.columns.find((c) => c.column === "indicators");
    expect(indicators).toMatchObject({ type: "jsonb" });
    expect(indicators!.values).toBeGreaterThan(0);
    expect(indicators!.sum_bytes).toBeGreaterThan(0);
    expect(indicators!.max_bytes!).toBeGreaterThan(0);
    expect(indicators!.avg_bytes!).toBeGreaterThan(0);

    const events = entry("analytics_overwrite_events").column_sizes!;
    expect(events.scan).toMatchObject({ mode: "window", column: "recorded_at" });
    const previous = events.columns.find((c) => c.column === "previous_row");
    expect(previous).toMatchObject({ type: "jsonb" });
    expect(previous!.values).toBeGreaterThan(0);
    expect(previous!.sum_bytes).toBeGreaterThan(0);

    const outputs = entry("analytics_output_snapshots").column_sizes!;
    expect(outputs.columns.find((c) => c.column === "payload_bytes")).toMatchObject({ type: "bytea" });
  });

  test("daily growth for the timestamped tables, counters since stats_reset for the current views", () => {
    const outputs = entry("analytics_output_snapshots").growth!;
    expect(outputs.mode).toBe("daily");
    if (outputs.mode !== "daily") throw new Error("unreachable");
    expect(outputs.days.some((d) => d.artifact_kind === REGIME_ARTIFACT_KIND.main && Number(d.rows) >= 2)).toBe(true);

    const members = entry("analytics_vintage_members").growth!;
    expect(members).toMatchObject({ mode: "daily", by: "analytics_data_vintages.created_at" });

    const events = entry("analytics_overwrite_events").growth!;
    if (events.mode !== "daily") throw new Error("analytics_overwrite_events growth is not daily");
    expect(events.days.some((d) => d.table_name === "regime_snapshots" && Number(d.rows) >= 1)).toBe(true);

    for (const table of ["regime_snapshots", "research_signals", "raw_indicator_history"]) {
      const growth = entry(table).growth!;
      expect(growth.mode).toBe("counters_since_stats_reset");
      if (growth.mode !== "counters_since_stats_reset") throw new Error("unreachable");
      expect(typeof growth.n_tup_ins).toBe("number");
      expect(growth.counters_unavailable).toBeNull();
    }
  });

  test("a seeded regime artifact reports an as-of versus history split in [0, 1]", () => {
    const split = report.artifact_split.find((s) => s.artifact_kind === REGIME_ARTIFACT_KIND.main);
    expect(split).toBeDefined();
    expect(split!.artifacts).toBeGreaterThanOrEqual(2);
    expect(split!.asof_bytes).toBeGreaterThan(0);
    expect(split!.total_bytes).toBeGreaterThan(split!.asof_bytes);
    for (const ratio of [split!.ratio, split!.min_ratio, split!.avg_ratio, split!.max_ratio]) {
      expect(typeof ratio).toBe("number");
      expect(ratio!).toBeGreaterThanOrEqual(0);
      expect(ratio!).toBeLessThanOrEqual(1);
    }
    // Three rows of about the same size: the as-of row is about a third.
    expect(split!.ratio!).toBeGreaterThan(0.2);
    expect(split!.ratio!).toBeLessThan(0.5);
  });

  test("a write on the session fails: CREATE TEMP TABLE is refused with SQLSTATE 25006", async () => {
    let refusal: { errno?: string; message?: string } | null = null;
    try {
      await db!.query("CREATE TEMP TABLE storage_baseline_write_probe (i int)");
    } catch (error) {
      refusal = error as { errno?: string; message?: string };
    }
    expect(refusal?.errno).toBe("25006");
    expect(refusal?.message).toMatch(/read-only transaction/);
  });

  test("proveReadOnly refuses a session that is not read-only, closes it and runs no further query", async () => {
    const statements: string[] = [];
    let closed = 0;
    const query = async (text: string): Promise<Record<string, unknown>[]> => {
      statements.push(text);
      return text.startsWith("SHOW") ? [{ transaction_read_only: "off" }] : [];
    };
    await expect(proveReadOnly(query, async () => { closed += 1; }, "rm_readonly@fake:5432/db")).rejects.toThrow(
      "the session to rm_readonly@fake:5432/db is not read-only; refusing to read",
    );
    expect(statements).toEqual(["SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY", "SHOW transaction_read_only"]);
    expect(closed).toBe(1);

    // And the control: an `on` answer passes and closes nothing.
    statements.length = 0;
    await proveReadOnly(async (text) => {
      statements.push(text);
      return text.startsWith("SHOW") ? [{ transaction_read_only: "on" }] : [];
    }, async () => { closed += 1; });
    expect(statements).toHaveLength(2);
    expect(closed).toBe(1);
  });

  test("the command line takes only the documented options, validated", () => {
    expect(parseArgs([])).toEqual({});
    expect(parseArgs(["--days", "3", "--sample-percent", "0.5", "--exact-counts"])).toEqual({ days: 3, samplePercent: 0.5, exactCounts: true });
    expect(() => parseArgs(["--days", "1.5"])).toThrow(/days must be an integer/);
    expect(() => parseArgs(["--sample-percent", "0"])).toThrow(/samplePercent must be above 0/);
    expect(() => parseArgs(["--sample-percent", "101"])).toThrow(/samplePercent must be above 0/);
    expect(() => parseArgs(["--days"])).toThrow(/--days needs a value/);
    expect(() => parseArgs(["--host", "x"])).toThrow(/unknown argument/);
  });
});
