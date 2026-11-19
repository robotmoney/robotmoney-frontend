// Issue 1436: csvb's API source fetches the same backups a replica backup makes. On one seeded database (the REAL
// ephemeral Postgres tests/preload.ts provisions; no skip, no env gate):
//   - `csvb backup --source api` (packages/csvb/src/api-fill.ts) fills a repo over HTTP from the in-process public
//     archive routes (handlePublicAnalytics behind a local Bun.serve);
//   - csvb's `runBackup` backs up the served tables from the same database into another repo;
//   - both repos verify, and give the same backup ids, the same file paths, and per served table the same rows,
//     sha256_raw, id_min, id_max and watermarks. The records differ only in what says who made them and how: `source`,
//     `consistency`, `tool`, the `snapshot` (the API's is the boundary instant, user "api"), and the gzip size and hash
//     per file (the API's record carries none: the gzip bytes depend on the encoder);
//   - the SDK's `bun run inputs --archive` writes the same inputs file from each.
// The writer parity of the archive store and csvb is backend/tests/csvb-api-archive-parity.test.ts; this test adds the
// client. The fill runs on a fake clock (its pacing waits are skipped) and the server's per-client budgets are reset
// before each request, as the recording test does, so the fill is fast and never refused.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPublicAnalyticsCacheForTests, _resetPublicAnalyticsRateLimitForTests, handlePublicAnalytics } from "../src/api/routes/public-analytics.ts";
import { _resetArchiveForTests, _setArchiveClockForTests, _setArchiveJunctionForTests, listBackupIds, recordFor } from "../src/analytics/store/public-archive-store.ts";
import { APPEND_ONLY_TABLES } from "../../packages/analyst-sdk/src/archive/format1.ts";
import { parseRawHistory } from "../../packages/analyst-sdk/src/input/load.ts";
import { apiFill } from "../../packages/csvb/src/api-fill.ts";
import { APPEND_ONLY } from "../../packages/csvb/src/config.ts";
import { defaultOptions, runBackup } from "../../packages/csvb/src/backup.ts";
import { loadRecords } from "../../packages/csvb/src/repo.ts";
import type { BackupRecord } from "../../packages/csvb/src/model.ts";
import { verifyRepo } from "../../packages/csvb/src/verify.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

const SDK = join(import.meta.dir, "../../packages/analyst-sdk");
// "Now": 2001-01-03 03:00 UTC, so the backups 2001-01-02T000000Z and 2001-01-03T000000Z are sealed.
const NOW = Date.parse("2001-01-03T03:00:00Z");
const IDS = ["2001-01-02T000000Z", "2001-01-03T000000Z"];
const FROM = "2026-05-01";
const RUN1 = { key: "0f6b6c1e-6a52-4c39-9f4e-1a2b3c4d1436", asof: "2026-08-01" };
const RUN2 = { key: "0f6b6c1e-6a52-4c39-9f4e-1a2b3c4d2436", asof: "2026-08-15" };
const BUILD = "1436aaaabbbbccccddddeeeeffff000011112222";
const EXTRA: Record<string, string> = { SPX: "backtest:^GSPC", ETH: "backtest:ETH-USD", TBILL3M: "backtest:DTB3" };
const SERVED = APPEND_ONLY_TABLES.filter((t) => t.served).map((t) => t.name);
const TMP = mkdtempSync(join(tmpdir(), "csvb-api-parity-1436-"));

/** Two days, each with source values, a regime run and its frozen vintage (as freezeVintage stores them). */
async function seed(): Promise<void> {
  const text = readFileSync(join(SDK, "tests/fixtures/raw-indicator-history.csv"), "utf8");
  const obs = parseRawHistory(text)
    .filter((r) => r.date >= FROM)
    .map((r) => ({ key: EXTRA[r.indicator] ?? `raw_indicator_history:${r.indicator}`, date: r.date, value: r.value }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const [mv] = await fixtureDb<{ id: string }[]>`
    INSERT INTO analytics_ledger_methodology_versions (tool_id, version_label, config, config_digest, created_at)
    VALUES ('regime', 'regime-v3', '{"panels": ["macro", "onchain"], "note": "a,\\"b\\""}', repeat('d', 64), '2001-01-01 00:30:00+00')
    RETURNING id::text AS id`;
  const insert = async (list: typeof obs, kt: string) => {
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      await fixtureDb`
        INSERT INTO source_value_versions (source_key, market_date, value, revision_kind, knowledge_time)
        SELECT k, d::date, v::float8, 'legacy_baseline', ${kt}::timestamptz
        FROM unnest(${fixtureDb.array(chunk.map((o) => o.key))}::text[], ${fixtureDb.array(chunk.map((o) => o.date))}::text[],
                    ${fixtureDb.array(chunk.map((o) => String(o.value)))}::text[]) AS t(k, d, v)
        ORDER BY k, d`;
    }
  };
  const run = async (r: typeof RUN1, day: string) => {
    const [row] = await fixtureDb<{ id: string }[]>`
      INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity, created_at)
      VALUES (${r.key}, ${r.asof}, 'regime', 'live', ${mv!.id}, ${BUILD}, ${`${day} 05:00:00+00`}) RETURNING id::text AS id`;
    const cutoff = `${day} 04:00:00+00`;
    const members = await fixtureDb<{ id: string; source_key: string }[]>`
      SELECT id::text AS id, source_key FROM source_value_versions
      WHERE knowledge_time <= ${cutoff}::timestamptz AND market_date <= ${r.asof}::date ORDER BY id`;
    const [v] = await fixtureDb<{ id: string }[]>`
      INSERT INTO analytics_data_vintages (run_id, tool_id, knowledge_time_cutoff, market_time_cutoff, methodology_version_id,
        build_identity, manifest, manifest_digest, member_count, created_at)
      VALUES (${row!.id}, 'regime', ${cutoff}, ${r.asof}, ${mv!.id}, ${BUILD}, ${`{"run": ${row!.id}}`}, repeat('e', 64), ${members.length},
        ${`${day} 06:00:00+00`}) RETURNING id::text AS id`;
    for (let i = 0; i < members.length; ) {
      let j = i;
      while (j + 1 < members.length && BigInt(members[j + 1]!.id) === BigInt(members[j]!.id) + 1n && members[j + 1]!.source_key === members[i]!.source_key) j++;
      await fixtureDb`INSERT INTO analytics_vintage_members (vintage_id, source_value_version_id, source_key, last_source_value_version_id)
        VALUES (${v!.id}, ${members[i]!.id}, ${members[i]!.source_key}, ${j > i ? members[j]!.id : null})`;
      i = j + 1;
    }
  };
  await insert(obs.filter((o) => o.date <= RUN1.asof), "2001-01-01 02:00:00.000123+00");
  await run(RUN1, "2001-01-01");
  await insert(obs.filter((o) => o.date > RUN1.asof), "2001-01-02 02:00:00.000456+00");
  await run(RUN2, "2001-01-02");
}

let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  _resetArchiveForTests();
  _setArchiveClockForTests(() => NOW);
  _setArchiveJunctionForTests(null);
  await seed();
  // Build every record before the fill, so no request meets a 503 while one is prepared.
  for (const id of await listBackupIds()) await recordFor(id);
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      _resetPublicAnalyticsRateLimitForTests();
      _resetPublicAnalyticsCacheForTests();
      const url = new URL(req.url);
      return handlePublicAnalytics(req, url, "192.0.2.36");
    },
  });
}, 120_000);

afterAll(() => {
  server?.stop(true);
  _setArchiveJunctionForTests(null);
  _setArchiveClockForTests(null);
  _resetArchiveForTests();
  rmSync(TMP, { recursive: true, force: true }); // the directory this test made, never a parent
});

/** A record without what names its maker and its snapshot, and without the per-file gzip size and hash. */
function comparable(rec: BackupRecord): unknown {
  const { source: _s, consistency: _c, tool: _t, snapshot: _n, ...rest } = rec as BackupRecord & { source?: string; consistency?: string };
  const strip = (f: object) => {
    const { bytes_gz: _g, sha256_gz: _h, ...kept } = f as Record<string, unknown>;
    return kept;
  };
  return { ...rest, anomalies: rest.anomalies ?? [], append_only: Object.fromEntries(Object.entries(rest.append_only).map(([t, a]) => [t, { ...a, files: a.files.map(strip) }])) };
}

async function inputs(archive: string, out: string): Promise<string> {
  const p = Bun.spawn(["bun", join(SDK, "bin/inputs.ts"), "--archive", archive, "--run", RUN2.key, "--out", out], { cwd: SDK, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  expect(code, stderr).toBe(0);
  return readFileSync(join(out, "inputs.csv"), "utf8");
}

describe("csvb's API fill and a replica backup of the same database", () => {
  const apiRepo = join(TMP, "api-repo");
  const dbRepo = join(TMP, "db-repo");

  test(
    "the same backup ids, file paths, sha256_raw, rows, id ranges and watermarks; records differ only in who made them",
    async () => {
      let t = NOW;
      const fill = await apiFill({
        repo: apiRepo,
        api: `http://127.0.0.1:${server.port}`,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
        log: () => {},
      });
      expect(fill).toEqual({ added: IDS, status: "complete", remaining: 0 });
      expect(await verifyRepo({ root: apiRepo })).toEqual([]);

      const made = await runBackup({
        ...defaultOptions(fixtureDb, dbRepo),
        appendOnly: APPEND_ONLY.filter((x) => SERVED.includes(x.name)),
        revised: [],
        pauseMs: 0,
        requireReplica: false,
        nowMs: NOW,
        junction: null,
        log: () => {},
      });
      expect(await verifyRepo({ root: dbRepo })).toEqual([]);

      const api = loadRecords({ root: apiRepo });
      const db = loadRecords({ root: dbRepo });
      expect(made.map((r) => r.backup)).toEqual(IDS);
      expect(api.map((r) => r.backup)).toEqual(IDS);
      let files = 0;
      for (const [i, a] of api.entries()) {
        const d = db[i]!;
        expect((a as { source?: string }).source).toBe("api");
        expect(Object.keys(a.append_only).sort()).toEqual([...SERVED].sort());
        for (const table of SERVED) {
          const x = a.append_only[table]!;
          const y = d.append_only[table]!;
          expect({ table, before: x.watermark_before, after: x.watermark_after }).toEqual({ table, before: y.watermark_before, after: y.watermark_after });
          const pick = (f: { path: string; rows: number; sha256_raw: string; id_min?: string; id_max?: string }) => ({ path: f.path, rows: f.rows, sha256_raw: f.sha256_raw, id_min: f.id_min, id_max: f.id_max });
          expect(x.files.map(pick)).toEqual(y.files.map(pick));
          files += x.files.length;
        }
        expect(comparable(a)).toEqual(comparable(d));
      }
      // Every served table that holds rows on a seeded day has a file, so the comparison is not vacuous.
      expect(files).toBeGreaterThanOrEqual(8);
    },
    180_000,
  );

  test("bun run inputs --archive writes the same inputs file from the API-filled copy as from the replica backup", async () => {
    const fromApi = await inputs(apiRepo, join(TMP, "api-inputs"));
    const fromDb = await inputs(dbRepo, join(TMP, "db-inputs"));
    expect(fromApi.split("\n")[0]).toBe("date,series,value,kind");
    expect(fromApi.split("\n").length).toBeGreaterThan(100);
    expect(fromApi).toBe(fromDb);
    const manifest = (dir: string) => JSON.parse(readFileSync(join(TMP, dir, "inputs.manifest.json"), "utf8"));
    expect(manifest("api-inputs")).toMatchObject({ run_key: RUN2.key, backup_id: IDS[1], source: "api" });
    expect(manifest("db-inputs")).toMatchObject({ run_key: RUN2.key, backup_id: IDS[1], sha256: manifest("api-inputs").sha256 });
  }, 120_000);
});
