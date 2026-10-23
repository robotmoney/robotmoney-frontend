// Issue 1404: the API-only acquisition, recorded from the REAL public archive
// routes (issue 1422), replayed by the analyst SDK.
//
// Two committed regime runs are seeded into the ephemeral Postgres with fixed
// times. The test acquires them the way the README's API-only fill does: list
// `archive/backups`, fetch each `backup.json`, then each archive it lists, and
// check every archive's sha256_gz. It drives the real handler
// (handlePublicAnalytics), as the issue 1422 archive tests do.
//
// Every response body is compared with the recording committed at
// packages/analyst-sdk/tests/fixtures/archive/api-recorded/, which the SDK's
// unit and analyst-sdk jobs replay with no database and no private repository.
// The recording therefore stays what the real routes serve:
//   - under the pinned encoder (Bun 1.3.5, ARCHIVE_GZIP_FIXTURE_SHA256), byte for byte;
//   - under another Bun, by content: each record with its gzip-dependent
//     fields (bytes_gz, sha256_gz) left out, and each archive's uncompressed bytes.
// RECORD_ANALYST_SDK_ARCHIVE=1 rewrites the recording instead (run it under the
// pinned Bun only; the test then refuses to write under any other).
//
// The acquired copy then goes through the SDK's real `bin/inputs.ts`: the
// generated input is exactly the frozen vintage's members, and the report is
// byte-identical to the one built from the members read straight from Postgres.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { ROUTES } from "@robotmoney/contract";
import { _resetPublicAnalyticsRateLimitForTests, handlePublicAnalytics } from "../src/api/routes/public-analytics.ts";
import {
  _resetArchiveForTests,
  _setArchiveClockForTests,
  _setArchiveEncoderPinForTests,
  ARCHIVE_GZIP_FIXTURE_SHA256,
  encoderFixtureSha256,
} from "../src/analytics/store/public-archive-store.ts";
import { parseInput, parseRawHistory, toHistory } from "../../packages/analyst-sdk/src/input/load.ts";
import { seriesForStorageKey } from "../../packages/analyst-sdk/src/archive/format1.ts";
import { buildReport, runRegime } from "../../packages/analyst-sdk/src/run.ts";
import type { RawIndicatorHistory } from "../../packages/analyst-sdk/src/types.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

const P = ROUTES.publicAnalytics;
const SDK = join(import.meta.dir, "../../packages/analyst-sdk");
const RECORDING = join(SDK, "tests/fixtures/archive/api-recorded");
const TMP = mkdtempSync(join(tmpdir(), "rm-sdk-api-recording-"));
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

// "Now" for the archive: 2001-01-03 03:00 UTC, so the backups of 2001-01-01 and
// 2001-01-02 (ids 2001-01-02T000000Z, 2001-01-03T000000Z) are sealed.
const NOW = Date.parse("2001-01-03T03:00:00Z");
const FROM = "2026-05-01";
const RUN1 = { key: "0f6b6c1e-6a52-4c39-9f4e-1a2b3c4d5ea1", asof: "2026-08-01" };
const RUN2 = { key: "0f6b6c1e-6a52-4c39-9f4e-1a2b3c4d5ea2", asof: "2026-08-15" };
const BUILD = "4b4414c0e5a1d2f3b4c5d6e7f8091a2b3c4d5e6f";
const EXTRA: Record<string, string> = { SPX: "backtest:^GSPC", ETH: "backtest:ETH-USD", TBILL3M: "backtest:DTB3" };
let pinned = false;
let vintage2 = "";
const revised = { key: "raw_indicator_history:VIX", date: "2026-07-31" };

beforeAll(async () => {
  _resetArchiveForTests();
  _setArchiveClockForTests(() => NOW);
  const here = await encoderFixtureSha256();
  pinned = here === ARCHIVE_GZIP_FIXTURE_SHA256;
  // Under another Bun the archives are served with this runtime's encoder, and
  // compared with the recording by content (see the header).
  if (!pinned) _setArchiveEncoderPinForTests(here);

  const text = readFileSync(join(SDK, "tests/fixtures/raw-indicator-history.csv"), "utf8");
  const rows = parseRawHistory(text).filter((r) => r.date >= FROM);
  const obs = rows
    .map((r) => ({ key: EXTRA[r.indicator] ?? `raw_indicator_history:${r.indicator}`, date: r.date, value: r.value }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const early = obs.filter((o) => o.date <= RUN1.asof);
  const late = obs.filter((o) => o.date > RUN1.asof);

  const [mv] = await fixtureDb<{ id: string }[]>`
    INSERT INTO analytics_ledger_methodology_versions (tool_id, version_label, config, config_digest, created_at)
    VALUES ('regime', 'regime-v3', '{"panels": ["macro", "onchain"]}', repeat('d', 64), '2001-01-01 00:30:00+00')
    RETURNING id::text AS id`;
  // Day 1: everything known at run 1's cutoff, in key-then-date order, so each
  // key's versions are consecutive ids (one member range per key).
  const insertLegacy = async (list: typeof obs, kt: string) => {
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
  await insertLegacy(early, "2001-01-01 02:00:00.000123+00");
  const [r1] = await fixtureDb<{ id: string }[]>`
    INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity, created_at)
    VALUES (${RUN1.key}, ${RUN1.asof}, 'regime', 'live', ${mv!.id}, ${BUILD}, '2001-01-01 05:00:00+00') RETURNING id::text AS id`;
  const freeze = async (runId: string, cutoff: string, asof: string, createdAt: string, excludeId: string | null) => {
    const members = await fixtureDb<{ id: string; source_key: string }[]>`
      SELECT id::text AS id, source_key FROM source_value_versions
      WHERE knowledge_time <= ${cutoff}::timestamptz AND market_date <= ${asof}::date AND (${excludeId}::bigint IS NULL OR id <> ${excludeId}::bigint)
      ORDER BY id`;
    const [v] = await fixtureDb<{ id: string }[]>`
      INSERT INTO analytics_data_vintages (run_id, tool_id, knowledge_time_cutoff, market_time_cutoff, methodology_version_id,
        build_identity, manifest, manifest_digest, member_count, created_at)
      VALUES (${runId}, 'regime', ${cutoff}, ${asof}, ${mv!.id}, ${BUILD}, ${`{"run": ${runId}}`}, repeat('e', 64), ${members.length}, ${createdAt})
      RETURNING id::text AS id`;
    // Runs of consecutive ids under one key, as freezeVintage stores them.
    const ranges: [string, string, string | null][] = [];
    for (let i = 0; i < members.length; ) {
      let j = i;
      while (j + 1 < members.length && BigInt(members[j + 1]!.id) === BigInt(members[j]!.id) + 1n && members[j + 1]!.source_key === members[i]!.source_key) j++;
      ranges.push([members[i]!.id, members[i]!.source_key, j > i ? members[j]!.id : null]);
      i = j + 1;
    }
    for (const [first, key, last] of ranges) {
      await fixtureDb`INSERT INTO analytics_vintage_members (vintage_id, source_value_version_id, source_key, last_source_value_version_id)
        VALUES (${v!.id}, ${first}, ${key}, ${last})`;
    }
    return { id: v!.id, members: members.length };
  };
  await freeze(r1!.id, "2001-01-01 04:00:00+00", RUN1.asof, "2001-01-01 06:00:00+00", null);

  // Day 2: a provider revises VIX on one date (a new version, its own
  // acquisition), then the later observations arrive, then run 2 freezes.
  const [orig] = await fixtureDb<{ id: string; value: number }[]>`
    SELECT id::text AS id, value FROM source_value_versions WHERE source_key = ${revised.key} AND market_date = ${revised.date}::date`;
  await fixtureDb`INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity, knowledge_time)
    VALUES ('00000000-0000-4000-8000-000000001404', 'yahoo', 'v1', 'vix', '2001-01-02 01:00:00+00')`;
  await fixtureDb`
    INSERT INTO source_value_versions (acquisition_id, source_key, market_date, value, prior_version_id, revision_kind, knowledge_time, provenance)
    VALUES ('00000000-0000-4000-8000-000000001404', ${revised.key}, ${revised.date}, ${orig!.value + 0.25}, ${orig!.id}, 'revision',
      '2001-01-02 01:00:00+00', 'live')`;
  await insertLegacy(late, "2001-01-02 02:00:00.000456+00");
  const [r2] = await fixtureDb<{ id: string }[]>`
    INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity, created_at)
    VALUES (${RUN2.key}, ${RUN2.asof}, 'regime', 'live', ${mv!.id}, ${BUILD}, '2001-01-02 05:00:00+00') RETURNING id::text AS id`;
  vintage2 = (await freeze(r2!.id, "2001-01-02 04:00:00+00", RUN2.asof, "2001-01-02 06:00:00+00", orig!.id)).id;
}, 120_000);

afterAll(() => {
  _setArchiveEncoderPinForTests(null);
  _setArchiveClockForTests(null);
  _resetArchiveForTests();
  rmSync(TMP, { recursive: true, force: true });
});

async function get(path: string): Promise<Uint8Array> {
  for (let i = 0; i < 60; i++) {
    _resetPublicAnalyticsRateLimitForTests();
    const req = new Request(`http://api.test${path}`);
    const res = await handlePublicAnalytics(req, new URL(req.url), "192.0.2.14");
    if (res.status === 503) {
      await Bun.sleep(250);
      continue;
    }
    expect(res.status, path).toBe(200);
    return new Uint8Array(await res.arrayBuffer());
  }
  throw new Error(`${path} kept answering 503`);
}

const listFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p.slice(root.length + 1));
    }
  };
  if (existsSync(root)) walk(root);
  return out;
};

// A record without its gzip-dependent fields: what must match across Bun versions.
function encoderFree(recordText: string): unknown {
  const r = JSON.parse(recordText);
  for (const t of Object.values(r.append_only) as { files: Record<string, unknown>[] }[]) {
    for (const f of t.files) {
      delete f.bytes_gz;
      delete f.sha256_gz;
    }
  }
  return r;
}

test(
  "the API-only acquisition from the real archive routes matches the committed recording, and the SDK replays it to the vintage's exact report",
  async () => {
    // (1) Acquire: the backup list, each record, each archive it lists.
    const served = new Map<string, Uint8Array>();
    const list = JSON.parse(new TextDecoder().decode(await get(`${P.archiveBackups}?limit=1000`)));
    expect(list.nextCursor).toBeNull();
    expect(list.backups.map((b: { backup: string }) => b.backup)).toEqual(["2001-01-02T000000Z", "2001-01-03T000000Z"]);
    served.set("backups.json", await get(`${P.archiveBackups}?limit=1000`));
    for (const { record } of list.backups as { record: string }[]) {
      const recBytes = await get(`${P.archiveFiles}${record}`);
      served.set(record, recBytes);
      const rec = JSON.parse(new TextDecoder().decode(recBytes));
      for (const t of Object.values(rec.append_only) as { files: { path: string; sha256_gz: string; rows: number }[] }[]) {
        for (const f of t.files) {
          const body = await get(`${P.archiveFiles}${f.path}`);
          expect(sha256(body), f.path).toBe(f.sha256_gz);
          served.set(f.path, body);
        }
      }
    }
    expect([...served.keys()].some((k) => k.includes("/data/source_value_versions."))).toBe(true);

    // (2) The committed recording is what the real routes serve.
    if (process.env.RECORD_ANALYST_SDK_ARCHIVE === "1") {
      expect(pinned, "record only under the pinned Bun (1.3.5), so CI's bytes are the recording").toBe(true);
      rmSync(RECORDING, { recursive: true, force: true });
      for (const [rel, bytes] of served) {
        mkdirSync(dirname(join(RECORDING, rel)), { recursive: true });
        writeFileSync(join(RECORDING, rel), bytes);
      }
    }
    expect(listFiles(RECORDING).sort()).toEqual([...served.keys()].sort());
    for (const [rel, bytes] of served) {
      const committed = new Uint8Array(readFileSync(join(RECORDING, rel)));
      if (pinned) expect(sha256(committed), rel).toBe(sha256(bytes));
      else if (rel.endsWith(".gz")) expect(sha256(gunzipSync(committed)), rel).toBe(sha256(gunzipSync(bytes)));
      else if (rel === "backups.json") expect(new TextDecoder().decode(committed)).toBe(new TextDecoder().decode(bytes));
      else expect(encoderFree(new TextDecoder().decode(committed))).toEqual(encoderFree(new TextDecoder().decode(bytes)));
    }

    // (3) The acquired local copy, through the SDK's real input command.
    const copy = join(TMP, "copy");
    for (const [rel, bytes] of served) {
      if (rel === "backups.json") continue;
      mkdirSync(dirname(join(copy, rel)), { recursive: true });
      writeFileSync(join(copy, rel), bytes);
    }
    const out = join(TMP, "out");
    const p = Bun.spawn(["bun", join(SDK, "bin/inputs.ts"), "--archive", copy, "--run", RUN2.key, "--out", out], { cwd: SDK, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    expect(code, stderr).toBe(0);
    const inputText = readFileSync(join(out, "inputs.csv"), "utf8");
    const manifest = JSON.parse(readFileSync(join(out, "inputs.manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ backup_id: "2001-01-03T000000Z", run_key: RUN2.key, asof: RUN2.asof, source: "api", code_revision: BUILD, sha256: sha256(inputText) });

    // (4) Exact membership and report bytes against the vintage read from Postgres.
    const members = await fixtureDb<{ source_key: string; market_date: string; value: number }[]>`
      SELECT v.source_key, v.market_date::text AS market_date, v.value
      FROM analytics_vintage_members m
      CROSS JOIN LATERAL generate_series(m.source_value_version_id, COALESCE(m.last_source_value_version_id, m.source_value_version_id)) g(id)
      JOIN source_value_versions v ON v.id = g.id
      WHERE m.vintage_id = ${vintage2}::bigint`;
    const fromDb: RawIndicatorHistory = {};
    for (const m of members) {
      const id = seriesForStorageKey(m.source_key);
      if (id) (fromDb[id] ??= []).push({ date: m.market_date, value: m.value });
    }
    for (const id in fromDb) fromDb[id]!.sort((a, b) => (a.date < b.date ? -1 : 1));
    const generated = parseInput(inputText, { replay: true });
    expect(generated.rows).toBe(members.length);
    expect(generated.history).toEqual(fromDb);
    const rev = generated.history.VIX!.find((x) => x.date === revised.date)!.value;
    expect(rev).toBe(toHistory(parseRawHistory(readFileSync(join(SDK, "tests/fixtures/raw-indicator-history.csv"), "utf8"))).VIX!.find((x) => x.date === revised.date)!.value + 0.25);
    const a = JSON.stringify(buildReport(runRegime(generated.history, { asof: RUN2.asof }), { full: true }));
    const b = JSON.stringify(buildReport(runRegime(fromDb, { asof: RUN2.asof }), { full: true }));
    expect(a).toBe(b);
    expect(JSON.parse(a).backtest).not.toBeNull();
  },
  { timeout: 180_000 },
);
