// The regime dial's drawing (lib/regime-dial.js): where its dot sits, and how a
// segment ends when the dot is near that end. The dot's dark halo cuts the arc,
// so a dot close to a segment's end used to strand a sliver of arc past it.
import { describe, expect, test } from "bun:test";
import { ordinalPct, regimeDialSvg, regimeDialTip, regimeDialValid } from "../../../frontend/public/assets/js/app/lib/regime-dial.js";

const CUTS = { riskOff: 0.33, riskOn: 0.67 };
const dial = (percentile: number, regime = "risk_off") => regimeDialSvg({ percentile, regime, ...CUTS });

function drawn(svg: string) {
  const segments = [...svg.matchAll(/d="M ([\d.]+) ([\d.]+) A [\d.]+ [\d.]+ 0 0 1 ([\d.]+) ([\d.]+)"/g)]
    .map((m) => ({ from: `${m[1]},${m[2]}`, to: `${m[3]},${m[4]}` }));
  const dot = svg.match(/cx="([\d.]+)" cy="([\d.]+)"/);
  return { segments, dot: dot ? `${dot[1]},${dot[2]}` : "" };
}

describe("regimeDialSvg", () => {
  test("a dot near a segment's end: the segment ends at the dot, so no sliver is left past it", () => {
    // The 3rd percentile: just inside risk-off's lower end.
    const low = drawn(dial(0.03));
    expect(low.segments[0]!.from).toBe(low.dot);
    // The 97th: just inside risk-on's upper end.
    const high = drawn(dial(0.97, "risk_on"));
    expect(high.segments[2]!.to).toBe(high.dot);
    // The 31st: just below risk-off's upper end, the cut.
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
    expect(regimeDialSvg({ percentile: null, regime: "neutral", ...CUTS })).toBe("");
    expect(regimeDialValid({ percentile: 0.5, riskOff: 0.67, riskOn: 0.33 })).toBe(false);
  });
});

describe("regimeDialTip", () => {
  test("each state says where the composite has to sit; only today's says how the label moves", () => {
    const m = { percentile: 0.03, regime: "risk_off", ...CUTS };
    expect(regimeDialTip(m, "risk_off").body).toContain("below the 33rd percentile");
    expect(regimeDialTip(m, "risk_off").now).toContain("Today, at the 3rd");
    expect(regimeDialTip(m, "neutral").body).toContain("between the 33rd and the 67th percentile");
    expect(regimeDialTip(m, "neutral").now).toBeNull();
    expect(regimeDialTip(m, "risk_on").body).toContain("above the 67th percentile");
  });

  test("ordinals read as ordinals", () => {
    expect([0.01, 0.02, 0.03, 0.11, 0.12, 0.13, 0.21, 0.33, 0.67].map(ordinalPct)).toEqual(["1st", "2nd", "3rd", "11th", "12th", "13th", "21st", "33rd", "67th"]);
  });
});
