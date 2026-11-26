// `bun run backtest <portfolio.json> <input.csv|input.json> [--from D] [--to D] [--cost-bps N] [--full] [--replay] [--universe <path>] [--allow-outside-universe]`
// Backtests one fixed-target portfolio with the shared simulation
// (simulatePortfolio + periodStats, analytics requirements section 5) and prints
// its statistics as JSON. Reads local files only; no network.
//
// portfolio.json is a map of holding to weight in percent of NAV, summing to
// 100, for example { "BTC": 10, "GOLD": 6, "USDC": 84 }. `cash` is the cash leg,
// which earns the input's 3-month T-bill rate (TBILL3M, fred:DTB3). Every other
// holding is checked against the Base asset universe first (issue 1400,
// bin/universe-option.ts) and priced from the universe asset's series in the
// input. A holding outside the universe, or over a cap, is refused (exit 2)
// unless --allow-outside-universe is set; such a holding is priced from the
// input series named by the holding itself. A yield series (defillama-yields)
// is not a price and is refused.
//
// Exit status: 0 on success; 2 for a usage error or a refused holding; 1 for a
// runtime failure (unreadable or malformed file, missing price coverage).
//
// This file parses arguments, reads files and prints. The portfolio and option
// checks, the cash-rate names, the declared fill, the date axis and the holding
// to price matching are pure, in src/analyze/backtest-portfolio.ts (issue 1765).
import { parseInput } from "../src/input/load.ts";
import { periodStats, simulatePortfolio } from "../src/analyze/backtest.ts";
import {
  backtestAxis, checkBacktestOptions, checkPortfolio, portfolioFill, portfolioSeries, PortfolioError, type Portfolio,
} from "../src/analyze/backtest-portfolio.ts";
import { parseArgs, resolveFromCaller, UsageError } from "./args.ts";
import { ALLOW_OUTSIDE_FLAG, UNIVERSE_FLAG, universeFromArgs, universeGate } from "./universe-option.ts";

const USAGE =
  `usage: bun run backtest <portfolio.json> <input.csv|input.json> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--cost-bps N] [--full] [--replay] [${UNIVERSE_FLAG} <path>] [${ALLOW_OUTSIDE_FLAG}]`;

function fail(e: unknown, code: number): never {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  if (code === 2) console.error(USAGE);
  process.exit(code);
}

// The pure module refuses with PortfolioError; the command prints it as the usage error it has always been.
const asUsage = (e: unknown): unknown => (e instanceof PortfolioError ? new UsageError(e.message) : e);

const argv = process.argv.slice(2);
let args;
try {
  args = parseArgs(argv, {
    flags: ["--full", "--replay", ALLOW_OUTSIDE_FLAG],
    values: ["--from", "--to", "--cost-bps", UNIVERSE_FLAG],
    maxPositionals: 2,
  });
  if (args.positionals.length !== 2) throw new UsageError("a portfolio file and an input file are required");
} catch (e) {
  fail(e, 2);
}

let portfolio: Portfolio;
let costBps: number | undefined;
try {
  const text = await Bun.file(resolveFromCaller(args.positionals[0]!, "backtest")).text();
  portfolio = checkPortfolio(JSON.parse(text));
  ({ costBps } = checkBacktestOptions({ costBps: args.values.get("--cost-bps"), from: args.values.get("--from"), to: args.values.get("--to") }));
} catch (e) {
  const err = asUsage(e);
  fail(err, err instanceof UsageError || err instanceof RangeError ? 2 : 1);
}

try {
  // The universe gate runs before any input is read: a refused holding never backtests.
  const universe = await universeFromArgs(argv.map((a, i) => (argv[i - 1] === UNIVERSE_FLAG ? resolveFromCaller(a, "backtest") : a)));
  const holdings = Object.fromEntries(Object.entries(portfolio).filter(([k]) => k !== "cash"));
  const gate = universeGate({ portfolio: holdings }, universe, argv);
  for (const line of gate.lines) console.error(line);
  if (gate.exitCode !== 0) process.exit(gate.exitCode);

  const input = parseInput(await Bun.file(resolveFromCaller(args.positionals[1]!, "backtest")).text(), { replay: args.flags.has("--replay") });
  const { weights, prices, cashRate } = portfolioSeries(portfolio, universe, input.history);
  if (weights.cash && cashRate.length === 0) console.error("note: the input holds no TBILL3M (fred:DTB3) rate; cash earns zero");
  const { axis } = backtestAxis(prices, { from: args.values.get("--from"), to: args.values.get("--to") });
  const fill = portfolioFill(Object.keys(prices));
  const sim = simulatePortfolio(axis, axis.map(() => weights), prices, cashRate, { ...(costBps === undefined ? {} : { costBps }), fill });
  const { _daily, ...stats } = periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, excess: sim.excess, trades: sim.trades });
  const out = {
    portfolio,
    universe: { exported: universe.exported, findings: gate.findings.length },
    stats,
    ...(args.flags.has("--full") ? { daily: _daily, returns: sim.returns, trades: sim.trades } : {}),
  };
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  const err = asUsage(e);
  fail(err, err instanceof UsageError ? 2 : 1);
}
