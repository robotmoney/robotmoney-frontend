// Issue 1644: bun backend/scripts/ratio-legs-backfill.ts gives every ratio leg
// (yahoo:<SYMBOL>.close and yahoo:<SYMBOL>.adjclose) its history in the source ledger. Against a
// clean database it writes one version per (leg key, date) that has none, with
// provenance 'backfill' and the database clock as knowledge_time, never touches
// a version that exists, and a second run writes nothing. Yahoo is replaced by
// an injected fetcher (runRatioLegsBackfill is the command's whole body).
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "../src/db/client.ts";
import { saveSourceAcquisition } from "../src/analytics/store/source-ledger-store.ts";
import { RATIO_LEG_KEYS } from "../src/analytics/extras.ts";
import { runRatioLegsBackfill } from "../scripts/ratio-legs-backfill.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const DATES = ["2024-01-02", "2024-01-03", "2024-01-04"];
const ts = DATES.map((d) => Date.parse(`${d}T00:00:00Z`) / 1000);
// One chart per symbol: the raw close and the adjusted close differ.
const close = (symbol: string) => DATES.map((date, i) => ({ date, value: symbol.length * 10 + i + 0.5 }));
const adjclose = (symbol: string) => DATES.map((date, i) => ({ date, value: symbol.length * 10 + i + 0.25 }));
const chart = (symbol: string) => ({ chart: { result: [{ timestamp: ts, indicators: {
  quote: [{ close: close(symbol).map((p) => p.value) }], adjclose: [{ adjclose: adjclose(symbol).map((p) => p.value) }],
} }] } });
const valueOf = (key: string, date: string) => {
  const sym = key.slice(6, key.lastIndexOf("."));
  return (key.endsWith(".adjclose") ? adjclose(sym) : close(sym)).find((p) => p.date === date)!.value;
};

test("the backfill writes each missing (leg, date) once with provenance backfill and a fresh knowledge_time; a second run writes nothing", async () => {
  // A version that already exists: the live run recorded SPY's close for one date.
  await saveSourceAcquisition({
    id: randomUUID(), provider: "yahoo", parserVersion: "yahoo-close:1", cacheIdentity: "SPY:close", requestedByRunId: null,
    events: [{ type: "started", detail: null }, { type: "succeeded", detail: null }], fetches: [],
    values: [{ sourceKey: "yahoo:SPY.close", marketDate: DATES[1]!, marketInstant: null, value: 999, provenance: "live" }],
  });
  const [{ started }] = await sql<{ started: string }[]>`SELECT clock_timestamp()::text AS started`;
  const symbols: string[] = [];
  const quiet = () => {};

  const first = await runRatioLegsBackfill({ fetchChart: async (s) => { symbols.push(s); return chart(s); }, log: quiet });
  expect(symbols.sort()).toEqual(["BTC-USD", "ETH-USD", "GC=F", "HG=F", "IWD", "IWF", "IWM", "MTUM", "SPHB", "SPLV", "SPY", "XLP", "XLU", "XLY"]);
  expect(Object.keys(first.written).sort()).toEqual([...RATIO_LEG_KEYS].sort());
  expect(Object.keys(first.written)).toHaveLength(28);
  expect(Object.values(first.written).reduce((a, b) => a + b, 0)).toBe(28 * DATES.length - 1);
  expect(first.existing).toBe(1);

  const rows = await sql<{ source_key: string; market_date: string; value: number; provenance: string; revision_kind: string; fresh: boolean }[]>`
    SELECT source_key, market_date::text AS market_date, value, provenance, revision_kind, knowledge_time >= ${started}::timestamptz AS fresh
    FROM source_value_versions WHERE source_key LIKE 'yahoo:%.close' OR source_key LIKE 'yahoo:%.adjclose' ORDER BY source_key, market_date`;
  const backfilled = rows.filter((r) => r.provenance === "backfill");
  expect(backfilled).toHaveLength(28 * DATES.length - 1);
  for (const r of backfilled) {
    expect({ key: r.source_key, date: r.market_date, fresh: r.fresh, kind: r.revision_kind }).toEqual({ key: r.source_key, date: r.market_date, fresh: true, kind: "initial" });
    expect(Number(r.value)).toBe(valueOf(r.source_key, r.market_date));
  }
  // The existing version is untouched: one row, its own value and provenance.
  expect(rows.filter((r) => r.source_key === "yahoo:SPY.close" && r.market_date === DATES[1])).toEqual([
    expect.objectContaining({ value: 999, provenance: "live" }),
  ]);

  const second = await runRatioLegsBackfill({ fetchChart: async (s) => chart(s), log: quiet });
  expect(Object.values(second.written).reduce((a, b) => a + b, 0)).toBe(0);
  const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM source_value_versions WHERE source_key LIKE 'yahoo:%.close' OR source_key LIKE 'yahoo:%.adjclose'`;
  expect(n).toBe(rows.length);
});

test("a leg with no raw close fails the backfill loudly and writes nothing", async () => {
  const before = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM source_value_versions`;
  const empty = { chart: { result: [{ timestamp: [], indicators: { quote: [{ close: [] }], adjclose: [{ adjclose: [] }] } }] } };
  await expect(runRatioLegsBackfill({ fetchChart: async (s) => (s === "GC=F" ? empty : chart(s)), log: () => {} })).rejects.toThrow(/GC=F/);
  const after = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM source_value_versions`;
  expect(after[0]!.n).toBe(before[0]!.n);
});
