// One-time, explicitly-invoked regeneration of the regime-fidelity GOLDEN
// fixtures that are downstream of backend/tests/fixtures/regime/raw-indicator-
// history.csv.gz (issue #400: adding real BTC_MVRV to that floor changes
// every onchain-panel-derived number, so the frozen goldens computed WITHOUT
// BTC_MVRV go stale). Regenerates, via the SAME in-repo, already-fidelity-
// proven TS pipeline the tests replay (regime-fidelity.test.ts's "STRICT,
// multi-day" test independently proved this port byte-identical to the
// original JS over the PRE-BTC_MVRV floor):
//
//   - regime-history.csv.gz  (full-history per-date rows; CURRENT_REGIME_VERSION
//     "v3" already means "every run recomputes the full history on
//     best-available raw data, no frozen lockout" — see regime-versions.ts —
//     so a single fresh full recompute IS the current production methodology,
//     not a new one invented for this regeneration.)
//   - regime-snapshot.json.gz  (asof-only rich snapshot: composite/percentile/
//     panel indices/regime + per-indicator objects + backtest + correlations)
//
// regime-extras.json.gz (real Yahoo ^GSPC/ETH-USD + FRED DTB3) is untouched —
// it is independent of the registry indicators / raw floor.
//
// Issue #447: this script used to ALSO write the two INDEPENDENT-fidelity
// reference fixtures here, driving them from this SAME in-repo TS pipeline —
// which silently converted them from independent cross-implementation
// references into in-repo self-consistency checks (PR #444 claimed the
// original out-of-repo agentjuno/robotmoney JS generator was "permanently
// unavailable"; it was not — `robotmoney/robotmoney-site`, a same-org fork,
// still holds it byte-identical). Those two fixtures are now EXCLUSIVELY
// owned by `regime-independent-reference-regenerate.ts`, which drives the
// genuine vendored original JS instead of this TS port; see that script's
// header for which files it owns. Do not add write blocks for them back
// here — the two scripts must never both write the same file. This file
// deliberately contains no textual reference to either fixture's basename,
// so `grep` for those basenames is a reliable guard that ownership has not
// silently drifted back (issue #500 acceptance criterion).
//
// Usage: bun run scripts/regime-goldens-regenerate.ts
import { gzipSync, gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { INDICATORS } from "../src/analytics/analyze/indicators.ts";
import { computeRegime, type RegimeComputeResult } from "../src/analytics/analyze/compute.ts";
import { applyTransform } from "../src/analytics/transform/transforms.ts";
import { buildDateAxis, alignDailyForwardFill, alignDailyZeroFill } from "../src/analytics/transform/math.ts";
import { CURRENT_REGIME_VERSION } from "../src/analytics/analyze/regime-versions.ts";
import { computeBacktest, stripDailyFromSnapshot, type BacktestExtras } from "../src/analytics/analyze/backtest.ts";
import { computeCorrelations, type CorrelationExtras } from "../src/analytics/analyze/correlations.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXDIR = join(HERE, "..", "tests", "fixtures", "regime");
const BACKFILL_START = "2018-01-01";

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

function monthlySparkline(series: number[] | undefined, dateAxis: string[], months: number): (number | null)[] {
  if (!series || series.length === 0) return [];
  const lastDate = dateAxis[dateAxis.length - 1];
  const [ly, lm] = lastDate.split("-").map(Number);
  const monthLast = new Map<string, number>();
  for (let i = 0; i < dateAxis.length; i++) {
    const v = series[i];
    if (!Number.isFinite(v)) continue;
    monthLast.set(dateAxis[i].slice(0, 7), v);
  }
  const out: (number | null)[] = [];
  for (let k = months - 1; k >= 0; k--) {
    let y = ly;
    let m = lm - k;
    while (m <= 0) { m += 12; y -= 1; }
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    const v = monthLast.get(ym);
    out.push(typeof v === "number" && Number.isFinite(v) ? v : null);
  }
  return out;
}

async function main(): Promise<void> {
  const raw = loadRawIndicatorHistory();
  let maxDate = BACKFILL_START;
  for (const id in raw) {
    const rows = raw[id];
    if (rows.length && rows[rows.length - 1].date > maxDate) maxDate = rows[rows.length - 1].date;
  }
  const dateAxis = buildDateAxis(BACKFILL_START, maxDate);
  const nanSeries = new Array(dateAxis.length).fill(NaN);
  const transformed: Record<string, number[]> = {};
  const lastRaw: Record<string, RawRow | null> = {};
  for (const ind of INDICATORS) {
    const series = raw[ind.id] ?? [];
    lastRaw[ind.id] = series.length ? series[series.length - 1] : null;
    if (series.length === 0) {
      transformed[ind.id] = nanSeries.slice();
      continue;
    }
    const aligner = (ind as any).align === "zero_fill" ? alignDailyZeroFill : alignDailyForwardFill;
    transformed[ind.id] = applyTransform(ind.transform, aligner(series, dateAxis));
  }

  const r2 = computeRegime(transformed, dateAxis); // [macro, onchain]
  const r3 = computeRegime(transformed, dateAxis, ["macro", "onchain", "factor"]); // +factor

  console.log(`[regime-goldens-regenerate] dateAxis=${dateAxis.length} rows, asof=${dateAxis[dateAxis.length - 1]}`);

  // The full-history INDEPENDENT-fidelity reference is NOT written here — see
  // the file header note. It is exclusively owned by
  // regime-independent-reference-regenerate.ts (issue #447).

  // ── regime-history.csv.gz ─────────────────────────────────────────────────
  // v3 methodology already means "every run recomputes the full history" (no
  // frozen lockout, see regime-versions.ts) — one version tag for every row.
  const histLines = [
    "date,macro_index,onchain_index,composite,composite_percentile,macro_percentile,onchain_percentile,macro_regime,onchain_regime,regime,version",
  ];
  for (let i = 0; i < dateAxis.length; i++) {
    if (!r2.regime[i]) continue; // unclassified days are never persisted/committed
    histLines.push(
      [
        dateAxis[i],
        r2.macroIndex?.[i]?.toFixed(6),
        r2.onchainIndex?.[i]?.toFixed(6),
        r2.composite[i]?.toFixed(6),
        r2.compositePercentile[i]?.toFixed(6),
        r2.macroPercentile?.[i]?.toFixed(6),
        r2.onchainPercentile?.[i]?.toFixed(6),
        r2.macroRegime?.[i] ?? "",
        r2.onchainRegime?.[i] ?? "",
        r2.regime[i] ?? "",
        CURRENT_REGIME_VERSION,
      ].join(","),
    );
  }
  writeGzAtomic("regime-history.csv.gz", histLines.join("\n") + "\n");
  console.log(`[regime-goldens-regenerate] wrote regime-history.csv.gz (${histLines.length - 1} classified rows)`);

  // ── backtest + correlations (needs regime-extras.json.gz, untouched real
  // Yahoo/FRED market data — independent of the registry indicator floor) ───
  const extras = readJsonGz<BacktestExtras & CorrelationExtras>("regime-extras.json.gz");
  const corr = computeCorrelations(dateAxis, r2, extras as CorrelationExtras);
  const bt = stripDailyFromSnapshot(computeBacktest(dateAxis, r2, extras as BacktestExtras));

  // The backtest+correlations INDEPENDENT-fidelity reference is NOT written
  // here — see the file header note. It is exclusively owned by
  // regime-independent-reference-regenerate.ts (issue #447). `corr`/`bt`
  // above are still computed here because regime-snapshot.json.gz (below)
  // legitimately embeds this TS pipeline's own backtest/correlations output.

  // ── regime-snapshot.json.gz ────────────────────────────────────────────────
  // Preserve the existing rich, non-numeric top-level/descriptive fields
  // (bucket_thresholds, extras, history, rolling_window_days, generated_at,
  // panels) from the committed fixture; only overwrite fields that are
  // mathematically downstream of the raw floor (onchain-panel figures +
  // composite + the per-indicator numeric fields + backtest/correlations).
  const oldSnap: any = readJsonGz("regime-snapshot.json.gz");
  const i = dateAxis.length - 1;
  const byId = new Map<string, any>((oldSnap.indicators as any[]).map((ind) => [ind.id, ind]));

  const newIndicators = INDICATORS.filter((ind) => ind.panel === "macro" || ind.panel === "onchain").map((ind) => {
    const weight = r2.weightsByPanel[ind.panel]?.[ind.id] ?? null;
    const percentile = r2.ranks[ind.id]?.[i];
    const signed = r2.signed[ind.id]?.[i];
    const transformedValue = transformed[ind.id]?.[i];
    const prior = byId.get(ind.id);
    // BTC_MVRV's committed descriptive metadata still names the DEAD
    // blockchain.com source ("Blockchain.com mvrv chart...") — the #127
    // repoint means the registry's OWN fields (Coinmetrics CapMVRVCur) are the
    // only accurate description now, so always rebuild its descriptive text
    // fresh from the registry rather than preserving the stale vendored copy.
    // Every other indicator's descriptive text is unchanged, so the old
    // vendored entry is preserved verbatim.
    const registryBase = {
      id: ind.id,
      name: ind.name,
      panel: ind.panel,
      source: ind.source,
      source_url: (ind as any).source_url ?? null,
      sign: ind.sign,
      transform: ind.transform,
      unit: (ind as any).unit ?? null,
      description: (ind as any).description ?? null,
      derivation: (ind as any).derivation ?? null,
      interpretation: (ind as any).interpretation ?? null,
    };
    const base = ind.id === "BTC_MVRV" ? registryBase : (prior ?? registryBase);
    return {
      ...base,
      raw_value: lastRaw[ind.id]?.value ?? null,
      raw_date: lastRaw[ind.id]?.date ?? null,
      transformed_value: Number.isFinite(transformedValue) ? transformedValue : null,
      percentile: Number.isFinite(percentile) ? percentile : null,
      signed_percentile: Number.isFinite(signed) ? signed : null,
      panel_weight: weight,
      sparkline: monthlySparkline(r2.signed[ind.id], dateAxis, 24),
    };
  });

  const newSnap = {
    ...oldSnap,
    asof: dateAxis[i],
    composite: r2.composite[i],
    composite_percentile: r2.compositePercentile[i],
    macro_index: r2.macroIndex?.[i],
    onchain_index: r2.onchainIndex?.[i],
    macro_percentile: r2.macroPercentile?.[i],
    onchain_percentile: r2.onchainPercentile?.[i],
    regime: r2.regime[i],
    macro_regime: r2.macroRegime?.[i],
    onchain_regime: r2.onchainRegime?.[i],
    panel_weights: { macro: r2.weightsByPanel.macro, onchain: r2.weightsByPanel.onchain, factor: r3.weightsByPanel.factor },
    indicators: newIndicators,
    backtest: bt,
    correlations: corr,
  };
  writeGzAtomic("regime-snapshot.json.gz", JSON.stringify(newSnap));
  console.log(`[regime-goldens-regenerate] wrote regime-snapshot.json.gz (${newIndicators.length} macro+onchain indicators)`);
}

main().catch((err) => {
  console.error(`[regime-goldens-regenerate] FAILED: ${err instanceof Error ? err.stack ?? err.message : err}`);
  process.exitCode = 1;
});
