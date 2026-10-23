// The Base asset universe (issue 1400): the shipped file loads, checkHoldings
// names every holding outside the universe or over a cap, the bin/ option reads
// `--universe <path>` and the gate refuses (exit 2) without the override flag.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHoldings, loadUniverse, UniverseError, type Universe } from "../src/index.ts";
import { universeFromArgs, universeGate } from "../bin/universe-option.ts";
import { buildUniverse, parseCsv, parseGroupsCsv } from "../scripts/export-universe.ts";
import shippedJson from "../universe/base-universe.json" with { type: "json" };

// The prototype's reference rule R1 (draft PR 1397, rules/R1.json): the holdings
// the shipped seed is built from must fit it in every state.
const R1 = {
  risk_off: { USDC: 5, SUSDS: 27, SPARK: 8, GT: 12, STEAK: 2, AAVE: 35, COMP: 5, GOLD: 6, BTC: 0 },
  neutral: { USDC: 2, SUSDS: 24, SPARK: 11, GT: 12, STEAK: 7, AAVE: 28, COMP: 5, GOLD: 6, BTC: 5 },
  risk_on: { USDC: 2, SUSDS: 22, SPARK: 11, GT: 12, STEAK: 7, AAVE: 27, COMP: 5, GOLD: 4, BTC: 10 },
};

const clone = (): Record<string, any> => JSON.parse(JSON.stringify(shippedJson));

describe("loadUniverse", () => {
  test("the shipped file loads with its assets, group caps and exported date", () => {
    const u = loadUniverse();
    expect(u.exported).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(u.assets.map((a) => a.id).sort()).toEqual(["AAVE", "BTC", "COMP", "GOLD", "GT", "SPARK", "STEAK", "SUSDS", "USDC"]);
    const caps = Object.fromEntries(u.groups.map((g) => [g.id, g.cap]));
    expect(caps).toEqual({ sky: 35, aave: 35, morpho: 30, morpho_v2: 12, compound: 10, bitcoin: 10, gold: 6 });
    expect(u.assets.find((a) => a.id === "BTC")!.maxWeight).toBe(10);
    for (const id of ["SPARK", "GT", "STEAK"]) expect(u.assets.find((a) => a.id === id)!.maxWeight).toBe(12); // 12% per Morpho curator
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
    expect(f[0]!.message).toContain("Morpho (SPARK, GT, STEAK) at 31% is over its cap of 30%");
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
    expect((await universeFromArgs(["rules/R1.json"])).assets).toHaveLength(9);
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
    const u = buildUniverse(csv, shipped.groups.filter((g) => g.id === "bitcoin"), "2026-10-23", "test");
    expect(u.assets).toHaveLength(2);
    expect(u.assets[0]).toMatchObject({ id: "BTC", liquidityUsd: 1200000, yieldPct: null, tier: "eligible", maxWeight: 10 });
    expect(u.assets[1]).toMatchObject({ id: "WATCH", contract: null, yieldPct: 4.5, tier: "watchlist", series: null });
  });

  test("a missing column or an empty cap is refused by name", () => {
    expect(() => buildUniverse("id,name\nBTC,x", [], "2026-10-23", "t")).toThrow(/missing column\(s\): sleeve, chain, tier, maxWeight/);
    expect(() => buildUniverse("id,name,sleeve,chain,tier,cap\nBTC,x,b,base,eligible,", [], "2026-10-23", "t")).toThrow(/row 2: not a number/);
  });

  test("a groups export parses members separated by semicolons", () => {
    expect(parseGroupsCsv("id,name,cap,members\nmorpho,Morpho,30,SPARK; GT;STEAK")).toEqual([
      { id: "morpho", name: "Morpho", cap: 30, members: ["SPARK", "GT", "STEAK"] },
    ]);
  });
});
