// `bun run regime <history.csv|history.json> [--full] [--start D] [--asof D] [--factor]`
// Prints the regime report as JSON on stdout. Reads one local file, no network.
import { parseRawHistory, toHistory } from "../src/input/load.ts";
import { buildReport, runRegime } from "../src/run.ts";

const args = process.argv.slice(2);
const full = args.includes("--full");
const factor = args.includes("--factor");
const flags = ["--start", "--asof"];
const USAGE = "usage: bun run regime <history.csv|history.json> [--full] [--start YYYY-MM-DD] [--asof YYYY-MM-DD] [--factor]";
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
const KNOWN_FLAGS = ["--full", "--factor", ...flags];
const unknown = args.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.includes(a));
if (unknown.length) {
  const hint = unknown.includes("--panels") ? " (--panels was replaced by --factor)" : "";
  console.error(`unknown option(s): ${unknown.join(" ")}${hint}\n${USAGE}`);
  process.exit(2);
}
const start = val("--start");
const asof = val("--asof");
const file = args.find((a, i) => !a.startsWith("--") && !flags.includes(args[i - 1] ?? ""));
if (!file) {
  console.error(USAGE);
  process.exit(2);
}
try {
  const rows = parseRawHistory(await Bun.file(file).text());
  const report = buildReport(runRegime(toHistory(rows), { start, asof, factor }), { full });
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  // A rejected option value (RangeError from runRegime) is a usage error like a
  // missing value or an unknown flag: exit 2. Anything else (unreadable file,
  // malformed CSV) is a runtime failure: exit 1.
  process.exit(e instanceof RangeError ? 2 : 1);
}
