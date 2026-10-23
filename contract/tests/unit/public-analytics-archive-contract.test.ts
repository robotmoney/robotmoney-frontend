// Issue 1422: the public analytics contract for the record and its archives.
//   - every route is under /api/public/analytics/, exported from routes.js and
//     declared in routes.d.ts;
//   - every JSON list route has a schema file requiring `schemaVersion`, and
//     the archive record has its own format 1 schema;
//   - executable fixtures: a body of each new shape validates against its
//     schema, and a malformed one does not (the backend tests validate the
//     bodies the real handlers answer against the same files);
//   - the §4.8 budgets and the format 1 constants hold the specified values.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTES } from "../../src/routes.js";
import {
  ARCHIVE_BACKUP_RECORD_SCHEMA,
  ARCHIVE_FORMAT,
  ARCHIVE_PART_BYTES,
  ARCHIVE_SETTLE_MS,
  PUBLIC_ANALYTICS_BYTES_PER_MINUTE,
  PUBLIC_ANALYTICS_CACHE_CONTROL,
  PUBLIC_ANALYTICS_HEAVY_COST,
  PUBLIC_ANALYTICS_IMMUTABLE_CACHE_CONTROL,
  PUBLIC_ANALYTICS_LIST_COST,
  PUBLIC_ANALYTICS_MAX_CONCURRENT_QUERIES,
  PUBLIC_ANALYTICS_QUERY_TIMEOUT_MS,
  PUBLIC_ANALYTICS_SCHEMAS,
  PUBLIC_ANALYTICS_TOKENS_PER_MINUTE,
} from "../../src/public-analytics.js";
import { validateJsonSchema } from "../../../backend/tests/support/json-schema.ts";

const src = join(import.meta.dir, "../../src");
const P = ROUTES.publicAnalytics;
const load = (rel: string) => JSON.parse(readFileSync(join(src, rel), "utf8"));
const H = "a".repeat(64);

describe("routes", () => {
  test("the six record routes and the two archive routes live under /api/public/analytics/", () => {
    for (const key of ["rawHistory", "assetPrices", "sourceVersions", "vintages", "reports", "overwriteEvents", "archiveBackups", "archiveFiles"]) {
      const v = (P as Record<string, string>)[key];
      expect(v, key).toBeTruthy();
      expect(v.startsWith("/api/public/analytics/"), key).toBe(true);
    }
    expect(P.archiveFiles.endsWith("/")).toBe(true);
    const dts = readFileSync(join(src, "routes.d.ts"), "utf8");
    for (const key of ["sourceVersions", "reports", "archiveBackups", "archiveFiles"]) expect(dts).toContain(`${key}: string;`);
  });

  test("every JSON list route has a schema requiring schemaVersion 1; the archive record has its own", () => {
    const lists = Object.values(P).filter((r) => r !== P.archiveFiles);
    expect(Object.keys(PUBLIC_ANALYTICS_SCHEMAS).sort()).toEqual([...lists].sort());
    for (const rel of Object.values(PUBLIC_ANALYTICS_SCHEMAS)) {
      expect(existsSync(join(src, rel)), rel).toBe(true);
      const s = load(rel);
      expect(s.required).toContain("schemaVersion");
      expect(s.properties.schemaVersion).toEqual({ const: 1 });
    }
    const rec = load(ARCHIVE_BACKUP_RECORD_SCHEMA);
    expect(rec.properties.format).toEqual({ const: 1 });
  });
});

describe("budgets and format constants (§4.7, §4.8)", () => {
  test("the values the server and the downloader agree on", () => {
    expect(PUBLIC_ANALYTICS_MAX_CONCURRENT_QUERIES).toBe(2);
    expect(PUBLIC_ANALYTICS_QUERY_TIMEOUT_MS).toBe(5000);
    expect(PUBLIC_ANALYTICS_TOKENS_PER_MINUTE).toBe(100);
    expect(PUBLIC_ANALYTICS_LIST_COST).toBe(1);
    expect(PUBLIC_ANALYTICS_HEAVY_COST).toBe(10);
    expect(PUBLIC_ANALYTICS_BYTES_PER_MINUTE).toBe(50 * 1024 * 1024);
    expect(PUBLIC_ANALYTICS_CACHE_CONTROL).toBe("public, max-age=300");
    expect(PUBLIC_ANALYTICS_IMMUTABLE_CACHE_CONTROL).toBe("public, max-age=31536000, immutable");
    expect(ARCHIVE_FORMAT).toBe(1);
    expect(ARCHIVE_PART_BYTES).toBe(64 * 1024 * 1024);
    expect(ARCHIVE_PART_BYTES).toBeLessThanOrEqual(90 * 1024 * 1024);
    expect(ARCHIVE_SETTLE_MS).toBe(3_600_000);
  });
});

describe("executable fixtures", () => {
  const sourceVersions = {
    schemaVersion: 1,
    limit: 100,
    asof: "2026-10-01T00:00:00.000Z",
    rows: [
      { id: 7, series: "backtest:DTB3", market_date: "2026-09-30", market_instant: null, value: 5.2, revision_kind: "revision", prior_version_id: 6, knowledge_time: "2026-09-30T23:00:00.000Z" },
    ],
    nextCursor: null,
  };
  const reports = {
    schemaVersion: 1,
    limit: 100,
    reports: [{ report_id: 1, run_key: "11111111-1111-4111-8111-111111111111", asof: "2026-09-30", checksum: H, byte_length: 1234, created_at: "2026-09-30T23:31:00.000Z" }],
    nextCursor: "WyIxIl0",
  };
  const backups = {
    schemaVersion: 1,
    limit: 100,
    format: 1,
    backups: [{ backup: "2026-10-01T000000Z", record: "csv/2026-10-01T000000Z/backup.json" }],
    nextCursor: null,
  };
  const file = {
    path: "csv/2026-10-01T000000Z/data/source_value_versions.2026-09-30T010000Z_2026-09-30T230000Z.csv.gz",
    rows: 3, bytes_raw: 300, bytes_gz: 200, sha256_raw: H, sha256_gz: H, id_min: "1", id_max: "3", sum_id: "6",
    time_min: "2026-09-30 01:00:00.123456+00", time_max: "2026-09-30 23:00:00+00",
  };
  const table = (files: unknown[]) => ({
    time: { column: "created_at" }, watermark_before: null, watermark_after: files.length ? "3" : null, rows_added: files.length ? 3 : 0, files,
    db_rows_through_watermark: files.length ? "3" : "0", db_sum_id_through_watermark: files.length ? "6" : "0",
  });
  const record = {
    format: 1,
    backup: "2026-10-01T000000Z",
    source: "api",
    consistency: "paged",
    snapshot: { exported_at_db: "2026-10-01 00:00:00+00", replica_replay_ts: null, db_user: "api", was_replica: false },
    tool: { name: "robotmoney-api", commit: null },
    append_only: Object.fromEntries(
      ["analytics_output_snapshots", "analytics_report_snapshots", "source_value_versions", "analytics_ledger_runs", "analytics_ledger_methodology_versions", "analytics_data_vintages", "analytics_vintage_members", "analytics_overwrite_events"].map(
        (t) => [t, table(t === "source_value_versions" ? [file] : [])],
      ),
    ),
    revisions: {},
  };

  test("each new body validates against its schema", () => {
    expect(validateJsonSchema(load(PUBLIC_ANALYTICS_SCHEMAS[P.sourceVersions]!), sourceVersions)).toEqual([]);
    expect(validateJsonSchema(load(PUBLIC_ANALYTICS_SCHEMAS[P.reports]!), reports)).toEqual([]);
    expect(validateJsonSchema(load(PUBLIC_ANALYTICS_SCHEMAS[P.archiveBackups]!), backups)).toEqual([]);
    expect(validateJsonSchema(load(ARCHIVE_BACKUP_RECORD_SCHEMA), record)).toEqual([]);
  });

  test("RED CONTROL: a malformed body of each shape is refused", () => {
    expect(validateJsonSchema(load(PUBLIC_ANALYTICS_SCHEMAS[P.sourceVersions]!), { ...sourceVersions, rows: [{ ...sourceVersions.rows[0], revision_kind: "guess" }] })).not.toEqual([]);
    expect(validateJsonSchema(load(PUBLIC_ANALYTICS_SCHEMAS[P.reports]!), { ...reports, reports: [{ ...reports.reports[0], checksum: "nope" }] })).not.toEqual([]);
    expect(validateJsonSchema(load(PUBLIC_ANALYTICS_SCHEMAS[P.archiveBackups]!), { ...backups, backups: [{ backup: "2026-10-01", record: "x" }] })).not.toEqual([]);
    const badPath = structuredClone(record);
    (badPath.append_only.source_value_versions.files[0] as { path: string }).path = "csv/2026-10-01T000000Z/data/../../etc.csv.gz";
    expect(validateJsonSchema(load(ARCHIVE_BACKUP_RECORD_SCHEMA), badPath)).not.toEqual([]);
    const missing = structuredClone(record) as { append_only: Record<string, unknown> };
    delete missing.append_only.analytics_ledger_runs;
    expect(validateJsonSchema(load(ARCHIVE_BACKUP_RECORD_SCHEMA), missing)).not.toEqual([]);
    expect(validateJsonSchema(load(ARCHIVE_BACKUP_RECORD_SCHEMA), { ...record, format: 2 })).not.toEqual([]);
  });
});
