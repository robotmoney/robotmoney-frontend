// Issue 1477: one writer of format 1. csvb (packages/csvb, reading the database as a replica would) and the public
// archive store (the API) cut the same backups from the same committed rows, and write byte-equal uncompressed data
// archives, against the REAL ephemeral Postgres tests/preload.ts provisions. No skip, no env gate.
//
// Seeded: three UTC days of append-only rows in every served table, with text that needs every CSV rule. Both
// writers run with the same fixed clock and a small part size, so tables split into several parts:
//   - the day-cut backup ids are the same;
//   - per backup and served table, the watermarks, the file names, row counts, bytes_raw and sha256_raw are the
//     same, and so are the uncompressed bytes (csvb's files on disk against the API's streamed bodies);
//   - with the same synthetic junction planted in both (never production watermarks), the junction backup and the
//     next day-cut backup agree the same way.
// csvb runs with requireReplica off (its test option: a test database is a primary) into a temp --repo.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  _resetArchiveForTests,
  _setArchiveClockForTests,
  _setArchiveJunctionForTests,
  _setArchivePartBytesForTests,
  archiveBodyStream,
  fileIn,
  listBackupIds,
  recordFor,
  type BuiltRecord,
} from "../src/analytics/store/public-archive-store.ts";
import { APPEND_ONLY_TABLES, type Junction } from "../../packages/analyst-sdk/src/archive/format1.ts";
import { APPEND_ONLY } from "../../packages/csvb/src/config.ts";
import { defaultOptions, runBackup } from "../../packages/csvb/src/backup.ts";
import type { BackupRecord } from "../../packages/csvb/src/model.ts";
import { verifyRepo } from "../../packages/csvb/src/verify.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

// "Now": 2002-03-04 02:00 UTC, so the boundaries 2002-03-02, -03 and -04 are sealed (the first row is on 03-01).
const NOW = Date.parse("2002-03-04T02:00:00Z");
const PART_BYTES = 3000;
const SERVED = APPEND_ONLY_TABLES.filter((t) => t.served).map((t) => t.name);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const dirs: string[] = [];

async function seed(): Promise<void> {
  const [mv] = await fixtureDb<{ id: string }[]>`
    INSERT INTO analytics_ledger_methodology_versions (tool_id, version_label, config, config_digest, created_at)
    VALUES ('regime', 'regime-v3', '{"panels": ["macro", "onchain"], "note": "a,b"}', repeat('a', 64), '2002-03-01 01:00:00.5+00')
    RETURNING id::text AS id`;
  for (const [k, [day, n]] of ([["2002-03-01", 120], ["2002-03-02", 60], ["2002-03-03", 40]] as const).entries()) {
    await fixtureDb`
      INSERT INTO source_value_versions (source_key, market_date, value, revision_kind, knowledge_time)
      SELECT CASE WHEN g % 11 = 0 THEN 'raw_indicator_history:A,"B"' ELSE 'raw_indicator_history:P' || (g % 3) END,
             DATE '1999-01-01' + g + ${k * 1000}::int, g * 1.25 + 0.1, 'legacy_baseline',
             ${`${day} 02:00:00+00`}::timestamptz + g * INTERVAL '7 second' + INTERVAL '0.000123 second'
      FROM generate_series(0, ${n - 1}) g`;
    const [run] = await fixtureDb<{ id: string }[]>`
      INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity, created_at)
      VALUES (gen_random_uuid()::text, ${day}::date - 1, 'regime', 'live', ${mv!.id}, ${`build "${day}", x`}, ${`${day} 05:00:00+00`}) RETURNING id::text AS id`;
    const [ids] = await fixtureDb<{ lo: string; hi: string }[]>`
      SELECT min(id)::text AS lo, max(id)::text AS hi FROM source_value_versions WHERE knowledge_time::date = ${day}::date`;
    const [vin] = await fixtureDb<{ id: string }[]>`
      INSERT INTO analytics_data_vintages (run_id, tool_id, knowledge_time_cutoff, market_time_cutoff, methodology_version_id,
        build_identity, manifest, manifest_digest, member_count, created_at)
      VALUES (${run!.id}, 'regime', ${`${day} 04:00:00+00`}, ${day}::date - 1, ${mv!.id}, 'b', '{"run": "x,\\"y\\""}', repeat('b', 64), ${n},
        ${`${day} 06:00:00+00`}) RETURNING id::text AS id`;
    await fixtureDb`
      INSERT INTO analytics_vintage_members (vintage_id, source_value_version_id, source_key, last_source_value_version_id)
      VALUES (${vin!.id}, ${ids!.lo}, 'raw_indicator_history:P0', ${ids!.hi})`;
    const report = `{"report":"${day}","note":"é ✓ — \\"q\\", c","lines":"one\\ntwo"}`;
    await fixtureDb`
      INSERT INTO analytics_report_snapshots (run_id, asof, report_bytes, checksum, created_at)
      VALUES (${run!.id}, ${day}::date - 1, convert_to(${report}, 'UTF8'), encode(sha256(convert_to(${report}, 'UTF8')), 'hex'), ${`${day} 07:00:00+00`})`;
    const output = `[{"date":"${day}","regime":"risk_on","text":"a, \\"b\\"\\nc"}]`;
    await fixtureDb`
      INSERT INTO analytics_output_snapshots (run_id, artifact_kind, payload_bytes, checksum, created_at)
      VALUES (${run!.id}, 'regime_snapshots', convert_to(${output}, 'UTF8'), encode(sha256(convert_to(${output}, 'UTF8')), 'hex'), ${`${day} 07:00:00+00`})`;
    await fixtureDb`
      INSERT INTO analytics_overwrite_events (table_name, operation, natural_key, previous_row, replacement_row, recorded_at)
      VALUES ('raw_indicator_history', 'update', '{"indicator": "VIX", "date": "2000-12-29"}', '{"value": 1, "note": "x,\\"y\\""}', '{"value": 2}',
        ${`${day} 12:00:00+00`})`;
  }
}

/** The API's records for every sealed backup. */
async function apiRecords(): Promise<Map<string, BuiltRecord>> {
  const out = new Map<string, BuiltRecord>();
  for (const id of await listBackupIds()) out.set(id, await recordFor(id));
  return out;
}

async function apiBody(built: BuiltRecord, path: string): Promise<Buffer> {
  const hit = fileIn(built, path)!;
  const chunks: Uint8Array[] = [];
  const reader = archiveBodyStream(hit.table, hit.file).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return gunzipSync(Buffer.concat(chunks));
}

/** csvb's backups of the served tables into a fresh --repo, with the same clock, part size and junction. */
async function csvbBackups(junction: Junction | null): Promise<{ repo: string; records: BackupRecord[] }> {
  const d = mkdtempSync(join(tmpdir(), "csvb-api-parity-"));
  dirs.push(d);
  const repo = join(d, "repo");
  const records = await runBackup({
    ...defaultOptions(fixtureDb, repo),
    appendOnly: APPEND_ONLY.filter((t) => SERVED.includes(t.name)),
    partBytes: PART_BYTES,
    pauseMs: 0,
    requireReplica: false,
    nowMs: NOW,
    ...(junction ? { junction } : {}),
    log: () => {},
  });
  expect(await verifyRepo({ root: repo })).toEqual([]);
  return { repo, records };
}

/** Both writers agree on a backup: watermarks and, per data archive, name, rows, bytes_raw, sha256_raw and bytes. */
async function expectSameBackup(repo: string, mine: BackupRecord, api: BuiltRecord): Promise<number> {
  let compared = 0;
  expect(api.record.backup).toBe(mine.backup);
  for (const table of SERVED) {
    const a = api.record.append_only[table]!;
    const c = mine.append_only[table]!;
    expect({ table, before: c.watermark_before, after: c.watermark_after }).toEqual({ table, before: a.watermark_before, after: a.watermark_after });
    const pick = (f: { path: string; rows: number; bytes_raw: number; sha256_raw: string }) => ({ path: f.path, rows: f.rows, bytes_raw: f.bytes_raw, sha256_raw: f.sha256_raw });
    expect(c.files.map(pick)).toEqual(a.files.map(pick));
    for (const f of c.files) {
      const disk = gunzipSync(readFileSync(join(repo, f.path)));
      const served = await apiBody(api, f.path);
      expect(sha256(served)).toBe(f.sha256_raw);
      expect(Buffer.compare(disk, served), f.path).toBe(0);
      compared += 1;
    }
  }
  return compared;
}

beforeAll(async () => {
  _resetArchiveForTests();
  _setArchiveClockForTests(() => NOW);
  _setArchivePartBytesForTests(PART_BYTES);
  _setArchiveJunctionForTests(null);
  await seed();
}, 120_000);

afterAll(() => {
  _setArchiveJunctionForTests(null);
  _setArchiveClockForTests(null);
  _setArchivePartBytesForTests(null);
  _resetArchiveForTests();
  for (const d of dirs) rmSync(d, { recursive: true, force: true }); // the directories this test made, never a parent
});

describe("csvb and the archive store write one format 1", () => {
  test("three UTC days: the same day-cut ids, watermarks, file records and uncompressed bytes for every served table", async () => {
    const api = await apiRecords();
    expect([...api.keys()]).toEqual(["2002-03-02T000000Z", "2002-03-03T000000Z", "2002-03-04T000000Z"]);
    const { repo, records } = await csvbBackups(null);
    expect(records.map((r) => r.backup)).toEqual([...api.keys()]);
    let compared = 0;
    for (const r of records) compared += await expectSameBackup(repo, r, api.get(r.backup)!);
    // Every served table had rows on every day, and the small part size split the larger ones.
    expect(compared).toBeGreaterThan(SERVED.length * 3);
    expect(records[0]!.append_only.source_value_versions!.files.length).toBeGreaterThan(1);
  }, 180_000);

  test("with the same synthetic junction planted in both, the junction backup and the next day cut agree", async () => {
    // The junction at 2002-03-02 13:00: each table's watermark is its newest id stamped before then.
    const watermarks: Record<string, string> = {};
    for (const t of APPEND_ONLY_TABLES.filter((x) => x.served)) {
      const rows =
        "column" in t.time
          ? await fixtureDb.unsafe(`SELECT max(id)::text AS wm FROM ${t.name} WHERE ${t.time.column} < '2002-03-02 13:00:00+00'`)
          : await fixtureDb.unsafe(`SELECT max(id)::text AS wm FROM ${t.name} WHERE ${t.time.lookup.column} <= ${watermarks[t.time.lookup.table]}`);
      watermarks[t.name] = rows[0]!.wm;
    }
    const junction: Junction = { id: "2002-03-02T130000Z", watermarks };
    _setArchiveJunctionForTests(junction);
    try {
      const api = await apiRecords();
      expect([...api.keys()]).toEqual(["2002-03-02T000000Z", "2002-03-02T130000Z", "2002-03-03T000000Z", "2002-03-04T000000Z"]);
      const { repo, records } = await csvbBackups(junction);
      expect(records.map((r) => r.backup)).toEqual([...api.keys()]);
      const j = records[1]!;
      for (const t of SERVED) {
        expect(j.append_only[t]!.watermark_after).toBe(watermarks[t]!);
        expect(records[2]!.append_only[t]!.watermark_before).toBe(watermarks[t]!);
      }
      for (const r of records) await expectSameBackup(repo, r, api.get(r.backup)!);
    } finally {
      _setArchiveJunctionForTests(null);
    }
  }, 180_000);
});
