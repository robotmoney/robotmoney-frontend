import { describe, expect, test } from "bun:test";
import { BACKTEST_PATH, backtestStartProblems } from "../../release/version-checks/v0.7.3/backtest-start.ts";

const line = (start: string, first: { date: string; value: number }) => ({ start_date: start, equity_curve: [first, { date: "2018-06-30", value: 1.1 }] });
const body = (backtest: unknown) => JSON.stringify({ latest: { backtest } });

describe("v0.7.3 backtest-start check (PR 1562)", () => {
  test("green: every line in each market starts on one date at $1", () => {
    const ok = { eth: { composite: line("2018-05-15", { date: "2018-05-15", value: 1 }), eth_hodl: line("2018-05-15", { date: "2018-05-15", value: 1 }) } };
    expect(backtestStartProblems(200, body(ok))).toEqual([]);
  });

  test("red: production's v0.7.2 shape, the hodl and stables lines starting four and a half months earlier", () => {
    const old = { eth: {
      composite: line("2018-05-15", { date: "2018-05-31", value: 0.8072 }),
      eth_hodl: line("2018-01-01", { date: "2018-01-31", value: 1.4474 }),
    } };
    const problems = backtestStartProblems(200, body(old));
    expect(problems[0]).toContain("market eth: lines start on different dates");
    expect(problems.join()).toContain("line composite: the equity curve opens at");
  });

  test("red: a non-200, a non-JSON body and a payload with no backtest", () => {
    expect(backtestStartProblems(503, "")).toEqual([`GET ${BACKTEST_PATH} answered 503, not 200`]);
    expect(backtestStartProblems(200, "<html>")).toEqual([`GET ${BACKTEST_PATH} did not answer JSON`]);
    expect(backtestStartProblems(200, JSON.stringify({ latest: {} }))).toEqual([`GET ${BACKTEST_PATH} carries no backtest in latest`]);
  });
});
