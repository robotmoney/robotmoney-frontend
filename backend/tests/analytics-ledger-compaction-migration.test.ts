// Issue #1035 AC6/AC7: migration 0080 compacts the analytics ledger the old
// writers left behind — re-observation and float-noise source_value_versions
// rows, one-row-per-member vintage copies, and noise-only overwrite evidence —
// and every immutability guard is armed again. Since issue #1050 it also
// re-points every existing vintage to the rows the fixed writer would have
// written and recomputes its digest, so each vintage keeps its member count and
// replays to its (recomputed) manifest digest, and every series keeps one head
// under the same label and within tolerance of the same value.
// tests/analytics-ledger-vintage-repair.test.ts proves the result equals what
// the fixed writers alone would have produced.
//
// WHY ITS OWN DATABASE. The suite's template (tests/preload.ts) has 0080
// applied already, and on an empty ledger, so there is no pre-migration state
// left in it to compact. This file builds a database of its own on the same
// ephemeral instance, applies every migration BEFORE 0080 exactly as
// src/db/migrate.ts does, writes the shapes the pre-#1035 writers wrote, then
// applies 0080 for real. Nothing here touches the shared database, and nothing
// is cleaned up by deleting rows: the whole database is dropped afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { buildVintageManifest } from "../src/analytics/run-ledger.ts";
import { loadFrozenVintage, loadHistoricalSourceValues } from "../src/analytics/store/run-ledger-store.ts";
import { ledgerCurrentRawIndicatorHistory } from "../src/analytics/cutover/ledger-current.ts";
import { checkAnalyticsLedgerGuard } from "../src/db/analytics-ledger-guard.ts";
import { checkAppendOnlyGuard } from "../src/db/append-only-guard.ts";
import { applyMigrationFile, reclaimAfterMigrations } from "../src/db/migrate.ts";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MIGRATION = "0080_analytics_ledger_compaction.sql";

const DB_URL = process.env.DATABASE_URL;
// Loud, never skipped: without tests/preload.ts there is no Postgres to migrate.
if (!DB_URL) throw new Error("DATABASE_URL is unset — tests/preload.ts must provision the ephemeral Postgres first");

type Db = ReturnType<typeof postgres>;
let admin: Db;
let db: Db;
let dbName: string;

async function applyMigration(file: string): Promise<void> {
  // The runner's own per-file step (src/db/migrate.ts): one transaction per
  // file, as rm_owner from 0054 on, including any TypeScript step the file
  // needs (0080's vintage manifest rebuild), recorded under its full basename.
  await applyMigrationFile(db, file);
}

// ── The pre-#1035 writers, reproduced ───────────────────────────────────────
// store/source-ledger-store.ts before this issue: EVERY fetched point appends a
// version — 'initial' with no prior, 'unchanged' on exact equality, otherwise
// 'revision' — chained to the current head, one INSERT statement per series
// per acquisition (so a series' ids are consecutive, as in production).
const heads = new Map<string, { id: string; value: number }>();

async function oldAcquire(sourceKey: string, points: { date: string; value: number }[], provenance: string | null): Promise<void> {
  const acquisitionId = randomUUID();
  await db`
    INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity)
    VALUES (${acquisitionId}::uuid, 'fixture', 'fixture:1', ${`${sourceKey}:${acquisitionId}`})`;
  const rows = points.map((p) => {
    const prior = heads.get(`${sourceKey}|${p.date}`);
    return {
      acquisition_id: acquisitionId,
      source_key: sourceKey,
      market_date: p.date,
      value: p.value,
      prior_version_id: prior?.id ?? null,
      revision_kind: prior === undefined ? "initial" : prior.value === p.value ? "unchanged" : "revision",
      provenance,
    };
  });
  const inserted = (await db`
    INSERT INTO source_value_versions ${db(rows, "acquisition_id", "source_key", "market_date", "value", "prior_version_id", "revision_kind", "provenance")}
    RETURNING id::text AS id, market_date::text AS market_date, value`) as unknown as { id: string; market_date: string; value: number }[];
  for (const r of inserted) heads.set(`${sourceKey}|${r.market_date}`, { id: r.id, value: Number(r.value) });
}

// store/run-ledger-store.ts's freezeVintage before this issue: the selection is
// unchanged, and the membership is copied one row per member.
let methodologyId = "";
async function oldFreeze(label: string): Promise<string> {
  const [{ now }] = (await db`SELECT clock_timestamp() AS now`) as unknown as { now: Date }[];
  const knowledgeTimeCutoff = new Date(now).toISOString();
  const marketTimeCutoff = "2026-01-01";
  const members = await loadHistoricalSourceValues(knowledgeTimeCutoff, marketTimeCutoff, db);
  const buildIdentity = `compaction-build-${label}`;
  const { manifest } = buildVintageManifest(members, methodologyId, buildIdentity, knowledgeTimeCutoff, marketTimeCutoff);
  const [run] = (await db`
    INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity)
    VALUES (${randomUUID()}, '2025-06-01', 'compaction-test', 'fixture', ${methodologyId}::bigint, ${buildIdentity})
    RETURNING id::text AS id`) as unknown as { id: string }[];
  const [vintage] = (await db`
    INSERT INTO analytics_data_vintages
      (run_id, tool_id, knowledge_time_cutoff, market_time_cutoff, methodology_version_id, build_identity,
       manifest, manifest_digest, member_count)
    VALUES (${run!.id}::bigint, 'compaction-test', ${knowledgeTimeCutoff}::timestamptz, ${marketTimeCutoff}::date,
            ${methodologyId}::bigint, ${buildIdentity}, ${db.json(manifest as never)}, ${manifest.manifestDigest}, ${members.length})
    RETURNING id::text AS id`) as unknown as { id: string }[];
  await db`
    INSERT INTO analytics_vintage_members ${db(
      members.map((m) => ({ vintage_id: vintage!.id, source_value_version_id: m.versionId, source_key: m.sourceKey })),
      "vintage_id", "source_value_version_id", "source_key",
    )}`;
  return vintage!.id;
}

// ── Fixture ─────────────────────────────────────────────────────────────────
const YAHOO_KEY = "raw_indicator_history:VIX"; // D56: relative 1e-6
const FRED_KEY = "raw_indicator_history:T10Y2Y"; // D56: exact
const RESEARCH_KEY = "research:SPY"; // D56: relative 1e-6
const IRREGULAR_KEY = "research:QQQ";
const DATES = Array.from({ length: 200 }, (_, i) => new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10));
const base = (key: string, i: number) => (key === FRED_KEY ? 1.25 + i / 100 : 4523.68017578125 + i * 3.5);
const noisy = (v: number) => v * (1 + 1e-7);
const revised = (v: number) => v * (1 + 1e-3);

const vintageIds: string[] = [];
interface Snapshot {
  counts: { svv: number; members: number; events: number };
  vintageMembers: Record<string, string[]>;
  rawHeads: unknown;
  allHeads: unknown;
}
let before: Snapshot;
let fetchesBefore: { id: string; response_checksum: string | null }[] = [];
const RECLAIMED = ["source_value_versions", "analytics_vintage_members", "analytics_overwrite_events"] as const;
let sizesBefore: Record<string, number> = {};

// Heap, indexes and TOAST: what the table actually occupies on disk.
async function relationSizes(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of RECLAIMED) {
    const [{ bytes }] = (await db`SELECT pg_total_relation_size(${`public.${table}`}::regclass)::bigint AS bytes`) as unknown as { bytes: string }[];
    out[table] = Number(bytes);
  }
  return out;
}

async function snapshot(resolveMembers: (vintageId: string) => Promise<string[]>): Promise<Snapshot> {
  const [counts] = (await db`
    SELECT (SELECT count(*)::int FROM source_value_versions) AS svv,
           (SELECT count(*)::int FROM analytics_vintage_members) AS members,
           (SELECT count(*)::int FROM analytics_overwrite_events) AS events`) as unknown as Snapshot["counts"][];
  const vintageMembers: Record<string, string[]> = {};
  for (const id of vintageIds) vintageMembers[id] = (await resolveMembers(id)).sort();
  const rawHeads = (await ledgerCurrentRawIndicatorHistory(db)).sort((a, b) =>
    `${a.indicator}|${a.date}` < `${b.indicator}|${b.date}` ? -1 : 1);
  const allHeads = await db`
    SELECT s.id::text AS id, s.source_key, s.market_date::text AS market_date, s.value, s.provenance,
           s.knowledge_time::text AS knowledge_time
    FROM source_value_versions s
    WHERE NOT EXISTS (SELECT 1 FROM source_value_versions n WHERE n.prior_version_id = s.id)
    ORDER BY s.id`;
  return { counts: counts!, vintageMembers, rawHeads, allHeads: [...allHeads] };
}

async function chainOf(sourceKey: string, date: string): Promise<{ id: string; prior: string | null; kind: string; value: number; provenance: string | null }[]> {
  return (await db`
    SELECT id::text AS id, prior_version_id::text AS prior, revision_kind AS kind, value, provenance
    FROM source_value_versions WHERE source_key = ${sourceKey} AND market_date = ${date}::date
    ORDER BY knowledge_time, id`) as never;
}

beforeAll(async () => {
  admin = postgres(DB_URL, { max: 1, onnotice: () => {} });
  dbName = `tmp_ledger_compaction_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  const url = new URL(DB_URL);
  url.pathname = `/${dbName}`;
  db = postgres(url.toString(), { max: 1, onnotice: () => {} });

  await db`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  expect(files).toContain(MIGRATION);
  for (const file of files.filter((f) => f < MIGRATION)) await applyMigration(file);

  const [methodology] = (await db`
    INSERT INTO analytics_ledger_methodology_versions (tool_id, version_label, config, config_digest)
    VALUES ('compaction-test', 'v-test', '{"k":"v"}'::jsonb, ${"a".repeat(64)})
    RETURNING id::text AS id`) as unknown as { id: string }[];
  methodologyId = methodology!.id;

  // 0057's legacy baselines for the two raw-history keys: no acquisition,
  // the shape the cutover backfilled from raw_indicator_history.
  for (const key of [YAHOO_KEY, FRED_KEY]) {
    const inserted = (await db`
      INSERT INTO source_value_versions ${db(
        DATES.map((date, i) => ({ source_key: key, market_date: date, value: base(key, i), revision_kind: "legacy_baseline" })),
        "source_key", "market_date", "value", "revision_kind",
      )}
      RETURNING id::text AS id, market_date::text AS market_date, value`) as unknown as { id: string; market_date: string; value: number }[];
    for (const r of inserted) heads.set(`${key}|${r.market_date}`, { id: r.id, value: Number(r.value) });
  }

  const generation = (key: string, value: (i: number) => number, provenance: string | null = "live") =>
    oldAcquire(key, DATES.map((date, i) => ({ date, value: value(i) })), provenance);
  const keys = [YAHOO_KEY, FRED_KEY, RESEARCH_KEY];
  // g0, g1: the same values re-fetched ('unchanged' against the baseline).
  for (const key of keys) await generation(key, (i) => base(key, i));
  for (const key of keys) await generation(key, (i) => base(key, i));
  vintageIds.push(await oldFreeze("v1"));
  // g2, g3: float32 jitter, then that jitter re-fetched.
  for (const key of keys) await generation(key, (i) => noisy(base(key, i)));
  for (const key of keys) await generation(key, (i) => noisy(base(key, i)));
  // g4: a real revision on the first five dates; jitter back to base elsewhere.
  for (const key of keys) await generation(key, (i) => (i < 5 ? revised(base(key, i)) : base(key, i)));
  vintageIds.push(await oldFreeze("v2"));
  // g5: g4 re-fetched. g6: the same values relabelled 'seed' on dates 7..9.
  // g7: g6 re-fetched — the heads.
  const g4 = (key: string) => (i: number) => (i < 5 ? revised(base(key, i)) : base(key, i));
  for (const key of keys) await generation(key, g4(key));
  for (const key of keys) {
    await oldAcquire(key, DATES.map((date, i) => ({ date, value: g4(key)(i) })).filter((_, i) => i >= 7 && i <= 9), "seed");
    await oldAcquire(key, DATES.map((date, i) => ({ date, value: g4(key)(i) })).filter((_, i) => i < 7 || i > 9), "live");
  }
  for (const key of keys) {
    await oldAcquire(key, DATES.map((date, i) => ({ date, value: g4(key)(i) })).filter((_, i) => i >= 7 && i <= 9), "seed");
    await oldAcquire(key, DATES.map((date, i) => ({ date, value: g4(key)(i) })).filter((_, i) => i < 7 || i > 9), "live");
  }

  // A coordinate whose chain does not follow its own time order (two roots):
  // the migration must leave it exactly as it is.
  const acq = randomUUID();
  await db`INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity) VALUES (${acq}::uuid, 'fixture', 'fixture:1', 'irregular')`;
  for (const _ of [1, 2, 3]) {
    const a = randomUUID();
    await db`INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity) VALUES (${a}::uuid, 'fixture', 'fixture:1', ${a})`;
    await db`
      INSERT INTO source_value_versions (acquisition_id, source_key, market_date, value, revision_kind, provenance)
      VALUES (${a}::uuid, ${IRREGULAR_KEY}, '2024-01-01', 10, 'initial', 'live')`;
  }

  // Overwrite evidence as migration 0056's trigger records it: two noise-only
  // rewrites (removable) and three material ones (kept).
  await db`INSERT INTO raw_indicator_history (date, indicator, value, source) VALUES
    ('2024-02-01', 'VIX', 18.719999313354492, 'live'), ('2024-02-01', 'T10Y2Y', 1.25, 'live')`;
  // The orchestrator's whole-floor rewrite, many times over: jitter out and
  // back, each one an event (400 removable).
  for (let i = 0; i < 200; i++) {
    await db`UPDATE raw_indicator_history SET value = ${noisy(18.719999313354492)} WHERE indicator = 'VIX'`;
    await db`UPDATE raw_indicator_history SET value = 18.719999313354492 WHERE indicator = 'VIX'`;
  }
  await db`UPDATE raw_indicator_history SET value = ${revised(18.719999313354492)} WHERE indicator = 'VIX'`;
  await db`UPDATE raw_indicator_history SET source = 'seed' WHERE indicator = 'VIX'`;
  await db`UPDATE raw_indicator_history SET value = ${noisy(1.25)} WHERE indicator = 'T10Y2Y'`; // exact key: material

  // Raw response bodies as the pre-#1035 writer stored them: one
  // source_payloads blob per distinct body, each fetch pointing at it.
  const bodyAcquisition = randomUUID();
  await db`INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity) VALUES (${bodyAcquisition}::uuid, 'fixture', 'fixture:1', 'bodies')`;
  for (let i = 0; i < 3; i++) {
    const body = Buffer.from(`DATE,VALUE\n2024-01-0${i + 1},${i}\n`, "utf8");
    const checksum = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    await db`INSERT INTO source_payloads (checksum, payload_bytes) VALUES (${checksum}, ${body})`;
    await db`
      INSERT INTO source_fetches (id, acquisition_id, sequence, request_identity, cache_status, response_status, response_checksum)
      VALUES (${randomUUID()}::uuid, ${bodyAcquisition}::uuid, ${i + 1}, '{"method":"GET","url":"https://example.invalid","headers":{}}',
              'disabled', 200, ${checksum})`;
  }
  fetchesBefore = (await db`
    SELECT id::text AS id, response_checksum FROM source_fetches ORDER BY id`) as unknown as { id: string; response_checksum: string | null }[];
  const [{ n: payloadsBefore }] = (await db`SELECT count(*)::int AS n FROM source_payloads`) as unknown as { n: number }[];
  expect(payloadsBefore).toBe(3);

  before = await snapshot(async (id) =>
    ((await db`SELECT source_value_version_id::text AS id FROM analytics_vintage_members WHERE vintage_id = ${id}::bigint`) as unknown as { id: string }[]).map((r) => r.id));
  expect(before.counts.events).toBe(403);
  sizesBefore = await relationSizes();

  await applyMigration(MIGRATION);
  // The runner's own post-commit step (src/db/migrate.ts): VACUUM FULL of the
  // compacted tables, run because 0080 was applied in this run.
  await reclaimAfterMigrations(db, [MIGRATION]);
  for (const file of (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql") && f > MIGRATION).sort()) await applyMigration(file);
}, 180_000);

afterAll(async () => {
  await db?.end({ timeout: 5 });
  if (dbName) await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin?.end({ timeout: 5 });
});

describe("issue #1035 AC6: compaction keeps every vintage and every head, and drops the duplication", () => {
  test("source_value_versions, analytics_vintage_members and analytics_overwrite_events row counts drop", async () => {
    const after = await snapshot(async () => []);
    expect(after.counts.svv).toBeLessThan(before.counts.svv);
    expect(after.counts.members).toBeLessThan(before.counts.members);
    // Each vintage's membership is now a handful of runs, not one row a member.
    expect(after.counts.members).toBeLessThan(before.counts.members / 10);
    expect(after.counts.events).toBe(3);
  });

  test("the upgrade returns disk space: every compacted table is smaller on disk after 0080 and the runner's VACUUM FULL", async () => {
    const sizesAfter = await relationSizes();
    for (const table of RECLAIMED) {
      expect({ table, smaller: sizesAfter[table]! < sizesBefore[table]! }, JSON.stringify({ before: sizesBefore, after: sizesAfter }))
        .toEqual({ table, smaller: true });
    }
  });

  test("every seeded vintage keeps its member count and replays to its recomputed manifest_digest", async () => {
    expect(vintageIds).toHaveLength(2);
    for (const id of vintageIds) {
      const loaded = await loadFrozenVintage(id, db);
      expect(loaded).not.toBeNull();
      // Re-pointed (issue #1050): one member per coordinate, as before.
      expect(loaded!.members).toHaveLength(before.vintageMembers[id]!.length);
      expect(loaded!.memberCount).toBe(before.vintageMembers[id]!.length);
      const { manifest } = buildVintageManifest(
        loaded!.members, loaded!.methodologyVersionId, loaded!.buildIdentity,
        loaded!.knowledgeTimeCutoff, loaded!.marketTimeCutoff,
      );
      expect(manifest.manifestDigest).toBe(loaded!.manifestDigest);
    }
  });

  test("every series keeps one head, under the same label, with the same value within tolerance", async () => {
    // Since issue #1050 a head that was only a re-observation is dropped like
    // any other, so the head can be an EARLIER row: same coordinate, same
    // label, a value within the source's tolerance.
    const after = await snapshot(async () => []);
    const shape = (heads: unknown) =>
      (heads as { source_key: string; market_date: string; provenance: string | null; value: number }[])
        .map((h) => ({ key: `${h.source_key}|${h.market_date}`, provenance: h.provenance, value: Number(h.value) }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.value - b.value));
    const b = shape(before.allHeads);
    const a = shape(after.allHeads);
    expect(a.map((h) => [h.key, h.provenance])).toEqual(b.map((h) => [h.key, h.provenance]));
    for (let i = 0; i < a.length; i++) {
      const rel = Math.abs(a[i]!.value - b[i]!.value) / Math.max(Math.abs(a[i]!.value), Math.abs(b[i]!.value));
      expect(rel).toBeLessThanOrEqual(a[i]!.key.startsWith(FRED_KEY) ? 0 : 1e-6);
    }
    const raw = (heads: unknown) =>
      (heads as { indicator: string; date: string; value: number; source: string | null }[])
        .map((h) => [h.indicator, h.date, h.source, Math.round(h.value * 1e6)]);
    expect(raw(after.rawHeads)).toEqual(raw(before.rawHeads));
  });

  test("each chain keeps exactly what the fixed writer would have written, re-linked into one chain", async () => {
    // A Yahoo date with no real revision: the baseline, and g0, which moved the
    // label from NULL to 'live'. Everything after it (g1..g7) was a
    // re-observation, or jitter within 1e-6, of that head under the same label,
    // so the fixed writer wrote none of it — vintage references and the old
    // head included (issue #1050).
    const plain = await chainOf(YAHOO_KEY, DATES[20]!);
    expect(plain.map((v) => v.kind)).toEqual(["legacy_baseline", "unchanged"]);
    expect(plain.every((v) => Number(v.value) === base(YAHOO_KEY, 20))).toBe(true);
    // A relabelled date: g6's 'seed' label is new information, so it stays; its
    // g7 repeat does not.
    const relabelled = await chainOf(YAHOO_KEY, DATES[8]!);
    expect(relabelled.map((v) => v.provenance)).toEqual([null, "live", "seed"]);
    // An EXACT key keeps its jitter: under D56 a FRED change is always real.
    // g2's jitter and g4's return to base are revisions; every repeat goes.
    const exact = await chainOf(FRED_KEY, DATES[20]!);
    const b = base(FRED_KEY, 20);
    expect(exact.map((v) => Number(v.value))).toEqual([b, b, noisy(b), b]);
    expect(exact.map((v) => v.kind)).toEqual(["legacy_baseline", "unchanged", "revision", "revision"]);
    for (const chain of [plain, relabelled, exact]) {
      expect(chain[0]!.prior).toBeNull();
      for (let i = 1; i < chain.length; i++) expect(chain[i]!.prior).toBe(chain[i - 1]!.id);
    }
    // The irregular coordinate is untouched.
    expect(await chainOf(IRREGULAR_KEY, "2024-01-01")).toHaveLength(3);
  });
});

describe("issue #1035: the ledger keeps no raw response bodies", () => {
  test("source_payloads no longer exists, and every source_fetches row keeps its response_checksum", async () => {
    const [{ table }] = (await db`SELECT to_regclass('public.source_payloads')::text AS table`) as unknown as { table: string | null }[];
    expect(table).toBeNull();
    const fetchesAfter = await db`SELECT id::text AS id, response_checksum FROM source_fetches ORDER BY id`;
    expect(fetchesBefore.filter((f) => f.response_checksum !== null)).toHaveLength(3);
    expect([...fetchesAfter]).toEqual(fetchesBefore);
    // The checksum is a plain fingerprint now: no foreign key points it at
    // stored bytes.
    const [{ n }] = (await db`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = 'public.source_fetches'::regclass AND contype = 'f'
        AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.source_fetches'::regclass AND attname = 'response_checksum')]`) as unknown as { n: number }[];
    expect(n).toBe(0);
  });
});

// Review finding on this pr (review-data-integrity, 2026-09-25): resolving a
// member run with `svv.id BETWEEN first AND last` gave the planner no join key
// but source_key (~43 values), so it hash-joined on that and range-filtered
// every member against every version of its key — quadratic, about a day on
// the production ledger. Both resolutions now expand each run with
// generate_series and join on the primary key. These plan-shape checks keep it
// that way: EXPLAIN only, so they cost nothing at any scale.
interface PlanNode { "Node Type": string; "Relation Name"?: string; "Index Name"?: string; "Index Cond"?: string;
  "Hash Cond"?: string; "Merge Cond"?: string; "Join Filter"?: string; Plans?: PlanNode[] }

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

async function planOf(query: string, params: unknown[] = [], forceIndex = false): Promise<PlanNode> {
  return await db.begin(async (tx) => {
    if (forceIndex) {
      // Take the alternatives away too: even then the id must be probed by
      // equality, never by a range.
      await tx.unsafe("SET LOCAL enable_hashjoin = off");
      await tx.unsafe("SET LOCAL enable_mergejoin = off");
      await tx.unsafe("SET LOCAL enable_seqscan = off");
    }
    const [row] = (await tx.unsafe(`EXPLAIN (FORMAT JSON) ${query}`, params as never[])) as unknown as { "QUERY PLAN": { Plan: PlanNode }[] }[];
    return row!["QUERY PLAN"][0]!.Plan;
  }) as PlanNode;
}

function assertMemberResolutionPlan(plan: PlanNode): void {
  const all = nodes(plan);
  // The quadratic signature: the version id compared in a join FILTER, i.e.
  // checked row by row against every candidate instead of used as a key. A
  // residual `source_key` equality on the one row an id probe returns is fine.
  expect(all.map((n) => n["Join Filter"]).filter((f) => f !== undefined && /\bsvv\.id\b/.test(f))).toEqual([]);
  const versions = all.filter((n) => n["Relation Name"] === "source_value_versions");
  expect(versions.length).toBeGreaterThan(0);
  let probes = 0;
  for (const n of versions) {
    if (n["Node Type"] === "Index Scan" || n["Node Type"] === "Index Only Scan") {
      expect(n["Index Name"]).toBe("source_value_versions_pkey");
      // Equality on the expanded id, never a range.
      expect(n["Index Cond"]).toMatch(/^\(id = g\.id\)$/);
      probes++;
    } else {
      throw new Error(`source_value_versions reached by ${n["Node Type"]}, not a primary-key probe`);
    }
  }
  expect(probes).toBe(versions.length);
}

describe("issue #1035 review: member runs resolve by primary-key equality, never a range join", () => {
  test("0080's membership count query", async () => {
    await db.unsafe("ANALYZE");
    const sql = await readFile(join(migrationsDir, MIGRATION), "utf8");
    const match = /INSERT INTO ledger_repair_member_counts \(vintage_id, members\)\n([\s\S]*?GROUP BY vm\.vintage_id);/.exec(sql);
    expect(match).not.toBeNull();
    const query = match![1]!;
    assertMemberResolutionPlan(await planOf(query));
    assertMemberResolutionPlan(await planOf(query, [], true));
  });

  test("loadFrozenVintage's member query, captured from the production loader", async () => {
    await db.unsafe("ANALYZE");
    const captured: { query: string; params: unknown[] }[] = [];
    const url = new URL(DB_URL!);
    url.pathname = `/${dbName}`;
    const spy = postgres(url.toString(), {
      max: 1, onnotice: () => {},
      debug: (_connection, query, params) => { captured.push({ query, params: params as unknown[] }); },
    });
    try {
      expect(await loadFrozenVintage(vintageIds[1]!, spy)).not.toBeNull();
    } finally {
      await spy.end({ timeout: 5 });
    }
    const member = captured.find((c) => c.query.includes("analytics_vintage_members vm"));
    expect(member, "loadFrozenVintage must resolve members from analytics_vintage_members").toBeDefined();
    assertMemberResolutionPlan(await planOf(member!.query, member!.params));
    assertMemberResolutionPlan(await planOf(member!.query, member!.params, true));
  });

  test("control: the old BETWEEN resolution fails the same assertion", async () => {
    const old = `
      SELECT svv.id FROM analytics_vintage_members vm
      JOIN source_value_versions svv
        ON svv.id BETWEEN vm.source_value_version_id
                      AND COALESCE(vm.last_source_value_version_id, vm.source_value_version_id)
       AND svv.source_key = vm.source_key
      WHERE vm.vintage_id = $1::bigint`;
    const plan = await planOf(old, [vintageIds[1]!], true);
    expect(() => assertMemberResolutionPlan(plan)).toThrow();
  });
});

describe("issue #1035 AC7: every guard 0080 disarmed is armed again", () => {
  test("checkAnalyticsLedgerGuard reports armed", async () => {
    const result = await checkAnalyticsLedgerGuard(db);
    expect(result.problems).toEqual([]);
    expect(result.status).toBe("armed");
  });

  test("the append-only guard check reports armed", async () => {
    const result = await checkAppendOnlyGuard(db);
    expect(result.problems).toEqual([]);
    expect(result.status).toBe("armed");
  });

  test("the compacted tables refuse UPDATE and DELETE again, with their own guards' messages", async () => {
    for (const [statement, message] of [
      ["DELETE FROM source_value_versions WHERE id = (SELECT min(id) FROM source_value_versions)", "source ledger is immutable"],
      ["UPDATE analytics_vintage_members SET last_source_value_version_id = NULL", "analytics run ledger is immutable"],
      ["DELETE FROM analytics_overwrite_events", "is append-only"],
    ] as const) {
      let raised: unknown = null;
      try {
        await db.unsafe(statement);
      } catch (e) {
        raised = e;
      }
      expect(String((raised as Error | null)?.message ?? "no error raised")).toContain(message);
    }
  });
});
