// Issue 1398: the model portfolio inputs. The inventory, the extract clients
// for the new series run against REAL recorded responses, and the SDK input
// carrying them under their source ids. globalThis.fetch is the preload
// thrower, so every request below goes through configureHttp({fetch}).
//
// Recorded responses (tests/fixtures/extract/model-portfolio/), captured once
// on 2026-10-22 from the live endpoints, bodies unedited (gzipped):
//   yahoo-<SYMBOL>.json.gz                v8 chart for GLD and USDC-USD, period1=2018-01-01 (the
//                                         start requested before issue 1514 moved it to 2016-01-01)
//   defillama-yields-<pool>.json.gz       yields.llama.fi/chart/<pool> for every pool the
//                                         inventory collects (Aave v3 USDC on Base and
//                                         Ethereum, and the Base universe pools; USDC-USD
//                                         and the universe pools were captured 2026-10-23)
//   defillama-yields-unknown-pool.json    the answer for a pool that does not exist
//   yahoo-BTC-USD-2010-01.json            Yahoo's HTTP 400 body for a window before BTC-USD's inception
// expected-points.json.gz is what the clients must return for them, computed
// independently of the parsers (a python script over the raw bodies: Yahoo
// adjclose else close, finite only, UTC day; DefiLlama apyBase, finite only,
// UTC day of the timestamp, last row per day).
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { configureHttp } from "../src/extract/http.ts";
import { loadInventory, loadResearchSeriesInventory, inventoryCollection, COLLECTION_START, requireCoverage, collectedByInventory, InventoryError, InventoryCoverageError, INVENTORY_FIELDS } from "../src/inventory.ts";
import { extractInventorySeries, describeCoverage, NoObservationsError, SeriesExtractError } from "../src/extract/model-portfolio.ts";
import { parseLlamaYieldChart } from "../src/extract/defillama-yields.ts";
import { LEDGER_EXTRA_KEYS } from "../src/extras.ts";
import { loadUniverse } from "../src/allocate/universe.ts";
import { resolveInputHistory } from "../src/series-ids.ts";
import { buildReport, runRegime, parseRawHistory, toHistory, type RawRow } from "../src/index.ts";
import shippedJson from "../inventory/model-portfolio.json";
import researchJson from "../inventory/research-series.json";

afterEach(() => { configureHttp({}); });

const FIX = join(import.meta.dir, "fixtures/extract/model-portfolio");
const gz = async (name: string) => new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await Bun.file(join(FIX, name)).arrayBuffer())));
const inventory = loadInventory();
const byId = new Map(inventory.series.map((s) => [s.id, s]));
const NEW_IDS = inventory.series.filter(collectedByInventory).map((s) => s.id);
// One recorded body per collected series; a missing file fails the file loudly.
const recorded: Record<string, string> = {};
for (const id of NEW_IDS) recorded[id] = await gz(`${id.replace(":", "-")}.json.gz`);
/** The URL fragment that identifies a series' request. */
const fragment = (id: string) => {
  const s = byId.get(id)!;
  return s.provider === "yahoo" ? `/chart/${encodeURIComponent(s.symbol)}?` : `/chart/${s.symbol}`;
};
const expected = JSON.parse(await gz("expected-points.json.gz")) as Record<string, { date: string; value: number }[]>;
const unknownPool = await Bun.file(join(FIX, "defillama-yields-unknown-pool.json")).text();
const yahooPreInception = await Bun.file(join(FIX, "yahoo-BTC-USD-2010-01.json")).text();
const fredMaintenance = await Bun.file(join(import.meta.dir, "fixtures/extract/fred-maintenance.html")).text();

/** A fake fetch serving one recorded body per URL fragment; it fails on any other URL. */
function serve(routes: [fragment: string, body: string, status?: number][]): string[] {
  const urls: string[] = [];
  configureHttp({
    fetch: (async (input: string) => {
      const url = String(input);
      urls.push(url);
      const hit = routes.find(([f]) => url.includes(f));
      if (!hit) throw new Error(`unrecorded URL ${url}`);
      return new Response(hit[1], { status: hit[2] ?? 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
  return urls;
}

describe("the model portfolio inventory", () => {
  test("lists every version one series with every field, and fails on a missing one", () => {
    expect(inventory.workflow).toBe("model-portfolio");
    expect(inventory.series.map((s) => s.id).sort()).toEqual([
      "defillama-yields:0c8567f8-ba5b-41ad-80de-00a71895eb19",
      "defillama-yields:7e0661bf-8cf3-45e6-9424-31916d4c7b84",
      "defillama-yields:a5fab52f-73fa-4f44-9c09-9af1eb20996c",
      "defillama-yields:aa70268e-4b52-42bf-a116-608b370f9501",
      "defillama-yields:ba68527f-8ec2-4c55-827a-8f4673ae047c",
      "defillama-yields:d8c4eff5-c8a9-46fc-a888-057c4c668e72",
      "defillama-yields:e0672197-9f3e-4414-bca5-e6b4c90aa469",
      "fred:DTB3",
      "yahoo:BTC-USD",
      "yahoo:ETH-USD",
      "yahoo:GLD",
      "yahoo:USDC-USD",
      "yahoo:^GSPC",
    ]);
    const raw = (shippedJson as { series: Record<string, unknown>[] }).series;
    for (const entry of raw) {
      expect(Object.keys(entry)).toEqual([...INVENTORY_FIELDS]);
      for (const field of INVENTORY_FIELDS) {
        const broken = structuredClone(shippedJson) as { series: Record<string, unknown>[] };
        delete broken.series[raw.indexOf(entry)]![field];
        expect(() => loadInventory(broken)).toThrow(new InventoryError(`inventory series ${raw.indexOf(entry) + 1}${field === "id" ? "" : ` (${entry.id})`}: missing field ${field}`));
      }
    }
    for (const s of inventory.series) {
      expect(s.requestedStart).toBe(COLLECTION_START);
      expect(s.id).toBe(`${s.provider}:${s.symbol}`);
      // A late inception is explained, never silent.
      if (s.inception > s.requestedStart) expect(s.limitation ?? s.proxy).not.toBeNull();
    }
  });

  test("asset prices, the lending yields with their proxy provenance, and the T-bill rate are all listed", () => {
    const kinds = (k: string) => inventory.series.filter((s) => s.kind === k).map((s) => s.symbol).sort();
    expect(kinds("price")).toEqual(["BTC-USD", "ETH-USD", "GLD", "USDC-USD", "^GSPC"]);
    expect(kinds("rate")).toEqual(["DTB3"]);
    const base = byId.get("defillama-yields:7e0661bf-8cf3-45e6-9424-31916d4c7b84")!;
    expect(base.kind).toBe("lending_yield");
    expect(base.proxy).toMatchObject({ id: "defillama-yields:aa70268e-4b52-42bf-a116-608b370f9501", from: "2023-02-06", to: "2024-03-09" });
    expect(base.proxy!.provenance).toContain("PR 1397");
  });

  test("every Base universe asset with a series is in the inventory; an asset without one names why in its unavailable marker", () => {
    const universe = loadUniverse();
    expect(universe.assets.length).toBeGreaterThan(0);
    for (const a of universe.assets) {
      // An asset the model portfolio inputs do not read names no series: its unavailable marker says why.
      if (a.series === null) {
        expect(a.unavailable?.series, `${a.id}: null series without a reason`).toMatch(/\S/);
        continue;
      }
      expect(byId.has(a.series), `${a.id}: ${a.series} missing from the inventory`).toBe(true);
    }
  });

  test("series another collector already holds keep its storage key; the rest are recorded under their own id", () => {
    expect(byId.get("yahoo:^GSPC")!.storageKey).toBe(LEDGER_EXTRA_KEYS.spx.ledgerKey);
    expect(byId.get("yahoo:ETH-USD")!.storageKey).toBe(LEDGER_EXTRA_KEYS.eth.ledgerKey);
    expect(byId.get("fred:DTB3")!.storageKey).toBe(LEDGER_EXTRA_KEYS.tbill3m.ledgerKey);
    expect(byId.get("yahoo:BTC-USD")!.storageKey).toBe("research:BTC-USD");
    expect([...NEW_IDS].sort()).toEqual(Object.keys(recorded).sort());
  });

  test("a bad entry is refused by name: wrong id, duplicate, dangling proxy, unexplained late inception", () => {
    const base = () => structuredClone(shippedJson) as { series: Record<string, unknown>[] };
    let d = base(); d.series[0]!.id = "yahoo:WRONG";
    expect(() => loadInventory(d)).toThrow(/id must be <provider>:<symbol>/);
    d = base(); d.series.push(structuredClone(d.series[0]!));
    expect(() => loadInventory(d)).toThrow(/yahoo:BTC-USD is listed twice/);
    d = base(); (d.series[4]!.proxy as Record<string, unknown>).id = "yahoo:NOPE";
    expect(() => loadInventory(d)).toThrow(/proxy yahoo:NOPE is not in the inventory/);
    d = base(); d.series[5]!.limitation = null;
    expect(() => loadInventory(d)).toThrow(/inception 2023-02-06 is after requestedStart 2016-01-01; record the limitation or a proxy/);
  });
});

// Issue 1514: the 2016 collection floor and the research-series inventory.
// Recorded responses (tests/fixtures/extract/research-series/), captured once
// on 2026-10-29 from the live Yahoo v8 chart endpoint with period1=2016-01-01
// and period2=2026-10-28, bodies unedited (gzipped): yahoo-<SYMBOL>.json.gz
// for each of the thirteen new series. expected-points.json.gz is computed
// independently of the parser (a python script over the raw bodies: adjclose
// else close, finite only, UTC day).
describe("the collection floor and the research-series inventory", () => {
  const research = loadResearchSeriesInventory();
  const RS_FIX = join(import.meta.dir, "fixtures/extract/research-series");
  const rsGz = async (name: string) => new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await Bun.file(join(RS_FIX, name)).arrayBuffer())));
  const NEW = [
    "yahoo:GC=F", "yahoo:CL=F", "yahoo:HG=F", "yahoo:SI=F", "yahoo:TLT", "yahoo:VNQ", "yahoo:DBC",
    "yahoo:MSTR", "yahoo:SOL-USD", "yahoo:BNB-USD", "yahoo:AAVE-USD", "yahoo:HYPE32196-USD", "yahoo:VIRTUAL-USD",
  ];

  test("COLLECTION_START is 2016-01-01, and every entry of both shipped inventories requests from it", () => {
    expect(COLLECTION_START).toBe("2016-01-01");
    expect(research.workflow).toBe("research-series");
    for (const inv of [inventory, research]) {
      for (const s of inv.series) expect({ id: s.id, start: s.requestedStart }).toEqual({ id: s.id, start: COLLECTION_START });
    }
  });

  test("an entry whose requestedStart is not COLLECTION_START is refused by name, in either inventory", () => {
    for (const json of [shippedJson, researchJson]) {
      const d = structuredClone(json) as { series: Record<string, unknown>[] };
      d.series[1]!.requestedStart = "2018-01-01";
      expect(() => loadInventory(d)).toThrow(new InventoryError(`inventory series 2 (${d.series[1]!.id}): requestedStart must be COLLECTION_START (2016-01-01), not 2018-01-01`));
    }
  });

  test("an entry whose inception is after COLLECTION_START carries a limitation or a proxy, in both inventories", () => {
    const late = [...inventory.series, ...research.series].filter((s) => s.inception > COLLECTION_START);
    expect(late.map((s) => s.id)).toContain("yahoo:ETH-USD");
    expect(late.map((s) => s.id)).toContain("yahoo:SOL-USD");
    for (const s of late) expect({ id: s.id, explained: s.limitation !== null || s.proxy !== null }).toEqual({ id: s.id, explained: true });
  });

  test("the research inventory lists the thirteen new series under their own id, and BTC-USD, QQQ and GLD under their existing keys", () => {
    const byKey = new Map(research.series.map((s) => [s.id, s.storageKey]));
    expect(research.series.filter(collectedByInventory).map((s) => s.id).filter((id) => id !== "yahoo:GLD").sort()).toEqual([...NEW].sort());
    expect(byKey.get("yahoo:BTC-USD")).toBe("research:BTC-USD");
    expect(byKey.get("yahoo:QQQ")).toBe("research:QQQ");
    expect(byKey.get("yahoo:GLD")).toBe("yahoo:GLD");
    for (const s of research.series) {
      const crypto = s.symbol.endsWith("-USD"), futures = s.symbol.endsWith("=F");
      expect({ id: s.id, units: s.units.includes(crypto || futures ? "daily close" : "daily adjusted close") }).toEqual({ id: s.id, units: true });
    }
  });

  test("the collection is one entry per storage key: GLD, listed in both inventories, is collected once", () => {
    const keys = inventoryCollection().map((s) => s.storageKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k === "yahoo:GLD")).toHaveLength(1);
    expect(keys).not.toContain("research:BTC-USD");
    expect(keys).not.toContain("research:QQQ");
    for (const id of NEW) expect(keys).toContain(id);
  });

  test("each new series extracts from its recorded response to the independently computed points, requested from 2016-01-01", async () => {
    const expectedRs = JSON.parse(await rsGz("expected-points.json.gz")) as Record<string, { date: string; value: number }[]>;
    const byIdRs = new Map(research.series.map((s) => [s.id, s]));
    const routes: [string, string][] = [];
    for (const id of NEW) routes.push([`/chart/${encodeURIComponent(byIdRs.get(id)!.symbol)}?`, await rsGz(`${id.replace(":", "-")}.json.gz`)]);
    const urls = serve(routes);
    for (const id of NEW) {
      const out = await extractInventorySeries(byIdRs.get(id)!);
      expect(out.points).toEqual(expectedRs[id]!);
    }
    expect(urls).toHaveLength(NEW.length);
    for (const u of urls) expect(u).toContain(`period1=${Date.parse("2016-01-01T00:00:00Z") / 1000}&`);
  });
});

describe("recorded-response extract for each new series", () => {
  test("valid responses give the independently computed points, through the injected fetch", async () => {
    const urls = serve(NEW_IDS.map((id) => [fragment(id), recorded[id]!]));
    for (const id of NEW_IDS) {
      const out = await extractInventorySeries(byId.get(id)!);
      expect(out.points).toEqual(expected[id]!);
      expect(out.points.length).toBeGreaterThan(300);
      expect(out.coverage.rows).toBe(out.points.length);
    }
    expect(urls).toHaveLength(NEW_IDS.length);
    const gld = urls.find((u) => u.includes("/chart/GLD?"))!;
    expect(gld).toBe(`https://query2.finance.yahoo.com/v8/finance/chart/GLD?period1=${Date.parse("2016-01-01T00:00:00Z") / 1000}&period2=${gld.match(/period2=(\d+)/)![1]}&interval=1d&events=history`);
    expect(urls).toContain("https://yields.llama.fi/chart/7e0661bf-8cf3-45e6-9424-31916d4c7b84");
  });

  test("a late inception is reported as a coverage limitation, with the recorded reason, and no row before it", async () => {
    serve([["/chart/7e0661bf", recorded["defillama-yields:7e0661bf-8cf3-45e6-9424-31916d4c7b84"]!]]);
    const s = byId.get("defillama-yields:7e0661bf-8cf3-45e6-9424-31916d4c7b84")!;
    const out = await extractInventorySeries(s);
    expect(out.coverage.firstDate).toBe("2024-03-10");
    expect(out.coverage.limitations).toEqual([`${s.id} starts 2024-03-10, after the requested start 2016-01-01 (recorded: ${s.limitation})`]);
    expect(out.points.every((p) => p.date >= s.inception)).toBe(true);
    // A response that covers its requested start has no limitation: GLD's
    // body was recorded from 2018-01-01, the start it was requested with then.
    serve([["/chart/GLD?", recorded["yahoo:GLD"]!]]);
    expect((await extractInventorySeries({ ...byId.get("yahoo:GLD")!, requestedStart: "2018-01-01" })).coverage.limitations).toEqual([]);
  });

  test("the DefiLlama value is apyBase, never apy: a row without apyBase is dropped, not filled with rewards", () => {
    const pts = parseLlamaYieldChart({ status: "success", data: [
      { timestamp: "2024-01-01T23:01:00.000Z", apy: 5, apyBase: 4 },
      { timestamp: "2024-01-02T23:01:00.000Z", apy: 6, apyBase: null },
      { timestamp: "2024-01-03T23:01:00.000Z", apy: 7, apyBase: 3 },
    ] }, "p");
    expect(pts).toEqual([{ date: "2024-01-01", value: 4 }, { date: "2024-01-03", value: 3 }]);
    // The recorded Base pool carries rewards today, so apy and apyBase differ there.
    const last = JSON.parse(recorded["defillama-yields:7e0661bf-8cf3-45e6-9424-31916d4c7b84"]!).data.at(-1);
    expect(last.apy).not.toBe(last.apyBase);
    expect(expected["defillama-yields:7e0661bf-8cf3-45e6-9424-31916d4c7b84"]!.at(-1)!.value).toBe(last.apyBase);
  });

  test("an empty response (a pool with no data) is NoObservationsError, with no rows", async () => {
    serve([["yields.llama.fi", unknownPool]]);
    const s = byId.get("defillama-yields:aa70268e-4b52-42bf-a116-608b370f9501")!;
    const err = await extractInventorySeries(s).catch((e) => e);
    expect(err).toBeInstanceOf(NoObservationsError);
    expect(err.message).toBe(`${s.id}: the provider returned no observations from 2016-01-01`);
  });

  test("a malformed response is SeriesExtractError naming the series", async () => {
    serve([["yields.llama.fi", fredMaintenance]]);
    const err = await extractInventorySeries(byId.get("defillama-yields:aa70268e-4b52-42bf-a116-608b370f9501")!).catch((e) => e);
    expect(err).toBeInstanceOf(SeriesExtractError);
    expect(err.message).toStartWith("defillama-yields:aa70268e-4b52-42bf-a116-608b370f9501: extract failed:");
    serve([["yields.llama.fi", JSON.stringify({ status: "success", data: [{ timestamp: "yesterday", apyBase: 1 }] })]]);
    await expect(extractInventorySeries(byId.get("defillama-yields:aa70268e-4b52-42bf-a116-608b370f9501")!)).rejects.toThrow(/row timestamp "yesterday" is not an ISO instant/);
  });

  test("a pre-inception Yahoo window (HTTP 400) is SeriesExtractError naming the series, with no rows", async () => {
    serve([["finance.yahoo.com", yahooPreInception, 400]]);
    const err = await extractInventorySeries({ ...byId.get("yahoo:BTC-USD")!, requestedStart: "2010-01-01" }).catch((e) => e);
    expect(err).toBeInstanceOf(SeriesExtractError);
    expect(err.message).toMatch(/^yahoo:BTC-USD: extract failed: 400 /);
  });
});

describe("coverage is checked, never repaired", () => {
  test("requireCoverage names each missing series and its date range", () => {
    const series = inventory.series.filter((s) => s.id === "yahoo:GLD" || s.id === "defillama-yields:aa70268e-4b52-42bf-a116-608b370f9501");
    const history = { "yahoo:GLD": expected["yahoo:GLD"]!.filter((p) => p.date >= "2020-01-01") };
    let err: unknown;
    try { requireCoverage(series, history, { from: "2018-01-01", to: "2026-10-21" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(InventoryCoverageError);
    expect((err as InventoryCoverageError).gaps).toEqual([
      { id: "yahoo:GLD", from: "2018-01-01", to: "2020-01-01" },
      { id: "defillama-yields:aa70268e-4b52-42bf-a116-608b370f9501", from: "2023-02-06", to: "2026-10-21" },
    ]);
    // From the series' inception, with its weekend calendar, the recorded data covers it.
    requireCoverage(series, { ...expected }, { from: "2018-01-01", to: "2026-10-21" });
  });

  test("describeCoverage on no points is the defined error", () => {
    expect(() => describeCoverage(byId.get("yahoo:GLD")!, [])).toThrow(NoObservationsError);
  });
});

describe("the SDK input carries the series under their source ids", () => {
  const golden = Bun.file(join(import.meta.dir, "golden/regime-report.json")).text();
  const fixture = Bun.file(join(import.meta.dir, "fixtures/raw-indicator-history.csv")).text();

  test("every recorded series loads under its source id, and the regime report stays byte-identical to the golden", async () => {
    const extra: RawRow[] = [];
    for (const id of NEW_IDS) for (const p of expected[id]!) extra.push({ date: p.date, indicator: id, value: p.value, source: "fixture" });
    const csv = (await fixture).trimEnd() + "\n" + extra.map((r) => `${r.date},${r.indicator},${r.value},${r.source}`).join("\n") + "\n";
    const history = toHistory(parseRawHistory(csv));
    for (const id of NEW_IDS) expect(history[id]).toEqual(expected[id]!);
    // The new series run past the fixture's last date (2026-08-15); they are
    // not read by the regime, so they move neither the date axis nor a number.
    expect(expected["yahoo:GLD"]!.at(-1)!.date > "2026-08-15").toBe(true);
    expect(JSON.stringify(buildReport(runRegime(history)), null, 2) + "\n").toBe(await golden);
  }, 120_000);
});

describe("the SDK input file in the source-data form (date,series,value)", () => {
  // tests/fixtures/model-portfolio-inputs.csv: March 2026 of every inventory
  // series under its source id. The values are the expected points above for
  // the collected series, the backend regime extras fixture
  // (backend/tests/fixtures/regime/regime-extras.json.gz) for ^GSPC, ETH-USD
  // and DTB3, and a Yahoo v8 BTC-USD response for 2026-03 (captured 2026-10-23).
  const text = Bun.file(join(import.meta.dir, "fixtures/model-portfolio-inputs.csv")).text();

  test("prices, lending yields and the T-bill rate load with every inventory series under its source id", async () => {
    const t = await text;
    expect(t.split("\n")[0]).toBe("date,series,value");
    const history = toHistory(parseRawHistory(t));
    expect(Object.keys(history).sort()).toEqual(inventory.series.map((s) => s.id).sort());
    for (const s of inventory.series) expect(history[s.id]!.length).toBeGreaterThan(20);
    for (const id of NEW_IDS) expect(history[id]).toEqual(expected[id]!.filter((p) => p.date >= "2026-03-01" && p.date <= "2026-03-31"));
    for (const k of ["price", "lending_yield", "rate"]) expect(inventory.series.some((s) => s.kind === k && history[s.id])).toBe(true);
    // The source ids the backtest reads resolve to the ids it reads (D74 mapping).
    const resolved = resolveInputHistory(history);
    expect(resolved.SPX).toBe(history["yahoo:^GSPC"]!);
    expect(resolved.ETH).toBe(history["yahoo:ETH-USD"]!);
    expect(resolved.TBILL3M).toBe(history["fred:DTB3"]!);
    expect(resolved["yahoo:GLD"]).toBe(history["yahoo:GLD"]!);
  });

  test("the JSON form gives the same rows", async () => {
    const rows = parseRawHistory(await text);
    const json = JSON.stringify(rows.map((r) => ({ date: r.date, series: r.indicator, value: r.value })));
    expect(parseRawHistory(json)).toEqual(rows);
  });

  test("the source-data form refuses a bad date, a non-decimal value, a non source id and a wrong field count", () => {
    const h = "date,series,value\n";
    expect(() => parseRawHistory(h + "2026-02-30,yahoo:GLD,1\n")).toThrow(/row 2: date must be a real YYYY-MM-DD date/);
    expect(() => parseRawHistory(h + "2026-03-02,yahoo:GLD,0x10\n")).toThrow(/value must be a plain decimal number/);
    expect(() => parseRawHistory(h + "2026-03-02,yahoo:GLD, 1\n")).toThrow(/value must be a plain decimal number/);
    expect(() => parseRawHistory(h + "2026-03-02,yahoo:GLD,Infinity\n")).toThrow(/value must be a plain decimal number/);
    expect(() => parseRawHistory(h + "2026-03-02,GLD,1\n")).toThrow(/series must be a source id/);
    expect(() => parseRawHistory(h + "2026-03-02,yahoo:GLD,1,x\n")).toThrow(/expected 3 fields, got 4/);
    expect(parseRawHistory(h + "2026-03-02,yahoo:GLD,-1.5e2\n")).toEqual([{ date: "2026-03-02", indicator: "yahoo:GLD", value: -150, source: "" }]);
  });
});
