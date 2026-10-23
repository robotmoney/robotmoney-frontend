// `bun run universe:check <holdings.json> [--universe <path>] [--allow-outside-universe]`
// Checks a JSON map of state to holding weights (percent of NAV), for example
// { "neutral": { "BTC": 5, "AAVE": 28 }, "risk_on": { "BTC": 10 } }, against the
// Base asset universe (issue 1400). Prints one line per finding to stderr.
// Exit 0: no findings, or findings allowed by --allow-outside-universe.
// Exit 2: findings, or a usage error. Exit 1: an unreadable or malformed file.
import { ALLOW_OUTSIDE_FLAG, UNIVERSE_FLAG, universeFromArgs, universeGate } from "./universe-option.ts";
import type { HoldingsByState } from "../src/allocate/universe.ts";

const USAGE = `usage: bun run universe:check <holdings.json> [${UNIVERSE_FLAG} <path>] [${ALLOW_OUTSIDE_FLAG}]`;
const args = process.argv.slice(2);
const unknown = args.filter((a) => a.startsWith("--") && a !== UNIVERSE_FLAG && a !== ALLOW_OUTSIDE_FLAG);
if (unknown.length) {
  console.error(`unknown option(s): ${unknown.join(" ")}\n${USAGE}`);
  process.exit(2);
}
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== UNIVERSE_FLAG);
if (!file) {
  console.error(USAGE);
  process.exit(2);
}

function asHoldings(data: unknown): HoldingsByState {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(data)) throw new TypeError("holdings: expected a JSON object of state to holding weights");
  for (const [state, holdings] of Object.entries(data)) {
    if (!isObj(holdings)) throw new TypeError(`holdings: state ${state} is not an object of holding weights`);
    for (const [id, w] of Object.entries(holdings))
      if (typeof w !== "number" || !Number.isFinite(w)) throw new TypeError(`holdings: ${state}.${id} is not a number`);
  }
  return data as HoldingsByState;
}

try {
  const universe = await universeFromArgs(args);
  const holdings = asHoldings(JSON.parse(await Bun.file(file).text()));
  const gate = universeGate(holdings, universe, args);
  for (const line of gate.lines) console.error(line);
  if (!gate.findings.length) console.error(`ok: every holding is inside the universe (${universe.assets.length} assets, exported ${universe.exported})`);
  process.exit(gate.exitCode);
} catch (e) {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  // A missing --universe path (RangeError) is a usage error: exit 2, like regime.ts.
  process.exit(e instanceof RangeError ? 2 : 1);
}
