// The regime dial's drawing (lib/regime-dial.js): where its dot sits, and how a
// segment ends when the dot is near that end. The dot's dark halo cuts the arc,
// so a dot close to a segment's end used to strand a sliver of arc past it.
import { describe, expect, test } from "bun:test";
import { ordinalPct, regimeDialSvg, regimeDialTip, regimeDialValid } from "../../../frontend/public/assets/js/app/lib/regime-dial.js";
import { confirmedRegimes, readOnComposite } from "../../../frontend/public/assets/js/app/lib/regime-scale.js";

const CUTS = { riskOff: 0.33, riskOn: 0.67 };
const dial = (value: number, regime = "risk_off") => regimeDialSvg({ value, regime, ...CUTS });

function drawn(svg: string) {
  const segments = [...svg.matchAll(/d="M ([\d.]+) ([\d.]+) A [\d.]+ [\d.]+ 0 0 1 ([\d.]+) ([\d.]+)"/g)]
    .map((m) => ({ from: `${m[1]},${m[2]}`, to: `${m[3]},${m[4]}` }));
  const dot = svg.match(/cx="([\d.]+)" cy="([\d.]+)"/);
  return { segments, dot: dot ? `${dot[1]},${dot[2]}` : "" };
}

describe("regimeDialSvg", () => {
  test("a dot near a segment's end: the segment ends at the dot, so no sliver is left past it", () => {
    // 0.03: just inside risk-off's lower end.
    const low = drawn(dial(0.03));
    expect(low.segments[0]!.from).toBe(low.dot);
    // 0.97: just inside risk-on's upper end.
    const high = drawn(dial(0.97, "risk_on"));
    expect(high.segments[2]!.to).toBe(high.dot);
    // 0.31: just below risk-off's upper end, the cut.
    const cut = drawn(dial(0.31));
    expect(cut.segments[0]!.to).toBe(cut.dot);
  });

  test("a dot well inside a segment leaves every segment whole", () => {
    const whole = drawn(dial(0));
    const mid = drawn(dial(0.15));
    expect(mid.segments).toEqual(whole.segments);
    expect(mid.dot).not.toBe(mid.segments[0]!.from);
  });

  test("no reading, or cuts out of order, draws nothing", () => {
    expect(regimeDialSvg({ value: null, regime: "neutral", ...CUTS })).toBe("");
    expect(regimeDialValid({ value: 0.5, riskOff: 0.67, riskOn: 0.33 })).toBe(false);
  });
});

describe("regimeDialTip", () => {
  test("each state says where the composite has to sit; only today's says how the label moves", () => {
    const m = { value: 0.38, regime: "neutral", ...CUTS };
    expect(regimeDialTip(m, "risk_off").body).toContain("below 0.33");
    expect(regimeDialTip(m, "risk_off").now).toBeNull();
    expect(regimeDialTip(m, "neutral").body).toContain("between 0.33 and 0.67");
    expect(regimeDialTip(m, "neutral").now).toContain("Today, at 0.38");
    expect(regimeDialTip(m, "risk_on").body).toContain("above 0.67");
    // The composite is read on its own scale: no tip ranks it.
    expect(JSON.stringify(["risk_off", "neutral", "risk_on"].map((k) => regimeDialTip(m, k as "neutral")))).not.toContain("percentile");
  });

  test("ordinals read as ordinals", () => {
    expect([0.01, 0.02, 0.03, 0.11, 0.12, 0.13, 0.21, 0.33, 0.67].map(ordinalPct)).toEqual(["1st", "2nd", "3rd", "11th", "12th", "13th", "21st", "33rd", "67th"]);
  });
});

describe("the regime read on the composite", () => {
  test("a label is cut on the composite, and switches only after five readings in the new bucket", () => {
    // Four readings below the cut do not switch it; the fifth does.
    expect(confirmedRegimes([0.5, 0.3, 0.3, 0.3, 0.3, 0.5])).toEqual(["neutral", "neutral", "neutral", "neutral", "neutral", "neutral"]);
    expect(confirmedRegimes([0.5, 0.3, 0.3, 0.3, 0.3, 0.3]).at(-1)).toBe("risk_off");
    // A missing reading keeps the label and does not count toward the run.
    expect(confirmedRegimes([0.5, 0.7, 0.7, null, 0.7, 0.7, 0.7])).toEqual(["neutral", "neutral", "neutral", "neutral", "neutral", "neutral", "risk_on"]);
  });

  test("a composite of 0.38 that the engine ranks 4th in three years reads neutral", () => {
    const history = Array.from({ length: 8 }, (_, i) => ({ date: `2026-11-${10 + i}`, composite: 0.38 + i * 0.001, compositePercentile: 0.04, regime: "risk_off", macroIndex: 0.3, onchainIndex: 0.4 }));
    const out = readOnComposite({ latest: { ...history[7], bucketThresholds: null }, history });
    expect(out.latest.regime).toBe("neutral");
    expect(out.history.every((r: { regime: string }) => r.regime === "neutral")).toBe(true);
    expect(out.latest.macroRegime).toBe("risk_off");
    expect(out.latest.onchainRegime).toBe("neutral");
    // The reading itself is untouched.
    expect(out.latest.composite).toBe(history[7]!.composite);
    expect(out.latest.compositePercentile).toBe(0.04);
  });
});
