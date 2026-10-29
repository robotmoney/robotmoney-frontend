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
import { join, relative } from "node:path";
import { Transform } from "node:stream";
import { createGzip, gunzipSync, gzipSync } from "node:zlib";
import { ARCHIVE_BACKUP_RECORD_SCHEMA, ARCHIVE_PART_BYTES, PUBLIC_ANALYTICS_SCHEMAS, ROUTES } from "@robotmoney/contract";
import { sql } from "../../src/db/client.ts";
import { _resetPublicAnalyticsRateLimitForTests, handlePublicAnalytics } from "../../src/api/routes/public-analytics.ts";
import { publicQueryGate } from "../../src/api/public-analytics-limits.ts";
import {
  _resetArchiveForTests,
  _setArchiveClockForTests,
  _setArchiveGzipForTests,
  _setArchiveJunctionForTests,
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("a response body never ended")), 60_000);
  });
  try {
    return new Uint8Array(await Promise.race([res.arrayBuffer(), timeout]));
  } finally {
    clearTimeout(timer);
  }
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
  _setArchiveJunctionForTests(null);
  _setArchiveGzipForTests(null);
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
    // Collected from events, ending on whichever of end or close comes first:
    // a for-await over this stream intermittently never saw its end under a
    // loaded full-suite run.
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString("utf8"));
      };
      const timer = setTimeout(() => {
        if (!done) reject(new Error(`COPY of ${select.slice(0, 80)} never ended`));
      }, 60_000);
      stream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
      stream.on("end", finish);
      stream.on("close", finish);
      stream.on("error", (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });
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
      if (i % 10 === 9) console.error(`[archives test] backup ${id} still 503 after ${i + 1} tries: ${await res.text()} (gate ${publicQueryGate.inUse()})`);
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
      [5.1, "initial", "2001-01-02T03:00:00.000000Z"],
      [5.2, "revision", "2001-01-02T09:00:00.000000Z"],
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
    expect(before.asof).toBe("2001-01-02T05:00:00Z");
    expect(before.rows.map((r: any) => r.value)).toEqual([5.1]);
    const after: any = await (await get(`${P.sourceVersions}?series=backtest:DTB3&asof=2001-01-02`)).json();
    expect(after.rows.map((r: any) => r.value)).toEqual([5.2]);
    const none: any = await (await get(`${P.sourceVersions}?series=backtest:DTB3&asof=2001-01-01`)).json();
    expect(none.rows).toEqual([]);
  });

  test("times keep their microseconds: an asof one microsecond before a version excludes it, at it includes it", async () => {
    const at: any = await (await get(`${P.sourceVersions}?series=raw_indicator_history:ARCH&asof=2001-01-01T02:00:00.000123Z`)).json();
    expect(at.asof).toBe("2001-01-01T02:00:00.000123Z");
    expect(at.rows.map((r: any) => [r.market_date, r.knowledge_time])).toEqual([["1990-01-01", "2001-01-01T02:00:00.000123Z"]]);
    const before: any = await (await get(`${P.sourceVersions}?series=raw_indicator_history:ARCH&asof=2001-01-01T02:00:00.000122Z`)).json();
    expect(before.rows).toEqual([]);
    const [stored] = await fixtureDb<{ t: string }[]>`
      SELECT to_char(knowledge_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t
      FROM source_value_versions WHERE source_key = 'raw_indicator_history:ARCH' AND market_date = '1990-01-01'`;
    expect(stored!.t).toBe("2001-01-01T02:00:00.000123Z");
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
          expect(body.headers.get("ETag")).toBe(`"${f.sha256_raw}"`);
          expect(body.headers.get("X-Content-SHA256")).toBe(f.sha256_raw);
          const gz = await bytesOf(body);
          const text = gunzipSync(gz).toString("utf8");
          expect(sha256(text)).toBe(f.sha256_raw);
          expect(Buffer.byteLength(text)).toBe(f.bytes_raw);
          // The parity check: Postgres's own COPY CSV of the same rows, as
          // csvb selects them, is the same text (its identity is the hash of
          // that text, whatever gzip carries it).
          if (f.rows <= PARITY_ROWS) {
            const copy = await copyCsv(csvbSelect(table, f.id_min, f.id_max));
            expect(text === copy, `${f.path} differs from COPY CSV`).toBe(true);
            expect(sha256(copy)).toBe(f.sha256_raw);
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
      const cond = await get(`${P.archiveFiles}${f.path}`, { headers: { "If-None-Match": `"${f.sha256_raw}"` } });
      expect(cond.status).toBe(304);
      expect(cond.headers.get("ETag")).toBe(`"${f.sha256_raw}"`);
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
    expect(sha256(gunzipSync(await bytesOf(ok)))).toBe(f.sha256_raw);
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
    expect(sha256(gunzipSync(await bytesOf(await get(`${P.archiveFiles}${f.path}`))))).toBe(f.sha256_raw);
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
      expect(sha256(gunzipSync(gz))).toBe(f.sha256_raw);
      expect(normalMs).toBeLessThan(2000);
      expect(worst).toBeLessThan(500);
    } finally {
      clearInterval(tick);
    }
  }, 120_000);
});

describe("archive: watermarks that never move", () => {
  test("a gap at the tail of an id sequence does not move a sealed watermark when a later row arrives", async () => {
    _resetArchiveForTests();
    // Burn two ids, as a rolled-back insert or a 23505 retry does.
    await fixtureDb.unsafe("SELECT nextval(pg_get_serial_sequence('analytics_ledger_methodology_versions', 'id')) FROM generate_series(1, 2)");
    const before = await record("2001-01-04T000000Z");
    const [{ max }] = await fixtureDb<{ max: string }[]>`SELECT max(id)::text AS max FROM analytics_ledger_methodology_versions`;
    expect(before.body.append_only.analytics_ledger_methodology_versions.watermark_after).toBe(max);
    // A later row arrives past the gap.
    await fixtureDb`
      INSERT INTO analytics_ledger_methodology_versions (tool_id, version_label, config, config_digest)
      VALUES ('regime', 'after-the-gap', '{}', repeat('e', 64))`;
    _resetArchiveForTests();
    const after = await record("2001-01-04T000000Z");
    expect(after.body.append_only.analytics_ledger_methodology_versions.watermark_after).toBe(max);
    expect(Buffer.compare(Buffer.from(after.bytes), Buffer.from(before.bytes))).toBe(0);
    for (const id of ["2001-01-02T000000Z", "2001-01-03T000000Z"]) {
      const a = (await record(id)).body.append_only;
      for (const [t, rec] of Object.entries<any>(a)) {
        if (rec.watermark_after === null) continue;
        const [hit] = await fixtureDb.unsafe(`SELECT count(*)::int AS n FROM ${t} WHERE id = ${rec.watermark_after}`);
        expect(hit!.n, `${id} ${t} watermark ${rec.watermark_after} names a row`).toBe(1);
      }
    }
  }, 120_000);

  test("two freezes interleaving across midnight: every member of a vintage is in the backup that holds the vintage", async () => {
    const [run] = await fixtureDb<{ id: string; mv: string }[]>`
      SELECT id::text AS id, methodology_version_id::text AS mv FROM analytics_ledger_runs WHERE run_key = ${RUN_B}`;
    const freeze = async (tool: string, at: string) => {
      const [v] = await fixtureDb<{ id: string }[]>`
        INSERT INTO analytics_data_vintages (run_id, tool_id, knowledge_time_cutoff, market_time_cutoff, methodology_version_id,
          build_identity, manifest, manifest_digest, member_count, created_at)
        VALUES (${run!.id}, ${tool}, ${at}, '2001-01-04', ${run!.mv}, 'build-i', '{}', repeat('f', 64), 2, ${at})
        RETURNING id::text AS id`;
      return v!.id;
    };
    const c = await freeze("interleave-c", "2001-01-04T23:59:59Z");
    const d = await freeze("interleave-d", "2001-01-05T00:00:01Z");
    const member = async (vintage: string, svv: number) => {
      const [m] = await fixtureDb<{ id: string }[]>`
        INSERT INTO analytics_vintage_members (vintage_id, source_value_version_id, source_key)
        VALUES (${vintage}, ${svv}, 'raw_indicator_history:ARCH') RETURNING id::text AS id`;
      return m!.id;
    };
    const first = Number(svvIds.first);
    const c1 = await member(c, first);
    await member(d, first);
    const c2 = await member(c, first + 1);
    await member(d, first + 1);
    _setArchiveClockForTests(() => Date.parse("2001-01-06T03:00:00Z"));
    _resetArchiveForTests();
    try {
      const membersOf = async (id: string): Promise<{ vintages: Set<string>; members: Map<string, string> }> => {
        const a = (await record(id)).body.append_only;
        const vintages = new Set<string>();
        for (const f of a.analytics_data_vintages.files) {
          const lines = gunzipSync(await bytesOf(await get(`${P.archiveFiles}${f.path}`))).toString("utf8").trim().split("\n").slice(1);
          for (const l of lines) vintages.add(l.split(",")[0]!);
        }
        const members = new Map<string, string>();
        for (const f of a.analytics_vintage_members.files) {
          const lines = gunzipSync(await bytesOf(await get(`${P.archiveFiles}${f.path}`))).toString("utf8").trim().split("\n").slice(1);
          for (const l of lines) members.set(l.split(",")[0]!, l.split(",")[1]!);
        }
        return { vintages, members };
      };
      const day5 = await membersOf("2001-01-05T000000Z");
      expect(day5.vintages.has(c)).toBe(true);
      expect(day5.vintages.has(d)).toBe(false);
      expect(day5.members.get(c1)).toBe(c);
      expect(day5.members.get(c2)).toBe(c);
      // No member of a vintage the backup holds is left for a later one.
      const day6 = await membersOf("2001-01-06T000000Z");
      expect(day6.vintages.has(d)).toBe(true);
      expect([...day6.members.values()].includes(c)).toBe(false);
    } finally {
      _setArchiveClockForTests(() => NOW);
      _resetArchiveForTests();
    }
  }, 120_000);
});

// Three gzip encoders that write different bytes for the same content: Bun's
// gzip, and node:zlib at level 1 and level 9.
function bunGzip(): Transform {
  const parts: Buffer[] = [];
  return new Transform({
    transform(chunk, _enc, cb) {
      parts.push(Buffer.from(chunk));
      cb();
    },
    flush(cb) {
      cb(null, Buffer.from(Bun.gzipSync(Buffer.concat(parts))));
    },
  });
}
const ENCODERS: Record<string, () => Transform> = { bun: bunGzip, "zlib-1": () => createGzip({ level: 1 }), "zlib-9": () => createGzip({ level: 9 }) };

describe("archive: identity is the content, never the gzip encoder", () => {
  test("the same content under three gzip encoders: the same identity, ETag and manifest entry, with no 503 and no encoder pin", async () => {
    const id = "2001-01-02T000000Z";
    const recordTexts = new Set<string>();
    const etags = new Set<string>();
    const gzHashes = new Set<string>();
    const contentHashes = new Set<string>();
    let file: any;
    try {
      for (const [name, make] of Object.entries(ENCODERS)) {
        _setArchiveGzipForTests(make);
        _resetArchiveForTests();
        const { body, bytes } = await record(id);
        recordTexts.add(new TextDecoder().decode(bytes));
        file = body.append_only.source_value_versions.files[0];
        const res = await get(`${P.archiveFiles}${file.path}`);
        expect(res.status, `${name} must not be refused`).toBe(200);
        etags.add(res.headers.get("ETag")!);
        const gz = await bytesOf(res);
        gzHashes.add(sha256(gz));
        contentHashes.add(sha256(gunzipSync(gz)));
        expect(res.headers.get("X-Content-SHA256")).toBe(file.sha256_raw);
        // A revalidation by the content hash is a 304 whatever the encoder.
        const cond = await get(`${P.archiveFiles}${file.path}`, { headers: { "If-None-Match": `"${file.sha256_raw}"` } });
        expect(cond.status).toBe(304);
      }
    } finally {
      _setArchiveGzipForTests(null);
      _resetArchiveForTests();
    }
    expect(gzHashes.size, "the encoders must write different gzip bytes for this to test anything").toBeGreaterThan(1);
    expect(recordTexts.size).toBe(1);
    expect([...etags]).toEqual([`"${file.sha256_raw}"`]);
    expect([...contentHashes]).toEqual([file.sha256_raw]);
  }, 120_000);

  test("content gzipped by each encoder has one identity: the hash of the uncompressed bytes", () => {
    const content = Buffer.from(Array.from({ length: 4000 }, (_, i) => `${i},raw_indicator_history:X${i % 7},${(i * 1.25).toFixed(3)}\n`).join(""));
    const identities = new Set<string>();
    const gzips = new Set<string>();
    for (const gz of [Bun.gzipSync(content), gzipSync(content, { level: 1 }), gzipSync(content, { level: 9 })]) {
      gzips.add(sha256(gz));
      identities.add(sha256(gunzipSync(gz)));
    }
    expect(gzips.size).toBeGreaterThan(1);
    expect([...identities]).toEqual([sha256(content)]);
  });

  test("an encoded slash names no route", async () => {
    expect((await get(`${P.archiveFiles}csv%2F2001-01-02T000000Z%2Fbackup.json`)).status).toBe(404);
    expect((await get(`/api/public/analytics/reports%2f`)).status).toBe(404);
  });
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
    ].map((f) => relative(join(src, "..", ".."), f));
    expect(reached).toContain("backend/src/analytics/store/public-archive-store.ts");
    // The store writes format 1 through the SDK's format module (issue 1477), which reaches only the series ids and
    // the indicator catalog: no SDK calculation, no source client.
    expect(reached).toContain("packages/analyst-sdk/src/archive/format1.ts");
    const forbidden = reached.filter(
      (f) =>
        /^backend\/src\/analytics\/(analyze|extract|transform|access)\/|^backend\/src\/analytics\/(prepare|index)\.ts$/.test(f) ||
        /^packages\/analyst-sdk\/src\/(transform|allocate|extract|access)\/|^packages\/analyst-sdk\/src\/analyze\/(?!indicators\.ts$)|^packages\/analyst-sdk\/src\/(run|prepare|index|coverage)\.ts$|^packages\/analyst-sdk\/src\/archive\/local-copy\.ts$/.test(f),
    );
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

// Issue 1477: the legacy junction, planted synthetically (never production watermarks). Format 1's cut rule makes
// the newest snapshot-time csvb backup one extra cut point between the day cuts around it, so a repo clone and an API
// increment join at its id.
describe("archive: the legacy junction", () => {
  const JUNCTION = "2001-01-02T130000Z";
  const AT = "2001-01-02 13:00:00+00";

  /** Each served table's watermark at AT, by the day-cut rule's own definition. */
  async function watermarksAt(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const t of ARCHIVE_TABLES) {
      let rows: { wm: string | null }[];
      if ("column" in t.time) {
        rows = await fixtureDb.unsafe(
          `SELECT (SELECT max(x.id) FROM ${t.name} x WHERE x.id < COALESCE((SELECT id FROM ${t.name} WHERE ${t.time.column} >= $1::timestamptz ORDER BY id LIMIT 1), (SELECT max(id) FROM ${t.name}) + 1))::text AS wm`,
          [AT],
        );
      } else {
        const l = t.time.lookup;
        rows = await fixtureDb.unsafe(`SELECT max(id)::text AS wm FROM ${t.name} WHERE ${l.column} <= $1::bigint`, [out[l.table]!]);
      }
      out[t.name] = rows[0]!.wm!;
    }
    return out;
  }
  async function maxIds(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const t of ARCHIVE_TABLES) out[t.name] = (await fixtureDb.unsafe(`SELECT max(id)::text AS wm FROM ${t.name}`))[0]!.wm;
    return out;
  }
  async function served(): Promise<{ ids: string[]; records: Map<string, { body: any; bytes: Uint8Array }> }> {
    const ids = ((await (await get(P.archiveBackups)).json()) as any).backups.map((b: any) => b.backup) as string[];
    const records = new Map<string, { body: any; bytes: Uint8Array }>();
    for (const id of ids) records.set(id, await record(id));
    return { ids, records };
  }

  test("pre-junction day cuts are unchanged, the junction is served between them, and the next day chains from it", async () => {
    _setArchiveJunctionForTests(null);
    const base = await served();
    expect(base.ids).not.toContain(JUNCTION);

    const planted = await watermarksAt();
    for (const [t, wm] of Object.entries(planted)) expect(wm, `${t} has a row before the junction`).toBeTruthy();
    _setArchiveJunctionForTests({ id: JUNCTION, watermarks: planted });
    try {
      const got = await served();
      // The list: the day cuts, with the junction in its place.
      expect(got.ids).toEqual([...base.ids, JUNCTION].sort());
      const at = got.ids.indexOf(JUNCTION);
      const before = got.ids[at - 1]!;
      const after = got.ids[at + 1]!;
      expect([before, after]).toEqual(["2001-01-02T000000Z", "2001-01-03T000000Z"]);
      // (a) every pre-junction day cut, byte for byte.
      for (const id of got.ids.slice(0, at)) expect(Buffer.from(got.records.get(id)!.bytes).equals(Buffer.from(base.records.get(id)!.bytes)), id).toBe(true);
      // (b) the junction backup continues from the preceding day cut and ends at the planted watermarks.
      const j = got.records.get(JUNCTION)!.body;
      expect(validateJsonSchema(schema(P.archiveFiles), j)).toEqual([]);
      expect(j.snapshot.exported_at_db).toBe("2001-01-02 13:00:00+00");
      for (const t of ARCHIVE_TABLES) {
        expect(j.append_only[t.name].watermark_before, t.name).toBe(got.records.get(before)!.body.append_only[t.name].watermark_after);
        expect(j.append_only[t.name].watermark_after, t.name).toBe(planted[t.name]);
      }
      // (c) the next day cut chains from the junction, and ends where it did without it.
      const next = got.records.get(after)!.body;
      for (const t of ARCHIVE_TABLES) {
        expect(next.append_only[t.name].watermark_before, t.name).toBe(planted[t.name]);
        expect(next.append_only[t.name].watermark_after, t.name).toBe(base.records.get(after)!.body.append_only[t.name].watermark_after);
      }
      // Later day cuts are byte for byte what they were: the junction only splits one day.
      for (const id of got.ids.slice(at + 2)) expect(Buffer.from(got.records.get(id)!.bytes).equals(Buffer.from(base.records.get(id)!.bytes)), id).toBe(true);
      // The junction's archives are served, and hash to its record.
      for (const t of Object.values(j.append_only) as any[]) {
        for (const f of t.files) {
          const res = await get(`${P.archiveFiles}${f.path}`);
          expect(res.status, f.path).toBe(200);
          expect(sha256(gunzipSync(await bytesOf(res)))).toBe(f.sha256_raw);
        }
      }
      expect((j.append_only.analytics_overwrite_events.files as any[]).length).toBe(1); // the 12:00 revision row
    } finally {
      _setArchiveJunctionForTests(null);
    }
  }, 180_000);

  test("a junction no row follows is no cut: the list and every record are unchanged", async () => {
    _setArchiveJunctionForTests(null);
    const base = await served();
    _setArchiveJunctionForTests({ id: JUNCTION, watermarks: await maxIds() });
    try {
      const got = await served();
      expect(got.ids).toEqual(base.ids);
      expect((await get(`${P.archiveFiles}csv/${JUNCTION}/backup.json`)).status).toBe(404);
      for (const id of got.ids) expect(Buffer.from(got.records.get(id)!.bytes).equals(Buffer.from(base.records.get(id)!.bytes)), id).toBe(true);
    } finally {
      _setArchiveJunctionForTests(null);
    }
  }, 180_000);
});
