// Unit coverage for the pure SVG sparkline generators (issue #381,
// docs/bot-analytics-ui-port-plan.md §4.3's own test-plan cell: "Unit tests
// on sparkline path output (fixed inputs → fixed `d`/points strings, `—`
// under 4 pts)"). These functions have zero DOM/CSSOM dependency by design
// (see the header comment in sparkline.js), so bun:test can import the
// production module directly and assert on the exact geometry strings the
// browser will render — no jsdom, no Playwright needed for the math itself
// (dash-styleguide.spec.ts covers the rendered-in-a-real-page half).
//
// GEOMETRY ONLY. Colors deliberately live in
// scripts/tests/unit/dash-color-css-lockstep.test.ts (issue #516): this file
// used to assert the rendered stroke/fill against the very `DASH_COLOR`
// constant that produced it, which cannot fail when those hex literals drift
// from the dash.css `.a3` tokens they are a hand-copy of. The trend-routing
// and color-value assertions now run there, anchored on the CSS instead.
//
// Runs in the required `unit.yml` job — `bun run test:unit`, and again in that
// same workflow's `bun run test` sweep over scripts/tests.
import { describe, expect, test } from "bun:test";
import { renderRowSparkline, renderSparkline } from "../../../frontend/public/assets/js/app/alpine/lib/sparkline.js";

function pointsOf(svg: string): string {
  return svg.match(/<polyline[^>]*\bpoints="([^"]+)"/)?.[1] ?? "";
}

function pathDOf(svg: string): string {
  return svg.match(/<path[^>]*\bd="([^"]+)"/)?.[1] ?? "";
}

describe("renderSparkline (default Sparkline, 80x24 stroke 1.5)", () => {
  test("rising series: fixed points string, no fill", () => {
    const svg = renderSparkline([1, 2, 3, 4]);
    expect(svg).toContain('viewBox="0 0 80 24"');
    expect(svg).toContain('width="80" height="24"');
    expect(pointsOf(svg)).toBe("0,22.5 26.67,15.5 53.33,8.5 80,1.5");
    expect(svg).toContain('stroke-width="1.5"');
    expect(svg).not.toContain("<path"); // polyline only, no area fill
  });

  test("constant series collapses to a flat mid-line (no divide-by-zero)", () => {
    const svg = renderSparkline([5, 5, 5, 5]);
    expect(pointsOf(svg)).toBe("0,22.5 26.67,22.5 53.33,22.5 80,22.5");
  });

  test("fewer than 2 finite points renders empty string, not a broken polyline", () => {
    expect(renderSparkline([1])).toBe("");
    expect(renderSparkline([])).toBe("");
    expect(renderSparkline([null, undefined, NaN])).toBe("");
  });

  test("large WalletProfile mode (800x120) + custom stroke/color are honored verbatim", () => {
    const svg = renderSparkline([1, 2], { width: 800, height: 120, stroke: 2, color: "#123456" });
    expect(svg).toContain('viewBox="0 0 800 120"');
    expect(pointsOf(svg)).toBe("0,118 800,2");
    expect(svg).toContain('stroke="#123456"');
    expect(svg).toContain('stroke-width="2"');
  });

  test("className option is forwarded onto the root <svg>", () => {
    const svg = renderSparkline([1, 2, 3], { className: "my-spark" });
    expect(svg).toContain('<svg class="my-spark"');
  });
});

describe("renderRowSparkline (table-cell RowSparkline, 80x22 stroke 1.25, area fill)", () => {
  test("under 4 finite points renders the literal em-dash, never SVG", () => {
    expect(renderRowSparkline([1, 2, 3])).toBe("—");
    expect(renderRowSparkline([])).toBe("—");
    expect(renderRowSparkline([1, null, undefined, NaN])).toBe("—");
  });

  // Area-path geometry and the 12%-opacity fill. WHICH color the trend routes
  // to (and whether that color still matches dash.css) is asserted in
  // scripts/tests/unit/dash-color-css-lockstep.test.ts.
  test("rising >0.5% end-to-end draws a closed area path under the line", () => {
    const svg = renderRowSparkline([1, 1, 1, 2]);
    expect(pathDOf(svg)).toBe("M0,20.75 L26.67,20.75 L53.33,20.75 L80,1.25 L80,22 L0,22 Z");
    expect(pointsOf(svg)).toBe("0,20.75 26.67,20.75 53.33,20.75 80,1.25");
    expect(svg).toContain('fill-opacity="0.12"');
    expect(svg).toContain('stroke-width="1.25"');
  });

  test("null/undefined/NaN gaps are skipped in the plotted line but still count toward the 4-point floor", () => {
    const svg = renderRowSparkline([null, 1, undefined, 2, NaN, 3, 4]);
    expect(pointsOf(svg)).toBe("13.33,20.75 40,14.25 66.67,7.75 80,1.25");
  });
});
