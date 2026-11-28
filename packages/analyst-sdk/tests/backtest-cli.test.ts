// `bun run backtest` as a process (issue 1404, extra scope): a fixed-target
// portfolio through simulatePortfolio + periodStats, gated by the Base asset
// universe through bin/universe-option.ts (issue 1400): `--universe <path>`
// and `--allow-outside-universe`.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { periodStats, simulatePortfolio } from "../src/analyze/backtest.ts";
import {
  BACKTEST_FILL, CASH_RATE_NAMES, PortfolioError, backtestAxis, checkBacktestOptions, checkPortfolio, dateAxis, isDay, portfolioFill, portfolioSeries,
} from "../src/analyze/backtest-portfolio.ts";
import { loadUniverse } from "../src/allocate/universe.ts";
import { parseInput } from "../src/input/load.ts";

setDefaultTimeout(120_000);
const DIR = import.meta.dir;
const PKG = join(DIR, "..");
const BIN = join(PKG, "bin/backtest.ts");
const TMP = mkdtempSync(join(DIR, ".backtest-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

async function run(args: string[], cwd = TMP) {
  const p = Bun.spawn(["bun", BIN, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}
const day = (i: number) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
const lines = ["date,series,value"];
for (let i = 0; i < 60; i++) {
  lines.push(`${day(i)},yahoo:BTC-USD,${90000 + 1000 * Math.sin(i / 5)}`);
  lines.push(`${day(i)},yahoo:GLD,${240 + i * 0.1}`);
  lines.push(`${day(i)},yahoo:WIDGET,${10 + (i % 3)}`);
  if (i % 7 === 0) lines.push(`${day(i)},fred:DTB3,4.2`);
}
const INPUT = join(TMP, "prices.csv");
writeFileSync(INPUT, lines.join("\n") + "\n");
const portfolio = (name: string, p: Record<string, number>) => {
  writeFileSync(join(TMP, name), JSON.stringify(p));
  return name;
};

describe("bun run backtest", () => {
  test("a portfolio inside the universe runs, and its statistics are periodStats over simulatePortfolio", async () => {
    const r = await run([portfolio("ok.json", { BTC: 10, GOLD: 6, cash: 84 }), "prices.csv", "--cost-bps", "25"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.universe.findings).toBe(0);
    const h = parseInput(lines.join("\n")).history;
    const axis = Array.from({ length: 60 }, (_, i) => day(i));
    const sim = simulatePortfolio(axis, axis.map(() => ({ BTC: 0.1, GOLD: 0.06, cash: 0.84 })), { BTC: h["yahoo:BTC-USD"]!, GOLD: h["yahoo:GLD"]! }, h["fred:DTB3"]!, { costBps: 25 });
    const { _daily, ...stats } = periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, excess: sim.excess, trades: sim.trades });
    void _daily;
    expect(JSON.stringify(out.stats)).toBe(JSON.stringify(stats));
  });

  test("a holding outside the universe or over its cap is refused (exit 2) before any input is read", async () => {
    const [outside, overCap] = await Promise.all([
      run([portfolio("outside.json", { WIDGET: 5, cash: 95 }), "missing-input.csv"]),
      run([portfolio("over.json", { BTC: 20, cash: 80 }), "prices.csv"]),
    ]);
    expect(outside.code).toBe(2);
    expect(outside.stderr).toMatch(/refused: portfolio: WIDGET at 5% is not in the universe/);
    expect(outside.stdout).toBe("");
    expect(overCap.code).toBe(2);
    expect(overCap.stderr).toMatch(/BTC at 20% is over its cap of 10%/);
  });

  test("--allow-outside-universe runs it with a warning; the holding is priced from its own series", async () => {
    const r = await run([portfolio("outside2.json", { "yahoo:WIDGET": 5, cash: 95 }), "prices.csv", "--allow-outside-universe"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/warning \(allowed by --allow-outside-universe\): portfolio: yahoo:WIDGET/);
    expect(JSON.parse(r.stdout).universe.findings).toBe(1);
  });

  test("--universe <path> swaps in another universe file, resolved from the caller's folder", async () => {
    const shipped = JSON.parse(await Bun.file(join(PKG, "universe/base-universe.json")).text());
    shipped.assets.push({ ...shipped.assets.find((a: { id: string }) => a.id === "GOLD"), id: "WIDGET", name: "Widget", series: "yahoo:WIDGET", maxWeight: 50 });
    writeFileSync(join(TMP, "my-universe.json"), JSON.stringify(shipped));
    const r = await run([portfolio("w.json", { WIDGET: 40, cash: 60 }), "prices.csv", "--universe", "my-universe.json"]);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).universe.findings).toBe(0);
    const missing = await run([portfolio("w2.json", { WIDGET: 40, cash: 60 }), "prices.csv", "--universe"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/--universe needs a value/);
  });

  test("usage and input errors: bad weights, repeated options, a yield series, missing price coverage", async () => {
    const outs = await Promise.all([
      run([portfolio("sum.json", { BTC: 10, cash: 80 }), "prices.csv"]),
      run([portfolio("ok2.json", { BTC: 10, cash: 90 }), "prices.csv", "--from", "2025-01-01", "--from", "2025-01-02"]),
      run([portfolio("ok3.json", { BTC: 10, cash: 90 }), "prices.csv", "extra.csv"]),
      run([portfolio("yield.json", { AAVE: 10, cash: 90 }), "prices.csv"]),
      run([portfolio("nogold.json", { BTC: 10, cash: 90 }), "prices.csv", "--from", "2024-06-01", "--to", "2024-06-30"]),
    ]);
    expect(outs.map((o) => o.code)).toEqual([2, 2, 2, 2, 1]);
    expect(outs[0]!.stderr).toMatch(/must sum to 100/);
    expect(outs[1]!.stderr).toMatch(/--from given more than once/);
    expect(outs[3]!.stderr).toMatch(/yield series/);
    expect(outs[4]!.stderr).toMatch(/missing price coverage/);
  });
});

// Issue 1765: the command is argument parsing over the pure module
// src/analyze/backtest-portfolio.ts. The module's calls give the command's
// output byte for byte, and the moved definitions live only there.
describe("bin/backtest.ts is argument parsing over src/analyze/backtest-portfolio.ts (issue 1765)", () => {
  test("the pure calls reproduce the command's stdout byte for byte", async () => {
    const r = await run([portfolio("pure.json", { BTC: 10, GOLD: 6, cash: 84 }), "prices.csv", "--cost-bps", "25", "--full"]);
    expect(r.code, r.stderr).toBe(0);
    const p = checkPortfolio({ BTC: 10, GOLD: 6, cash: 84 });
    const { costBps } = checkBacktestOptions({ costBps: "25" });
    const universe = loadUniverse();
    const { weights, prices, cashRate } = portfolioSeries(p, universe, parseInput(lines.join("\n")).history);
    const { axis } = backtestAxis(prices, {});
    const sim = simulatePortfolio(axis, axis.map(() => weights), prices, cashRate, { costBps, fill: portfolioFill(Object.keys(prices)) });
    const { _daily, ...stats } = periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, excess: sim.excess, trades: sim.trades });
    const out = { portfolio: p, universe: { exported: universe.exported, findings: 0 }, stats, daily: _daily, returns: sim.returns, trades: sim.trades };
    expect(r.stdout).toBe(`${JSON.stringify(out, null, 2)}\n`);
  });

  test("the checks refuse with PortfolioError, a RangeError; the command still prints it as the usage error it was", async () => {
    expect(new PortfolioError("x")).toBeInstanceOf(RangeError);
    expect(() => checkPortfolio([1])).toThrow(PortfolioError);
    expect(() => checkPortfolio({ BTC: 10, cash: 80 })).toThrow(/^portfolio: weights must sum to 100, got 90$/);
    expect(() => checkPortfolio({ BTC: "x", cash: 90 })).toThrow(/BTC must be a finite nonnegative percent, got "x"/);
    expect(() => checkBacktestOptions({ costBps: "-3" })).toThrow(/--cost-bps must be a nonnegative number, got "-3"/);
    expect(() => checkBacktestOptions({ from: "2025-02-30" })).toThrow(/--from must be a real YYYY-MM-DD date/);
    expect(checkBacktestOptions({ costBps: "2.5", from: "2025-01-01", to: "2025-01-31" })).toEqual({ costBps: 2.5 });
    expect(checkBacktestOptions({})).toEqual({});
    const r = await run([portfolio("sum2.json", { BTC: 10, cash: 80 }), "prices.csv"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toStartWith("UsageError: portfolio: weights must sum to 100, got 90\n");
  });

  test("a holding is priced from its universe asset's series, else its own; cash earns the first CASH_RATE_NAMES series held", () => {
    const pt = (v: number) => [{ date: "2025-01-01", value: v }];
    const history = { "yahoo:BTC-USD": pt(1), "yahoo:WIDGET": pt(2), "fred:DTB3": [], "backtest:DTB3": pt(4) };
    const got = portfolioSeries({ BTC: 50, "yahoo:WIDGET": 20, cash: 30 }, loadUniverse(), history);
    expect(got.weights).toEqual({ BTC: 0.5, "yahoo:WIDGET": 0.2, cash: 0.3 });
    expect(got.prices.BTC).toBe(history["yahoo:BTC-USD"]);
    expect(got.prices["yahoo:WIDGET"]).toBe(history["yahoo:WIDGET"]);
    expect(got.cashRate).toBe(history["backtest:DTB3"]);
    expect(CASH_RATE_NAMES).toEqual(["TBILL3M", "fred:DTB3", "backtest:DTB3"]);
    expect(portfolioSeries({ cash: 100 }, loadUniverse(), {}).cashRate).toEqual([]);
    expect(() => portfolioSeries({ AAVE: 10, cash: 90 }, loadUniverse(), history)).toThrow(PortfolioError);
    expect(() => portfolioSeries({ AAVE: 10, cash: 90 }, loadUniverse(), history)).toThrow(/is priced by a yield series/);
    let missing: unknown;
    try {
      portfolioSeries({ GOLD: 10, cash: 90 }, loadUniverse(), history);
    } catch (e) {
      missing = e;
    }
    expect(missing).toBeInstanceOf(Error);
    expect(missing).not.toBeInstanceOf(PortfolioError);
    expect((missing as Error).message).toMatch(/^missing input: GOLD needs the price series yahoo:GLD/);
    expect(portfolioFill(["BTC"])).toEqual({ cash: BACKTEST_FILL, BTC: BACKTEST_FILL });
    expect(BACKTEST_FILL).toEqual({ kind: "forward", maxAgeDays: null, reason: "Reproduces the former command-line carry" });
  });

  test("the window and its axis: the given days, else the priced days; a calendar axis with real days only", () => {
    const prices = { A: [{ date: "2025-01-03", value: 1 }, { date: "2025-01-05", value: 1 }], B: [{ date: "2025-01-02", value: 1 }] };
    expect(backtestAxis(prices, {})).toEqual({ from: "2025-01-02", to: "2025-01-05", axis: ["2025-01-02", "2025-01-03", "2025-01-04", "2025-01-05"] });
    expect(backtestAxis({}, { from: "2025-01-01", to: "2025-01-02" }).axis).toEqual(["2025-01-01", "2025-01-02"]);
    expect(() => backtestAxis({}, {})).toThrow(/^an all-cash portfolio needs --from and --to$/);
    expect(() => backtestAxis(prices, { from: "2025-01-04", to: "2025-01-03" })).toThrow(/^--from 2025-01-04 is after --to 2025-01-03$/);
    expect(dateAxis("2024-02-27", "2024-03-01")).toEqual(["2024-02-27", "2024-02-28", "2024-02-29", "2024-03-01"]);
    expect([isDay("2024-02-29"), isDay("2025-02-29"), isDay("2025-1-01"), isDay("")]).toEqual([true, false, false, false]);
  });

  test("bin/backtest.ts holds none of the moved definitions", () => {
    const bin = readFileSync(BIN, "utf8");
    for (const name of ["CASH_RATE_NAMES", "BACKTEST_FILL", "isDay", "dateAxis"]) expect(bin, name).not.toMatch(new RegExp(`\\b(const|function)\\s+${name}\\b`));
    expect(bin).not.toContain("defillama-yields:");
    expect(bin).not.toContain("pct / 100");
  });
});
