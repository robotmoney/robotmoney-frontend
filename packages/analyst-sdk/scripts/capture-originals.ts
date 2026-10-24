// `bun run scripts/capture-originals.ts` captures the SDK side of the issue 1421
// original evidence into tests/fixtures/originals/, from the code it runs on.
// Dev-only: it reads and writes local files and lives outside src/.
//
// Run it ONLY on an unmodified tree at the commit you record as the origin
// (the pre-refactor baseline): its output is the reference every later test
// compares against byte for byte. Re-running it on changed code would turn a
// regression into the new "original", which is exactly what the provenance
// test (tests/originals-provenance.test.ts) exists to catch: a changed fixture
// no longer matches the sha256 in manifest.json.
//
// Writes, per input variant (production, missing-label, zero-volatility):
//   sdk-report-<v>.json.gz             the default CLI envelope (bun run regime <csv>)
//   sdk-report-full-factor-<v>.json.gz the --full --factor CLI envelope
//   shared-analysis-<v>.json.gz        JSON.stringify({correlations, backtest}) of runRegime
//   daily-portfolio-<v>.json.gz        the unstripped daily portfolio values
// and an-behaviours.json.gz (the AN-5/6/9/10/14 pins). The backend envelopes are
// written by backend/scripts/capture-analytics-originals.ts. Both scripts merge
// their entries into manifest.json.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parseRawHistory, toHistory } from "../src/input/load.ts";
import { buildReport, EXTRA_IDS, runRegime } from "../src/run.ts";
import { computeBacktest } from "../src/analyze/backtest.ts";
import { cutAtAsof } from "../src/prepare.ts";
import {
  ORIGINALS_DIR,
  VARIANTS,
  dailyEvidenceBytes,
  originalFile,
  sha256,
  sharedAnalysisBytes,
  variantCsv,
  type OriginalEntry,
  type OriginalsManifest,
  type Variant,
} from "../tests/support/originals.ts";
import { anPins, anScenario } from "../tests/support/an-scenario.ts";

const codeCommit = process.argv[2];
if (!codeCommit || !/^[0-9a-f]{40}$/.test(codeCommit)) {
  console.error("usage: bun run scripts/capture-originals.ts <40-char commit sha the tree is at>");
  process.exit(2);
}

mkdirSync(ORIGINALS_DIR, { recursive: true });
const manifestPath = join(ORIGINALS_DIR, "manifest.json");
const manifest: OriginalsManifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { origin: { codeCommit, capturedAt: "", commands: [], rule: "" }, inputs: {} as OriginalsManifest["inputs"], originals: [] };
if (manifest.origin.codeCommit !== codeCommit) throw new Error(`manifest origin is ${manifest.origin.codeCommit}, not ${codeCommit}`);
manifest.origin.capturedAt = new Date().toISOString();
manifest.origin.rule =
  "Captured from the pre-refactor code at codeCommit on an unmodified tree. Never regenerate these files from later code: " +
  "a mismatch against them is a regression to explain, not a fixture to refresh.";
const command = `cd packages/analyst-sdk && bun run scripts/capture-originals.ts ${codeCommit}`;
if (!manifest.origin.commands.includes(command)) manifest.origin.commands.push(command);

function put(file: string, content: string, entry: Omit<OriginalEntry, "file" | "fileSha256" | "contentSha256" | "byteLength">) {
  const gz = gzipSync(Buffer.from(content, "utf8"), { level: 9 });
  writeFileSync(join(ORIGINALS_DIR, file), gz);
  manifest.originals = manifest.originals.filter((o) => o.file !== file);
  manifest.originals.push({ file, fileSha256: sha256(gz), contentSha256: sha256(content), byteLength: Buffer.byteLength(content), ...entry });
  console.log(`${file}: ${Buffer.byteLength(content)} bytes (${gz.length} gz)`);
}

const producedBy = "packages/analyst-sdk/scripts/capture-originals.ts";
for (const v of VARIANTS) {
  const csv = variantCsv(v);
  const rows = parseRawHistory(csv);
  const history = toHistory(rows);
  manifest.inputs[v as Variant] = {
    contentSha256: sha256(csv),
    rows: rows.length,
    derivation: v === "production"
      ? "tests/fixtures/raw-indicator-history.csv as committed"
      : `variantCsv("${v}") in tests/support/originals.ts over the production fixture`,
  };

  const run = runRegime(history);
  put(originalFile.sdkReport(v), JSON.stringify(buildReport(run), null, 2) + "\n", {
    kind: "report", variant: v, producedBy, describes: "default CLI envelope: JSON.stringify(buildReport(runRegime(h)), null, 2) + newline",
  });
  put(originalFile.sdkReportFull(v), JSON.stringify(buildReport(runRegime(history, { factor: true }), { full: true }), null, 2) + "\n", {
    kind: "report", variant: v, producedBy, describes: "--full --factor CLI envelope: buildReport(runRegime(h, {factor:true}), {full:true})",
  });
  put(originalFile.sharedAnalysis(v), sharedAnalysisBytes({ correlations: run.correlations ?? null, backtest: run.backtest ?? null }), {
    kind: "report", variant: v, producedBy, describes: "shared calculation artifact: JSON.stringify({correlations, backtest}) (backtest stripped of _daily)",
  });
  const asof = run.dateAxis[run.dateAxis.length - 1]!;
  const full = computeBacktest(run.dateAxis, run.result, {
    spx: cutAtAsof(history[EXTRA_IDS.spx] ?? [], asof),
    eth: cutAtAsof(history[EXTRA_IDS.eth] ?? [], asof),
    tbill3m: cutAtAsof(history[EXTRA_IDS.tbill3m] ?? [], asof),
  });
  put(originalFile.daily(v), dailyEvidenceBytes(full), {
    kind: "report", variant: v, producedBy, describes: "daily portfolio values: portfolio -> strategy -> [date, value][] from the unstripped computeBacktest",
  });
}

const s = anScenario();
const bt = computeBacktest(s.dateAxis, s.result, s.extras);
put(originalFile.anBehaviours, JSON.stringify({ pins: anPins(bt), backtest: bt }, null, 2) + "\n", {
  kind: "report", variant: "an-behaviours", producedBy,
  describes: "AN-5/6/9/10/14 named pins and the full unstripped backtest of tests/support/an-scenario.ts",
});

manifest.originals.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
