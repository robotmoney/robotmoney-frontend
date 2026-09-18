// Phase A research-integrity evidence (issue #974), exercised against real
// migrated PostgreSQL. Current-view writers keep their existing upsert
// semantics; database triggers atomically preserve every material old/new row.
import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import postgres from "postgres";
import { saveRawIndicatorHistory } from "../src/analytics/store/raw-history-store.ts";
import { saveRegimeSnapshots } from "../src/analytics/store/regime-store.ts";
import { persistResearchSignal } from "../src/analytics/store/research-store.ts";
import type { ResearchPayload } from "../src/analytics/analyze/research.ts";
import type { RegimeSnapshotRow } from "../src/analytics/store/regime-store.ts";
import { sql } from "../src/db/client.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { POSTGRES_IMAGE } from "../../scripts/lib/postgres-image.ts";

useCleanDatabase(import.meta.file);

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MIGRATION = "0056_analytics_overwrite_events.sql";

interface OverwriteEvent {
  table_name: string;
  operation: "update" | "delete";
  natural_key: Record<string, unknown>;
  previous_row: Record<string, unknown>;
  replacement_row: Record<string, unknown> | null;
  recorded_at: Date | string;
}

async function events(table: string, key: Record<string, unknown>): Promise<OverwriteEvent[]> {
  return await sql<OverwriteEvent[]>`
    SELECT table_name, operation, natural_key, previous_row, replacement_row, recorded_at
    FROM analytics_overwrite_events
    WHERE table_name = ${table} AND natural_key = ${sql.json(key as never)}
    ORDER BY id`;
}

async function rowJson(table: string, where: string): Promise<Record<string, unknown>> {
  const [row] = await sql.unsafe<{ row: Record<string, unknown> }[]>(
    `SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${where}`,
  );
  if (!row) throw new Error(`missing fixture row in ${table}: ${where}`);
  return row.row;
}

function regime(date: string, composite: number, source: string): RegimeSnapshotRow {
  return {
    date,
    composite,
    compositePercentile: 0.6,
    regime: "neutral",
    macroRegime: "neutral",
    onchainRegime: "risk_on",
    factorRegime: "risk_off",
    source,
    percentiles: { VIX: 0.4 },
    indicators: [{ id: "VIX", name: "vol", panel: "macro", sign: -1, value: 18, score: 0.4, weight: 1 }],
  };
}

function research(asof: string, window: number): ResearchPayload {
  return {
    asof,
    title: "Overwrite evidence",
    question: "Was the stored recommendation revised?",
    spec: { window },
    gauges: [{ id: "G", name: "g", value: window, percentile: 0.5, read: "neutral" }],
    series: { label: "L", points: [{ date: asof, value: window }] },
  };
}

test("a raw-history upsert changes the current row and records the complete old/new rows", async () => {
  const date = "2041-01-02";
  const indicator = "OVERWRITE_RAW_CHANGED";
  await saveRawIndicatorHistory({ [indicator]: [{ date, value: 10 }] }, undefined, "seed");
  const before = await rowJson("raw_indicator_history", `date = '${date}' AND indicator = '${indicator}'`);

  await saveRawIndicatorHistory({ [indicator]: [{ date, value: 12.5 }] }, undefined, "live");
  const after = await rowJson("raw_indicator_history", `date = '${date}' AND indicator = '${indicator}'`);
  const captured = await events("raw_indicator_history", { date, indicator });

  expect(after).toEqual({ date, indicator, value: 12.5, source: "live" });
  expect(captured).toHaveLength(1);
  expect(captured[0]).toMatchObject({
    table_name: "raw_indicator_history",
    operation: "update",
    natural_key: { date, indicator },
    previous_row: before,
    replacement_row: after,
  });
  expect(captured[0]!.recorded_at).toBeTruthy();
});

test("regime and research persistence paths each record exactly one material overwrite", async () => {
  const regimeDate = "2041-01-03";
  await saveRegimeSnapshots([regime(regimeDate, 0.2, "seed")]);
  const regimeBefore = await rowJson("regime_snapshots", `date = '${regimeDate}'`);
  await saveRegimeSnapshots([regime(regimeDate, 0.8, "live")]);
  const regimeAfter = await rowJson("regime_snapshots", `date = '${regimeDate}'`);
  const regimeEvents = await events("regime_snapshots", { date: regimeDate });
  expect(regimeEvents).toHaveLength(1);
  expect(regimeEvents[0]).toMatchObject({
    table_name: "regime_snapshots",
    operation: "update",
    natural_key: { date: regimeDate },
    previous_row: regimeBefore,
    replacement_row: regimeAfter,
  });
  expect(Number(regimeAfter.composite)).toBeCloseTo(0.8, 9);

  const signalDate = "2041-01-04";
  const signalKey = "overwrite-research-changed";
  await persistResearchSignal(signalKey, signalDate, research(signalDate, 20));
  const researchBefore = await rowJson(
    "research_signals",
    `signal_key = '${signalKey}' AND date = '${signalDate}'`,
  );
  await persistResearchSignal(signalKey, signalDate, research(signalDate, 30));
  const researchAfter = await rowJson(
    "research_signals",
    `signal_key = '${signalKey}' AND date = '${signalDate}'`,
  );
  const researchEvents = await events("research_signals", { signal_key: signalKey, date: signalDate });
  expect(researchEvents).toHaveLength(1);
  expect(researchEvents[0]).toMatchObject({
    table_name: "research_signals",
    operation: "update",
    natural_key: { signal_key: signalKey, date: signalDate },
    previous_row: researchBefore,
    replacement_row: researchAfter,
  });
  expect((researchAfter.payload as { spec: { window: number } }).spec.window).toBe(30);
});

test("identical upserts for all three current views append no evidence", async () => {
  const rawDate = "2041-01-05";
  const rawIndicator = "OVERWRITE_RAW_IDENTICAL";
  await saveRawIndicatorHistory({ [rawIndicator]: [{ date: rawDate, value: 7 }] }, undefined, "live");
  await saveRawIndicatorHistory({ [rawIndicator]: [{ date: rawDate, value: 7 }] }, undefined, "live");

  const regimeDate = "2041-01-06";
  const sameRegime = regime(regimeDate, 0.5, "live");
  await saveRegimeSnapshots([sameRegime]);
  await saveRegimeSnapshots([sameRegime]);

  const signalDate = "2041-01-07";
  const signalKey = "overwrite-research-identical";
  const sameResearch = research(signalDate, 14);
  await persistResearchSignal(signalKey, signalDate, sameResearch);
  await persistResearchSignal(signalKey, signalDate, sameResearch);

  expect(await events("raw_indicator_history", { date: rawDate, indicator: rawIndicator })).toHaveLength(0);
  expect(await events("regime_snapshots", { date: regimeDate })).toHaveLength(0);
  expect(await events("research_signals", { signal_key: signalKey, date: signalDate })).toHaveLength(0);
});

test("allowed deletes retain complete old rows while regime deletion stays refused", async () => {
  const rawDate = "2041-01-08";
  const rawIndicator = "OVERWRITE_RAW_DELETE";
  await saveRawIndicatorHistory({ [rawIndicator]: [{ date: rawDate, value: 9 }] }, undefined, "live");
  const rawBefore = await rowJson("raw_indicator_history", `date = '${rawDate}' AND indicator = '${rawIndicator}'`);
  await sql`DELETE FROM raw_indicator_history WHERE date = ${rawDate} AND indicator = ${rawIndicator}`;
  const rawEvents = await events("raw_indicator_history", { date: rawDate, indicator: rawIndicator });
  expect(rawEvents).toHaveLength(1);
  expect(rawEvents[0]).toMatchObject({ operation: "delete", previous_row: rawBefore, replacement_row: null });

  const signalDate = "2041-01-09";
  const signalKey = "overwrite-research-delete";
  await persistResearchSignal(signalKey, signalDate, research(signalDate, 9));
  const researchBefore = await rowJson(
    "research_signals",
    `signal_key = '${signalKey}' AND date = '${signalDate}'`,
  );
  await sql`DELETE FROM research_signals WHERE signal_key = ${signalKey} AND date = ${signalDate}`;
  const researchEvents = await events("research_signals", { signal_key: signalKey, date: signalDate });
  expect(researchEvents).toHaveLength(1);
  expect(researchEvents[0]).toMatchObject({ operation: "delete", previous_row: researchBefore, replacement_row: null });

  const regimeDate = "2041-01-10";
  await saveRegimeSnapshots([regime(regimeDate, 0.4, "live")]);
  let refusal: { code?: string; message?: string } | null = null;
  try {
    await sql`DELETE FROM regime_snapshots WHERE date = ${regimeDate}`;
  } catch (error) {
    refusal = error as { code?: string; message?: string };
  }
  expect(refusal?.code).toBe("0A000");
  expect(refusal?.message).toMatch(/^table "regime_snapshots" is append-only/);
  expect(await events("regime_snapshots", { date: regimeDate })).toHaveLength(0);
  expect(await rowJson("regime_snapshots", `date = '${regimeDate}'`)).toBeTruthy();
});

test("rolling back a current-view update also rolls back its evidence", async () => {
  const date = "2041-01-11";
  const indicator = "OVERWRITE_RAW_ROLLBACK";
  await saveRawIndicatorHistory({ [indicator]: [{ date, value: 1 }] }, undefined, "seed");
  const before = await rowJson("raw_indicator_history", `date = '${date}' AND indicator = '${indicator}'`);

  try {
    await sql.begin(async (tx) => {
      await saveRawIndicatorHistory({ [indicator]: [{ date, value: 2 }] }, tx, "live");
      throw new Error("force transaction rollback");
    });
  } catch (error) {
    expect((error as Error).message).toBe("force transaction rollback");
  }

  expect(await rowJson("raw_indicator_history", `date = '${date}' AND indicator = '${indicator}'`)).toEqual(before);
  expect(await events("raw_indicator_history", { date, indicator })).toHaveLength(0);
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

test("0056 installs over pre-existing current rows without fabricating historical events", async () => {
  const port = await freePort();
  const container = `rmtest_overwrite_migration_${crypto.randomUUID().slice(0, 8)}`;
  const up = Bun.spawnSync([
    "docker", "run", "-d", "--rm", "--name", container,
    "-e", "POSTGRES_PASSWORD=robotmoney", "-e", "POSTGRES_USER=robotmoney", "-e", "POSTGRES_DB=robotmoney",
    "-p", `${port}:5432`, POSTGRES_IMAGE,
  ]);
  if (up.exitCode !== 0) {
    throw new Error(`analytics overwrite migration test requires Docker+Postgres:\n${up.stderr.toString()}`);
  }

  const db = postgres(`postgres://robotmoney:robotmoney@localhost:${port}/robotmoney`, { max: 1, onnotice: () => {} });
  try {
    const started = Date.now();
    for (;;) {
      try {
        await db`SELECT 1`;
        break;
      } catch (error) {
        if (Date.now() - started > 30_000) throw error;
        await Bun.sleep(200);
      }
    }

    await db`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    expect(files).toContain(MIGRATION);
    const preceding = files.filter((file) => file < MIGRATION);
    expect(preceding.at(-1)).toBe("0055_swarm_recommendations_member_received_idx.sql");
    for (const file of preceding) {
      const ddl = await readFile(join(migrationsDir, file), "utf8");
      await db.begin(async (tx) => {
        if (file >= "0054_rm_worker_allowlist.sql") await tx.unsafe("SET LOCAL ROLE rm_owner");
        await tx.unsafe(ddl);
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      });
    }

    await db`INSERT INTO raw_indicator_history (date, indicator, value, source)
             VALUES ('2040-12-01', 'PRE_MIGRATION_RAW', 1, 'legacy')`;
    await db`INSERT INTO regime_snapshots (date, composite, source)
             VALUES ('2040-12-02', 0.5, 'legacy')`;
    await db`INSERT INTO research_signals (signal_key, date, payload)
             VALUES ('pre-migration-research', '2040-12-03', '{"legacy":true}'::jsonb)`;

    const ddl = await readFile(join(migrationsDir, MIGRATION), "utf8");
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx.unsafe(ddl);
      await tx`INSERT INTO schema_migrations (name) VALUES (${MIGRATION})`;
    });

    const [{ count }] = await db<{ count: number }[]>`
      SELECT count(*)::int AS count FROM analytics_overwrite_events`;
    expect(count).toBe(0);
    const [{ currentRows }] = await db<{ currentRows: number }[]>`
      SELECT (
        (SELECT count(*) FROM raw_indicator_history WHERE indicator = 'PRE_MIGRATION_RAW') +
        (SELECT count(*) FROM regime_snapshots WHERE date = '2040-12-02') +
        (SELECT count(*) FROM research_signals WHERE signal_key = 'pre-migration-research')
      )::int AS "currentRows"`;
    expect(currentRows).toBe(3);
  } finally {
    await db.end({ timeout: 5 });
    Bun.spawnSync(["docker", "rm", "-f", container]);
  }
}, 120_000);
