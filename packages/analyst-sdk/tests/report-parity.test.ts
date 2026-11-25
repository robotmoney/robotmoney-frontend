// Issue 1421: the SDK reproduces the original (pre-refactor) reports for
// identical effective inputs and options, for every input variant:
//   - the shared calculation artifact JSON.stringify({correlations, backtest}),
//     the SAME original bytes backend/tests/regime-fidelity.test.ts compares the
//     backend's latest snapshot row against;
//   - the daily portfolio values of every portfolio and strategy;
//   - each CLI envelope (default, and --full --factor) against its own golden,
//     both in process and through the real CLI on a file.
// Decision D78 (compensated arithmetic) moves numbers in their last
// bits, so the originals are now matched value by value (support/numeric-diff.ts):
// identical structure, field order, labels, nulls and integers, and no number
// moved by more than rounding. The in-process and CLI outputs still agree byte
// for byte with each other. The originals themselves are never regenerated.
// Issue 1559 starts every line of a market on the strategies' start, so each
// original is compared with that rule applied (support/issue-1559.ts), using
// the variant's original daily values to re-window the baselines.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRawHistory, toHistory } from "../src/input/load.ts";
import { buildReport, EXTRA_IDS, runRegime as runRegimeOutcome, requireComplete, type RunResult } from "../src/run.ts";
// Each run here scores a complete day (issue 1655): an IncompleteDay fails the test.
const runRegime = (...a: Parameters<typeof runRegimeOutcome>) => requireComplete(runRegimeOutcome(...a));
import { computeBacktest } from "../src/analyze/backtest.ts";
import { cutAtAsof } from "../src/prepare.ts";
import type { Panel } from "../src/analyze/indicators.ts";
import { expectSameUpToRounding } from "./support/numeric-diff.ts";
import { shapeDiffs } from "./support/shape-diff.ts";
import { apply1559ToDaily, apply1559ToText, type DailyEvidence } from "./support/issue-1559.ts";
import {
  VARIANTS,
  bytesEqual,
  dailyEvidenceBytes,
  firstDifference,
  originalFile,
  readOriginal,
  sharedAnalysisBytes,
  variantCsv,
  type Variant,
} from "./support/originals.ts";

setDefaultTimeout(180_000);
// The originals were captured when the composite averaged macro and onchain
// only (issue 1708 added factor): they are replayed with that panel set.
const ORIGINAL_PANELS: Panel[] = ["macro", "onchain"];
const SDK_DIR = join(import.meta.dir, "..");
const tmp = mkdtempSync(join(tmpdir(), "analyst-sdk-parity-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Computed {
  csvPath: string;
  run: RunResult;
  history: ReturnType<typeof toHistory>;
  defaultEnvelope: string;
  fullFactorEnvelope: string;
}
const computed = {} as Record<Variant, Computed>;
for (const v of VARIANTS) {
  const csv = variantCsv(v);
  const csvPath = join(tmp, `${v}.csv`);
  writeFileSync(csvPath, csv);
  const history = toHistory(parseRawHistory(csv));
  const run = runRegime(history, { version: "v3", panels: ORIGINAL_PANELS });
  computed[v] = {
    csvPath,
    run,
    history,
    defaultEnvelope: JSON.stringify(buildReport(run), null, 2) + "\n",
    fullFactorEnvelope: JSON.stringify(buildReport(runRegime(history, { factor: true, version: "v3", panels: ORIGINAL_PANELS }), { full: true }), null, 2) + "\n",
  };
}

// The original with the issue 1559 rule applied, matched up to rounding (D78):
// no structural or discrete difference.
// Issue 1734 (D94): the backtest section no longer reproduces the original's numbers (a label trades
// one session later, a trade waits for an open market, Sharpe is post-cost and net of cash, the cash
// leg is a yield). It keeps the original's shape, so everything else is compared up to rounding and
// the backtest by shape.
function expectOriginal(got: string, file: string, v: Variant) {
  const evidence = JSON.parse(readOriginal(originalFile.daily(v))) as DailyEvidence;
  const want = JSON.parse(apply1559ToText(readOriginal(file), evidence)) as Record<string, unknown>;
  const have = JSON.parse(got) as Record<string, unknown>;
  const { backtest: haveBacktest, ...haveRest } = have;
  const { backtest: wantBacktest, ...wantRest } = want;
  expectSameUpToRounding(JSON.stringify(haveRest), JSON.stringify(wantRest), file);
  if (wantBacktest !== undefined) expect(shapeDiffs(haveBacktest, wantBacktest), `${file} backtest shape`).toEqual([]);
}

function expectBytes(got: string, want: string, label: string) {
  expect(firstDifference(got, want), label).toBeNull();
  expect(bytesEqual(got, want), label).toBe(true);
}

function cli(args: string[]): string {
  const proc = Bun.spawnSync([process.execPath, "run", "bin/regime.ts", ...args], { cwd: SDK_DIR, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`CLI exited ${proc.exitCode}: ${proc.stderr.toString()}`);
  return proc.stdout.toString();
}

for (const v of VARIANTS) {
  describe(`report parity: ${v} variant`, () => {
    const c = computed[v];

    test("shared correlations/backtest artifact equals the original up to rounding", () => {
      expect(c.run.correlations).toBeDefined();
      expect(c.run.backtest).toBeDefined();
      expectOriginal(sharedAnalysisBytes({ correlations: c.run.correlations, backtest: c.run.backtest }), originalFile.sharedAnalysis(v), v);
    });

    test("daily portfolio values cover every portfolio and strategy of the original", () => {
      const asof = c.run.dateAxis[c.run.dateAxis.length - 1]!;
      const bt = computeBacktest(c.run.dateAxis, c.run.result, {
        spx: cutAtAsof(c.history[EXTRA_IDS.spx] ?? [], asof),
        eth: cutAtAsof(c.history[EXTRA_IDS.eth] ?? [], asof),
        tbill3m: cutAtAsof(c.history[EXTRA_IDS.tbill3m] ?? [], asof),
      });
      expect(Object.keys(bt)).toEqual(["eth", "sp500", "mixed"]);
      const original = JSON.parse(readOriginal(originalFile.sharedAnalysis(v))) as { backtest: Parameters<typeof apply1559ToDaily>[1] };
      const evidence = JSON.parse(readOriginal(originalFile.daily(v))) as DailyEvidence;
      const got = JSON.parse(dailyEvidenceBytes(bt)) as Record<string, Record<string, unknown[]>>;
      const want = apply1559ToDaily(evidence, original.backtest);
      expect(Object.keys(got)).toEqual(Object.keys(want));
      for (const p of Object.keys(got)) expect(Object.keys(got[p]!)).toEqual(Object.keys(want[p]!));
    });

    test("default report envelope equals its original up to rounding; the CLI prints the in-process bytes", () => {
      expectOriginal(c.defaultEnvelope, originalFile.sdkReport(v), v);
      expectBytes(cli([c.csvPath, "--methodology", "v3", "--panels", ORIGINAL_PANELS.join(",")]), c.defaultEnvelope, `${v} CLI`);
    });

    test("--full --factor report envelope equals its original up to rounding; the CLI prints the in-process bytes", () => {
      expectOriginal(c.fullFactorEnvelope, originalFile.sdkReportFull(v), v);
      expectBytes(cli([c.csvPath, "--full", "--factor", "--methodology", "v3", "--panels", ORIGINAL_PANELS.join(",")]), c.fullFactorEnvelope, `${v} CLI --full --factor`);
    });
  });
}

describe("the variants exercise the edge cases they are named for", () => {
  test("missing-label: the composite has unlabelled days inside the history", () => {
    const { run } = computed["missing-label"];
    const labelledBefore = run.result.regime.findIndex((r) => r !== null);
    const gaps = run.result.regime.filter((r, i) => i > labelledBefore && r === null).length;
    expect(labelledBefore).toBeGreaterThan(-1);
    expect(gaps).toBeGreaterThan(30);
  });

  test("zero-volatility: every line that never trades takes the sd = 0 branch, Sharpe exactly 0; trading costs make the rest negative (issue 1734)", () => {
    const bt = computed["zero-volatility"].run.backtest!;
    const lines = Object.values(bt).flatMap((p) => Object.values(p));
    expect(lines.length).toBeGreaterThan(20);
    // Flat prices and a zero cash yield: every pre-cost return is 0, and Sharpe reads post-cost returns.
    const quiet = lines.filter((m) => m.transitions === 0);
    expect(quiet.length).toBeGreaterThan(5);
    expect(new Set(quiet.map((m) => m.sharpe))).toEqual(new Set([0]));
    for (const m of lines.filter((x) => x.transitions > 0)) expect(m.sharpe!).toBeLessThan(0);
  });

  // The production variant drops the ratio legs (the originals predate them).
  // The current version reads the equity ratios from their raw-close legs
  // (issue 1733), so it runs on the committed fixture, legs included.
  test("production: under the current version, the committed fixture's default envelope is the committed CLI golden", async () => {
    const fixture = toHistory(parseRawHistory(await Bun.file(join(import.meta.dir, "fixtures/raw-indicator-history.csv")).text()));
    const current = JSON.stringify(buildReport(runRegime(fixture)), null, 2) + "\n";
    expect(current).toBe(await Bun.file(join(import.meta.dir, "golden/regime-report.json")).text());
  });
});
