// Regenerates the TWO independent-fidelity golden fixtures
// (regime-compute-reference.json.gz, regime-backtest-correlations-reference
// .json.gz) from the GENUINE original, out-of-repo JS regime pipeline —
// NOT this repo's own TS port.
//
// Issue #447: PR #444 (issue #400) claimed the original out-of-repo
// agentjuno/robotmoney JS generator was "permanently unavailable" and
// regenerated these two fixtures using this repo's own TS pipeline instead,
// silently converting the STRICT tests in regime-fidelity.test.ts /
// backtest-correlations-fidelity.test.ts from independent cross-
// implementation checks into mere self-consistency checks. That claim was
// false: `robotmoney/robotmoney-site`, a fork in this same GitHub org, still
// holds the exact original code — byte-identical to upstream
// agentjuno/robotmoney (verified by matching blob shas across both repos,
// see scripts/vendor/regime-reference-js/README.md). This script vendors
// that original JS (scripts/vendor/regime-reference-js/) and drives it,
// UNMODIFIED, over this repo's own vendored raw floor to regenerate the two
// fixtures as a genuine independent reference again.
//
// Only these two fixtures are in scope:
//   - regime-compute-reference.json.gz (original JS computeRegime, 2-panel
//     [macro, onchain] default, full history)
//   - regime-backtest-correlations-reference.json.gz (original JS
//     computeCorrelations + computeBacktest/stripDailyFromSnapshot, over the
//     computeRegime result above + regime-extras.json.gz)
//
// regime-history.csv.gz and regime-snapshot.json.gz are NOT touched here —
// they are legitimately TS v3-methodology production outputs (this repo's
// own CURRENT_REGIME_VERSION "v3" full-history-recompute-every-run
// methodology, see analyze/regime-versions.ts), not independent-fidelity
// check fixtures, and remain owned by regime-goldens-regenerate.ts.
//
// Usage: bun run scripts/regime-independent-reference-regenerate.ts
//    (or: bun run regime-independent-reference:regenerate)
import { gzipSync, gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXDIR = join(HERE, "..", "tests", "fixtures", "regime");
const VENDOR_DIR = join(HERE, "vendor", "regime-reference-js");
const BACKFILL_START = "2018-01-01";

// The vendored reference is CommonJS (verbatim from the source repo) — use a
// require() shim so bun (an ESM script) can load it without converting it.
const require = createRequire(import.meta.url);

const { INDICATORS } = require(join(VENDOR_DIR, "lib", "indicators.js")) as {
  INDICATORS: Array<{ id: string; panel: string; transform: string; align?: string }>;
};
const { applyTransform } = require(join(VENDOR_DIR, "lib", "transforms.js")) as {
  applyTransform: (name: string, xs: number[]) => number[];
};
const { buildDateAxis, alignDailyForwardFill, alignDailyZeroFill } = require(
  join(VENDOR_DIR, "lib", "utils.js"),
) as {
  buildDateAxis: (start: string, end: string) => string[];
  alignDailyForwardFill: (series: RawRow[], dates: string[]) => number[];
  alignDailyZeroFill: (series: RawRow[], dates: string[]) => number[];
};
const { computeRegime } = require(join(VENDOR_DIR, "compute.js")) as {
  computeRegime: (panelData: Record<string, number[]>, dateAxis: string[]) => any;
};
const { computeCorrelations, computeBacktest, stripDailyFromSnapshot } = require(
  join(VENDOR_DIR, "backtest-correlations.js"),
) as {
  computeCorrelations: (dateAxis: string[], result: any, extras: any) => any;
  computeBacktest: (dateAxis: string[], result: any, extras: any) => any;
  stripDailyFromSnapshot: (backtest: any) => any;
};

function readGz(name: string): string {
  return gunzipSync(readFileSync(join(FIXDIR, name))).toString("utf8");
}
function readJsonGz<T = any>(name: string): T {
  return JSON.parse(readGz(name)) as T;
}
function writeGzAtomic(name: string, text: string): void {
  const finalPath = join(FIXDIR, name);
  const tmp = `${finalPath}.tmp-${crypto.randomUUID()}`;
  writeFileSync(tmp, gzipSync(Buffer.from(text, "utf8")));
  // Round-trip through the exact decompression path before committing.
  gunzipSync(readFileSync(tmp));
  renameSync(tmp, finalPath);
}

interface RawRow { date: string; value: number; }

function loadRawIndicatorHistory(): Record<string, RawRow[]> {
  const text = readGz("raw-indicator-history.csv.gz");
  const lines = text.split("\n");
  const out: Record<string, RawRow[]> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.indexOf(",");
    const c2 = line.indexOf(",", c + 1);
    const date = line.slice(0, c);
    const id = line.slice(c + 1, c2);
    const v = parseFloat(line.slice(c2 + 1));
    if (!date || !id || !Number.isFinite(v)) continue;
    (out[id] ||= []).push({ date, value: v });
  }
  for (const id in out) out[id].sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

async function main(): Promise<void> {
  const raw = loadRawIndicatorHistory();
  let maxDate = BACKFILL_START;
  for (const id in raw) {
    const rows = raw[id];
    if (rows.length && rows[rows.length - 1].date > maxDate) maxDate = rows[rows.length - 1].date;
  }
  const dateAxis: string[] = buildDateAxis(BACKFILL_START, maxDate);
  const nanSeries = new Array(dateAxis.length).fill(NaN);
  const transformed: Record<string, number[]> = {};
  for (const ind of INDICATORS) {
    const series = raw[ind.id] ?? [];
    if (series.length === 0) {
      transformed[ind.id] = nanSeries.slice();
      continue;
    }
    const aligner = ind.align === "zero_fill" ? alignDailyZeroFill : alignDailyForwardFill;
    transformed[ind.id] = applyTransform(ind.transform, aligner(series, dateAxis));
  }

  // computeRegime's default `panels` argument (from the vendored
  // lib/indicators.js's PANELS export) is already the 2-panel [macro,
  // onchain] composite — matching this fixture's historical shape.
  const result = computeRegime(transformed, dateAxis);

  console.log(
    `[regime-independent-reference-regenerate] dateAxis=${dateAxis.length} rows, asof=${dateAxis[dateAxis.length - 1]}`,
  );

  // ── regime-compute-reference.json.gz ──────────────────────────────────────
  const reference = {
    meta: {
      source:
        "genuine independent original-JS reference — robotmoney/robotmoney-site " +
        "(fork of agentjuno/robotmoney) scripts/regime/{compute,lib/*}.js, vendored " +
        "verbatim at backend/scripts/vendor/regime-reference-js/ (see its README.md " +
        "for blob-sha provenance), driven by " +
        "backend/scripts/regime-independent-reference-regenerate.ts (issue #447 — " +
        "restores the independent cross-implementation check PR #444 replaced with " +
        "an in-repo self-consistency check, over the BTC_MVRV-inclusive floor from " +
        "issue #400)",
      backfill_start: BACKFILL_START,
      max_date: maxDate,
      indicators: INDICATORS.map((i) => i.id),
      rows: dateAxis.length,
    },
    dateAxis,
    composite: result.composite,
    compositePercentile: result.compositePercentile,
    macroIndex: result.macroIndex,
    onchainIndex: result.onchainIndex,
    macroPercentile: result.macroPercentile,
    onchainPercentile: result.onchainPercentile,
    regime: result.regime,
    macroRegime: result.macroRegime,
    onchainRegime: result.onchainRegime,
  };
  writeGzAtomic("regime-compute-reference.json.gz", JSON.stringify(reference));
  console.log("[regime-independent-reference-regenerate] wrote regime-compute-reference.json.gz");

  // ── backtest + correlations (needs regime-extras.json.gz, untouched real
  // Yahoo/FRED market data — independent of the registry indicator floor) ───
  const extras = readJsonGz<{ spx: RawRow[]; eth: RawRow[]; tbill3m: RawRow[] }>("regime-extras.json.gz");
  const corr = computeCorrelations(dateAxis, result, extras);
  const bt = stripDailyFromSnapshot(computeBacktest(dateAxis, result, extras));

  // ── regime-backtest-correlations-reference.json.gz ────────────────────────
  const btCorrRef = {
    meta: {
      asof: dateAxis[dateAxis.length - 1],
      extras: { spx: extras.spx.length, eth: extras.eth.length, tbill3m: extras.tbill3m.length },
      source:
        "genuine independent original-JS reference — robotmoney/robotmoney-site " +
        "(fork of agentjuno/robotmoney) scripts/regime/update.js's computeCorrelations " +
        "/ computeBacktest (extracted verbatim, no logic changes) at " +
        "backend/scripts/vendor/regime-reference-js/backtest-correlations.js, driven by " +
        "backend/scripts/regime-independent-reference-regenerate.ts (issue #447)",
    },
    correlations: corr,
    backtest: bt,
  };
  writeGzAtomic("regime-backtest-correlations-reference.json.gz", JSON.stringify(btCorrRef));
  console.log("[regime-independent-reference-regenerate] wrote regime-backtest-correlations-reference.json.gz");
}

main().catch((err) => {
  console.error(`[regime-independent-reference-regenerate] FAILED: ${err instanceof Error ? err.stack ?? err.message : err}`);
  process.exitCode = 1;
});
