// Issue #1050: migration 0080 leaves the analytics ledger exactly as the FIXED
// writers would have left it, as if the pre-#1035 re-observation / float-noise
// bug had never shipped.
//
// HOW. One acquisition sequence — repeats, float noise, real revisions, a drift
// that only crosses tolerance on its second step, relabels (with and without
// noise), and vintages frozen between them — is written twice:
//
//   * FIXED   — this file's own clean database (support/clean-db.ts: the
//               migrated template, 0080 included), written by the real,
//               current writers: saveSourceAcquisition, saveRawIndicatorHistory,
//               beginRun + freezeVintage.
//   * REPAIRED — a database migrated only up to 0080, written by the pre-#1035
//               writers reproduced below, then taken through 0080 exactly as a
//               deploy does (applyMigrationFile + reclaimAfterMigrations).
//
// The two must be equivalent row for row. Ids cannot match (the old writer
// burned ids on rows the fixed one never wrote, and the repair keeps original
// ids), so rows are compared by acquisition, coordinate, value, provenance,
// knowledge_time and revision_kind. knowledge_time is database-assigned, so the
// old writer is handed the FIXED database's knowledge_time for each
// acquisition's rows — the one field that makes the two sequences the same
// sequence in time.
//
// A third database — the pre-0080 state again, taken through 0080 AS MERGED IN
// PR 1046 (tests/fixtures/ledger/), before this repair — is the "0080 alone"
// baseline the size assertion compares against.
//
// Small by design (a few hundred rows): the planner assertions are EXPLAIN
// only, and nothing here is a timing or scale run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as client from "../src/db/client.ts";
import { buildVintageManifest } from "../src/analytics/run-ledger.ts";
import {
  beginRun,
  freezeVintage,
  loadFrozenVintage,
  loadHistoricalSourceValues,
} from "../src/analytics/store/run-ledger-store.ts";
import { saveSourceAcquisition } from "../src/analytics/store/source-ledger-store.ts";
import { saveRawIndicatorHistory } from "../src/analytics/store/raw-history-store.ts";
import { checkRawIndicatorHistoryParity, recordParityObservation } from "../src/analytics/cutover/parity.ts";
import { checkAnalyticsLedgerGuard } from "../src/db/analytics-ledger-guard.ts";
import { checkAppendOnlyGuard } from "../src/db/append-only-guard.ts";
import { applyMigrationFile, reclaimAfterMigrations } from "../src/db/migrate.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const testsDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(testsDir, "..", "migrations");
const MIGRATION = "0080_analytics_ledger_compaction.sql";
// 0080 byte for byte as PR 1046 merged it (89e1268b), before #1050 extended it.
const MIGRATION_AS_MERGED_1046 = join(testsDir, "fixtures", "ledger", "0080_analytics_ledger_compaction.as-merged-1046.sql");

const DB_URL = process.env.DATABASE_URL;
// Loud, never skipped: without tests/preload.ts there is no Postgres to migrate.
if (!DB_URL) throw new Error("DATABASE_URL is unset — tests/preload.ts must provision the ephemeral Postgres first");

type Db = ReturnType<typeof postgres>;
let admin: Db;
let old: Db; // the pre-#1035 database, repaired by 0080 in beforeAll
let alone: Db; // the same pre-#1035 database, taken through 0080 as merged in 1046
const names: string[] = [];

function urlFor(database: string): string {
  const url = new URL(DB_URL!);
  url.pathname = `/${database}`;
  return url.toString();
}
const fixed = () => client.sql;

// ── Fixture ─────────────────────────────────────────────────────────────────
const VIX = "VIX"; // raw_indicator_history:VIX — D56 relative 1e-6
const T10Y2Y = "T10Y2Y"; // raw_indicator_history:T10Y2Y — D56 exact
const RAW = [VIX, T10Y2Y] as const;
const rawKey = (indicator: string) => `raw_indicator_history:${indicator}`;
const SPY = "research:SPY"; // 1e-6
const QQQ = "research:QQQ"; // 1e-6
const BTC = "research:BTC-USD"; // 1e-6, market_instant coordinates
const DATES = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10));
const INSTANTS = Array.from({ length: 6 }, (_, i) => new Date(Date.UTC(2024, 2, 1, i)).toISOString());
const base = (key: string, i: number) => (key === rawKey(T10Y2Y) ? 1.25 + i / 100 : 4523.68017578125 + i * 3.5);
const noisy = (v: number) => v * (1 + 1e-7);
const drift = (v: number, steps: number) => v * (1 + 0.8e-6 * steps);
const revised = (v: number) => v * (1 + 1e-3);

interface Point { sourceKey: string; marketDate: string | null; marketInstant: string | null; value: number }
const dated = (sourceKey: string, value: (i: number) => number, only?: (i: number) => boolean): Point[] =>
  DATES.flatMap((d, i) => (only && !only(i) ? [] : [{ sourceKey, marketDate: d, marketInstant: null, value: value(i) }]));
const instants = (value: (i: number) => number): Point[] =>
  INSTANTS.map((t, i) => ({ sourceKey: BTC, marketDate: null, marketInstant: t, value: value(i) }));
// SPY and QQQ fetched TOGETHER, their points interleaved: one acquisition, ids
// alternating between the two keys. Every re-fetch like this left a vintage
// whose members were all one-id runs after 0080 alone; the fixed writer only
// ever kept each key's first, per-key acquisition.
const interleaved = (value: (key: string, i: number) => number): Point[] =>
  DATES.flatMap((d, i) => [SPY, QQQ].map((k) => ({ sourceKey: k, marketDate: d, marketInstant: null, value: value(k, i) })));

const coordOf = (p: { sourceKey: string; marketDate: string | null; instantMs: number | null }) =>
  `${p.sourceKey}|${p.marketDate ?? ""}|${p.instantMs ?? ""}`;

// ── The pre-#1035 writers, reproduced (as tests/analytics-ledger-compaction-migration.test.ts does) ──
// store/source-ledger-store.ts before #1035: EVERY fetched point appends a
// version — 'initial' with no prior, 'unchanged' on exact equality, otherwise
// 'revision' — chained to the current head, one INSERT per acquisition.
const oldHeads = new Map<string, { id: string; value: number }>();

async function acquire(points: Point[], provenance: string): Promise<void> {
  const id = randomUUID();
  // FIXED: the real writer.
  await saveSourceAcquisition({
    id, provider: "fixture", parserVersion: "fixture:1", cacheIdentity: `vintage-repair:${id}`,
    requestedByRunId: null, events: [], fetches: [],
    values: points.map((p) => ({ ...p, provenance })),
  });
  const [acq] = (await fixed()`SELECT knowledge_time::text AS kt FROM source_acquisitions WHERE id = ${id}::uuid`) as unknown as { kt: string }[];
  const written = (await fixed()`
    SELECT source_key, market_date::text AS market_date,
           (extract(epoch FROM market_instant) * 1000)::bigint::text AS instant_ms, knowledge_time::text AS kt
    FROM source_value_versions WHERE acquisition_id = ${id}::uuid`) as unknown as
    { source_key: string; market_date: string | null; instant_ms: string | null; kt: string }[];
  const fixedKt = new Map(written.map((w) => [
    coordOf({ sourceKey: w.source_key, marketDate: w.market_date, instantMs: w.instant_ms === null ? null : Number(w.instant_ms) }), w.kt,
  ]));

  // OLD: the same acquisition, at the same knowledge time. A row the fixed
  // writer did not write gets its acquisition's own knowledge_time: after every
  // earlier acquisition's rows and before every later one's, which is all the
  // replay's ordering depends on.
  await old`
    INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity, knowledge_time)
    VALUES (${id}::uuid, 'fixture', 'fixture:1', ${`vintage-repair:${id}`}, ${acq!.kt}::timestamptz)`;
  const rows = points.map((p) => {
    const coord = coordOf({ sourceKey: p.sourceKey, marketDate: p.marketDate, instantMs: p.marketInstant === null ? null : new Date(p.marketInstant).getTime() });
    const prior = oldHeads.get(coord);
    return {
      acquisition_id: id,
      source_key: p.sourceKey,
      market_date: p.marketDate,
      market_instant: p.marketInstant,
      value: p.value,
      prior_version_id: prior?.id ?? null,
      revision_kind: prior === undefined ? "initial" : prior.value === p.value ? "unchanged" : "revision",
      provenance,
      knowledge_time: fixedKt.get(coord) ?? acq!.kt,
      coord,
    };
  });
  // knowledge_time travels as TEXT and is cast in SQL: the bulk-insert helper
  // would round-trip it through a JS Date and lose the microseconds.
  const inserted = (await old`
    INSERT INTO source_value_versions
      (acquisition_id, source_key, market_date, market_instant, value, prior_version_id, revision_kind, provenance, knowledge_time)
    SELECT ${id}::uuid, r.source_key, r.market_date, r.market_instant, r.value, r.prior_version_id, r.revision_kind, ${provenance}, r.kt::timestamptz
    FROM unnest(${rows.map((r) => r.source_key)}::text[], ${rows.map((r) => r.market_date)}::date[],
                ${rows.map((r) => r.market_instant)}::timestamptz[], ${rows.map((r) => r.value)}::float8[],
                ${rows.map((r) => r.prior_version_id)}::bigint[], ${rows.map((r) => r.revision_kind)}::text[],
                ${rows.map((r) => r.knowledge_time)}::text[])
      WITH ORDINALITY AS r(source_key, market_date, market_instant, value, prior_version_id, revision_kind, kt, n)
    ORDER BY r.n
    RETURNING id::text AS id`) as unknown as { id: string }[];
  inserted.forEach((r, i) => oldHeads.set(rows[i]!.coord, { id: r.id, value: rows[i]!.value }));

  // raw_indicator_history is written from the same fetch, as the orchestrator
  // does: the fixed writer through its rule, the old one as a plain upsert
  // (every UPDATE that changes the row is recorded by 0056's trigger).
  for (const indicator of RAW) {
    const own = points.filter((p) => p.sourceKey === rawKey(indicator));
    if (own.length === 0) continue;
    await saveRawIndicatorHistory({ [indicator]: own.map((p) => ({ date: p.marketDate!, value: p.value })) }, fixed(), provenance);
    await old`
      INSERT INTO raw_indicator_history ${old(own.map((p) => ({ date: p.marketDate, indicator, value: p.value, source: provenance })), "date", "indicator", "value", "source")}
      ON CONFLICT (date, indicator) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source`;
  }
}

// freezeVintage before #1035: the same selection, the membership copied one
// row per member. FIXED freezes through the real beginRun + freezeVintage.
const METHODOLOGY = { toolId: "vintage-repair", versionLabel: "v-test", config: { k: "v" } };
const MARKET_CUTOFF = "2026-01-01";
let oldMethodologyId = "";
const vintagePairs: { label: string; fixedId: string; oldId: string; oldDigest: string }[] = [];

async function freeze(label: string): Promise<void> {
  // A millisecond past every row written so far, so the ISO cutoff (JS Date
  // precision) includes all of them; the next acquisition starts after it.
  const [{ ms }] = (await fixed()`SELECT (floor(extract(epoch FROM clock_timestamp()) * 1000) + 1)::bigint::text AS ms`) as unknown as { ms: string }[];
  const cutoff = new Date(Number(ms)).toISOString();
  const buildIdentity = `vintage-repair-${label}`;

  const run = await beginRun({ runKey: randomUUID(), asof: "2025-06-01", toolId: METHODOLOGY.toolId, sourceLabel: "fixture", methodology: METHODOLOGY, buildIdentity });
  const frozen = await freezeVintage({
    runId: run.runId, toolId: METHODOLOGY.toolId, knowledgeTimeCutoff: cutoff, marketTimeCutoff: MARKET_CUTOFF,
    methodologyVersionId: run.methodologyVersionId, buildIdentity,
  });

  const members = await loadHistoricalSourceValues(cutoff, MARKET_CUTOFF, old);
  const { manifest } = buildVintageManifest(members, oldMethodologyId, buildIdentity, cutoff, MARKET_CUTOFF);
  const [oldRun] = (await old`
    INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity)
    VALUES (${randomUUID()}, '2025-06-01', ${METHODOLOGY.toolId}, 'fixture', ${oldMethodologyId}::bigint, ${buildIdentity})
    RETURNING id::text AS id`) as unknown as { id: string }[];
  const [oldVintage] = (await old`
    INSERT INTO analytics_data_vintages
      (run_id, tool_id, knowledge_time_cutoff, market_time_cutoff, methodology_version_id, build_identity,
       manifest, manifest_digest, member_count)
    VALUES (${oldRun!.id}::bigint, ${METHODOLOGY.toolId}, ${cutoff}::timestamptz, ${MARKET_CUTOFF}::date,
            ${oldMethodologyId}::bigint, ${buildIdentity}, ${old.json(manifest as never)}, ${manifest.manifestDigest}, ${members.length})
    RETURNING id::text AS id`) as unknown as { id: string }[];
  await old`
    INSERT INTO analytics_vintage_members ${old(
      members.map((m) => ({ vintage_id: oldVintage!.id, source_value_version_id: m.versionId, source_key: m.sourceKey })),
      "vintage_id", "source_value_version_id", "source_key",
    )}`;
  vintagePairs.push({ label, fixedId: frozen.vintageId, oldId: oldVintage!.id, oldDigest: manifest.manifestDigest });
  await Bun.sleep(3);
}

// The two databases share everything written before the ledger existed:
// raw_indicator_history's rows and 0057's legacy baselines, one key at a time.
async function seedLegacy(db: Db | typeof client.sql): Promise<{ id: string; coord: string; value: number }[]> {
  const out: { id: string; coord: string; value: number }[] = [];
  for (const indicator of RAW) {
    await db`
      INSERT INTO raw_indicator_history ${db(DATES.map((date, i) => ({ date, indicator, value: base(rawKey(indicator), i), source: "seed" })), "date", "indicator", "value", "source")}`;
    const rows = (await db`
      INSERT INTO source_value_versions ${db(
        DATES.map((date, i) => ({ source_key: rawKey(indicator), market_date: date, value: base(rawKey(indicator), i), revision_kind: "legacy_baseline", knowledge_time: "2000-01-01T00:00:00Z" })),
        "source_key", "market_date", "value", "revision_kind", "knowledge_time",
      )}
      RETURNING id::text AS id, market_date::text AS market_date, value`) as unknown as { id: string; market_date: string; value: number }[];
    for (const r of rows) {
      out.push({ id: r.id, coord: coordOf({ sourceKey: rawKey(indicator), marketDate: r.market_date, instantMs: null }), value: Number(r.value) });
    }
  }
  return out;
}

const RELATIONS = ["source_value_versions", "analytics_vintage_members"] as const;
async function relationSizes(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of RELATIONS) {
    const [{ bytes }] = (await db`SELECT pg_total_relation_size(${`public.${table}`}::regclass)::bigint::text AS bytes`) as unknown as { bytes: string }[];
    out[table] = Number(bytes);
  }
  return out;
}

let oldCountBefore = 0;
let sizesAlone: Record<string, number> = {};
let sizesRepaired: Record<string, number> = {};

beforeAll(async () => {
  admin = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const oldName = `tmp_vintage_repair_${suffix}`;
  const aloneName = `tmp_vintage_repair_alone_${suffix}`;
  await admin.unsafe(`CREATE DATABASE ${oldName}`);
  names.push(oldName);
  old = postgres(urlFor(oldName), { max: 1, onnotice: () => {} });

  await old`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  expect(files).toContain(MIGRATION);
  for (const file of files.filter((f) => f < MIGRATION)) await applyMigrationFile(old, file);

  // The fixed database starts with an empty ledger: nothing the template
  // carries may leak into the comparison.
  const [{ n: templateRows }] = (await fixed()`SELECT count(*)::int AS n FROM source_value_versions`) as unknown as { n: number }[];
  expect(templateRows).toBe(0);

  await seedLegacy(fixed());
  // The baselines are the old writer's first heads, exactly as the fixed
  // writer's LATERAL head lookup finds them.
  for (const b of await seedLegacy(old)) oldHeads.set(b.coord, { id: b.id, value: b.value });
  const [m] = (await old`
    INSERT INTO analytics_ledger_methodology_versions (tool_id, version_label, config, config_digest)
    VALUES (${METHODOLOGY.toolId}, ${METHODOLOGY.versionLabel}, '{"k":"v"}'::jsonb, ${"a".repeat(64)})
    RETURNING id::text AS id`) as unknown as { id: string }[];
  oldMethodologyId = m!.id;

  // g0 — every key's first fetch, one acquisition per key: the raw keys move
  // their label from the baseline's NULL to 'live'; the research keys start.
  for (const indicator of RAW) await acquire(dated(rawKey(indicator), (i) => base(rawKey(indicator), i)), "live");
  for (const key of [SPY, QQQ]) await acquire(dated(key, (i) => base(key, i)), "live");
  await acquire(instants((i) => 100 + i), "live");
  await freeze("v1");
  // g1 — the same values again: pure re-observations.
  for (const indicator of RAW) await acquire(dated(rawKey(indicator), (i) => base(rawKey(indicator), i)), "live");
  await acquire(interleaved((k, i) => base(k, i)), "live");
  await acquire(instants((i) => 100 + i), "live");
  await freeze("v2");
  // g2, g3 — float32 jitter, then that jitter re-fetched. Real on the exact key.
  for (const _ of [0, 1]) {
    for (const indicator of RAW) await acquire(dated(rawKey(indicator), (i) => noisy(base(rawKey(indicator), i))), "live");
    await acquire(interleaved((k, i) => noisy(base(k, i))), "live");
    await acquire(instants((i) => noisy(100 + i)), "live");
    await freeze(`v3-${_}`);
  }
  // g4 — a real revision on the first five dates; back to base elsewhere.
  const g4 = (key: string) => (i: number) => (i < 5 ? revised(base(key, i)) : base(key, i));
  for (const indicator of RAW) await acquire(dated(rawKey(indicator), g4(rawKey(indicator))), "live");
  await acquire(interleaved((k, i) => g4(k)(i)), "live");
  await freeze("v4");
  // g5, g6 — a drift on dates 10..14 that stays within 1e-6 of the head for one
  // step and crosses it on the next: only the second is a revision.
  for (const steps of [1, 2]) {
    const v = (key: string) => (i: number) => (i >= 10 && i < 15 ? drift(g4(key)(i), steps) : g4(key)(i));
    for (const indicator of RAW) await acquire(dated(rawKey(indicator), v(rawKey(indicator))), "live");
    await acquire(interleaved((k, i) => v(k)(i)), "live");
  }
  // g7 — dates 7..9 relabelled 'seed' WITH jitter (the fixed writer keeps the
  // head's value and moves the label), the rest re-fetched 'live'. Then g8
  // repeats it, and g9 moves dates 7..8 back to 'live' at the exact value.
  const g6 = (key: string) => (i: number) => (i >= 10 && i < 15 ? drift(g4(key)(i), 2) : g4(key)(i));
  for (const round of [0, 1]) {
    for (const indicator of RAW) {
      await acquire(dated(rawKey(indicator), (i) => noisy(g6(rawKey(indicator))(i)), (i) => i >= 7 && i <= 9), "seed");
      await acquire(dated(rawKey(indicator), g6(rawKey(indicator)), (i) => i < 7 || i > 9), "live");
    }
    await acquire(interleaved((k, i) => g6(k)(i)), "live");
    await freeze(`v5-${round}`);
  }
  for (const indicator of RAW) await acquire(dated(rawKey(indicator), g6(rawKey(indicator)), (i) => i === 7 || i === 8), "live");
  await freeze("v6");

  const [{ n }] = (await old`SELECT count(*)::int AS n FROM source_value_versions`) as unknown as { n: number }[];
  oldCountBefore = n;

  // "0080 alone": the pre-#1035 database copied, then taken through 0080 as
  // PR 1046 merged it, plus the runner's VACUUM FULL.
  await old.end({ timeout: 5 });
  await admin.unsafe(`CREATE DATABASE ${aloneName} TEMPLATE ${oldName}`);
  names.push(aloneName);
  old = postgres(urlFor(oldName), { max: 1, onnotice: () => {} });
  alone = postgres(urlFor(aloneName), { max: 1, onnotice: () => {} });
  const asMerged = await readFile(MIGRATION_AS_MERGED_1046, "utf8");
  await alone.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    await tx.unsafe(asMerged);
    await tx`INSERT INTO schema_migrations (name) VALUES (${MIGRATION})`;
  });
  await reclaimAfterMigrations(alone, [MIGRATION]);
  sizesAlone = await relationSizes(alone);

  // The repair: 0080 as it ships, applied the way src/db/migrate.ts applies it.
  await applyMigrationFile(old, MIGRATION);
  await reclaimAfterMigrations(old, [MIGRATION]);
  for (const file of files.filter((f) => f > MIGRATION)) await applyMigrationFile(old, file);
  sizesRepaired = await relationSizes(old);
}, 180_000);

afterAll(async () => {
  await old?.end({ timeout: 5 });
  await alone?.end({ timeout: 5 });
  for (const name of names) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin?.end({ timeout: 5 });
});

// A version as the fixed writer's rules define it: everything but the id.
async function versions(db: Db | typeof client.sql): Promise<string[]> {
  const rows = await db`
    SELECT s.acquisition_id::text AS acquisition, s.source_key, s.market_date::text AS market_date,
           s.market_instant::text AS market_instant, s.value, s.provenance, s.knowledge_time::text AS knowledge_time,
           s.revision_kind, p.acquisition_id::text AS prior_acquisition, p.revision_kind AS prior_kind
    FROM source_value_versions s LEFT JOIN source_value_versions p ON p.id = s.prior_version_id`;
  return [...rows].map((r) => JSON.stringify({ ...r, value: Number(r.value) })).sort();
}

async function vintageMembers(db: Db | typeof client.sql, vintageId: string): Promise<string[]> {
  const loaded = await loadFrozenVintage(vintageId, db);
  expect(loaded).not.toBeNull();
  const ids = loaded!.members.map((m) => m.versionId);
  const kt = new Map(((await db`
    SELECT id::text AS id, knowledge_time::text AS kt FROM source_value_versions WHERE id = ANY(${ids}::bigint[])`) as unknown as { id: string; kt: string }[])
    .map((r) => [r.id, r.kt]));
  return loaded!.members
    .map((m) => JSON.stringify([m.sourceKey, m.marketDate ?? m.marketInstant, m.value, kt.get(m.versionId)]))
    .sort();
}

describe("issue #1050: the repaired ledger is the ledger the fixed writers write", () => {
  test("source_value_versions holds exactly the fixed writers' rows (acquisition, coordinate, value, provenance, knowledge_time, revision_kind, chain)", async () => {
    const repaired = await versions(old);
    const expected = await versions(fixed());
    // The fixture really did write rows the fixed writer never would.
    expect(oldCountBefore).toBeGreaterThan(expected.length * 3);
    expect(repaired).toEqual(expected);
  });

  test("no source_value_versions row exists that the fixed writer would not have written", async () => {
    const expected = new Set(await versions(fixed()));
    const extra = (await versions(old)).filter((v) => !expected.has(v));
    expect(extra).toEqual([]);
    const [{ n }] = (await old`SELECT count(*)::int AS n FROM source_value_versions`) as unknown as { n: number }[];
    expect(n).toBe(expected.size);
  });

  test("every vintage's members match the fixed writers' vintage for the same cutoffs (coordinate, value, knowledge_time)", async () => {
    expect(vintagePairs.length).toBe(8);
    for (const pair of vintagePairs) {
      const repaired = await vintageMembers(old, pair.oldId);
      const expected = await vintageMembers(fixed(), pair.fixedId);
      expect({ vintage: pair.label, members: repaired }).toEqual({ vintage: pair.label, members: expected });
    }
  });

  test("loadFrozenVintage recomputes every stored manifest_digest exactly, and member_count is the resolved count", async () => {
    const all = (await old`SELECT id::text AS id FROM analytics_data_vintages ORDER BY id`) as unknown as { id: string }[];
    expect(all.length).toBe(vintagePairs.length);
    for (const { id } of all) {
      const loaded = await loadFrozenVintage(id, old);
      expect(loaded).not.toBeNull();
      expect(loaded!.memberCount).toBe(loaded!.members.length);
      const { manifest } = buildVintageManifest(
        loaded!.members, loaded!.methodologyVersionId, loaded!.buildIdentity,
        loaded!.knowledgeTimeCutoff, loaded!.marketTimeCutoff,
      );
      expect(manifest.manifestDigest).toBe(loaded!.manifestDigest);
      expect(loaded!.manifest).toEqual(manifest);
    }
    // The repair did move them: a digest frozen over a dropped row cannot survive.
    const digests = (await old`SELECT id::text AS id, manifest_digest FROM analytics_data_vintages`) as unknown as { id: string; manifest_digest: string }[];
    const moved = vintagePairs.filter((p) => digests.find((d) => d.id === p.oldId)!.manifest_digest !== p.oldDigest);
    expect(moved.length).toBeGreaterThan(0);
  });

  test("the repair adds no table or column that records old digests or old version ids: the schema is the fixed writers' schema", async () => {
    const shape = async (db: Db | typeof client.sql) => [...(await db`
      SELECT c.relname, c.relkind::text AS relkind, a.attname, format_type(a.atttypid, a.atttypmod) AS type,
             a.attnotnull, a.attisdropped
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0
      WHERE n.nspname = 'public'
      ORDER BY c.relname, a.attnum`)].map((r) => JSON.stringify(r));
    expect(await shape(old)).toEqual(await shape(fixed()));
    const [{ n }] = (await old`SELECT count(*)::int AS n FROM pg_class WHERE relname LIKE 'ledger_repair%'`) as unknown as { n: number }[];
    expect(n).toBe(0);
  });

  test("raw_indicator_history and its overwrite evidence are what the fixed raw writer left", async () => {
    const raw = async (db: Db | typeof client.sql) => [...(await db`
      SELECT indicator, date::text AS date, value, source FROM raw_indicator_history
      WHERE indicator = ANY(${[...RAW]}::text[]) ORDER BY indicator, date`)];
    expect(await raw(old)).toEqual(await raw(fixed()));
    const events = async (db: Db | typeof client.sql) => [...(await db`
      SELECT operation, natural_key, previous_row, replacement_row FROM analytics_overwrite_events
      WHERE table_name = 'raw_indicator_history' AND natural_key ->> 'indicator' = ANY(${[...RAW]}::text[])
      ORDER BY natural_key ->> 'indicator', natural_key ->> 'date', id`)];
    const expected = await events(fixed());
    expect(expected.length).toBeGreaterThan(0);
    expect(await events(old)).toEqual(expected);
  });

  test("a raw_indicator_history parity check after the repair records matched:true", async () => {
    const result = await checkRawIndicatorHistoryParity(old);
    expect(result.mismatches).toEqual([]);
    expect(result.matched).toBe(true);
    const id = await recordParityObservation(result, old);
    const [row] = (await old`SELECT matched FROM analytics_parity_observations WHERE id = ${id}::bigint`) as unknown as { matched: boolean }[];
    expect(row!.matched).toBe(true);
  });

  test("both guards report armed, and source_value_versions and analytics_vintage_members are smaller on disk than after 0080 alone", async () => {
    const ledger = await checkAnalyticsLedgerGuard(old);
    expect(ledger.problems).toEqual([]);
    expect(ledger.status).toBe("armed");
    const appendOnly = await checkAppendOnlyGuard(old);
    expect(appendOnly.problems).toEqual([]);
    expect(appendOnly.status).toBe("armed");
    for (const table of RELATIONS) {
      expect({ table, smaller: sizesRepaired[table]! < sizesAlone[table]! }, JSON.stringify({ alone: sizesAlone, repaired: sizesRepaired }))
        .toEqual({ table, smaller: true });
    }
  });
});

// ── Planner: re-pointing is a primary-key probe per member id ───────────────
interface PlanNode { "Node Type": string; "Relation Name"?: string; "Index Name"?: string; "Index Cond"?: string;
  "Join Filter"?: string; Plans?: PlanNode[] }
const nodes = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

describe("issue #1050: the member re-pointing query uses index lookups, not a range or hash join", () => {
  test("0080's re-pointing query probes the scratch table's primary key per member id and never reads source_value_versions", async () => {
    const sql = await readFile(join(migrationsDir, MIGRATION), "utf8");
    const scratch = /CREATE TEMP TABLE ledger_repair_dropped \([\s\S]*?\) ON COMMIT DROP;/.exec(sql);
    const repoint = /INSERT INTO ledger_repair_members \(vintage_id, source_key, first_id, last_id\)\n([\s\S]*?GROUP BY o\.vintage_id, o\.source_key, o\.run_key);/.exec(sql);
    expect(scratch).not.toBeNull();
    expect(repoint).not.toBeNull();
    for (const forceIndex of [false, true]) {
      await old.begin(async (tx) => {
        await tx.unsafe(scratch![0]);
        // Sized like a real ledger's dropped set relative to its members, so the
        // planner is choosing on realistic statistics, not a one-page table.
        await tx.unsafe(`INSERT INTO ledger_repair_dropped (id, kept_id) SELECT g, g FROM generate_series(1, 200000) g`);
        await tx.unsafe("ANALYZE ledger_repair_dropped");
        await tx.unsafe("ANALYZE analytics_vintage_members");
        if (forceIndex) {
          await tx.unsafe("SET LOCAL enable_hashjoin = off");
          await tx.unsafe("SET LOCAL enable_mergejoin = off");
          await tx.unsafe("SET LOCAL enable_seqscan = off");
        }
        const [row] = (await tx.unsafe(`EXPLAIN (FORMAT JSON) ${repoint![1]}`)) as unknown as { "QUERY PLAN": { Plan: PlanNode }[] }[];
        const all = nodes(row!["QUERY PLAN"][0]!.Plan);
        expect(all.filter((n) => n["Relation Name"] === "source_value_versions")).toEqual([]);
        expect(all.map((n) => n["Node Type"]).filter((t) => t === "Hash Join" || t === "Merge Join")).toEqual([]);
        expect(all.map((n) => n["Join Filter"]).filter((f) => f !== undefined && /\bg\.id\b/.test(f))).toEqual([]);
        const probes = all.filter((n) => n["Relation Name"] === "ledger_repair_dropped");
        expect(probes.length).toBe(1);
        expect(["Index Scan", "Index Only Scan"]).toContain(probes[0]!["Node Type"]);
        expect(probes[0]!["Index Name"]).toBe("ledger_repair_dropped_pkey");
        expect(probes[0]!["Index Cond"]).toMatch(/^\(id = g\.id\)$/);
        throw new RollbackPlan();
      }).catch((e) => { if (!(e instanceof RollbackPlan)) throw e; });
    }
  });
});

class RollbackPlan extends Error {}
