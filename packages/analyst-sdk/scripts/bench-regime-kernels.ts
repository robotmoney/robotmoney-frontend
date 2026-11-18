// `bun scripts/bench-regime-kernels.ts` times the fast rank and weight kernels
// (issue 1667) against the code they replaced (tests/support/reference-kernels.ts)
// on the full SDK fixture, read through prepareRegimeInputs. Each case
// alternates new and reference, 1 warm-up then 5 timed runs each, compares the
// medians, prints the ratio and exits 1 when a ratio is over its limit.
// Dev-only script: not run in CI, timing is judged by this exit code.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INDICATORS, ROLLING_WINDOW_DAYS } from "../src/analyze/indicators.ts";
import { parseRawHistory, toHistory } from "../src/input/load.ts";
import { prepareRegimeInputs } from "../src/prepare.ts";
import { BACKFILL_START } from "../src/run.ts";
import { resolveInputHistory } from "../src/series-ids.ts";
import { inverseCorrelationWeights, MAX_FORWARD_FILL_DAYS, rollingPercentileRank } from "../src/transform/math.ts";
import { ratiosFromLegs } from "../src/transform/ratios.ts";
import * as ref from "../tests/support/reference-kernels.ts";

const fixture = toHistory(parseRawHistory(readFileSync(join(import.meta.dir, "..", "tests", "fixtures", "raw-indicator-history.csv"), "utf8")));
const raw = ratiosFromLegs(fixture, resolveInputHistory(fixture));
let asof = BACKFILL_START;
for (const rows of Object.values(raw)) if (rows.length && rows[rows.length - 1]!.date > asof) asof = rows[rows.length - 1]!.date;
const { transformed, ages } = prepareRegimeInputs(raw, { start: BACKFILL_START, asof });

// Each indicator's series as computeRegime ranks it (stale forward-fills masked).
const series = INDICATORS.map((ind) => {
  const age = ages[ind.id];
  const xs = transformed[ind.id]!;
  return age ? xs.map((v, i) => (Number.isFinite(age[i]) && age[i]! > MAX_FORWARD_FILL_DAYS ? NaN : v)) : xs;
});
const n = series[0]!.length;

// The weight windows computeRegime uses: each panel's sign-aligned ranks over
// the trailing window, every 21 days and on the last day.
const signed: Record<string, number[]> = {};
INDICATORS.forEach((ind, k) => {
  signed[ind.id] = rollingPercentileRank(series[k]!, ROLLING_WINDOW_DAYS).map((v) => (Number.isFinite(v) ? (ind.sign >= 0 ? v : 1 - v) : NaN));
});
const windows: Record<string, number[]>[] = [];
for (const p of ["macro", "onchain", "factor"]) {
  const ids = INDICATORS.filter((x) => x.panel === p).map((x) => x.id);
  for (let i = 0; i < n; i++) {
    if (i % 21 !== 0 && i !== n - 1) continue;
    const start = Math.max(0, i - ROLLING_WINDOW_DAYS + 1);
    const win: Record<string, number[]> = {};
    for (const id of ids) win[id] = signed[id]!.slice(start, i + 1);
    windows.push(win);
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
function time(f: () => void): number {
  const t = performance.now();
  f();
  return performance.now() - t;
}
function bench(name: string, limit: number, fast: () => void, slow: () => void): boolean {
  fast();
  slow();
  const tf: number[] = [];
  const ts: number[] = [];
  for (let r = 0; r < 5; r++) {
    tf.push(time(fast));
    ts.push(time(slow));
  }
  const ratio = median(tf) / median(ts);
  const ok = ratio <= limit;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: new ${median(tf).toFixed(1)} ms, reference ${median(ts).toFixed(1)} ms, ratio ${ratio.toFixed(3)} (limit ${limit})`);
  return ok;
}

console.log(`fixture: ${series.length} indicator series of ${n} days, ${windows.length} weight windows`);
const results = [
  bench("rollingPercentileRank window 1095", 0.2,
    () => { for (const xs of series) rollingPercentileRank(xs, ROLLING_WINDOW_DAYS); },
    () => { for (const xs of series) ref.rollingPercentileRank(xs, ROLLING_WINDOW_DAYS); }),
  bench("rollingPercentileRank window = series length", 0.05,
    () => { for (const xs of series) rollingPercentileRank(xs, xs.length); },
    () => { for (const xs of series) ref.rollingPercentileRank(xs, xs.length); }),
  bench("inverseCorrelationWeights", 0.6,
    () => { for (const w of windows) inverseCorrelationWeights(w); },
    () => { for (const w of windows) ref.inverseCorrelationWeights(w); }),
];
process.exit(results.every(Boolean) ? 0 : 1);
