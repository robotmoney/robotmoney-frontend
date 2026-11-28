// Issue 1766: Lex's optimizers page reproduced from the committed fixture
// alone. tests/fixtures/optimizers-page/ holds the five price series as stored
// in csv-backups backup 2026-11-17T000000Z up to 2026-11-16 (prices.json,
// written by scripts/optimizers-page-fixture.ts), Lex's published data file
// (reference-optimizers.json) and a manifest of both hashes. The labels are the
// composite labels of tests/fixtures/lex-equity-golden/outputs.json on the
// daily axis from its first day to its last (a day the golden does not serve
// has no label and keeps the last one).
//
// The file is not reproduced exactly: OPTIMIZERS_PRESET trades at a lag of one
// session on each asset's own calendar and earns the discount quote's yield,
// where Lex's page traded at the same close on continuous calendars and read
// the quote as a yield. The test holds the tolerance the workbench's
// `bun run reference-gap` enforces. A missing fixture file fails the test; a
// copy of the reference with one Sharpe ratio moved by 0.06 fails the
// comparison (the negative control).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crossCurveViolations, equityCurveViolations, weightingRuleViolations } from "../src/analyze/curve-checks.ts";
import { carryForward } from "../src/analyze/equity-curves.ts";
import { computePortfolioWeighting, OPTIMIZERS_PRESET, WEIGHTING_RULE_KEYS, type PortfolioWeighting } from "../src/allocate/weighting-rules.ts";
import { sha256 } from "../src/hash.ts";
import type { Point } from "../src/types.ts";

setDefaultTimeout(120_000);
const DIR = join(import.meta.dir, "fixtures/optimizers-page");
const GOLDEN = join(import.meta.dir, "fixtures/lex-equity-golden/outputs.json");
const FILES = ["prices.json", "reference-optimizers.json", "manifest.json"] as const;
const REFERENCE_SHA256 = "49995e9081ddbda834ee9e53552bfec80d9ffd2503f54b45d17731cfee1b7905";

/** The tolerance against Lex's file, since inception: Sharpe ratio, CAGR (a fraction), final value (a ratio less 1). */
const TOLERANCE = { sharpe: 0.05, cagr: 0.01, final_value: 0.06 } as const;
/** Lex's benchmark keys and the SDK's. */
const BENCHMARK = { cash: "stables_only", sp500: "sp500_hodl", eth: "eth_hodl" } as Record<string, string>;

interface ReferenceLine {
  key: string;
  money?: Record<string, number>;
  risk?: Record<string, number>;
  stats: { final_value: number; cagr: number; sharpe: number; start_date: string };
}
interface Reference {
  engines: ReferenceLine[];
  benchmarks: ReferenceLine[];
  covariance_1y: number[][];
  covariance_full: number[][];
}

const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(DIR, name)));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** Every gap past the tolerance, one sentence each: the six rules and three benchmarks, their shares and the covariances. */
function referenceGaps(out: PortfolioWeighting, ref: Reference): string[] {
  const gaps: string[] = [];
  for (const line of [...ref.engines, ...ref.benchmarks]) {
    const key = BENCHMARK[line.key] ?? line.key;
    const c = out.curves[key];
    if (c === undefined) {
      gaps.push(`no curve ${key} for the reference's ${line.key}`);
      continue;
    }
    const si = c.windows.since_inception;
    if (Math.abs(si.sharpe - line.stats.sharpe) > TOLERANCE.sharpe) gaps.push(`${key}: Sharpe ratio ${si.sharpe} against ${line.stats.sharpe}`);
    if (Math.abs(si.cagr - line.stats.cagr) > TOLERANCE.cagr) gaps.push(`${key}: CAGR ${si.cagr} against ${line.stats.cagr}`);
    if (Math.abs(si.final_value / line.stats.final_value - 1) > TOLERANCE.final_value) gaps.push(`${key}: final value ${si.final_value} against ${line.stats.final_value}`);
  }
  for (const line of ref.engines) {
    const e = out.figures.engines[line.key as (typeof WEIGHTING_RULE_KEYS)[number]];
    const tol = line.key === "markowitz" ? 0.03 : 1e-4;
    for (const part of ["money", "risk"] as const) {
      for (const [cls, want] of Object.entries(line[part] ?? {})) {
        if (!(Math.abs(e[part][cls]! - want) <= tol)) gaps.push(`${line.key}: ${part} share of ${cls} ${e[part][cls]} against ${want}`);
      }
    }
  }
  for (const k of ["covariance_1y", "covariance_full"] as const) {
    out.figures[k].forEach((row, i) => row.forEach((x, j) => {
      if (!(Math.abs(x - ref[k][i]![j]!) <= 1e-6)) gaps.push(`${k}[${i}][${j}] ${x} against ${ref[k][i]![j]}`);
    }));
  }
  return gaps;
}

describe("the optimizers page from the committed fixture", () => {
  test("every fixture file is present and matches the manifest", () => {
    for (const name of FILES) expect(() => read(name)).not.toThrow();
    const manifest = JSON.parse(text(read("manifest.json"))) as { files: Record<string, string> };
    expect(Object.keys(manifest.files).sort()).toEqual(["prices.json", "reference-optimizers.json"]);
    for (const [name, digest] of Object.entries(manifest.files)) expect(sha256(read(name))).toBe(digest);
    expect(manifest.files["reference-optimizers.json"]).toBe(REFERENCE_SHA256);
  });

  const prices = JSON.parse(text(read("prices.json"))) as { keys: Record<string, string>; series: Record<string, [string, number][]> };
  const series = (id: string): Point[] => prices.series[prices.keys[id]!]!.map(([date, value]) => ({ date, value }));
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as { dates: string[]; composite: { regime: (string | null)[] } };
  const served = new Map(golden.dates.map((d, i) => [d, golden.composite.regime[i]!]));
  const axis: string[] = [];
  for (let t = Date.parse(`${golden.dates[0]}T00:00:00Z`); t <= Date.parse(`${golden.dates.at(-1)}T00:00:00Z`); t += 86_400_000) axis.push(new Date(t).toISOString().slice(0, 10));
  const labels = axis.map((d) => served.get(d) ?? null);
  const cashQuotes = series("tbill3m");
  const P = OPTIMIZERS_PRESET;
  const out = computePortfolioWeighting(axis, labels, { btc: series("btc"), eth: series("eth"), sp500: series("sp500"), gld: series("gld") }, cashQuotes, {
    trading: P.trading, sampling: P.sampling, windows: P.windows, ...P.weightingRules,
  });
  const ref = JSON.parse(text(read("reference-optimizers.json"))) as Reference;

  test("each rule and benchmark stays within the tolerance of Lex's file, and so do the shares and covariances", () => {
    expect(out.figures.asof).toBe("2026-11-16");
    expect(out.figures.rebalance_date).toBe("2026-11-01");
    expect(Object.keys(out.curves)).toEqual([...WEIGHTING_RULE_KEYS, "stables_only", "sp500_hodl", "eth_hodl"]);
    expect(ref.engines.map((e) => e.key)).toEqual([...WEIGHTING_RULE_KEYS]);
    expect(referenceGaps(out, ref)).toEqual([]);
  });

  test("a copy of the reference with one Sharpe ratio moved by 0.06 fails", () => {
    const tampered = structuredClone(ref);
    // naive's Sharpe ratio sits 0.02 above Lex's: moving his up by 0.06 would close the gap, so it moves down
    tampered.engines[0]!.stats.sharpe -= 0.06;
    const gaps = referenceGaps(out, tampered);
    expect(gaps.length).toBe(1);
    expect(gaps[0]).toMatch(/^naive: Sharpe ratio/);
  });

  test("the reproduction passes all three output checks", () => {
    const { trailingMonths, commonPeriodMonths } = P.windows;
    const negativeQuoteDays = cashQuotes.filter((q) => q.value < 0).map((q) => q.date);
    const curveViolations = Object.entries(out.curves).flatMap(([n, c]) => equityCurveViolations(n, c, { trailingMonths, sampling: P.sampling, negativeQuoteDays }));
    expect(curveViolations).toEqual([]);
    expect(crossCurveViolations({ portfolio_weighting_rules: out.curves }, { lastAxisDay: axis.at(-1)!, trailingMonths, commonPeriodMonths })).toEqual([]);
    const label = carryForward(labels).at(-1)!;
    const { riskBudget, riskOnShare, markowitz } = P.weightingRules;
    expect(weightingRuleViolations(out.figures, { riskBudget, expectedReturn: markowitz.expectedReturn, riskOnShare, label })).toEqual([]);
  });
});
