// `bun run regime <history.csv|history.json> [--full] [--start YYYY-MM-DD]`
// Prints the regime report as JSON on stdout. Reads one local file, no network.
import { parseRawHistory, toHistory } from "../src/input/load.ts";
import { buildReport, runRegime } from "../src/run.ts";

const args = process.argv.slice(2);
const full = args.includes("--full");
const si = args.indexOf("--start");
const start = si >= 0 ? args[si + 1] : undefined;
const file = args.find((a, i) => !a.startsWith("--") && (si < 0 || i !== si + 1));
if (!file) {
  console.error("usage: bun run regime <history.csv|history.json> [--full] [--start YYYY-MM-DD]");
  process.exit(2);
}
try {
  const rows = parseRawHistory(await Bun.file(file).text());
  const report = buildReport(runRegime(toHistory(rows), { start }), { full });
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  process.exit(1);
}
