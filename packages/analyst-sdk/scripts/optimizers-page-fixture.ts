// Rebuilds tests/fixtures/optimizers-page/prices.json, the five price series
// the optimizers-page reproduction reads (tests/optimizers-page.test.ts, issue
// 1766), from a local csv-backups folder, and refreshes the fixture's
// manifest.json. Dev-only script: it reads and writes local files and lives
// outside src/, so the SDK stays pure. CI has no csv-backups access and never
// runs it; the test reads only the committed fixture.
//
//   RM_CSV_BACKUPS_DIR=<a csv-backups checkout> bun run packages/analyst-sdk/scripts/optimizers-page-fixture.ts [--check]
//
// Each series is latestStoredSeries of its storage key (the newest stored
// version of each market date) as of the backup the manifest names, cut at
// its last day. reference-optimizers.json is Lex's published data file, copied
// byte for byte from robotmoney/research-workbench
// research/optimizers-page/reference-optimizers.json; this script only hashes it.
// `--check` rebuilds in memory and exits 1 when a committed file differs.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openBackupsDir } from "../bin/backups-dir.ts";
import { latestStoredSeries } from "../src/archive/reader.ts";
import { sha256 } from "../node/hash.ts";

const DIR = join(import.meta.dir, "..", "tests/fixtures/optimizers-page");
const check = process.argv.includes("--check");

/** The storage key of each priced series, by the asset id the preset names. */
export const OPTIMIZERS_PAGE_KEYS = {
  btc: "research:BTC-USD",
  eth: "backtest:ETH-USD",
  sp500: "backtest:^GSPC",
  gld: "yahoo:GLD",
  tbill3m: "backtest:DTB3",
} as const;
const BACKUP = "2026-11-17T000000Z";
const LAST_DAY = "2026-11-16";

const root = process.env.RM_CSV_BACKUPS_DIR;
if (!root) {
  console.error("set RM_CSV_BACKUPS_DIR to a csv-backups checkout");
  process.exit(2);
}
const archive = openBackupsDir(root, BACKUP);
const keys = Object.values(OPTIMIZERS_PAGE_KEYS);
const series = latestStoredSeries(archive, keys, { notAfter: LAST_DAY });
for (const [id, key] of Object.entries(OPTIMIZERS_PAGE_KEYS)) {
  if (id !== "tbill3m") for (const p of series[key]!) if (!(p.value > 0)) throw new Error(`${key} on ${p.date} is ${p.value}`);
}
const prices = `${JSON.stringify({
  backup: BACKUP,
  last_day: LAST_DAY,
  keys: OPTIMIZERS_PAGE_KEYS,
  series: Object.fromEntries(keys.map((k) => [k, series[k]!.map((p) => [p.date, p.value])])),
})}\n`;
const reference = readFileSync(join(DIR, "reference-optimizers.json"));
const manifest = `${JSON.stringify(
  {
    csv_backups: { repository: "https://github.com/robotmoney/csv-backups", backup: BACKUP, last_day: LAST_DAY },
    reference: { repository: "https://github.com/robotmoney/research-workbench", path: "research/optimizers-page/reference-optimizers.json" },
    files: { "prices.json": sha256(new TextEncoder().encode(prices)), "reference-optimizers.json": sha256(reference) },
  },
  null,
  2,
)}\n`;

const outputs: [string, string][] = [
  ["prices.json", prices],
  ["manifest.json", manifest],
];
let stale = 0;
for (const [name, text] of outputs) {
  const path = join(DIR, name);
  let committed: string | null = null;
  try {
    committed = readFileSync(path, "utf8");
  } catch {
    committed = null;
  }
  if (check) {
    if (committed !== text) {
      console.error(`${path} differs from a rebuild`);
      stale++;
    }
  } else writeFileSync(path, text);
}
if (stale > 0) process.exit(1);
console.log(check ? "optimizers-page fixture: up to date" : `optimizers-page fixture: wrote ${outputs.map(([n]) => n).join(", ")}`);
