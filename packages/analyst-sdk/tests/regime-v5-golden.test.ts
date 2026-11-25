// Issue 1753: methodology v5 reproduces the workbench golden of
// experiment-lex-equity byte for byte, from the committed fixture alone
// (tests/fixtures/lex-equity-golden/; no csv-backups access, no network).
// This is the full 3,124-day reproduction: the first serving run walks forward
// from its own inputs, then each of the other serving runs computes its own
// day, all through the SDK functions a platform v5 run calls
// (tests/support/lex-golden.ts). It fails, never skips, when a fixture file is
// missing.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REGIME_BACKTEST_RULES } from "../src/analyze/backtest.ts";
import { PANELS, V5_INPUT_IDS } from "../src/analyze/indicators.ts";
import {
  BACKTEST_FIELDS,
  FIXTURE_DIR,
  GOLDEN_MODEL,
  GOLDEN_SHA256,
  backtestOf,
  computeRun,
  goldenText,
  publishedBacktest,
  readFixture,
  readManifest,
  readSupplementaryInputs,
  reproduce,
  servingInputs,
  sha256,
} from "./support/lex-golden.ts";
import { keptRegimeRows } from "../src/analyze/kept-regime.ts";
import { canonicalStringify } from "../src/report/canonical.ts";
import type { RawIndicatorHistory } from "../src/types.ts";

setDefaultTimeout(600_000);

const fixture = readFixture();
const manifest = readManifest();
const supplementary = readSupplementaryInputs();
const golden = readFileSync(join(FIXTURE_DIR, "outputs.json"));
const goldenJson = JSON.parse(golden.toString("utf8")) as {
  model: string;
  dates: string[];
  indicators: Record<string, (number | null)[]>;
  backtest: Record<string, Record<string, Record<string, unknown>>>;
  daily_record: { run: string[]; data_copy: string[]; included: string[]; n: number[]; mean_1n: (number | null)[] };
};
const repro = reproduce(fixture, supplementary);
const text = goldenText(repro.rows, repro.runOf);

describe("the committed fixture is the golden's inputs", () => {
  test("the golden copy is the workbench golden: 1,577,040 bytes with the SHA-256 the manifest names", () => {
    expect(golden.length).toBe(1_577_040);
    expect(sha256(golden)).toBe(GOLDEN_SHA256);
    expect(manifest.outputs.sha256).toBe(GOLDEN_SHA256);
    expect(manifest.model).toBe(GOLDEN_MODEL);
  });

  test("each of the twelve supplementary files has the SHA-256 the manifest names", () => {
    expect(manifest.supplementary.length).toBe(12);
    for (const s of manifest.supplementary) {
      expect(sha256(readFileSync(join(FIXTURE_DIR, "supplementary", s.path))), s.path).toBe(s.sha256);
    }
  });

  test("selectPublications over the fixture's runs yields 57 serving runs, newest run 1163, ledger start 2026-09-21", () => {
    expect(fixture.backup).toBe(manifest.csv_backups.backup);
    expect(fixture.commit).toBe(manifest.csv_backups.commit);
    expect(fixture.series.length).toBe(29);
    expect(repro.serving.serving.length).toBe(57);
    expect(repro.serving.serving.length).toBe(manifest.build.serving_runs);
    expect(repro.serving.first.asof).toBe("2026-09-21");
    expect(repro.serving.first.asof).toBe(manifest.build.ledger_start);
    expect(repro.newest.run.id).toBe("1163");
    expect(repro.newest.run.id).toBe(manifest.build.newest_run);
    expect(Object.keys(fixture.inputs).sort()).toEqual(repro.serving.serving.map((r) => r.id).sort());
  });
});

describe("methodology v5 reproduces the golden byte for byte", () => {
  test("the produced text equals outputs.json, with SHA-256 03b9633d...", () => {
    expect(sha256(text)).toBe(GOLDEN_SHA256);
    expect(Buffer.from(text, "utf8").equals(golden)).toBe(true);
  });

  test("3,124 dates from 2018-04-28 to 2026-11-16, 30 indicator series, 3,068 first_run days and 56 on_day days", () => {
    const out = JSON.parse(text) as typeof goldenJson;
    expect(out.model).toBe(GOLDEN_MODEL);
    expect(out.dates.length).toBe(3124);
    expect(out.dates[0]).toBe("2018-04-28");
    expect(out.dates.at(-1)).toBe("2026-11-16");
    expect(Object.keys(out.indicators).length).toBe(30);
    expect(out.daily_record.data_copy.filter((c) => c === "first_run").length).toBe(3068);
    expect(out.daily_record.data_copy.filter((c) => c === "on_day").length).toBe(56);
    expect(out.daily_record.included).toEqual([...PANELS]);
    expect(out.daily_record.run.length).toBe(3124);
    expect(out.daily_record.mean_1n.length).toBe(3124);
  });

  test("flipping one input value changes the output hash (negative control)", () => {
    // The newest serving run again, on its own inputs with one value changed.
    const newest = repro.newest.run;
    let history = null as ReturnType<typeof servingInputs> extends Generator<infer T> ? T | null : never;
    for (const h of servingInputs(fixture, repro.serving.serving)) if (h.run.id === newest.id) history = h;
    const series = history!.history["T10Y2Y"]!;
    const last = series.at(-1)!;
    const flipped: RawIndicatorHistory = { ...history!.history, T10Y2Y: [...series.slice(0, -1), { date: last.date, value: -last.value - 1 }] };
    const rerun = (h: RawIndicatorHistory) => {
      const c = computeRun(newest, h, supplementary, repro.keptBeforeNewest);
      const rows = JSON.parse(canonicalStringify(keptRegimeRows(c.result, { source: newest.source, backtest: backtestOf(c) }))) as typeof repro.rows;
      return goldenText([...repro.rows.filter((r) => r.date < newest.asof), ...rows], repro.runOf);
    };
    // The same run on its unchanged inputs gives the golden again, so the change below is the flipped value's.
    expect(sha256(rerun(history!.history))).toBe(GOLDEN_SHA256);
    expect(sha256(rerun(flipped))).not.toBe(GOLDEN_SHA256);
  });
});

describe("the backtest block is REGIME_BACKTEST_RULES.v5 through computeBacktest", () => {
  test("the v5 row is the golden's rule set", () => {
    expect(REGIME_BACKTEST_RULES.v5).toEqual({ splitDate: "2024-01-31", lagSessions: 0, calendars: { eth: "continuous", sp500: "continuous" }, cashBasis: "yield", sharpeBasis: "returns" });
  });

  test("it equals the golden's backtest block byte for byte: all three markets, every line, each line's eleven fields", () => {
    const mine = JSON.parse(canonicalStringify(publishedBacktest(backtestOf(repro.newest, REGIME_BACKTEST_RULES.v5) as never))) as typeof goldenJson.backtest;
    expect(Object.keys(mine).sort()).toEqual(["eth", "mixed", "sp500"]);
    expect(Object.keys(goldenJson.backtest).sort()).toEqual(["eth", "mixed", "sp500"]);
    let lines = 0;
    for (const market of Object.keys(goldenJson.backtest)) {
      expect(Object.keys(mine[market]!).sort()).toEqual(Object.keys(goldenJson.backtest[market]!).sort());
      for (const [name, line] of Object.entries(goldenJson.backtest[market]!)) {
        expect(Object.keys(line).sort()).toEqual([...BACKTEST_FIELDS].sort());
        for (const field of BACKTEST_FIELDS) {
          expect(JSON.stringify(mine[market]![name]![field]), `${market}.${name}.${field}`).toBe(JSON.stringify(line[field]));
        }
        lines++;
      }
    }
    expect(lines).toBe(27);
    expect(JSON.stringify(mine)).toBe(JSON.stringify(goldenJson.backtest));
  });

  test("computing it with the v4 row instead changes the bytes (negative control)", () => {
    const v4 = goldenText(repro.rows, repro.runOf, backtestOf(repro.newest, REGIME_BACKTEST_RULES.v4));
    expect(sha256(v4)).not.toBe(GOLDEN_SHA256);
    // Only the backtest block moved: the same rows with the v5 block are the golden.
    expect(sha256(goldenText(repro.rows, repro.runOf, backtestOf(repro.newest, REGIME_BACKTEST_RULES.v5)))).toBe(GOLDEN_SHA256);
  });
});

describe("the reproduction reads the derived series from the golden's own files", () => {
  test("the VIX_TERM denominator is the supplementary Yahoo ^VIX file, under its own input id", () => {
    const vix = supplementary[V5_INPUT_IDS.vix]!;
    expect(vix.length).toBeGreaterThan(3000);
    expect(fixture.series).not.toContain(V5_INPUT_IDS.vix);
    expect(fixture.series).toContain("VIX");
  });
});
