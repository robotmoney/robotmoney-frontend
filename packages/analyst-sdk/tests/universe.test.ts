// The Base asset universe (issue 1400): the shipped file loads, checkHoldings
// names every holding outside the universe or over a cap, the bin/ option reads
// `--universe <path>` and the gate refuses (exit 2) without the override flag.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHoldings, loadUniverse, UniverseError, type Universe } from "../src/index.ts";
import { universeFromArgs, universeGate } from "../bin/universe-option.ts";
import { buildUniverse, parseCsv, parseGroupsCsv, parseSeriesCsv } from "../scripts/export-universe.ts";
import shippedJson from "../universe/base-universe.json" with { type: "json" };
import { loadInventory } from "../src/inventory.ts";
import { SOURCE_TOLERANCES } from "../../../backend/src/analytics/source-tolerance.ts";

const PKG = join(import.meta.dir, "..");
const SHEET = join(PKG, "tests/fixtures/base-universe-sheet.csv");

// The prototype's reference rule R1 (draft PR 1397, rules/R1.json): the holdings
// the shipped seed is built from must fit it in every state.
const R1 = {
  risk_off: { USDC: 5, SUSDS: 27, SPARK: 8, GT: 12, STEAK: 2, AAVE: 35, COMP: 5, GOLD: 6, BTC: 0 },
  neutral: { USDC: 2, SUSDS: 24, SPARK: 11, GT: 12, STEAK: 7, AAVE: 28, COMP: 5, GOLD: 6, BTC: 5 },
  risk_on: { USDC: 2, SUSDS: 22, SPARK: 11, GT: 12, STEAK: 7, AAVE: 27, COMP: 5, GOLD: 4, BTC: 10 },
};

const clone = (): Record<string, any> => JSON.parse(JSON.stringify(shippedJson));

describe("loadUniverse", () => {
  test("the shipped file loads the 55 assets of the sheet and its group caps", () => {
    const u = loadUniverse();
    expect(u.exported).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(u.assets).toHaveLength(55);
    expect(new Set(u.assets.map((a) => a.id)).size).toBe(55);
    for (const id of ["USDC", "SUSDS", "SPARK", "GT", "STEAK", "AAVE", "COMP", "GOLD", "BTC"]) expect(u.assets.map((a) => a.id)).toContain(id);
    expect(u.assets.find((a) => a.id === "BTC")!.maxWeight).toBe(10);
    for (const id of ["SPARK", "GT", "STEAK"]) expect(u.assets.find((a) => a.id === id)!.maxWeight).toBe(12); // 12% per Morpho curator
  });

  test("every asset has a sleeve, a cap, and a value or a reason for each field the sheet leaves empty", () => {
    const u = loadUniverse();
    const rows = parseCsv(readFileSync(SHEET, "utf8"));
    const header = rows[0]!;
    const col = (n: string) => header.indexOf(n);
    expect(rows.length - 1).toBe(55);
    for (const a of u.assets) {
      expect(a.sleeve.length, a.id).toBeGreaterThan(0);
      expect(a.maxWeight, a.id).toBeGreaterThanOrEqual(0);
      const un = a.unavailable ?? {};
      for (const f of ["contract", "liquidityUsd", "yieldPct", "series"] as const) {
        if (a[f] === null) expect(un[f], `${a.id}.${f} is null without a reason`).toMatch(/\S/);
        else expect(un[f], `${a.id}.${f} has a value and a reason`).toBeUndefined();
      }
    }
    // The marker follows the sheet cell by cell: empty cell, null with a reason; set cell, a value.
    for (const r of rows.slice(1)) {
      const a = u.assets.find((x) => x.name === r[col("Asset")])!;
      expect(a, r[col("also")]).toBeDefined();
      expect(a.liquidityUsd === null, `${a.id} liquidity`).toBe((r[col("Base DEX liquidity ($k)")] ?? "").trim() === "");
      expect(a.yieldPct === null, `${a.id} yield`).toBe((r[col("Yield (APY)")] ?? "").trim() === "");
      expect(a.contract === null, `${a.id} contract`).toBe(!/^0x[0-9a-f]{40}$/i.test((r[col("Base contract")] ?? "").trim()));
      expect(a.maxWeight, `${a.id} cap`).toBe(Number((r[col("Max weight")] ?? "").replace("%", "")));
    }
  });

  test("rows with a non-address contract load without a fake address", () => {
    const u = loadUniverse();
    for (const id of ["ANCHORED_ASTOCK", "ST0X", "PENDLE_PT_BASE"]) {
      const a = u.assets.find((x) => x.id === id)!;
      expect(a.contract).toBeNull();
      expect(a.unavailable!.contract).toMatch(/no single address/);
    }
  });

  test("the group caps equal the caps the sheet states, and the Morpho 12% is a cap per curator", () => {
    const u = loadUniverse();
    const caps = Object.fromEntries(u.groups.map((g) => [g.id, g.cap]));
    expect(caps).toEqual({
      sky: 35, aave: 35, morpho: 30, morpho_v2: 12, morpho_gauntlet: 12, morpho_steakhouse: 12, morpho_sparkdao: 12,
      morpho_moonwell: 12, compound: 10, bitcoin: 10, us_equity: 10, gold: 6,
    });
    // The caps the sheet's Notes column states, read from the committed CSV.
    const rows = parseCsv(readFileSync(SHEET, "utf8")), header = rows[0]!;
    const notes = rows.slice(1).map((r) => r[header.indexOf("Notes")] ?? "").join("\n");
    for (const m of notes.matchAll(/(Sky|Morpho|US equity) (\d+)% cap|the (Morpho|US equity|Sky) (\d+)% cap/g)) {
      const name = m[1] ?? m[3], pct = Number(m[2] ?? m[4]);
      expect(caps[name!.toLowerCase().replace(" ", "_")], `${name} in Notes`).toBe(pct);
    }
    expect(notes).toContain("per-curator cap 12%");
    const members = (id: string) => u.groups.find((g) => g.id === id)!.members;
    expect(members("sky")).toEqual(["SUSDS", "USDS", "SPARK"]);
    expect(members("morpho_sparkdao")).toEqual(["SPARK"]);
    expect(members("morpho_gauntlet")).toEqual(["GT", "MORPHO_GTUSDCP_V2"]);
    expect(members("morpho_moonwell")).toEqual(["MOONWELL_FLAGSHIP_USDC"]);
    expect(members("morpho")).toContain("MOONWELL_FLAGSHIP_USDC");
    expect(members("us_equity")).toHaveLength(7);
    for (const g of u.groups) for (const m of g.members) expect(u.assets.map((a) => a.id)).toContain(m);
  });

  test("a model portfolio at the sheet's A (v8) target weights has no findings", () => {
    const rows = parseCsv(readFileSync(SHEET, "utf8")), header = rows[0]!;
    const u = loadUniverse();
    const neutral: Record<string, number> = {};
    for (const r of rows.slice(1)) {
      const w = Number((r[header.indexOf("A (v8) target weight")] ?? "").replace("%", ""));
      if (w > 0) neutral[u.assets.find((a) => a.name === r[header.indexOf("Asset")])!.id] = w;
    }
    expect(Object.values(neutral).reduce((x, y) => x + y, 0)).toBeCloseTo(100, 9);
    expect(checkHoldings({ neutral }, u)).toEqual([]);
    expect(neutral).toEqual(R1.neutral);
  });

  test("every non-null series id has an inventory row and a tolerance row", () => {
    const inv = new Map(loadInventory().series.map((s) => [s.id, s]));
    const withSeries = loadUniverse().assets.filter((a) => a.series !== null);
    expect(withSeries.length).toBeGreaterThan(0);
    for (const a of withSeries) {
      const row = inv.get(a.series!);
      expect(row, `${a.id}: ${a.series} has no inventory row`).toBeDefined();
      expect(SOURCE_TOLERANCES[row!.storageKey], `${a.id}: ${row!.storageKey} has no tolerance row`).toBeDefined();
    }
  });

  test("universe:export on the committed CSV rebuilds the committed universe", () => {
    const u = buildUniverse(
      readFileSync(SHEET, "utf8"), parseGroupsCsv(readFileSync(join(PKG, "universe/groups.csv"), "utf8")),
      shippedJson.exported, shippedJson.source, parseSeriesCsv(readFileSync(join(PKG, "universe/series.csv"), "utf8")),
    );
    expect(JSON.parse(JSON.stringify(u))).toEqual(shippedJson as unknown);
  });

  test("a series id, where present, is a <provider>:<symbol> source id", () => {
    for (const a of loadUniverse().assets) if (a.series !== null) expect(a.series).toMatch(/^[a-z][a-z0-9-]*:.+$/);
  });

  test("passed data is validated and returned", () => {
    const d = clone();
    d.assets = d.assets.filter((a: { id: string }) => a.id === "BTC");
    d.groups = [];
    expect(loadUniverse(d).assets.map((a) => a.id)).toEqual(["BTC"]);
  });

  test("a bad file is refused by name", () => {
    const noDate = clone(); delete noDate.exported;
    expect(() => loadUniverse(noDate)).toThrow(/exported/);
    const dup = clone(); dup.assets.push(dup.assets[0]);
    expect(() => loadUniverse(dup)).toThrow(/asset USDC: duplicate id/);
    const badCap = clone(); badCap.assets[0].maxWeight = 120;
    expect(() => loadUniverse(badCap)).toThrow(/asset USDC: maxWeight/);
    const strayMember = clone(); strayMember.groups[0].members.push("DOGE");
    expect(() => loadUniverse(strayMember)).toThrow(/group sky: member DOGE is not an asset/);
    const badTier = clone(); badTier.assets[0].tier = "maybe";
    expect(() => loadUniverse(badTier)).toThrow(UniverseError);
  });
});

describe("checkHoldings", () => {
  const u = loadUniverse();

  test("the prototype reference rule R1 has no findings", () => {
    expect(checkHoldings(R1, u)).toEqual([]);
  });

  test("an asset not in the universe is a finding naming the holding, the state and the cap", () => {
    const f = checkHoldings({ neutral: { ...R1.neutral, USDC: 0, DOGE: 2 } }, u);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "outside_universe", state: "neutral", holding: "DOGE", weight: 2, cap: null });
    expect(f[0]!.message).toContain("neutral");
    expect(f[0]!.message).toContain("DOGE");
    expect(f[0]!.message).toContain("cap: none");
  });

  test("Bitcoin at 12% is a finding naming the holding, the state and the 10% cap", () => {
    const f = checkHoldings({ risk_on: { ...R1.risk_on, BTC: 12, AAVE: 25 } }, u);
    const own = f.find((x) => x.kind === "asset_cap")!;
    expect(own).toMatchObject({ state: "risk_on", holding: "BTC", weight: 12, cap: 10 });
    expect(own.message).toBe("risk_on: BTC at 12% is over its cap of 10%");
    expect(f.find((x) => x.kind === "group_cap")).toMatchObject({ state: "risk_on", holding: "bitcoin", weight: 12, cap: 10 });
    expect(f).toHaveLength(2);
  });

  test("a group over its cap is a finding even when each member is under its own", () => {
    // Morpho at 31: SPARK 11 + GT 12 + STEAK 8, each at or under 12.
    const f = checkHoldings({ neutral: { ...R1.neutral, STEAK: 8, USDC: 1 } }, u);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "group_cap", state: "neutral", holding: "morpho", weight: 31, cap: 30 });
    expect(f[0]!.message).toContain("Morpho (GT, SPARK, STEAK, ");
    expect(f[0]!.message).toContain(") at 31% is over its cap of 30%");
  });

  test("findings are reported per state", () => {
    const f = checkHoldings({ risk_off: { DOGE: 1 }, risk_on: { BTC: 11 } }, u);
    expect(f.map((x) => `${x.state}/${x.holding}`)).toEqual(["risk_off/DOGE", "risk_on/BTC", "risk_on/bitcoin"]);
  });

  test("a zero weight is not a holding", () => {
    expect(checkHoldings({ neutral: { DOGE: 0 } }, u)).toEqual([]);
  });
});

describe("the --universe option and the exit-code gate (bin/universe-option.ts)", () => {
  const dir = mkdtempSync(join(tmpdir(), "analyst-sdk-universe-"));
  const other = clone();
  other.assets.push({ ...other.assets.find((a: { id: string }) => a.id === "BTC"), id: "DOGE", name: "Dogecoin", series: null });
  const otherPath = join(dir, "other.json");
  writeFileSync(otherPath, JSON.stringify(other));

  test("without --universe the shipped file is used", async () => {
    expect((await universeFromArgs(["rules/R1.json"])).assets).toHaveLength(55);
  });

  test("--universe other.json is honoured", async () => {
    const u = await universeFromArgs(["--universe", otherPath, "rules/R1.json"]);
    expect(u.assets.map((a) => a.id)).toContain("DOGE");
    expect(checkHoldings({ neutral: { DOGE: 2 } }, u)).toEqual([]);
  });

  test("--universe without a path is a usage error", async () => {
    await expect(universeFromArgs(["--universe"])).rejects.toBeInstanceOf(RangeError);
    await expect(universeFromArgs(["--universe", "--allow-outside-universe"])).rejects.toBeInstanceOf(RangeError);
  });

  test("findings exit 2 without --allow-outside-universe, and 0 with it", () => {
    const u = loadUniverse();
    const bad = { risk_on: { ...R1.risk_on, BTC: 12, AAVE: 25 } };
    const refused = universeGate(bad, u, ["rules/x.json"]);
    expect(refused.exitCode).toBe(2);
    expect(refused.lines[0]).toBe("refused: risk_on: BTC at 12% is over its cap of 10%");
    const allowed = universeGate(bad, u, ["rules/x.json", "--allow-outside-universe"]);
    expect(allowed.exitCode).toBe(0);
    expect(allowed.findings).toHaveLength(2);
    expect(allowed.lines[0]).toStartWith("warning (allowed by --allow-outside-universe)");
    expect(universeGate(R1, u, []).exitCode).toBe(0);
  });
});

describe("bun run universe:check (bin/check-universe.ts, spawned)", () => {
  const dir = mkdtempSync(join(tmpdir(), "analyst-sdk-universe-cli-"));
  const write = (name: string, data: unknown) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(data)); return p; };
  const bad = write("bad.json", { neutral: R1.neutral, risk_on: { ...R1.risk_on, BTC: 12, AAVE: 25 } });
  const doge = write("doge.json", { neutral: { ...R1.neutral, USDC: 0, DOGE: 2 } });
  const other = clone();
  other.assets.push({ ...other.assets.find((a: { id: string }) => a.id === "BTC"), id: "DOGE", name: "Dogecoin", series: null });
  const otherPath = write("other.json", other);
  const run = (...a: string[]) => {
    const p = Bun.spawnSync([process.execPath, "run", "bin/check-universe.ts", ...a], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, err: p.stderr.toString() };
  };

  test("findings exit 2 and name the holding, the state and the cap", () => {
    const r = run(bad);
    expect(r.code).toBe(2);
    expect(r.err).toContain("refused: risk_on: BTC at 12% is over its cap of 10%");
  });

  test("--allow-outside-universe exits 0 and still reports the findings", () => {
    const r = run(bad, "--allow-outside-universe");
    expect(r.code).toBe(0);
    expect(r.err).toContain("warning (allowed by --allow-outside-universe): risk_on: BTC at 12%");
  });

  test("--universe other.json is honoured", () => {
    expect(run(doge).code).toBe(2);
    const r = run(doge, "--universe", otherPath);
    expect(r.code).toBe(0);
    expect(r.err).toContain("ok: every holding is inside the universe (56 assets");
  });

  test("a usage error exits 2, an unreadable file exits 1", () => {
    expect(run(bad, "--universe").code).toBe(2);
    expect(run().code).toBe(2);
    expect(run(bad, "--nope").code).toBe(2);
    expect(run(join(dir, "missing.json")).code).toBe(1);
  });
});

describe("scripts/export-universe.ts", () => {
  const shipped: Universe = loadUniverse();

  test("parseCsv handles quotes, doubled quotes, commas and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n\r\n')).toEqual([["a", "b"], ["x, y", 'say "hi"']]);
  });

  test("a sheet export rebuilds a valid universe, matching headers loosely", () => {
    const csv = [
      "ID,Name,Sleeve,Chain,Contract Address,Liquidity (USD),Yield %,Tier,Max weight,Series",
      'BTC,"cbBTC (Coinbase Wrapped BTC)",bitcoin,base,0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf,"$1,200,000",,Eligible,10,yahoo:BTC-USD',
      "WATCH,Some token,other,base,,,4.5%,watchlist,2,",
    ].join("\n");
    const u = buildUniverse(csv, [{ id: "bitcoin", name: "Bitcoin", cap: 10, members: ["BTC"] }], "2026-10-23", "test");
    expect(u.assets).toHaveLength(2);
    expect(u.assets[0]).toMatchObject({ id: "BTC", liquidityUsd: 1200000, yieldPct: null, tier: "eligible", maxWeight: 10 });
    expect(u.assets[1]).toMatchObject({ id: "WATCH", contract: null, yieldPct: 4.5, tier: "watchlist", series: null });
  });

  test("a missing column or an empty cap is refused by name", () => {
    expect(() => buildUniverse("id,name\nBTC,x", [], "2026-10-23", "t")).toThrow(/missing column\(s\): sleeve, tier, maxWeight/);
    expect(() => buildUniverse("id,name,sleeve,chain,tier,cap\nBTC,x,b,base,eligible,", [], "2026-10-23", "t")).toThrow(/row 2: not a number/);
  });

  test("a groups export parses members separated by semicolons", () => {
    expect(parseGroupsCsv("id,name,cap,members\nmorpho,Morpho,30,SPARK; GT;STEAK")).toEqual([
      { id: "morpho", name: "Morpho", cap: 30, members: ["SPARK", "GT", "STEAK"] },
    ]);
  });
});
