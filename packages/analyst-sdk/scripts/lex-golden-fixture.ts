// Rebuilds tests/fixtures/lex-equity-golden/runs.json.gz, the committed inputs
// of the v5 golden reproduction (tests/regime-v5-golden.test.ts, issue 1753),
// from a local csv-backups folder. Dev-only script: it reads and writes local
// files and lives outside src/, so the SDK stays pure. CI has no csv-backups
// access and never runs it; the reproduction reads only the committed fixture.
//
//   RM_CSV_BACKUPS_DIR=<a csv-backups checkout> bun run packages/analyst-sdk/scripts/lex-golden-fixture.ts [--check]
//
// The backup read is the one the committed golden manifest names
// (tests/fixtures/lex-equity-golden/manifest.json, csv_backups.backup).
//
// What it writes (tests/support/lex-golden.ts reads it back):
//   runs    every finished regime run of the backup that froze a vintage, in id
//           order: its id, as-of day, the UTC day it finished and its source label.
//   series  the 29 input series the model reads: the registry inputs and SPX,
//           ETH, TBILL3M, under the ids the computation reads, each ratio as the
//           run stored it (the v5 ratio declarations).
//   inputs  for each serving run (the SDK's selectPublications over `runs`, plus
//           the first run), its series: the first serving run's full history,
//           then each later run's changed points against the serving run before
//           it (`set`: added or changed points; `drop`: dates no longer present).
// `--check` rebuilds in memory and exits 1 when the committed file's content differs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { openBackupsDir } from "../bin/backups-dir.ts";
import { RunInputCollector, type Row } from "../src/archive/format1.ts";
import { INDICATORS } from "../src/analyze/indicators.ts";
import { inputHistory } from "../src/input/load.ts";
import { EXTRA_IDS } from "../src/run.ts";
import { resolveInputHistory } from "../src/series-ids.ts";
import { ratioDeclarationsFor, ratiosFromLegs } from "../src/transform/ratios.ts";
import { servingRuns, type LexFixture, type LexRun, type LexSeries } from "../tests/support/lex-golden.ts";

const SDK = join(import.meta.dir, "..");
const DIR = join(SDK, "tests/fixtures/lex-equity-golden");
const OUT = join(DIR, "runs.json.gz");
const check = process.argv.includes("--check");

const root = process.env.RM_CSV_BACKUPS_DIR;
if (!root) {
  console.error("set RM_CSV_BACKUPS_DIR to a csv-backups checkout");
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as { csv_backups: { backup: string; commit: string } };
const archive = openBackupsDir(root, manifest.csv_backups.backup);

// A run is a candidate for its as-of day when it finished with a usable outcome
// (production stores a regime artifact for exactly those) and froze a vintage.
const USABLE = new Set(["succeeded", "degraded"]);
const finished = new Map<string, string>();
for (const e of archive.table("analytics_ledger_run_events")) if (USABLE.has(e.event_type!)) finished.set(e.run_id!, e.knowledge_time!.slice(0, 10));
const vintages = archive.table("analytics_data_vintages");
const vintageOfRun = new Map(vintages.map((v) => [v.run_id!, v.id!]));
const ledger = archive.table("analytics_ledger_runs");
const runs: LexRun[] = ledger
  .filter((r) => r.tool_id === "regime" && finished.has(r.id!) && vintageOfRun.has(r.id!))
  .map((r) => ({ id: r.id!, asof: r.asof!, finishedOn: finished.get(r.id!)!, source: r.source_label! }))
  .sort((a, b) => Number(a.id) - Number(b.id));
if (runs.length === 0) throw new Error(`no finished regime run with a data vintage in ${root} as of ${archive.asOf.backup}`);
const serving = servingRuns(runs).serving;
const runKeyOf = new Map(ledger.map((r) => [r.id!, r.run_key!]));

// One pass over the vintage members (about 29 million rows in a production
// copy), keeping only the serving runs' rows.
const wanted = new Set(serving.map((r) => vintageOfRun.get(r.id)!));
const members = new Map<string, Row[]>();
for (const f of archive.files("analytics_vintage_members")) {
  for (const m of archive.scanRows(f)) {
    if (!wanted.has(m.vintage_id!)) continue;
    let rows = members.get(m.vintage_id!);
    if (!rows) members.set(m.vintage_id!, (rows = []));
    rows.push(m);
  }
}

const SERIES = [...INDICATORS.map((i) => i.id), ...Object.values(EXTRA_IDS)];
const declarations = ratioDeclarationsFor("v5");
const versionFiles = archive.files("source_value_versions");
const versions = archive.versions();
const methodologies = archive.table("analytics_ledger_methodology_versions");

const inputs: LexFixture["inputs"] = {};
let prior: Record<string, Map<string, number>> | null = null;
serving.forEach((run, k) => {
  const collector = new RunInputCollector(runKeyOf.get(run.id)!, { runs: ledger, methodologies, vintages, members: members.get(vintageOfRun.get(run.id)!) ?? [] });
  versions.forEach((rows, i) => collector.addVersions(rows, `${root.replace(/\/+$/, "")}/${versionFiles[i]!.path}`));
  const history = inputHistory(collector.finish().rows.map((r) => ({ date: r.date, series: r.series, value: Number(r.value), kind: r.kind })));
  const resolved = ratiosFromLegs(history, resolveInputHistory(history), declarations);
  const now: Record<string, Map<string, number>> = {};
  const entry: Record<string, LexSeries> = {};
  for (const id of SERIES) {
    const points = resolved[id] ?? [];
    for (let i = 1; i < points.length; i++) if (!(points[i - 1]!.date < points[i]!.date)) throw new Error(`run ${run.id}: ${id} is not strictly ascending at ${points[i]!.date}`);
    now[id] = new Map(points.map((p) => [p.date, p.value]));
    if (prior === null) {
      entry[id] = { set: points.map((p) => [p.date, p.value]), drop: [] };
      continue;
    }
    const before = prior[id]!;
    const set = points.filter((p) => !Object.is(before.get(p.date), p.value)).map((p): [string, number] => [p.date, p.value]);
    const drop = [...before.keys()].filter((d) => !now[id]!.has(d));
    if (set.length > 0 || drop.length > 0) entry[id] = { set, drop };
  }
  inputs[run.id] = entry;
  prior = now;
  process.stderr.write(`\rrun ${k + 1}/${serving.length} (run ${run.id}, as of ${run.asof})   `);
});
process.stderr.write("\n");

const fixture: LexFixture = { format: 1, backup: archive.asOf.backup, commit: manifest.csv_backups.commit, series: SERIES, runs, inputs };
const text = JSON.stringify(fixture) + "\n";
const sha = new Bun.CryptoHasher("sha256").update(text).digest("hex");
const committed = existsSync(OUT) ? gunzipSync(readFileSync(OUT)).toString("utf8") : null;
if (check) {
  if (committed !== text) {
    console.error(`lex-golden-fixture: ${OUT} differs from the fixture rebuilt from ${root} (backup ${archive.asOf.backup}); run without --check and review the diff`);
    process.exit(1);
  }
  console.log(`lex-golden-fixture: ${OUT} matches (${runs.length} runs, ${serving.length} serving, ${text.length} bytes of JSON, sha256 ${sha})`);
} else {
  if (committed === text) {
    console.log(`lex-golden-fixture: ${OUT} is already current (sha256 ${sha})`);
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    // Level 9, no file name or time in the header: the same content gives the same bytes on one zlib.
    writeFileSync(OUT, gzipSync(text, { level: 9 }));
    console.log(`lex-golden-fixture: wrote ${OUT} (${runs.length} runs, ${serving.length} serving, ${text.length} bytes of JSON, sha256 ${sha})`);
  }
}
