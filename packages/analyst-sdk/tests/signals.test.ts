// Sleeve signals (issue 1402): a signal name parses with one grammar
// (parseSignalName, which the rule-file validator shares), reads one as-of
// label as a 0..1 percentile with high meaning risk-on, and gives null when its
// data is missing, which the engine reads as neutral (no tilt).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  asofLabel,
  computeChannelDivergence,
  computeLateCycle,
  INDICATORS,
  NEUTRAL_SIGNAL,
  PANELS,
  parseRawHistory,
  parseSignalName,
  researchSignalValues,
  runRegime,
  SignalNameError,
  signalOrNeutral,
  signalPercentile,
  toHistory,
  TOP7,
  type Point,
  type SignalInputs,
} from "../src/index.ts";

setDefaultTimeout(120_000);

const raw8y = toHistory(parseRawHistory(readFileSync(join(import.meta.dir, "fixtures/allocate/raw-indicator-history-8y.csv"), "utf8")));
// A fixture decision: Monday 2024-03-04, as-of the Friday before.
const DECISION = { date: "2024-03-04", asof: "2024-03-01" };
const label = asofLabel(raw8y, DECISION);

describe("signalPercentile on a fixture date", () => {
  test("indicator:VIX is the VIX percentile with the registry sign applied once", () => {
    const run = runRegime(raw8y, { asof: DECISION.asof });
    const i = run.dateAxis.lastIndexOf(DECISION.asof);
    const rank = run.result.ranks.VIX![i]!;
    const sign = INDICATORS.find((x) => x.id === "VIX")!.sign;
    expect(sign).toBe(-1);
    expect(Number.isFinite(rank)).toBe(true);
    const expected = sign >= 0 ? rank : 1 - rank;
    expect(signalPercentile("indicator:VIX", label)).toBeCloseTo(expected, 12);
    expect(signalPercentile("indicator:VIX", label)).toBe(label.indicators.VIX!);
  });

  test("composite and the panels read the label's percentiles", () => {
    expect(signalPercentile("composite", label)).toBe(label.compositePercentile!);
    expect(signalPercentile("macro", label)).toBe(label.panels.macro!.percentile!);
    expect(signalPercentile("onchain", label)).toBe(label.panels.onchain!.percentile!);
    for (const v of [label.compositePercentile, label.panels.macro!.percentile, label.panels.onchain!.percentile]) {
      expect(v).not.toBeNull();
      expect(v!).toBeGreaterThanOrEqual(0);
      expect(v!).toBeLessThanOrEqual(1);
    }
  });

  test("mean(macro,onchain) is their mean; inverse(composite) is 1 - composite", () => {
    const m = (label.panels.macro!.percentile! + label.panels.onchain!.percentile!) / 2;
    expect(signalPercentile("mean(macro,onchain)", label)).toBeCloseTo(m, 15);
    expect(signalPercentile("mean( macro , onchain )", label)).toBeCloseTo(m, 15);
    expect(signalPercentile("inverse(composite)", label)).toBeCloseTo(1 - label.compositePercentile!, 15);
  });

  test("nested calls: the prototype's real_rates_dollar is a mean of three indicators", () => {
    const xs = ["DFII10", "DXY", "T5YIE"].map((k) => label.indicators[k]!);
    const name = "mean(indicator:DFII10,indicator:DXY,indicator:T5YIE)";
    expect(signalPercentile(name, label)).toBeCloseTo(xs.reduce((a, b) => a + b, 0) / 3, 15);
    expect(signalPercentile(`inverse(${name})`, label)).toBeCloseTo(1 - xs.reduce((a, b) => a + b, 0) / 3, 15);
    expect(signalPercentile("mean(inverse(macro),onchain)", label)).toBeCloseTo(
      (1 - label.panels.macro!.percentile! + label.panels.onchain!.percentile!) / 2,
      15,
    );
  });

  test("an unknown name throws", () => {
    expect(() => signalPercentile("counter_composite", label)).toThrow(SignalNameError);
    expect(() => signalPercentile("indicator:NOPE", label)).toThrow(SignalNameError);
    expect(() => signalPercentile("research:nope", label)).toThrow(SignalNameError);
    expect(() => signalPercentile("", label)).toThrow(SignalNameError);
  });
});

describe("missing data", () => {
  const empty: SignalInputs = {
    compositePercentile: null,
    panels: { macro: { label: null, percentile: null }, onchain: { label: null, percentile: 0.8 } },
    indicators: { ...label.indicators, VIX: null },
  };

  test("a missing indicator, panel, composite or research signal gives null", () => {
    expect(signalPercentile("indicator:VIX", empty)).toBeNull();
    expect(signalPercentile("composite", empty)).toBeNull();
    expect(signalPercentile("macro", empty)).toBeNull();
    expect(signalPercentile("inverse(indicator:VIX)", empty)).toBeNull();
    expect(signalPercentile("research:channel_divergence", empty)).toBeNull();
    expect(signalPercentile("research:late_cycle", { ...empty, research: { channel_divergence: 0.4 } })).toBeNull();
    const { VIX: _gone, ...noVix } = empty.indicators;
    expect(signalPercentile("indicator:VIX", { ...empty, indicators: noVix })).toBeNull();
  });

  test("mean averages the values it has, and is null only when all are missing", () => {
    expect(signalPercentile("mean(macro,onchain)", empty)).toBe(0.8);
    expect(signalPercentile("mean(macro,composite)", empty)).toBeNull();
  });

  test("the engine reads null as neutral: 0.5, a tilt of zero", () => {
    const p = signalPercentile("indicator:VIX", empty);
    expect(signalOrNeutral(p)).toBe(NEUTRAL_SIGNAL);
    expect(NEUTRAL_SIGNAL).toBe(0.5);
    // tilt = tanh(k * (p - 0.5) / scale): zero at the neutral percentile for any k and scale.
    expect(Math.tanh((3 * (signalOrNeutral(p) - 0.5)) / 0.17)).toBe(0);
    expect(signalOrNeutral(0.9)).toBe(0.9);
  });

  test("no number on the as-of label is NaN, so no signal returns NaN", () => {
    for (const ind of INDICATORS) {
      const v = signalPercentile(`indicator:${ind.id}`, label);
      expect(v === null || (Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
    }
  });
});

describe("parseSignalName", () => {
  test("throws on indicator:NOPE, mean() and inverse(a,b)", () => {
    expect(() => parseSignalName("indicator:NOPE")).toThrow(SignalNameError);
    expect(() => parseSignalName("mean()")).toThrow(SignalNameError);
    expect(() => parseSignalName("inverse(macro,onchain)")).toThrow(SignalNameError);
    expect(() => parseSignalName("inverse(a,b)")).toThrow(SignalNameError);
  });

  test("throws on other malformed names", () => {
    for (const bad of ["mean(macro)", "mean(macro,)", "inverse()", "mean(macro,onchain", "mean(macro,(onchain))", "factor", "indicator:", "Composite", "median(macro,onchain)"]) {
      expect(() => parseSignalName(bad)).toThrow(SignalNameError);
    }
  });

  test("accepts every indicator:<ID> in INDICATORS", () => {
    // The issue says 27; the registry holds 26 today. Every id it holds parses, whatever the count.
    expect(INDICATORS.length).toBeGreaterThan(0);
    for (const ind of INDICATORS) {
      expect(parseSignalName(`indicator:${ind.id}`)).toEqual({ kind: "indicator", id: ind.id });
    }
  });

  test("accepts composite, every panel, both research signals, mean and inverse", () => {
    expect(parseSignalName("composite")).toEqual({ kind: "composite" });
    for (const p of PANELS) expect(parseSignalName(p)).toEqual({ kind: "panel", panel: p });
    expect(parseSignalName("research:channel_divergence")).toEqual({ kind: "research", id: "channel_divergence" });
    expect(parseSignalName("research:late_cycle")).toEqual({ kind: "research", id: "late_cycle" });
    expect(parseSignalName("inverse(mean(macro,indicator:VIX))")).toEqual({
      kind: "inverse",
      of: { kind: "mean", of: [{ kind: "panel", panel: "macro" }, { kind: "indicator", id: "VIX" }] },
    });
  });

  test("a parsed signal reads the same as its name", () => {
    const sig = parseSignalName("mean(composite,inverse(indicator:HY_OAS))");
    expect(signalPercentile(sig, label)).toBe(signalPercentile("mean(composite,inverse(indicator:HY_OAS))", label));
  });
});

describe("research signals through research-signals.ts", () => {
  // Deterministic synthetic daily series: a trend with a slow wave, per start date.
  function daily(from: string, to: string, f: (i: number) => number): Point[] {
    const out: Point[] = [];
    for (let t = Date.parse(`${from}T00:00:00Z`), i = 0; t <= Date.parse(`${to}T00:00:00Z`); t += 864e5, i++) {
      out.push({ date: new Date(t).toISOString().slice(0, 10), value: f(i) });
    }
    return out;
  }
  const monthly = (pts: Point[]) => pts.filter((p) => p.date.endsWith("-01"));

  test("channel_divergence is the CHANNEL gauge; late_cycle is 1 - the mean late-cycle gauge", () => {
    const asof = "2020-06-30";
    const channel = computeChannelDivergence(
      {
        btc: daily("2018-01-01", asof, (i) => 10000 + 30 * i + 2000 * Math.sin(i / 40)),
        qqq: daily("2018-01-01", asof, (i) => 150 + 0.1 * i + 10 * Math.sin(i / 55)),
        spy: daily("2018-01-01", asof, (i) => 270 + 0.08 * i + 8 * Math.sin(i / 70)),
        stables: daily("2018-01-01", asof, (i) => 2e9 + 5e6 * i + 1e8 * Math.sin(i / 30)),
      },
      asof,
    );
    const spy = daily("2010-01-01", asof, (i) => 110 + 0.05 * i + 6 * Math.sin(i / 90));
    const late = computeLateCycle(
      {
        spy,
        rsp: daily("2010-01-01", asof, (i) => 40 + 0.015 * i + 2 * Math.sin(i / 80)),
        top7: TOP7.map((_, k) => daily("2010-01-01", asof, (i) => 50 + 0.03 * i * (k + 1) + 5 * Math.sin(i / (60 + k)))),
        mna: monthly(daily("2010-01-01", asof, (i) => 30 + 10 * Math.sin(i / 200))),
        margin: monthly(daily("2010-01-01", asof, (i) => 3e5 + 100 * i)).filter((_, k) => k % 3 === 0),
        conf: monthly(daily("2010-01-01", asof, (i) => 80 + 10 * Math.sin(i / 300))),
      },
      asof,
    );
    const r = researchSignalValues(channel, late);
    const ch = channel.gauges.find((g) => g.id === "CHANNEL")!.percentile;
    expect(ch).not.toBeNull();
    expect(r.channel_divergence).toBe(ch);
    const lc = late.gauges.map((g) => g.percentile).filter((v): v is number => v !== null);
    expect(lc.length).toBe(5);
    expect(r.late_cycle!).toBeCloseTo(1 - lc.reduce((a, b) => a + b, 0) / lc.length, 15);

    const inputs: SignalInputs = { ...label, research: r };
    expect(signalPercentile("research:channel_divergence", inputs)).toBe(r.channel_divergence);
    expect(signalPercentile("research:late_cycle", inputs)).toBe(r.late_cycle);
    expect(signalPercentile("inverse(research:late_cycle)", inputs)).toBeCloseTo(1 - r.late_cycle!, 15);
    expect(signalPercentile("mean(composite,research:channel_divergence)", inputs)).toBeCloseTo(
      (label.compositePercentile! + r.channel_divergence!) / 2,
      15,
    );
  });

  test("issue 1514: BTC and QQQ collected from 2016 change neither research payload: rows before the 2018 axis are never read", () => {
    const asof = "2020-06-30";
    // QQQ trades on weekdays only, so the 2018 fixture has no 2018-01-01 row:
    // a 2017-12-29 close must not forward-fill into the axis's first day.
    const weekdays = (pts: Point[]) => pts.filter((p) => ![0, 6].includes(new Date(`${p.date}T00:00:00Z`).getUTCDay()) && p.date !== "2018-01-01");
    const btcAll = daily("2016-01-01", asof, (i) => 400 + 30 * i + 2000 * Math.sin(i / 40));
    const qqqAll = weekdays(daily("2016-01-01", asof, (i) => 100 + 0.1 * i + 10 * Math.sin(i / 55)));
    const from2018 = (pts: Point[]) => pts.filter((p) => p.date >= "2018-01-01");
    const rest = {
      spy: daily("2010-01-01", asof, (i) => 110 + 0.05 * i + 6 * Math.sin(i / 90)),
      stables: daily("2018-01-01", asof, (i) => 2e9 + 5e6 * i + 1e8 * Math.sin(i / 30)),
    };
    const lateInputs = {
      spy: rest.spy,
      rsp: daily("2010-01-01", asof, (i) => 40 + 0.015 * i + 2 * Math.sin(i / 80)),
      top7: TOP7.map((_, k) => daily("2010-01-01", asof, (i) => 50 + 0.03 * i * (k + 1) + 5 * Math.sin(i / (60 + k)))),
      mna: monthly(daily("2010-01-01", asof, (i) => 30 + 10 * Math.sin(i / 200))),
      margin: monthly(daily("2010-01-01", asof, (i) => 3e5 + 100 * i)).filter((_, k) => k % 3 === 0),
      conf: monthly(daily("2010-01-01", asof, (i) => 80 + 10 * Math.sin(i / 300))),
    };
    const short = { ...rest, btc: from2018(btcAll), qqq: from2018(qqqAll) };
    const long = { ...rest, btc: btcAll, qqq: qqqAll };
    expect(long.btc[0]!.date).toBe("2016-01-01");
    expect(short.qqq[0]!.date).toBe("2018-01-02");
    const channel = JSON.stringify(computeChannelDivergence(short, asof));
    expect(channel).toContain("CHANNEL");
    expect(JSON.stringify(computeChannelDivergence(long, asof))).toBe(channel);
    // The late-cycle signal shares the research run's inputs and reads neither series.
    expect(JSON.stringify(computeLateCycle({ ...lateInputs, ...({ btc: long.btc, qqq: long.qqq } as object) }, asof))).toBe(
      JSON.stringify(computeLateCycle({ ...lateInputs, ...({ btc: short.btc, qqq: short.qqq } as object) }, asof)),
    );
  });

  test("a missing payload or gauge reading gives null", () => {
    expect(researchSignalValues()).toEqual({ channel_divergence: null, late_cycle: null });
    expect(
      researchSignalValues(
        { gauges: [{ id: "CHANNEL", name: "", value: null, percentile: null, read: "no reading" }] },
        { gauges: [{ id: "MNA", name: "", value: null, percentile: null, read: "no reading" }] },
      ),
    ).toEqual({ channel_divergence: null, late_cycle: null });
  });
});
