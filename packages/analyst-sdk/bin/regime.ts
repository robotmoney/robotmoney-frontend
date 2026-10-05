// `bun run regime <history.csv|history.json> [--full] [--start D] [--asof D] [--panels macro,onchain,factor]`
// Prints the regime report as JSON on stdout. Reads one local file, no network.
import { parseRawHistory, toHistory } from "../src/input/load.ts";
import type { Panel } from "../src/analyze/indicators.ts";
import { buildReport, runRegime } from "../src/run.ts";

const PANELS_ALL = ["macro", "onchain", "factor"];
const args = process.argv.slice(2);
const full = args.includes("--full");
const flags = ["--start", "--asof", "--panels"];
const USAGE = "usage: bun run regime <history.csv|history.json> [--full] [--start YYYY-MM-DD] [--asof YYYY-MM-DD] [--panels macro,onchain,factor]";
const val = (f: string) => {
  const i = args.indexOf(f);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) {
    console.error(`${f} needs a value\n${USAGE}`);
    process.exit(2);
  }
  return v;
};
const start = val("--start");
const asof = val("--asof");
const panelsArg = val("--panels");
const file = args.find((a, i) => !a.startsWith("--") && !flags.includes(args[i - 1] ?? ""));
if (!file) {
  console.error(USAGE);
  process.exit(2);
}
let panels: Panel[] | undefined;
if (panelsArg !== undefined) {
  if (panelsArg.trim() === "") {
    console.error(`--panels needs a non-empty list\n${USAGE}`);
    process.exit(2);
  }
  panels = panelsArg.split(",") as Panel[];
  const bad = panels.filter((p) => !(PANELS_ALL as readonly string[]).includes(p));
  if (bad.length) {
    console.error(`unknown panel(s): ${bad.join(",")} (expected macro,onchain,factor)\n${USAGE}`);
    process.exit(2);
  }
}
try {
  const rows = parseRawHistory(await Bun.file(file).text());
  const report = buildReport(runRegime(toHistory(rows), { start, asof, panels }), { full });
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  process.exit(1);
}
