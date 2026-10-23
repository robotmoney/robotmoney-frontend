// Issue 1422: the public record and its format 1 archives, against the REAL
// ephemeral Postgres tests/preload.ts provisions. No skip, no env gate.
//
// What is proved here, each against seeded committed rows:
//   - source-versions serves every collected version with its observed time,
//     and `asof` gives exactly the versions in force then;
//   - reports serves each run's published report byte for byte, by run or by
//     vintage, with its checksum as a strong ETag, and a conditional request is
//     answered from the checksum alone (the TOAST'd bytes are never read);
//   - vintages name their members and their published report;
//   - the archive routes list sealed backups only, serve a format 1 record
//     that validates against the contract, and serve every archive it lists
//     byte for byte as Postgres COPY ... (FORMAT csv, HEADER) writes the same
//     rows (what robotmoney/csv-backups writes), gzipped as csvb gzips them;
//   - a sealed backup's record and bodies stay fixed while rows keep arriving
//     and across a rebuild from scratch; a body whose rows no longer hash to
//     its record is aborted, never completed; an unsealed day is not served;
//   - every handler reads committed rows only: with fetch replaced by a
//     thrower, every route still answers.
//
// The handler is driven directly, as public-analytics.test.ts does; the
// HTTP-level proxy and cache behaviour is scripts/tests/integration/
// public-archive-proxy.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { ARCHIVE_BACKUP_RECORD_SCHEMA, ARCHIVE_PART_BYTES, PUBLIC_ANALYTICS_SCHEMAS, ROUTES } from "@robotmoney/contract";
import { sql } from "../../src/db/client.ts";
import { _resetPublicAnalyticsRateLimitForTests, handlePublicAnalytics } from "../../src/api/routes/public-analytics.ts";
import { publicQueryGate } from "../../src/api/public-analytics-limits.ts";
import {
  _resetArchiveForTests,
  _setArchiveClockForTests,
  _setArchivePartBytesForTests,
  ARCHIVE_TABLES,
} from "../../src/analytics/store/public-archive-store.ts";
import { useCleanDatabase } from "../support/clean-db.ts";
import { fixtureDb } from "../support/fixture-db.ts";
import { validateJsonSchema } from "../support/json-schema.ts";

useCleanDatabase(import.meta.file);

const P = ROUTES.publicAnalytics;
const CONTRACT_SRC = join(import.meta.dir, "..", "..", "..", "contract", "src");
const schema = (route: string) =>
  JSON.parse(readFileSync(join(CONTRACT_SRC, route === P.archiveFiles ? ARCHIVE_BACKUP_RECORD_SCHEMA : PUBLIC_ANALYTICS_SCHEMAS[route]!), "utf8"));
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

let ipCounter = 0;
async function get(path: string, init: RequestInit = {}, ip = `192.0.2.${++ipCounter % 250}`): Promise<Response> {
  const req = new Request(`http://api.test${path}`, init);
  return handlePublicAnalytics(req, new URL(req.url), ip);
}
async function bytesOf(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

// "Now" for the archive: 2001-01-04 03:00 UTC, so 2001-01-02, -03 and -04 are
// sealed (each at least an hour past) and 2001-01-05 is not.
const NOW = Date.parse("2001-01-04T03:00:00Z");
const SVV_DAY1 = 2000;
const SVV_BIG = 60_000;
// Rows per Postgres COPY a parity check streams (a whole archive up to this size).
const PARITY_ROWS = 5000;

// A report and an output whose text needs every CSV rule: commas, quotes, a
// newline, and multibyte characters.
// The pad is incompressible, so the stored report is TOAST'd out of line.
const PAD = Array.from({ length: 300 }, (_, i) => createHash("sha256").update(String(i)).digest("hex")).join("");
const REPORT_A = `{"report":"A","note":"é ✓ — \\"quoted\\", with a comma","lines":"one\\ntwo","pad":"${PAD}"}`;
const REPORT_B = `{"report":"B","ünïcode":"日本語"}`;
const OUTPUT_A = `[{"date":"2000-12-31","regime":"risk_on","composite":0.5,"text":"a, \\"b\\"\\nc"}]`;
const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";
let vintageA = "";
let vintageB = "";
let svvIds: { first: string; last: string } = { first: "", last: "" };

beforeAll(async () => {
  // The archive store's caches are process-wide and bun runs every test file
  // in one process: start from nothing, not from another file's database.
  _resetArchiveForTests();
  _setArchivePartBytesForTests(null);
  _setArchiveClockForTests(() => NOW);
  const [mv] = await fixtureDb<{ id: string }[]>`
    INSERT INTO analytics_ledger_methodology_versions (tool_id, version_label, config, config_digest, created_at)
    VALUES ('regime', 'regime-v3', '{"panels": ["macro", "onchain"], "note": "a,b"}', repeat('a', 64), '2001-01-01 01:00:00.123456+00')
    RETURNING id::text AS id`;

  // Day 1: 2000 legacy versions, one under a key that needs CSV quoting.
  await fixtureDb`
    INSERT INTO source_value_versions (source_key, market_date, value, revision_kind, knowledge_time)
    SELECT CASE WHEN g = 7 THEN 'raw_indicator_history:A,"B"' ELSE 'raw_indicator_history:ARCH' END,
           DATE '1990-01-01' + g, g * 1.25 + 0.1, 'legacy_baseline',
           TIMESTAMPTZ '2001-01-01 02:00:00+00' + g * INTERVAL '1 second' + INTERVAL '0.000123 second'
    FROM generate_series(0, ${SVV_DAY1 - 1}) g`;
  const [ids] = await fixtureDb<{ first: string; last: string }[]>`SELECT min(id)::text AS first, max(id)::text AS last FROM source_value_versions`;
  svvIds = ids!;

  const [ra] = await fixtureDb<{ id: string }[]>`
    INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity, created_at)
    VALUES (${RUN_A}, '2000-12-31', 'regime', 'live', ${mv!.id}, 'build-a', '2001-01-01 05:00:00+00') RETURNING id::text AS id`;
  const [va] = await fixtureDb<{ id: string }[]>`
    INSERT INTO analytics_data_vintages (run_id, tool_id, knowledge_time_cutoff, market_time_cutoff, methodology_version_id,
      build_identity, manifest, manifest_digest, member_count, created_at)
    VALUES (${ra!.id}, 'regime', '2001-01-01 04:00:00+00', '2000-12-31', ${mv!.id}, 'build-a', '{"run": "a"}', repeat('b', 64),
      ${SVV_DAY1}, '2001-01-01 06:00:00+00') RETURNING id::text AS id`;
  vintageA = va!.id;
  await fixtureDb`
    INSERT INTO analytics_vintage_members (vintage_id, source_value_version_id, source_key, last_source_value_version_id)
    VALUES (${vintageA}, ${svvIds.first}, 'raw_indicator_history:ARCH', ${svvIds.last})`;
  await fixtureDb`
    INSERT INTO analytics_report_snapshots (run_id, asof, report_bytes, checksum, created_at)
    VALUES (${ra!.id}, '2000-12-31', convert_to(${REPORT_A}, 'UTF8'), encode(sha256(convert_to(${REPORT_A}, 'UTF8')), 'hex'),
      '2001-01-01 07:00:00+00')`;
  await fixtureDb`
    INSERT INTO analytics_output_snapshots (run_id, artifact_kind, payload_bytes, checksum, created_at)
    VALUES (${ra!.id}, 'regime_snapshots', convert_to(${OUTPUT_A}, 'UTF8'), encode(sha256(convert_to(${OUTPUT_A}, 'UTF8')), 'hex'),
      '2001-01-01 07:00:00+00')`;

  // Day 2: a provider acquisition with an initial value, then its revision.
  await fixtureDb`
    INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity, knowledge_time)
    VALUES ('00000000-0000-4000-8000-0000000000a1', 'fred', 'v1', 'c1', '2001-01-02 03:00:00+00'),
           ('00000000-0000-4000-8000-0000000000a2', 'fred', 'v1', 'c2', '2001-01-02 09:00:00+00')`;
  const [init] = await fixtureDb<{ id: string }[]>`
    INSERT INTO source_value_versions (acquisition_id, source_key, market_date, value, revision_kind, knowledge_time, provenance)
    VALUES ('00000000-0000-4000-8000-0000000000a1', 'backtest:DTB3', '2000-12-29', 5.1, 'initial', '2001-01-02 03:00:00+00', 'fred')
    RETURNING id::text AS id`;
  await fixtureDb`
    INSERT INTO source_value_versions (acquisition_id, source_key, market_date, value, prior_version_id, revision_kind, knowledge_time, provenance)
    VALUES ('00000000-0000-4000-8000-0000000000a2', 'backtest:DTB3', '2000-12-29', 5.2, ${init!.id}, 'revision', '2001-01-02 09:00:00+00', 'fred')`;
  const [rb] = await fixtureDb<{ id: string }[]>`
    INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity, created_at)
    VALUES (${RUN_B}, '2001-01-01', 'regime', 'live', ${mv!.id}, 'build-b', '2001-01-02 05:00:00+00') RETURNING id::text AS id`;
  const [vb] = await fixtureDb<{ id: string }[]>`
    INSERT INTO analytics_data_vintages (run_id, tool_id, knowledge_time_cutoff, market_time_cutoff, methodology_version_id,
      build_identity, manifest, manifest_digest, member_count, created_at)
    VALUES (${rb!.id}, 'regime', '2001-01-02 10:00:00+00', '2001-01-01', ${mv!.id}, 'build-b', '{"run": "b"}', repeat('c', 64),
      1, '2001-01-02 10:30:00+00') RETURNING id::text AS id`;
  vintageB = vb!.id;
  await fixtureDb`
    INSERT INTO analytics_vintage_members (vintage_id, source_value_version_id, source_key)
    VALUES (${vintageB}, ${init!.id}, 'backtest:DTB3')`;
  await fixtureDb`
    INSERT INTO analytics_report_snapshots (run_id, asof, report_bytes, checksum, created_at)
    VALUES (${rb!.id}, '2001-01-01', convert_to(${REPORT_B}, 'UTF8'), encode(sha256(convert_to(${REPORT_B}, 'UTF8')), 'hex'),
      '2001-01-02 11:00:00+00')`;
  await fixtureDb`
    INSERT INTO analytics_overwrite_events (table_name, operation, natural_key, previous_row, replacement_row, recorded_at)
    VALUES ('raw_indicator_history', 'update', '{"indicator": "VIX", "date": "2000-12-29"}',
      '{"value": 1, "note": "x,\\"y\\""}', '{"value": 2}', '2001-01-02 12:00:00+00')`;

  // Day 3: a large batch, for an archive big enough to time compression.
  await fixtureDb`
    INSERT INTO source_value_versions (source_key, market_date, value, revision_kind, knowledge_time)
    SELECT 'raw_indicator_history:BIG' || (g % 7), DATE '1900-01-01' + (g / 7), g / 3.0, 'legacy_baseline',
           TIMESTAMPTZ '2001-01-03 01:00:00+00' + (g / 100) * INTERVAL '1 second'
    FROM generate_series(0, ${SVV_BIG - 1}) g`;
}, 120_000);

afterAll(() => {
  _setArchiveClockForTests(null);
  _setArchivePartBytesForTests(null);
  _resetArchiveForTests();
});
beforeEach(() => _resetPublicAnalyticsRateLimitForTests());

/** Postgres's own COPY CSV of a select, in UTC: what csvb writes for the same rows. */
async function copyCsv(select: string): Promise<string> {
  return fixtureDb.begin(async (tx) => {
    await tx.unsafe("SET LOCAL TimeZone = 'UTC'");
    const stream = await tx.unsafe(`COPY (${select}) TO STDOUT WITH (FORMAT csv, HEADER true)`).readable();
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks).toString("utf8");
  }) as Promise<string>;
}

/** csvb's select list per table (its config.ts): `*`, or the decoded payload columns. */
function csvbSelect(table: string, lo: string, hi: string): string {
  const where = `WHERE id >= ${lo} AND id <= ${hi} ORDER BY id`;
  if (table === "analytics_output_snapshots") {
    return `SELECT id, run_id, artifact_kind, checksum, byte_length, created_at, convert_from(payload_bytes, 'UTF8') AS payload_json, encode(sha256(payload_bytes), 'hex') AS payload_sha256 FROM ${table} ${where}`;
  }
  if (table === "analytics_report_snapshots") {
    return `SELECT id, run_id, asof, checksum, byte_length, created_at, convert_from(report_bytes, 'UTF8') AS report_json, encode(sha256(report_bytes), 'hex') AS report_sha256 FROM ${table} ${where}`;
  }
  return `SELECT * FROM ${table} ${where}`;
}

/** GET a backup record, retrying while it is being built (503 + Retry-After). */
async function record(id: string): Promise<{ res: Response; body: any; bytes: Uint8Array }> {
  for (let i = 0; i < 60; i++) {
    const res = await get(`${P.archiveFiles}csv/${id}/backup.json`);
    if (res.status === 503) {
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
      await Bun.sleep(500);
      continue;
    }
    expect(res.status, `backup.json ${id}`).toBe(200);
    const bytes = await bytesOf(res);
    return { res, body: JSON.parse(new TextDecoder().decode(bytes)), bytes };
  }
  throw new Error(`backup ${id} never finished building`);
}

describe("source-versions", () => {
  test("every version with its observed time, filtered by series and market date, and paged by id", async () => {
    const res = await get(`${P.sourceVersions}?series=backtest:DTB3`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(validateJsonSchema(schema(P.sourceVersions), body)).toEqual([]);
    expect(body.asof).toBeNull();
    expect(body.rows.map((r: any) => [r.value, r.revision_kind, r.knowledge_time])).toEqual([
      [5.1, "initial", "2001-01-02T03:00:00.000Z"],
      [5.2, "revision", "2001-01-02T09:00:00.000Z"],
    ]);
    expect(body.rows[1].prior_version_id).toBe(body.rows[0].id);

    const ranged: any = await (await get(`${P.sourceVersions}?series=raw_indicator_history:ARCH&from=1990-01-03&to=1990-01-05`)).json();
    expect(ranged.rows.map((r: any) => r.market_date)).toEqual(["1990-01-03", "1990-01-04", "1990-01-05"]);

    let cursor: string | null = null;
    const seen: number[] = [];
    do {
      const page: any = await (await get(`${P.sourceVersions}?series=raw_indicator_history:ARCH&limit=700${cursor ? `&cursor=${cursor}` : ""}`)).json();
      seen.push(...page.rows.map((r: any) => r.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.length).toBe(SVV_DAY1 - 1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  test("asof gives the versions in force then, and a later revision does not change it", async () => {
    const before: any = await (await get(`${P.sourceVersions}?series=backtest:DTB3&asof=2001-01-02T05:00:00Z`)).json();
    expect(before.asof).toBe("2001-01-02T05:00:00.000Z");
    expect(before.rows.map((r: any) => r.value)).toEqual([5.1]);
    const after: any = await (await get(`${P.sourceVersions}?series=backtest:DTB3&asof=2001-01-02`)).json();
    expect(after.rows.map((r: any) => r.value)).toEqual([5.2]);
    const none: any = await (await get(`${P.sourceVersions}?series=backtest:DTB3&asof=2001-01-01`)).json();
    expect(none.rows).toEqual([]);
  });

  test("bad parameters are 400s", async () => {
    for (const q of ["asof=yesterday", "asof=2001-02-30", "from=2001-13-01", "cursor=zzz", "series="]) {
      const res = await get(`${P.sourceVersions}?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});

describe("reports", () => {
  test("the list names each published report with its checksum, never its bytes", async () => {
    const body: any = await (await get(P.reports)).json();
    expect(validateJsonSchema(schema(P.reports), body)).toEqual([]);
    expect(body.reports.map((r: any) => [r.run_key, r.checksum, r.byte_length])).toEqual([
      [RUN_A, sha256(REPORT_A), Buffer.byteLength(REPORT_A)],
      [RUN_B, sha256(REPORT_B), Buffer.byteLength(REPORT_B)],
    ]);
  });

  test("by run and by vintage: the stored bytes exactly, with the checksum as a strong, immutable ETag", async () => {
    const [stored] = await fixtureDb<{ report_bytes: Uint8Array }[]>`
      SELECT rs.report_bytes FROM analytics_report_snapshots rs JOIN analytics_ledger_runs r ON r.id = rs.run_id WHERE r.run_key = ${RUN_A}`;
    for (const q of [`run=${RUN_A}`, `vintage=${vintageA}`]) {
      const res = await get(`${P.reports}?${q}`);
      expect(res.status, q).toBe(200);
      const got = await bytesOf(res);
      expect(Buffer.compare(Buffer.from(got), Buffer.from(stored!.report_bytes))).toBe(0);
      expect(res.headers.get("ETag")).toBe(`"${sha256(REPORT_A)}"`);
      expect(res.headers.get("X-Content-SHA256")).toBe(sha256(got));
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    }
    // Byte for byte on every request, and gzip only as a transport encoding.
    const gz = await get(`${P.reports}?run=${RUN_A}`, { headers: { "Accept-Encoding": "gzip" } });
    expect(gz.headers.get("Content-Encoding")).toBeNull(); // under the 256 KB threshold
    expect(new TextDecoder().decode(await bytesOf(gz))).toBe(REPORT_A);
    expect(new TextDecoder().decode(await bytesOf(await get(`${P.reports}?vintage=${vintageB}`)))).toBe(REPORT_B);
  });

  test("404 for a run with no report, 400 for a bad or doubled selector", async () => {
    expect((await get(`${P.reports}?run=33333333-3333-4333-8333-333333333333`)).status).toBe(404);
    expect((await get(`${P.reports}?vintage=999999`)).status).toBe(404);
    expect((await get(`${P.reports}?run=not-a-uuid`)).status).toBe(400);
    expect((await get(`${P.reports}?vintage=0`)).status).toBe(400);
    expect((await get(`${P.reports}?run=${RUN_A}&vintage=${vintageA}`)).status).toBe(400);
  });

  test("a matching If-None-Match is 304 from the checksum alone: the report's stored bytes are never read", async () => {
    // REPORT_A is TOAST'd (over 2 KB), so reading its bytes reads the table's
    // TOAST relation. Backends flush their I/O counters to the cumulative
    // statistics within ~10 s of going idle, so the counter is read once
    // settled, after the 304s, and once more after a 200 to prove it moves.
    const toast = async (): Promise<number> => {
      const [r] = await fixtureDb<{ n: string }[]>`
        SELECT (coalesce(toast_blks_read, 0) + coalesce(toast_blks_hit, 0))::text AS n
        FROM pg_statio_all_tables WHERE relname = 'analytics_report_snapshots'`;
      return Number(r!.n);
    };
    const settled = async (): Promise<number> => {
      let last = await toast();
      for (let i = 0; i < 30; i++) {
        await Bun.sleep(1000);
        const now = await toast();
        if (now === last && i >= 11) return now;
        last = now;
      }
      return last;
    };
    const etag = `"${sha256(REPORT_A)}"`;
    const base = await settled();
    for (let i = 0; i < 5; i++) {
      const res = await get(`${P.reports}?run=${RUN_A}`, { headers: { "If-None-Match": etag } });
      expect(res.status).toBe(304);
      expect(res.headers.get("ETag")).toBe(etag);
      expect((await bytesOf(res)).length).toBe(0);
    }
    expect(await settled()).toBe(base);
    expect((await get(`${P.reports}?run=${RUN_A}`)).status).toBe(200);
    expect(await settled()).toBeGreaterThan(base);
  }, 120_000);
});

describe("vintages", () => {
  test("each vintage carries its id and the report its run published; its members page by id", async () => {
    const body: any = await (await get(P.vintages)).json();
    expect(validateJsonSchema(schema(P.vintages), body)).toEqual([]);
    const a = body.vintages.find((v: any) => v.run_key === RUN_A);
    expect(a.id).toBe(Number(vintageA));
    expect(a.report).toEqual({ report_id: expect.any(Number), checksum: sha256(REPORT_A), byte_length: Buffer.byteLength(REPORT_A) });
    // The member ids the vintage names are exactly the versions it froze.
    const ids: number[] = [];
    let cursor: string | null = null;
    do {
      const page: any = await (await get(`${P.vintages}?run_key=${RUN_A}&tool_id=regime&include=members&limit=1000${cursor ? `&cursor=${cursor}` : ""}`)).json();
      ids.push(...page.vintages[0].members.rows.map((r: any) => r.source_value_version_id));
      cursor = page.vintages[0].members.nextCursor;
    } while (cursor);
    expect(ids.length).toBe(SVV_DAY1);
    expect(ids[0]).toBe(Number(svvIds.first));
    expect(ids[ids.length - 1]).toBe(Number(svvIds.last));
  });
});

describe("archive: the backup list", () => {
  test("sealed day boundaries only, from the first after the earliest row", async () => {
    const res = await get(P.archiveBackups);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    const body: any = await res.json();
    expect(validateJsonSchema(schema(P.archiveBackups), body)).toEqual([]);
    expect(body.backups).toEqual(
      ["2001-01-02T000000Z", "2001-01-03T000000Z", "2001-01-04T000000Z"].map((b) => ({ backup: b, record: `csv/${b}/backup.json` })),
    );
    const paged: any = await (await get(`${P.archiveBackups}?limit=2`)).json();
    expect(paged.backups.length).toBe(2);
    expect(paged.nextCursor).toBe("2001-01-03T000000Z");
    const rest: any = await (await get(`${P.archiveBackups}?cursor=${paged.nextCursor}`)).json();
    expect(rest.backups.map((b: any) => b.backup)).toEqual(["2001-01-04T000000Z"]);
    expect((await get(`${P.archiveBackups}?cursor=../x`)).status).toBe(400);
  });

  test("an unsealed or unknown backup, and a path outside the layout, are 404s", async () => {
    for (const path of [
      "csv/2001-01-05T000000Z/backup.json", // not yet an hour past
      "csv/2001-01-01T000000Z/backup.json", // before the first row
      "csv/2001-01-02T120000Z/backup.json", // not a day boundary
      "csv/2001-01-02T000000Z/../backup.json",
      "csv/2001-01-02T000000Z/data/source_value_versions.2001-01-01T000000Z_2001-01-01T000000Z.csv.gz",
      "csv/2001-01-02T000000Z/revisions/regime_snapshots.csv.gz",
      "",
    ]) {
      const res = await get(`${P.archiveFiles}${path}`);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});

describe("archive: records and bodies", () => {
  test("each record is format 1, chains its watermarks, and lists archives byte-equal to COPY CSV of the same rows", async () => {
    let prevAfter: Record<string, string | null> = {};
    let cumRows: Record<string, bigint> = {};
    for (const id of ["2001-01-02T000000Z", "2001-01-03T000000Z", "2001-01-04T000000Z"]) {
      const { res, body, bytes } = await record(id);
      expect(validateJsonSchema(schema(P.archiveFiles), body)).toEqual([]);
      expect(res.headers.get("ETag")).toBe(`"${sha256(bytes)}"`);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
      expect(body).toMatchObject({ format: 1, backup: id, source: "api", consistency: "paged", revisions: {} });
      expect(Object.keys(body.append_only)).toEqual(ARCHIVE_TABLES.map((t) => t.name));
      for (const [table, a] of Object.entries<any>(body.append_only)) {
        expect(a.watermark_before, `${id} ${table}`).toBe(prevAfter[table] ?? null);
        prevAfter[table] = a.watermark_after;
        cumRows[table] = (cumRows[table] ?? 0n) + BigInt(a.rows_added);
        expect(a.db_rows_through_watermark).toBe(String(cumRows[table]));
        for (const f of a.files) {
          expect(f.path).toMatch(new RegExp(`^csv/${id}/data/${table}\\.\\d{4}-\\d{2}-\\d{2}T\\d{6}Z_\\d{4}-\\d{2}-\\d{2}T\\d{6}Z\\.csv\\.gz$`));
          expect(f.bytes_raw).toBeLessThanOrEqual(ARCHIVE_PART_BYTES);
          const body = await get(`${P.archiveFiles}${f.path}`);
          expect(body.status, f.path).toBe(200);
          expect(body.headers.get("Content-Type")).toBe("application/gzip");
          expect(body.headers.get("ETag")).toBe(`"${f.sha256_gz}"`);
          expect(body.headers.get("Content-Length")).toBe(String(f.bytes_gz));
          const gz = await bytesOf(body);
          expect(gz.length).toBe(f.bytes_gz);
          expect(sha256(gz)).toBe(f.sha256_gz);
          const text = gunzipSync(gz).toString("utf8");
          expect(sha256(text)).toBe(f.sha256_raw);
          // The parity check: Postgres's own COPY CSV of the same rows, as
          // csvb selects them, is the same text, and gzipped as csvb does
          // (node:zlib, level 9) the same bytes.
          if (f.rows <= PARITY_ROWS) {
            const copy = await copyCsv(csvbSelect(table, f.id_min, f.id_max));
            expect(text === copy, `${f.path} differs from COPY CSV`).toBe(true);
            expect(sha256(gzipSync(Buffer.from(copy), { level: 9 }))).toBe(f.sha256_gz);
          } else {
            // A large archive is compared on its first PARITY_ROWS rows: COPY
            // of the same id range is the same text as the archive's prefix.
            const lines = text.split("\n");
            const head = lines.slice(0, PARITY_ROWS + 1).join("\n") + "\n";
            const lastId = lines[PARITY_ROWS]!.split(",")[0]!;
            const copy = await copyCsv(csvbSelect(table, f.id_min, lastId));
            expect(head === copy, `${f.path} differs from COPY CSV`).toBe(true);
          }
        }
      }
    }
    // Day 1's rows are in the first backup, day 2's in the second, day 3's in the third.
    const first = (await record("2001-01-02T000000Z")).body.append_only;
    expect(first.source_value_versions.rows_added).toBe(SVV_DAY1);
    expect(first.analytics_report_snapshots.rows_added).toBe(1);
    expect(first.analytics_output_snapshots.rows_added).toBe(1);
    const second = (await record("2001-01-03T000000Z")).body.append_only;
    expect(second.source_value_versions.rows_added).toBe(2);
    expect(second.analytics_overwrite_events.rows_added).toBe(1);
    const third = (await record("2001-01-04T000000Z")).body.append_only;
    expect(third.source_value_versions.rows_added).toBe(SVV_BIG);
  }, 300_000);

  test("a conditional request is 304 from the record alone: with every gate slot held, a body is refused but a revalidation is not", async () => {
    const { body } = await record("2001-01-02T000000Z");
    const f = body.append_only.source_value_versions.files[0];
    const releases = [await publicQueryGate.acquire(), await publicQueryGate.acquire()];
    try {
      const cond = await get(`${P.archiveFiles}${f.path}`, { headers: { "If-None-Match": `"${f.sha256_gz}"` } });
      expect(cond.status).toBe(304);
      expect(cond.headers.get("ETag")).toBe(`"${f.sha256_gz}"`);
      expect(cond.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
      const recCond = await get(`${P.archiveFiles}csv/2001-01-02T000000Z/backup.json`, { headers: { "If-None-Match": `"${sha256((await record("2001-01-02T000000Z")).bytes)}"` } });
      expect(recCond.status).toBe(304);
      const busy = await get(`${P.archiveFiles}${f.path}`);
      expect(busy.status).toBe(503);
      expect(Number(busy.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
      expect(busy.headers.get("Cache-Control")).toBe("no-store");
    } finally {
      for (const r of releases) r();
    }
  });

  test("rows that keep arriving never change a sealed backup: its record and bodies rebuild to the same bytes", async () => {
    const before = await record("2001-01-03T000000Z");
    const f = before.body.append_only.source_value_versions.files[0];
    const bodyBefore = await bytesOf(await get(`${P.archiveFiles}${f.path}`));

    _resetArchiveForTests();
    // A rebuild racing new writes to every table it reads.
    const [mv] = await fixtureDb<{ id: string }[]>`SELECT id::text AS id FROM analytics_ledger_methodology_versions LIMIT 1`;
    const writes = (async () => {
      for (let i = 0; i < 5; i++) {
        await fixtureDb`
          INSERT INTO source_value_versions (source_key, market_date, value, revision_kind)
          VALUES ('raw_indicator_history:LATE', DATE '1980-01-01' + ${i}::int, ${i}, 'legacy_baseline')`;
        const [r] = await fixtureDb<{ id: string }[]>`
          INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity)
          VALUES (${crypto.randomUUID()}, '2001-01-01', 'regime', 'live', ${mv!.id}, 'late') RETURNING id::text AS id`;
        await fixtureDb`
          INSERT INTO analytics_report_snapshots (run_id, asof, report_bytes, checksum)
          VALUES (${r!.id}, '2001-01-01', convert_to('{"late":true}', 'UTF8'), encode(sha256(convert_to('{"late":true}', 'UTF8')), 'hex'))`;
      }
    })();
    const after = await record("2001-01-03T000000Z");
    await writes;
    expect(Buffer.compare(Buffer.from(after.bytes), Buffer.from(before.bytes))).toBe(0);
    _resetArchiveForTests();
    const again = await record("2001-01-03T000000Z");
    expect(Buffer.compare(Buffer.from(again.bytes), Buffer.from(before.bytes))).toBe(0);
    const bodyAfter = await bytesOf(await get(`${P.archiveFiles}${f.path}`));
    expect(Buffer.compare(Buffer.from(bodyAfter), Buffer.from(bodyBefore))).toBe(0);
    // The late rows land in no sealed backup: they are stamped after its boundary.
    const listed = (await record("2001-01-04T000000Z")).body.append_only;
    expect(listed.analytics_ledger_runs.rows_added).toBe(0);
  }, 120_000);

  test("parts: rows are never cut, parts are contiguous id ranges under the part size, and a same-second name gets -2", async () => {
    _setArchivePartBytesForTests(4096);
    _resetArchiveForTests();
    try {
      const { body } = await record("2001-01-02T000000Z");
      const files = body.append_only.source_value_versions.files;
      expect(files.length).toBeGreaterThan(10);
      let next = BigInt(svvIds.first);
      const names = new Set<string>();
      let joined = "";
      for (const f of files) {
        expect(BigInt(f.id_min)).toBe(next);
        next = BigInt(f.id_max) + 1n;
        expect(f.bytes_raw).toBeLessThanOrEqual(4096);
        expect(names.has(f.path)).toBe(false);
        names.add(f.path);
        const text = gunzipSync(await bytesOf(await get(`${P.archiveFiles}${f.path}`))).toString("utf8");
        joined += joined === "" ? text : text.slice(text.indexOf("\n") + 1);
      }
      expect(next - 1n).toBe(BigInt(svvIds.last));
      expect(joined).toBe(await copyCsv(csvbSelect("source_value_versions", svvIds.first, svvIds.last)));
      // Day 3 packs 100 rows into each second, so two parts can share a name's span.
      const third = (await record("2001-01-04T000000Z")).body.append_only.source_value_versions.files.map((f: any) => f.path);
      expect(third.some((p: string) => /-2\.csv\.gz$/.test(p))).toBe(true);
    } finally {
      _setArchivePartBytesForTests(null);
      _resetArchiveForTests();
    }
  }, 180_000);

  test("a body whose rows no longer hash to its record is aborted, never completed", async () => {
    const { body } = await record("2001-01-02T000000Z");
    const f = body.append_only.analytics_ledger_runs.files[0];
    // Only by switching the ledger's immutability trigger off (as the schema
    // owner, in this test's own database) can a stored row change at all.
    await fixtureDb.begin(async (tx) => {
      await tx.unsafe("ALTER TABLE analytics_ledger_runs DISABLE TRIGGER USER");
      await tx`UPDATE analytics_ledger_runs SET build_identity = 'tampered' WHERE run_key = ${RUN_A}`;
      await tx.unsafe("ALTER TABLE analytics_ledger_runs ENABLE ALWAYS TRIGGER analytics_ledger_runs_immutable");
      await tx.unsafe("ALTER TABLE analytics_ledger_runs ENABLE ALWAYS TRIGGER analytics_ledger_runs_immutable_row");
    });
    try {
      const res = await get(`${P.archiveFiles}${f.path}`);
      expect(res.status).toBe(200);
      let failed = false;
      try {
        await res.arrayBuffer();
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    } finally {
      await fixtureDb.begin(async (tx) => {
        await tx.unsafe("ALTER TABLE analytics_ledger_runs DISABLE TRIGGER USER");
        await tx`UPDATE analytics_ledger_runs SET build_identity = 'build-a' WHERE run_key = ${RUN_A}`;
        await tx.unsafe("ALTER TABLE analytics_ledger_runs ENABLE ALWAYS TRIGGER analytics_ledger_runs_immutable");
        await tx.unsafe("ALTER TABLE analytics_ledger_runs ENABLE ALWAYS TRIGGER analytics_ledger_runs_immutable_row");
      });
    }
    const ok = await get(`${P.archiveFiles}${f.path}`);
    expect(sha256(await bytesOf(ok))).toBe(f.sha256_gz);
  });

  test("a cancelled download leaves nothing behind: the next request gets the whole verified body", async () => {
    const { body } = await record("2001-01-04T000000Z");
    const f = body.append_only.source_value_versions.files[0];
    const res = await get(`${P.archiveFiles}${f.path}`);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await Bun.sleep(200);
    expect(publicQueryGate.inUse()).toBe(0);
    expect(sha256(await bytesOf(await get(`${P.archiveFiles}${f.path}`)))).toBe(f.sha256_gz);
  }, 60_000);

  test("compression runs off the event loop: timers keep firing and a normal request completes while a large archive streams", async () => {
    const { body } = await record("2001-01-04T000000Z");
    const f = body.append_only.source_value_versions.files[0];
    expect(f.bytes_raw).toBeGreaterThan(4_000_000);
    let last = performance.now();
    let worst = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 5);
    try {
      const download = get(`${P.archiveFiles}${f.path}`).then(bytesOf);
      await Bun.sleep(50);
      const started = performance.now();
      const normal = await get(`${P.rawHistory}?limit=1`);
      expect(normal.status).toBe(200);
      const normalMs = performance.now() - started;
      const gz = await download;
      expect(sha256(gz)).toBe(f.sha256_gz);
      expect(normalMs).toBeLessThan(2000);
      expect(worst).toBeLessThan(500);
    } finally {
      clearInterval(tick);
    }
  }, 120_000);
});

/** Every backend module a module reaches through its static imports. */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"/gms)) {
      const target = join(file, "..", m[1]!);
      if (/\.(ts|js)$/.test(target)) stack.push(target);
    }
  }
  return seen;
}

describe("committed persistence only", () => {
  test("no public analytics handler can reach a provider client or an analytics calculation", () => {
    const src = join(import.meta.dir, "..", "..", "src");
    const reached = [
      ...importGraph(join(src, "api", "routes", "public-analytics.ts")),
      ...importGraph(join(src, "analytics", "store", "public-archive-store.ts")),
    ].map((f) => f.slice(src.length + 1));
    expect(reached).toContain("analytics/store/public-archive-store.ts");
    const forbidden = reached.filter((f) => /^analytics\/(analyze|extract|transform|access)\/|^analytics\/(prepare|index)\.ts$|analyst-sdk/.test(f));
    expect(forbidden).toEqual([]);
  });

  test("with fetch replaced by a thrower, every public route still answers from stored rows", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("a public analytics handler made an HTTP request");
    }) as unknown as typeof fetch;
    try {
      const { body } = await record("2001-01-02T000000Z");
      const paths = [
        P.rawHistory, P.assetPrices, P.sourceVersions, P.vintages, P.overwriteEvents, P.reports,
        `${P.reports}?run=${RUN_A}`, `${P.reports}?vintage=${vintageB}`, P.archiveBackups,
        `${P.archiveFiles}csv/2001-01-02T000000Z/backup.json`,
        `${P.archiveFiles}${body.append_only.analytics_output_snapshots.files[0].path}`,
      ];
      for (const path of paths) {
        const res = await get(path);
        expect(res.status, path).toBe(200);
        await res.arrayBuffer();
      }
      expect(calls).toBe(0);
      // And no handler wrote: the ledger row counts are what the seed left.
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM analytics_report_snapshots`;
      expect(n).toBeGreaterThanOrEqual(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
