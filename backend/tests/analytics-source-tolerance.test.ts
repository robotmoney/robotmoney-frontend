// Issue #1035 AC8: every source_key an extractor writes has a declared
// tolerance (analytics/source-tolerance.ts), decision D56 names each one, and
// the compaction migration applied the same values.
//
// WHY THE KEYS ARE READ OUT OF THE SOURCE. The table is only useful if it
// cannot silently fall behind the extractors: an unlisted key is compared
// exactly, which is safe but means its float noise keeps growing the ledger.
// So the expected key set is not written in this file — it is extracted from
// every capture call site under src/analytics/extract and src/analytics/access,
// and a call site whose key this resolver does not understand fails the test
// instead of being skipped.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INDICATORS } from "../src/analytics/analyze/indicators.ts";
import { TOP7 } from "../src/analytics/analyze/research-signals.ts";
import { SOURCE_TOLERANCES, toleranceFor, withinTolerance } from "../src/analytics/source-tolerance.ts";
import { EXTRA_WRITE_KEYS } from "../src/analytics/extras.ts";
import { sql } from "../src/db/client.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import { CoverageError } from "../src/analytics/coverage.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { loadRawIndicatorHistory } from "../src/analytics/store/raw-history-store.ts";
import { loadFrozenVintage } from "../src/analytics/store/run-ledger-store.ts";
import type { TerminalRunPackageInput } from "../src/analytics/output-snapshots.ts";
import { noopTelemetrySink } from "../src/analytics/telemetry.ts";
import { mergeSeries } from "../src/analytics/transform/math.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { ASOF, baseObservations, capturingTelemetry, poisonedSource, secondObservations } from "./support/committed-inputs.ts";
import { inventoryCollection, loadResearchSeriesInventory, collectedByInventory } from "../src/analytics/extract/model-portfolio.ts";
import { registryRecordedLegs } from "../../packages/analyst-sdk/src/extract/sources.ts";
import { RATIO_LEG_MAPPING } from "../../packages/analyst-sdk/src/series-ids.ts";
import { captureSourceAcquisition } from "../src/analytics/source-ledger.ts";
import {
  BIN_COUNT,
  DEFILLAMA_KEYS,
  selectTolerance,
  type KeyDistribution,
} from "../scripts/analytics/measure-tolerance.ts";

const srcDir = join(import.meta.dir, "..", "src", "analytics");
const repoRoot = join(import.meta.dir, "..", "..");

function extractorFiles(): string[] {
  const out: string[] = [];
  // The indicator capture call site moved to the SDK with sources.ts (issue #1095 part B).
  const dirs = [join(srcDir, "extract"), join(srcDir, "access"), join(repoRoot, "packages", "analyst-sdk", "src", "extract")];
  for (const dir of dirs) {
    for (const f of readdirSync(dir)) if (f.endsWith(".ts")) out.push(join(dir, f));
  }
  return out;
}

// Every source-key EXPRESSION at a capture call site, resolved to the concrete
// keys it produces at runtime.
function resolve(expression: string, file: string): string[] {
  const e = expression.trim();
  const literal = /^"([^"]+)"$/.exec(e);
  if (literal) return [literal[1]!];
  if (e === "`raw_indicator_history:${ind.id}`") return INDICATORS.map((i) => `raw_indicator_history:${i.id}`);
  if (e === "`research:${sym}`") return TOP7.map((sym) => `research:${sym}`);
  // data-source.ts writes the backtest extras through the D74 reverse mapping (issue 1423).
  const write = /^W\.(spx|eth|tbill3m)$/.exec(e);
  if (write) return [EXTRA_WRITE_KEYS[write[1] as keyof typeof EXTRA_WRITE_KEYS]];
  // access/data-source.ts collectModelPortfolioInputs (issue 1398): both shipped inventories (issue 1514).
  if (e === "entry.storageKey") return inventoryCollection().map((s) => s.storageKey);
  // packages/analyst-sdk/src/extract/sources.ts fetchAll records the ratio legs (issue 1514).
  if (e === "legKey") return [...registryRecordedLegs()];
  throw new Error(
    `${file}: a capture call site names its source_key as \`${e}\`, which this test cannot resolve. ` +
      "Teach resolve() what it expands to, and give every resulting key an entry in SOURCE_TOLERANCES and D56.",
  );
}

function extractorSourceKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of extractorFiles()) {
    const text = readFileSync(file, "utf8");
    // captureSourceAcquisition({ ..., sourceKey: <expr>, ... }). `sourceKey: key`
    // is data-source.ts's local `acquire` wrapper forwarding its parameter; the
    // keys it forwards are read from the acquire(...) calls below.
    for (const m of text.matchAll(/sourceKey:\s*("[^"]*"|`[^`]*`|[\w.]+)/g)) {
      // `string` is the AcquisitionMeta type declaration in the SDK, not a call site.
      if (m[1]!.trim() === "key" || m[1]!.trim() === "string") continue;
      for (const k of resolve(m[1]!, file)) keys.add(k);
    }
    // acquire("<provider>", <key>, ...)
    for (const m of text.matchAll(/\bacquire\(\s*"[^"]+",\s*("[^"]*"|`[^`]*`|[\w.]+)/g)) {
      for (const k of resolve(m[1]!, file)) keys.add(k);
    }
  }
  return keys;
}

describe("issue #1035 AC8: a declared tolerance for every source_key the extractors write", () => {
  test("every extractor source_key has an entry in SOURCE_TOLERANCES", () => {
    const keys = extractorSourceKeys();
    // Non-vacuity: the registry alone is 26 keys; research and backtest add 17.
    expect(keys.size).toBeGreaterThanOrEqual(INDICATORS.length + 17);
    const missing = [...keys].filter((k) => !(k in SOURCE_TOLERANCES)).sort();
    expect(missing, "add these keys to SOURCE_TOLERANCES and to decision D56").toEqual([]);
  });

  test("the table lists no key an extractor no longer writes", () => {
    const keys = extractorSourceKeys();
    expect(Object.keys(SOURCE_TOLERANCES).filter((k) => !keys.has(k)).sort()).toEqual([]);
  });

  test("decision D56 in docs/decisions.md names every key with its tolerance", () => {
    const decisions = readFileSync(join(repoRoot, "docs", "decisions.md"), "utf8");
    const start = decisions.indexOf("## D56 ");
    expect(start, "docs/decisions.md must contain decision D56").toBeGreaterThan(-1);
    const next = decisions.indexOf("\n## D", start + 1);
    const d56 = decisions.slice(start, next === -1 ? undefined : next);
    for (const [key, tolerance] of Object.entries(SOURCE_TOLERANCES)) {
      const line = d56.split("\n").find((l) => l.includes(`\`${key}\``));
      expect(line, `D56 must name ${key}`).toBeDefined();
      const stated = tolerance.relative === 0 ? "exact" : tolerance.relative === 5e-6 ? "5e-6" : "1e-6";
      expect({ key, line: line!.includes(stated) }).toEqual({ key, line: true });
    }
  });

  test("issue 1514: every research-series key the inventory step collects is a Yahoo symbol at relative 1e-6, named in D56", () => {
    const keys = loadResearchSeriesInventory().series.filter(collectedByInventory).map((s) => s.storageKey);
    expect(keys.length).toBe(14); // the thirteen new series, and yahoo:GLD
    const collected = new Set(inventoryCollection().map((s) => s.storageKey));
    const decisions = readFileSync(join(repoRoot, "docs", "decisions.md"), "utf8");
    const d56 = decisions.slice(decisions.indexOf("## D56 "), decisions.indexOf("\n## D", decisions.indexOf("## D56 ") + 1));
    for (const key of keys) {
      expect(collected.has(key)).toBe(true);
      expect({ key, tolerance: SOURCE_TOLERANCES[key] }).toEqual({ key, tolerance: { relative: 1e-6, basis: "yahoo-float32" } });
      expect({ key, row: d56.split("\n").some((l) => l.includes(`\`${key}\``) && l.includes("1e-6")) }).toEqual({ key, row: true });
    }
  });

  test("issue 1514: every ratio leg's storage key has a SOURCE_TOLERANCES entry and a D56 row", () => {
    const decisions = readFileSync(join(repoRoot, "docs", "decisions.md"), "utf8");
    const d56 = decisions.slice(decisions.indexOf("## D56 "), decisions.indexOf("\n## D", decisions.indexOf("## D56 ") + 1));
    const keys = [...new Set(RATIO_LEG_MAPPING.map((m) => m.storageKey))];
    expect(keys.length).toBe(14);
    for (const key of keys) {
      expect({ key, listed: key in SOURCE_TOLERANCES }).toEqual({ key, listed: true });
      expect({ key, row: d56.split("\n").some((l) => l.includes(`\`${key}\``)) }).toEqual({ key, row: true });
    }
    expect([...registryRecordedLegs()].sort()).toEqual(["yahoo:IWD", "yahoo:IWF", "yahoo:IWM", "yahoo:MTUM", "yahoo:SPHB", "yahoo:SPLV", "yahoo:XLP", "yahoo:XLU", "yahoo:XLY"]);
  });

  // The v0.5.2 ledger repair (scripts/upgrades/0.5.1-to-0.5.2/ledger-repair.ts)
  // reads SOURCE_TOLERANCES itself, so there is no second copy to keep in step.
});

describe("withinTolerance", () => {
  test("an exact source counts only equal values as the same observation", () => {
    expect(withinTolerance("raw_indicator_history:T10Y2Y", 1.25, 1.25)).toBe(true);
    expect(withinTolerance("raw_indicator_history:T10Y2Y", 1.25, 1.25 * (1 + 1e-12))).toBe(false);
  });

  test("a Yahoo source absorbs float32 jitter up to a relative 1e-6 and no further", () => {
    const v = 4523.68017578125;
    expect(withinTolerance("raw_indicator_history:VIX", v, v * (1 + 1e-7))).toBe(true);
    expect(withinTolerance("raw_indicator_history:VIX", v, v * (1 - 9e-7))).toBe(true);
    expect(withinTolerance("raw_indicator_history:VIX", v, v * (1 + 2e-6))).toBe(false);
    // Symmetric: which value is the head does not change the answer.
    expect(withinTolerance("raw_indicator_history:VIX", v * (1 + 1e-7), v)).toBe(true);
  });

  test("an unlisted key is compared exactly — the conservative default", () => {
    expect(toleranceFor("not-a-real:key")).toEqual({ relative: 0, basis: "exact" });
    expect(withinTolerance("not-a-real:key", 10, 10 * (1 + 1e-9))).toBe(false);
  });
});

// ── Issue 1514 part 4: DefiLlama restatements, measured ─────────────────────
// scripts/analytics/measure-tolerance.ts bins every DEFI_TVL and STABLES
// revision in csv-backups backup 2026-10-28T180400Z; only the counts are
// committed (fixtures/defillama-revision-distribution.json). D56's amendment of
// issue 1514 records the outcome: the changes run without a gap from under
// 1e-9 to 3.16e-2, the pinned rule finds no noise band below 1e-4, and both
// keys stay exact.
const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "defillama-revision-distribution.json"), "utf8"),
) as { source: { backup: string; files: string[] }; keys: Record<string, KeyDistribution> };

// A distribution from per-bin counts, bins[0] = [0, 3.16e-9), ..., bins[15] = [3.16e-2, 1e-1).
function dist(counts: Record<number, number>): KeyDistribution {
  const bins = new Array(BIN_COUNT).fill(0);
  for (const [i, n] of Object.entries(counts)) bins[Number(i)] = n;
  return { revisions: bins.reduce((a, b) => a + b, 0), bins, above: 0 };
}

describe("issue 1514: the DefiLlama restatement tolerance is what the measured rule allows", () => {
  test("the fixture is the whole ledger of backup 2026-10-28T180400Z", () => {
    expect(fixture.source.backup).toBe("2026-10-28T180400Z");
    expect(fixture.source.files).toHaveLength(4);
    expect(fixture.keys["raw_indicator_history:DEFI_TVL"]!.revisions).toBe(81_650);
    for (const key of DEFILLAMA_KEYS) {
      const d = fixture.keys[key]!;
      expect(d.bins.reduce((a, b) => a + b, 0) + d.above).toBe(d.revisions);
    }
  });

  test("on the committed counts the rule finds no noise band below 1e-4 for either key, so both stay exact", () => {
    for (const key of DEFILLAMA_KEYS) {
      const r = selectTolerance(fixture.keys, [key]);
      expect(r.ok, key).toBe(false);
      if (!r.ok) expect(r.error).toContain("no empty band below 1e-4");
      expect(SOURCE_TOLERANCES[key]).toEqual({ relative: 0, basis: "exact" });
    }
    expect(selectTolerance(fixture.keys).ok).toBe(false);
  });

  test("a distribution with no empty band below 1e-4 is a rule failure", () => {
    // Every bin up to [1e-4, 3.16e-4) well populated; the first empty bin's top edge is 1e-3.
    const counts = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i, 100]));
    const r = selectTolerance({ a: dist(counts), b: dist({ 0: 5 }) }, ["a", "b"]);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("no empty band below 1e-4") });
  });

  test("a clear noise band then an empty bin: the empty bin's top edge, rounded down to one digit", () => {
    // Noise in [0, 1e-6), bin 6 = [1e-6, 3.16e-6) empty: 3.16e-6 rounds down to 3e-6.
    const odd = selectTolerance({ a: dist({ 0: 10, 1: 20, 2: 30, 3: 40, 4: 50, 5: 60, 9: 500 }) }, ["a"]);
    expect(odd).toEqual({ ok: true, relative: 3e-6, perKey: { a: { gapBin: 6, relative: 3e-6 } } });
    // Noise in [0, 3.16e-6), bin 7 = [3.16e-6, 1e-5) empty: an exact power of ten stays as it is.
    const even = selectTolerance({ a: dist({ 0: 10, 1: 20, 2: 30, 3: 40, 4: 50, 5: 60, 6: 70, 9: 500 }) }, ["a"]);
    expect(even.ok && even.relative).toBe(1e-5);
  });

  test("the keys share the larger of their two values", () => {
    const r = selectTolerance({ a: dist({ 0: 10, 1: 10, 2: 10, 9: 5 }), b: dist({ 0: 10, 1: 10, 2: 10, 3: 10, 4: 10, 5: 10, 9: 5 }) }, ["a", "b"]);
    expect(r.ok && r.perKey.a!.relative).toBe(1e-7);
    expect(r.ok && r.perKey.b!.relative).toBe(3e-6);
    expect(r.ok && r.relative).toBe(3e-6);
  });

  test("a bin under 0.1 percent of the key's revisions counts as the gap", () => {
    // 100,000 revisions: bin 6 holds 50 (0.05 percent), so it ends the band, not the empty bin 7.
    const r = selectTolerance({ a: dist({ 0: 20_000, 1: 20_000, 2: 20_000, 3: 20_000, 4: 10_000, 5: 9_950, 6: 50 }) }, ["a"]);
    expect(r).toEqual({ ok: true, relative: 3e-6, perKey: { a: { gapBin: 6, relative: 3e-6 } } });
  });
});

// ── Issue 1421 (review finding AN-15): the tolerance decision binds downstream ──
// Through REAL persistence, two whole-suite runs: the first commits the base
// observations, the second's provider serves within-tolerance jitter (whole
// VIX, SPX and BTC-USD series) and one material revision per handoff (T10Y2Y,
// ETH, QQQ). The writers already kept the stored values for the jitter (D56);
// the bug was that the orchestrator then computed from the FRESH in-memory
// values anyway. Here the pre-fix handoff is reproduced from the same data
// and shown to leak, and the run itself is shown not to.
describe("issue 1421: downstream consumes the committed value and version, never the discarded jitter", () => {
  useCleanDatabasePerTest(import.meta.file);

  test("unchanged, discarded-jitter and materially revised observations through real persistence", async () => {
    const base = await baseObservations();
    await directAnalyticsPersistence.saveRawHistory({ MNA: base.mna }, "fixture");
    const first = poisonedSource(base, 3);
    let firstResults: Record<string, unknown>;
    try {
      firstResults = await runAnalytics(ASOF, undefined, first, directAnalyticsPersistence, noopTelemetrySink);
    } finally {
      first.restore();
    }
    const firstRunId = (firstResults as any).__runLedger.runId as string;
    const reportRowsBefore = await reportRows(firstRunId);
    const floorBefore = await loadRawIndicatorHistory();
    const vixVersionsBefore = await versionsOf("raw_indicator_history:VIX");
    const firstHeads = new Map(first.acquired.map((a) => [a.evidence.values[0]!.sourceKey, a.committed]));

    const second = secondObservations(base);
    const source = poisonedSource(second, 3);
    const telemetry = capturingTelemetry();
    const submitted: TerminalRunPackageInput[] = [];
    let results: Record<string, unknown>;
    try {
      results = await runAnalytics(ASOF, undefined, source, {
        ...directAnalyticsPersistence,
        async submitTerminalRunPackage(input) {
          submitted.push(input);
          return directAnalyticsPersistence.submitTerminalRunPackage(input);
        },
      }, telemetry);
    } finally {
      source.restore();
    }
    const heads = new Map(source.acquired.map((a) => [a.evidence.values[0]!.sourceKey, a]));

    // AN-15 reproduced on the pre-fix handoff: the old orchestrator prepared the
    // in-memory merge of the floor with the FRESH fetch, and the old capture
    // returned the fresh extras and research values. Both carry the jitter
    // ingestion discarded, so the old code path computed from values that are
    // stored nowhere.
    const preFixRegistry = mergeSeries(floorBefore.VIX!, second.registry.VIX!);
    expect(preFixRegistry.at(-1)!.value).toBe(second.registry.VIX!.at(-1)!.value);
    expect(preFixRegistry.at(-1)!.value).not.toBe(floorBefore.VIX!.at(-1)!.value);
    const spx = heads.get("backtest:^GSPC")!;
    expect(spx.evidence.values.at(-1)!.value).not.toBe(spx.committed.at(-1)!.value); // what the old capture returned vs what is stored

    // 1. Within tolerance: the stored rows and versions are unchanged, and
    //    downstream received the stored value under the stored version.
    const floorAfter = await loadRawIndicatorHistory();
    expect(floorAfter.VIX).toEqual(floorBefore.VIX);
    expect(await versionsOf("raw_indicator_history:VIX")).toEqual(vixVersionsBefore);
    expect(spx.committed).toEqual(firstHeads.get("backtest:^GSPC")!);
    const latest = submitted[0]!.regimeSnapshots!.at(-1)!;
    const rawOf = (id: string) => (latest.indicators as { id: string; raw_value: number | null }[]).find((i) => i.id === id)!.raw_value;
    expect(rawOf("VIX")).toBe(floorBefore.VIX!.at(-1)!.value);
    expect(heads.get("research:BTC-USD")!.committed).toEqual(firstHeads.get("research:BTC-USD")!);

    // 2. A material revision commits a new version, and downstream uses it.
    const t10 = await versionsOf("raw_indicator_history:T10Y2Y");
    const revised = t10.filter((v) => v.revision_kind === "revision");
    expect(revised.length).toBe(1);
    expect(revised[0]!.value).toBe(second.registry.T10Y2Y!.at(-1)!.value);
    expect(rawOf("T10Y2Y")).toBe(second.registry.T10Y2Y!.at(-1)!.value);
    expect(floorAfter.T10Y2Y!.at(-1)!.value).toBe(second.registry.T10Y2Y!.at(-1)!.value);
    const eth = heads.get("backtest:ETH-USD")!;
    const ethNew = eth.committed.at(-1)!;
    expect(ethNew.value).toBe(second.extras.eth.at(-1)!.value);
    expect(ethNew.versionId).not.toBe(firstHeads.get("backtest:ETH-USD")!.at(-1)!.versionId);
    expect(heads.get("research:QQQ")!.committed.at(-1)!.value).toBe(second.research.qqq.at(-1)!.value);

    // 3. The run records the versions it consumed: its frozen vintage holds
    //    the stored VIX/SPX versions and the new T10Y2Y/ETH/QQQ versions.
    const vintage = await loadFrozenVintage((results as any).__runLedger.vintage.vintageId);
    const member = (key: string, date: string) => vintage!.members.find((m) => m.sourceKey === key && m.marketDate === date);
    expect(member("backtest:^GSPC", spx.evidence.values.at(-1)!.marketDate!)!.versionId).toBe(spx.committed.at(-1)!.versionId);
    expect(member("backtest:ETH-USD", eth.evidence.values.at(-1)!.marketDate!)!.versionId).toBe(ethNew.versionId);
    expect(member("raw_indicator_history:T10Y2Y", revised[0]!.market_date)!.versionId).toBe(String(revised[0]!.id));

    // 4. The input evidence reports the collected-versus-committed mismatches.
    const evidence = telemetry.runs[0]!.artifacts.find((a) => a.kind === "committed-input-evidence")!.preview as {
      registry: { indicators: Record<string, number> };
      acquisitions: Record<string, { mismatched: number }>;
      acquiredKeys: number;
      versionsSha256: string;
    };
    // With an acquisition sink the swap happens at the ledger, so the registry
    // floor already agrees with the fetched (committed) values; the jitter is
    // reported against the acquisition that carried it.
    expect(evidence.registry.indicators).toEqual({});
    expect(evidence.acquisitions["backtest:^GSPC"]!.mismatched).toBe(second.extras.spx.length);
    expect(evidence.acquisitions["research:BTC-USD"]!.mismatched).toBe(second.research.btc.length);
    expect(evidence.acquisitions["raw_indicator_history:VIX"]!.mismatched).toBe(second.registry.VIX!.length);
    expect(evidence.acquisitions["backtest:ETH-USD"]).toBeUndefined();
    expect(evidence.acquiredKeys).toBe(source.acquired.length);
    expect(evidence.versionsSha256).toMatch(/^[0-9a-f]{64}$/);

    // 5. The first run's frozen output and report rows are byte-unchanged.
    expect(await reportRows(firstRunId)).toEqual(reportRowsBefore);
    expect(reportRowsBefore.outputs.length).toBeGreaterThan(0);
  }, 300_000);

  // Issue 1514 part 4: DEFI_TVL and STABLES stay exact (D56 amendment of issue
  // 1514), so a real DefiLlama restatement is recorded through both writers.
  test("a DEFI_TVL or STABLES restatement at a relative 1e-3 adds one revision and one raw-history overwrite", async () => {
    const dates = ["2026-08-12", "2026-08-13", "2026-08-14"];
    for (const [indicator, level] of [["DEFI_TVL", 95_123_456_789.25], ["STABLES", 287_654_321_098.5]] as const) {
      const key = `raw_indicator_history:${indicator}`;
      const first = dates.map((date, i) => ({ date, value: level + i * 1_000_003.5 }));
      const second = first.map((p, i) => (i === 1 ? { date: p.date, value: p.value * (1 + 1e-3) } : { ...p }));
      for (const points of [first, first, second]) {
        await captureSourceAcquisition(
          { provider: "fixture", sourceKey: key, parserVersion: "issue-1514:1", cacheIdentity: key },
          { saveSourceAcquisition: directAnalyticsPersistence.saveSourceAcquisition! },
          async () => points,
        );
        await directAnalyticsPersistence.saveRawHistory({ [indicator]: points }, "live");
      }
      const versions = await versionsOf(key);
      expect(versions.filter((v) => v.revision_kind === "initial")).toHaveLength(3);
      const revised = versions.filter((v) => v.revision_kind === "revision");
      expect(revised).toHaveLength(1);
      expect(revised[0]!.market_date).toBe(dates[1]!);
      expect(revised[0]!.value).toBe(second[1]!.value);
      const events = await sql<{ date: string }[]>`
        SELECT natural_key->>'date' AS date FROM analytics_overwrite_events
        WHERE table_name = 'raw_indicator_history' AND natural_key->>'indicator' = ${indicator}`;
      expect(events.map((e) => e.date)).toEqual([dates[1]!]);
      expect((await loadRawIndicatorHistory())[indicator]!.map((p) => p.value)).toEqual(second.map((p) => p.value));
    }
  }, 60_000);

  test("a missing required series is a named CoverageError and missing extras are the documented missing result, with zero acquisition after extract", async () => {
    const base = await baseObservations();
    const composite = new Set(INDICATORS.filter((i) => i.panel === "macro" || i.panel === "onchain").map((i) => i.id));
    const noMacro: typeof base = { ...base, registry: Object.fromEntries(Object.entries(base.registry).filter(([id]) => !composite.has(id))) };
    const missingRequired = poisonedSource(noMacro, 2);
    let err: unknown;
    try {
      await runAnalytics(ASOF, "regime", missingRequired, directAnalyticsPersistence, noopTelemetrySink);
    } catch (e) {
      err = e;
    } finally {
      missingRequired.restore();
    }
    expect(err).toBeInstanceOf(CoverageError);
    expect((err as CoverageError).missingPanels).toEqual(["macro", "onchain"]);
    expect(missingRequired.calls).toEqual(["fetchIndicators", "fetchBacktestExtras"]);
    expect(missingRequired.afterExtract).toEqual([]);
    expect(missingRequired.poison!.attempts).toEqual([]);

    const noExtras: typeof base = { ...base, extras: { spx: [], eth: [], tbill3m: [] } };
    const missingOptional = poisonedSource(noExtras, 2);
    const submitted: TerminalRunPackageInput[] = [];
    try {
      await runAnalytics(ASOF, "regime", missingOptional, {
        ...directAnalyticsPersistence,
        async submitTerminalRunPackage(input) {
          submitted.push(input);
          return directAnalyticsPersistence.submitTerminalRunPackage(input);
        },
      }, noopTelemetrySink);
    } finally {
      missingOptional.restore();
    }
    const latest = submitted[0]!.regimeSnapshots!.at(-1)!;
    expect(latest.regime).not.toBeNull();
    expect(latest.backtest).toEqual({}); // no portfolio has prices
    const cells = Object.values((latest.correlations as { forward: Record<string, Record<string, { rho: number | null; n: number }>> }).forward).flatMap((c) => Object.values(c));
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((c) => c.rho === null && c.n === 0)).toBe(true);
    expect(missingOptional.afterExtract).toEqual([]);
    expect(missingOptional.poison!.attempts).toEqual([]);
  }, 300_000);
});

async function versionsOf(sourceKey: string) {
  return sql<{ id: string; market_date: string; value: number; revision_kind: string }[]>`
    SELECT id::text AS id, market_date::text AS market_date, value, revision_kind
    FROM source_value_versions WHERE source_key = ${sourceKey} ORDER BY id`;
}

async function reportRows(runId: string) {
  const outputs = await sql`SELECT id::text AS id, artifact_kind, payload_bytes, checksum FROM analytics_output_snapshots WHERE run_id = ${runId}::bigint ORDER BY id`;
  const reports = await sql`SELECT id::text AS id, report_bytes, checksum FROM analytics_report_snapshots WHERE run_id = ${runId}::bigint ORDER BY id`;
  return {
    outputs: outputs.map((r) => ({ ...r, payload_bytes: Buffer.from(r.payload_bytes as Uint8Array).toString("base64") })),
    reports: reports.map((r) => ({ ...r, report_bytes: Buffer.from(r.report_bytes as Uint8Array).toString("base64") })),
  };
}
