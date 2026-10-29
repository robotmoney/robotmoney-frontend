// Issue 1514 (archive record timeout): the analytics_vintage_members chain step
// of a format 1 backup record reads only the members of the vintages the backup
// adds, so an early backup's record still builds inside publicRead's 5 s
// statement timeout however many members were written after its boundary.
//
// On production every record answered 503: the step bounded its read by
// `vintage_id <= the vintages watermark` alone, and Postgres walked the primary
// key backward from the newest member until it reached an old vintage, which
// for an early backup is almost the whole table (3.34 million rows, 3.9 s on an
// idle restore, past 5 s under the analytics load). Here the table holds the
// first backup's 10,000 members at the lowest ids and a 2,000,000-member tail
// after the boundary (vintages of 1,000 members each, so the
// UNIQUE (vintage_id, source_value_version_id) key needs only 1,000
// source_value_versions rows).
//
// The bound is asserted on tuple reads, not on time: a freshly written table is
// all in cache, so the old walk is fast here and a time limit would prove
// nothing. Postgres' per-transaction counters (pg_stat_get_xact_tuples_fetched
// and pg_stat_get_xact_tuples_returned) on the table and each of its indexes
// are read around one run of the step, with parallel workers off, less what
// planning the same statement reads (the planner probes an index's ends when a
// bound falls outside its histogram, which depends on the statistics, not on
// the rows the step reads). They are equal with a 10,000-member tail and a
// 2,000,000-member tail, and stay within three passes over the backup's own
// members (the watermark, the row count and the id sum each read them once)
// plus a small constant (the first-row probe). Before the fix the step fetched
// 50,012 primary-key tuples with the small tail and 6,020,012 with the large
// one: it walked the tail three times, once per column naming the watermark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { registeredSites } from "../../src/db/registry.ts";
import {
  _resetArchiveForTests,
  _setArchiveClockForTests,
  ARCHIVE_TABLES,
  recordFor,
} from "../../src/analytics/store/public-archive-store.ts";
import { useCleanDatabase } from "../support/clean-db.ts";
import { fixtureDb } from "../support/fixture-db.ts";

useCleanDatabase(import.meta.file);

// The first backup is 2001-01-02T000000Z: every row of day 1 is in it, every
// tail row is stamped after its boundary. "Now" seals that backup only.
const BACKUP = "2001-01-02T000000Z";
const BOUNDARY = "2001-01-02T00:00:00.000Z";
const NOW = Date.parse("2001-01-02T03:00:00Z");
const MEMBERS_PER_VINTAGE = 1000;
const OWN_VINTAGES = 10;
const OWN_MEMBERS = OWN_VINTAGES * MEMBERS_PER_VINTAGE;
const SMALL_TAIL_VINTAGES = 10;
const LARGE_TAIL_VINTAGES = 2000;

const members = ARCHIVE_TABLES.find((t) => t.name === "analytics_vintage_members")!;
let methodology = "";
let firstSvv = 0;
let ownVintagesWatermark = "";

/** Add `count` runs and one vintage per run, all under `tool`, then MEMBERS_PER_VINTAGE members per vintage in id order. */
async function addVintages(tool: string, count: number, createdAt: string): Promise<void> {
  await fixtureDb`
    INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity, created_at)
    SELECT gen_random_uuid()::text, DATE '2000-12-31', ${tool}, 'fixture', ${methodology}::bigint, 'scale-build', ${createdAt}::timestamptz
    FROM generate_series(1, ${count}) g`;
  await fixtureDb`
    INSERT INTO analytics_data_vintages (run_id, tool_id, knowledge_time_cutoff, market_time_cutoff, methodology_version_id,
      build_identity, manifest, manifest_digest, member_count, created_at)
    SELECT r.id, ${tool}, ${createdAt}::timestamptz, DATE '2000-12-31', ${methodology}::bigint, 'scale-build', '{}'::jsonb,
      repeat('b', 64), ${MEMBERS_PER_VINTAGE}, ${createdAt}::timestamptz
    FROM analytics_ledger_runs r WHERE r.tool_id = ${tool} ORDER BY r.id`;
  await fixtureDb`
    INSERT INTO analytics_vintage_members (vintage_id, source_value_version_id, source_key)
    SELECT v.id, ${firstSvv}::bigint + g, 'raw_indicator_history:SCALE'
    FROM analytics_data_vintages v, generate_series(0, ${MEMBERS_PER_VINTAGE - 1}) g
    WHERE v.tool_id = ${tool} ORDER BY v.id, g`;
  // Settled statistics and visibility, so the plan and its heap fetches do not
  // depend on when autovacuum last ran.
  for (const table of ["analytics_ledger_runs", "analytics_data_vintages", "analytics_vintage_members"]) {
    await fixtureDb.unsafe(`VACUUM ANALYZE ${table}`);
  }
}

interface StepReads {
  fetched: number;
  returned: number;
  byRelation: Record<string, { fetched: number; returned: number }>;
  wm: string | null;
  n: string;
}

const MEMBERS_STEP = registeredSites().find((d) => d.site === "src/analytics/store/public-archive-store:analytics_vintage_members.step")!.probe!.statement;

/** Run the first backup's members step once, as the api's role, and count the tuples it read on the table and its indexes. */
async function membersStepReads(): Promise<StepReads> {
  return sql.begin("read only", async (tx) => {
    await tx`SET LOCAL max_parallel_workers_per_gather = 0`;
    const counters = async () =>
      tx<{ relname: string; fetched: string; returned: string }[]>`
        SELECT c.relname, pg_stat_get_xact_tuples_fetched(c.oid)::text AS fetched, pg_stat_get_xact_tuples_returned(c.oid)::text AS returned
        FROM pg_class c
        WHERE c.oid = 'analytics_vintage_members'::regclass
           OR c.oid IN (SELECT indexrelid FROM pg_index WHERE indrelid = 'analytics_vintage_members'::regclass)
        ORDER BY c.relname`;
    // The step's parameters: (after, previous vintages watermark, vintages watermark, after, after).
    const c0 = await counters();
    await tx.unsafe(`EXPLAIN ${MEMBERS_STEP}`, ["0", "0", ownVintagesWatermark, "0", "0"]);
    const c1 = await counters();
    const [step] = await members.step(tx as never, "0", BOUNDARY, ownVintagesWatermark, "0");
    const c2 = await counters();
    const at = (rows: typeof c0, name: string) => rows.find((x) => x.relname === name)!;
    const byRelation: StepReads["byRelation"] = {};
    let fetched = 0;
    let returned = 0;
    for (const r of c2) {
      const plan = { f: Number(at(c1, r.relname).fetched) - Number(at(c0, r.relname).fetched), r: Number(at(c1, r.relname).returned) - Number(at(c0, r.relname).returned) };
      const f = Number(r.fetched) - Number(at(c1, r.relname).fetched) - plan.f;
      const n = Number(r.returned) - Number(at(c1, r.relname).returned) - plan.r;
      byRelation[r.relname] = { fetched: f, returned: n };
      fetched += f;
      returned += n;
    }
    return { fetched, returned, byRelation, wm: step?.wm ?? null, n: step?.n ?? "0" };
  });
}

beforeAll(async () => {
  _resetArchiveForTests();
  _setArchiveClockForTests(() => NOW);
  const [mv] = await fixtureDb<{ id: string }[]>`
    INSERT INTO analytics_ledger_methodology_versions (tool_id, version_label, config, config_digest, created_at)
    VALUES ('scale', 'scale-v1', '{}', repeat('a', 64), '2001-01-01 01:00:00+00') RETURNING id::text AS id`;
  methodology = mv!.id;
  await fixtureDb`
    INSERT INTO source_value_versions (source_key, market_date, value, revision_kind, knowledge_time)
    SELECT 'raw_indicator_history:SCALE', DATE '1990-01-01' + g, g, 'legacy_baseline',
           TIMESTAMPTZ '2001-01-01 02:00:00+00' + g * INTERVAL '1 second'
    FROM generate_series(0, ${MEMBERS_PER_VINTAGE - 1}) g`;
  const [svv] = await fixtureDb<{ id: string }[]>`SELECT min(id)::text AS id FROM source_value_versions`;
  firstSvv = Number(svv!.id);
  // The first backup's own vintages, and so its members, hold the lowest ids.
  await addVintages("scale-own", OWN_VINTAGES, "2001-01-01 06:00:00+00");
  const [own] = await fixtureDb<{ id: string }[]>`SELECT max(id)::text AS id FROM analytics_data_vintages WHERE tool_id = 'scale-own'`;
  ownVintagesWatermark = own!.id;
  await addVintages("scale-tail-a", SMALL_TAIL_VINTAGES, "2001-01-02 06:00:00+00");
}, 120_000);

afterAll(() => {
  _setArchiveClockForTests(null);
  _resetArchiveForTests();
});

describe("archive: the members chain step reads only the backup's own members (issue 1514)", () => {
  let small: StepReads;

  test("with a 10,000-member tail after the boundary, the step reads only the backup's own members", async () => {
    small = await membersStepReads();
    console.log(`members step, ${SMALL_TAIL_VINTAGES * MEMBERS_PER_VINTAGE}-member tail: ${JSON.stringify(small)}`);
    expect(small.n).toBe(String(OWN_MEMBERS));
    expect(small.byRelation.analytics_vintage_members!.returned).toBe(0);
    expect(small.returned).toBeLessThanOrEqual(3 * OWN_MEMBERS + 16);
    expect(small.fetched).toBeLessThanOrEqual(3 * OWN_MEMBERS + 16);
  }, 60_000);

  test("with a 2,000,000-member tail, the step reads exactly as many tuples as with the 10,000-member tail", async () => {
    await addVintages("scale-tail-b", LARGE_TAIL_VINTAGES - SMALL_TAIL_VINTAGES, "2001-01-02 07:00:00+00");
    const [{ n }] = await fixtureDb<{ n: string }[]>`SELECT count(*)::text AS n FROM analytics_vintage_members`;
    expect(Number(n)).toBe(OWN_MEMBERS + LARGE_TAIL_VINTAGES * MEMBERS_PER_VINTAGE);
    const large = await membersStepReads();
    console.log(`members step, ${LARGE_TAIL_VINTAGES * MEMBERS_PER_VINTAGE}-member tail: ${JSON.stringify(large)}`);
    expect(large.wm).toBe(small.wm);
    expect(large.n).toBe(String(OWN_MEMBERS));
    expect(large.byRelation).toEqual(small.byRelation);
    expect(large.returned).toBe(small.returned);
    expect(large.fetched).toBe(small.fetched);
  }, 600_000);

  test("the first backup's record builds through recordFor under publicRead's 5 s statement timeout", async () => {
    _resetArchiveForTests();
    const t0 = Date.now();
    const built = await recordFor(BACKUP);
    console.log(`recordFor(${BACKUP}) built in ${Date.now() - t0} ms`);
    const m = built.record.append_only.analytics_vintage_members!;
    expect(m.watermark_before).toBeNull();
    expect(m.watermark_after).toBe(small.wm);
    expect(m.rows_added).toBe(OWN_MEMBERS);
    expect(m.db_rows_through_watermark).toBe(String(OWN_MEMBERS));
  }, 120_000);
});
