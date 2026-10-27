// Issue 1421: the SDK reproduces the original (pre-refactor) reports for
// identical effective inputs and options, for every input variant:
//   - the shared calculation artifact JSON.stringify({correlations, backtest}),
//     the SAME original bytes backend/tests/regime-fidelity.test.ts compares the
//     backend's latest snapshot row against;
//   - the daily portfolio values of every portfolio and strategy;
//   - each CLI envelope (default, and --full --factor) against its own golden,
//     both in process and through the real CLI on a file.
// Proposed decision D78 (compensated arithmetic) moves numbers in their last
// bits, so the originals are now matched value by value (support/numeric-diff.ts):
// identical structure, field order, labels, nulls and integers, and no number
// moved by more than rounding. The in-process and CLI outputs still agree byte
// for byte with each other. The originals themselves are never regenerated.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRawHistory, toHistory } from "../src/input/load.ts";
import { buildReport, EXTRA_IDS, runRegime, type RunResult } from "../src/run.ts";
import { computeBacktest } from "../src/analyze/backtest.ts";
import { cutAtAsof } from "../src/prepare.ts";
import { expectSameUpToRounding } from "./support/numeric-diff.ts";
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
  const run = runRegime(history);
  computed[v] = {
    csvPath,
    run,
    history,
    defaultEnvelope: JSON.stringify(buildReport(run), null, 2) + "\n",
    fullFactorEnvelope: JSON.stringify(buildReport(runRegime(history, { factor: true }), { full: true }), null, 2) + "\n",
  };
}

// The original, matched up to rounding (D78): no structural or discrete difference.
function expectOriginal(got: string, file: string) {
  expectSameUpToRounding(got, readOriginal(file), file);
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
      expectOriginal(sharedAnalysisBytes({ correlations: c.run.correlations, backtest: c.run.backtest }), originalFile.sharedAnalysis(v));
    });

    test("daily portfolio values of every portfolio and strategy equal the original up to rounding", () => {
      const asof = c.run.dateAxis[c.run.dateAxis.length - 1]!;
      const bt = computeBacktest(c.run.dateAxis, c.run.result, {
        spx: cutAtAsof(c.history[EXTRA_IDS.spx] ?? [], asof),
        eth: cutAtAsof(c.history[EXTRA_IDS.eth] ?? [], asof),
        tbill3m: cutAtAsof(c.history[EXTRA_IDS.tbill3m] ?? [], asof),
      });
      expect(Object.keys(bt)).toEqual(["eth", "sp500", "mixed"]);
      expectOriginal(dailyEvidenceBytes(bt), originalFile.daily(v));
    });

    test("default report envelope equals its original up to rounding; the CLI prints the in-process bytes", () => {
      expectOriginal(c.defaultEnvelope, originalFile.sdkReport(v));
      expectBytes(cli([c.csvPath]), c.defaultEnvelope, `${v} CLI`);
    });

    test("--full --factor report envelope equals its original up to rounding; the CLI prints the in-process bytes", () => {
      expectOriginal(c.fullFactorEnvelope, originalFile.sdkReportFull(v));
      expectBytes(cli([c.csvPath, "--full", "--factor"]), c.fullFactorEnvelope, `${v} CLI --full --factor`);
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

  test("zero-volatility: every strategy of every portfolio takes the sd = 0 branch, Sharpe exactly 0", () => {
    const bt = computed["zero-volatility"].run.backtest!;
    const sharpes = Object.values(bt).flatMap((p) => Object.values(p).map((m) => m.sharpe));
    expect(sharpes.length).toBeGreaterThan(20);
    expect(new Set(sharpes)).toEqual(new Set([0]));
  });

  test("production: the default envelope is the committed CLI golden", async () => {
    expect(computed.production.defaultEnvelope).toBe(await Bun.file(join(import.meta.dir, "golden/regime-report.json")).text());
  });
});
