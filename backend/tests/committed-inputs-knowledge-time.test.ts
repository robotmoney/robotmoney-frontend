// Issue 1733: a regime run for a past as-of day (knownBy) reads, per dated
// coordinate, the ledger version known by the end of that UTC day, never a
// later revision. A coordinate with no version known by then (history seeded
// later) reads its first-known version. A run for today (no knownBy) reads the
// heads, as before.
import { describe, expect, test } from "bun:test";
import { loadCommittedInputs } from "../src/analytics/store/run-ledger-store.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabasePerTest(import.meta.file);

const KEY = "raw_indicator_history:ICSA";

async function version(acq: number, date: string, value: number, knowledgeTime: string, kind: "initial" | "revision"): Promise<void> {
  await fixtureDb.unsafe(
    `INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity, knowledge_time)
     VALUES (md5('acq-1733-${acq}')::uuid, 'fixture', 'test:1', 'kt-1733:${acq}', '${knowledgeTime}'::timestamptz)
     ON CONFLICT DO NOTHING`,
  );
  await fixtureDb.unsafe(
    `INSERT INTO source_value_versions (acquisition_id, source_key, market_date, value, revision_kind, knowledge_time)
     VALUES (md5('acq-1733-${acq}')::uuid, '${KEY}', '${date}'::date, ${value}, '${kind}', '${knowledgeTime}'::timestamptz)`,
  );
}

const values = async (asof: string, knownBy?: string) =>
  (await loadCommittedInputs([KEY], asof, undefined, knownBy)).values.map((v) => ({ date: v.marketDate, value: v.value }));

describe("loadCommittedInputs by knowledge time (issue 1733)", () => {
  test("a past as-of day reads the revision known by the end of that day, not a later one", async () => {
    // 2026-03-07 (a Saturday) first published 2026-03-12, revised 2026-03-19.
    await version(1, "2026-03-07", 220_000, "2026-03-12T13:00:00Z", "initial");
    await version(2, "2026-03-07", 231_000, "2026-03-19T13:00:00Z", "revision");
    expect(await values("2026-03-12", "2026-03-12")).toEqual([{ date: "2026-03-07", value: 220_000 }]);
    expect(await values("2026-03-18", "2026-03-18")).toEqual([{ date: "2026-03-07", value: 220_000 }]);
    expect(await values("2026-03-19", "2026-03-19")).toEqual([{ date: "2026-03-07", value: 231_000 }]);
    // A run for today reads the head, unchanged.
    expect(await values("2026-03-12")).toEqual([{ date: "2026-03-07", value: 231_000 }]);
  });

  test("a value fetched before its UTC day ends is provisional: a replay as of that day never sees the full-day value", async () => {
    await version(3, "2026-04-01", 10, "2026-04-01T15:00:00Z", "initial");
    await version(4, "2026-04-01", 12, "2026-04-02T00:05:00Z", "revision");
    expect(await values("2026-04-01", "2026-04-01")).toEqual([{ date: "2026-04-01", value: 10 }]);
    expect(await values("2026-04-02", "2026-04-02")).toEqual([{ date: "2026-04-01", value: 12 }]);
  });

  test("a coordinate with no version known by the as-of day reads its first-known version", async () => {
    await version(5, "2020-01-04", 200_000, "2026-09-01T00:00:00Z", "initial");
    await version(6, "2020-01-04", 205_000, "2026-10-01T00:00:00Z", "revision");
    expect(await values("2020-01-10", "2020-01-10")).toEqual([{ date: "2020-01-04", value: 200_000 }]);
  });
});
