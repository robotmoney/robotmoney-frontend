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
import { parseInput } from "../src/input/load.ts";
import { periodStats, simulatePortfolio, type Weights } from "../src/analyze/backtest.ts";
import type { Point } from "../src/types.ts";
import { parseArgs, resolveFromCaller, UsageError } from "./args.ts";
import { ALLOW_OUTSIDE_FLAG, UNIVERSE_FLAG, universeFromArgs, universeGate } from "./universe-option.ts";

const USAGE =
  `usage: bun run backtest <portfolio.json> <input.csv|input.json> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--cost-bps N] [--full] [--replay] [${UNIVERSE_FLAG} <path>] [${ALLOW_OUTSIDE_FLAG}]`;

function fail(e: unknown, code: number): never {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  if (code === 2) console.error(USAGE);
  process.exit(code);
}

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

const CASH_RATE_NAMES = ["TBILL3M", "fred:DTB3", "backtest:DTB3"];
const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

function dateAxis(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

let portfolio: Record<string, number>;
let costBps: number | undefined;
try {
  const text = await Bun.file(resolveFromCaller(args.positionals[0]!, "backtest")).text();
  const data: unknown = JSON.parse(text);
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new UsageError("portfolio: expected a JSON object of holding to weight in percent");
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new UsageError(`portfolio: ${k} must be a finite nonnegative percent, got ${JSON.stringify(v)}`);
  }
  portfolio = data as Record<string, number>;
  const sum = Object.values(portfolio).reduce((s, v) => s + v, 0);
  if (Math.abs(sum - 100) > 1e-9) throw new UsageError(`portfolio: weights must sum to 100, got ${sum}`);
  const c = args.values.get("--cost-bps");
  if (c !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(c)) throw new UsageError(`--cost-bps must be a nonnegative number, got ${JSON.stringify(c)}`);
    costBps = Number(c);
  }
  for (const f of ["--from", "--to"]) {
    const v = args.values.get(f);
    if (v !== undefined && !isDay(v)) throw new UsageError(`${f} must be a real YYYY-MM-DD date, got ${JSON.stringify(v)}`);
  }
} catch (e) {
  fail(e, e instanceof UsageError || e instanceof RangeError ? 2 : 1);
}

try {
  // The universe gate runs before any input is read: a refused holding never backtests.
  const universe = await universeFromArgs(argv.map((a, i) => (argv[i - 1] === UNIVERSE_FLAG ? resolveFromCaller(a, "backtest") : a)));
  const holdings = Object.fromEntries(Object.entries(portfolio).filter(([k]) => k !== "cash"));
  const gate = universeGate({ portfolio: holdings }, universe, argv);
  for (const line of gate.lines) console.error(line);
  if (gate.exitCode !== 0) process.exit(gate.exitCode);

  const input = parseInput(await Bun.file(resolveFromCaller(args.positionals[1]!, "backtest")).text(), { replay: args.flags.has("--replay") });
  const history = input.history;
  const byId = new Map(universe.assets.map((a) => [a.id, a]));
  const prices: Record<string, Point[]> = {};
  const weights: Weights = {};
  for (const [holding, pct] of Object.entries(portfolio)) {
    weights[holding] = pct / 100;
    if (holding === "cash") continue;
    const series = byId.get(holding)?.series ?? holding;
    if (series.startsWith("defillama-yields:")) throw new UsageError(`${holding} is priced by a yield series (${series}), not a price; this command backtests price series only`);
    const points = history[series];
    if (!points?.length) throw new Error(`missing input: ${holding} needs the price series ${series}, which the input does not hold (a run never fetches)`);
    prices[holding] = points;
  }
  const cashRate = CASH_RATE_NAMES.map((n) => history[n]).find((p) => p?.length) ?? [];
  if (weights.cash && cashRate.length === 0) console.error("note: the input holds no TBILL3M (fred:DTB3) rate; cash earns zero");
  const dates = Object.values(prices).flatMap((p) => p.map((x) => x.date)).sort();
  if (dates.length === 0 && !args.values.get("--from")) throw new UsageError("an all-cash portfolio needs --from and --to");
  const from = args.values.get("--from") ?? dates[0]!;
  const to = args.values.get("--to") ?? dates[dates.length - 1]!;
  if (from > to) throw new UsageError(`--from ${from} is after --to ${to}`);
  const axis = dateAxis(from, to);
  const sim = simulatePortfolio(axis, axis.map(() => weights), prices, cashRate, costBps === undefined ? {} : { costBps });
  const { _daily, ...stats } = periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, trades: sim.trades });
  const out = {
    portfolio,
    universe: { exported: universe.exported, findings: gate.findings.length },
    stats,
    ...(args.flags.has("--full") ? { daily: _daily, returns: sim.returns, trades: sim.trades } : {}),
  };
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  fail(e, e instanceof UsageError ? 2 : 1);
}
