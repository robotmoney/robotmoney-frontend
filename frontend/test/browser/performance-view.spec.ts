// Render test for the LIVE /performance page (issue #84). The walletPerfView
// factory used to bake a frozen 99-day per-asset series inline in
// alpine/views.js; it now derives the eight stacked series + the Historical Data
// table from GET /api/dashboards/wallet-balances (holdings[] = fixed
// group/colour order, history[] = continuous sparse byAsset per day).
//
// Same harness as allocation-view.spec.ts: the SPA + view HTML are served by the
// backend at baseURL, vendor CDN scripts are fulfilled from node_modules, and the
// wallet-balances endpoint is stubbed inline (no live prop-wallet capture — the
// addresses are owner data). Asserts: the table's series order matches the
// endpoint holdings[] order, the rows/totals come from history[], and the baked
// series literal no longer survives in the served view.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { navigate } from "./navigation.ts";

const vendorScripts = {
  "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js":
    "node_modules/alpinejs/dist/cdn.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js":
    "node_modules/chart.js/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/p5@1.11.2/lib/p5.min.js":
    "node_modules/p5/lib/p5.min.js",
};

// The eight fixed series, in Stable→Protocol→Agent→Stocks group/colour order.
const SERIES: { symbol: string; color: string }[] = [
  { symbol: "USDC", color: "#10b981" },
  { symbol: "ZYFAI-SS1", color: "#10b981" },
  { symbol: "GIZA-SS1", color: "#10b981" },
  { symbol: "WETH", color: "#f59e0b" },
  { symbol: "ETH", color: "#f59e0b" },
  { symbol: "ROBOTMONEY", color: "#3b82f6" },
  { symbol: "BNKR", color: "#3b82f6" },
  { symbol: "SP500", color: "#8b5cf6" },
];

// Six PERSISTED days out of a genuine ~97-day span (2026-03-19 → 2026-06-24),
// deliberately gapped — issue #614 AC6: this fixture used to be labelled "six
// days of CONTINUOUS history" while jumping across that same hole, which
// would have passed unchanged against production's real 40-day gap. It is the
// fixture the AC5 gap-rendering assertions below reuse for exactly that
// reason: a real multi-week gap, not a synthetic one-off.
// Rows carry the endpoint's real `provenance`/`historyProvenance` shape even
// though the UI no longer renders a seed-share disclosure from it.
const HISTORY = [
  { date: "2026-03-18", byAsset: { WETH: 21519, ROBOTMONEY: 51300, BNKR: 12 }, totalUsd: 72831, provenance: "seed" },
  { date: "2026-03-19", byAsset: { WETH: 20841, ROBOTMONEY: 45207, BNKR: 12 }, totalUsd: 66060, provenance: "seed" },
  { date: "2026-06-24", byAsset: { USDC: 8995, WETH: 25682, ETH: 83, ROBOTMONEY: 36143, BNKR: 11, SP500: 4669, "ZYFAI-SS1": 4537 }, totalUsd: 80120, provenance: "seed" },
  { date: "2026-06-25", byAsset: { USDC: 9042, WETH: 24916, ETH: 81, ROBOTMONEY: 31831, BNKR: 10, SP500: 4683, "ZYFAI-SS1": 4538 }, totalUsd: 75101, provenance: "seed" },
  { date: "2026-06-26", byAsset: { USDC: 9052, WETH: 24194, ETH: 78, ROBOTMONEY: 30652, BNKR: 9, SP500: 4656, "ZYFAI-SS1": 4538 }, totalUsd: 73180, provenance: "live" },
  { date: "2026-06-27", byAsset: { USDC: 9100, WETH: 24000, ETH: 80, ROBOTMONEY: 30000, BNKR: 9, SP500: 4660, "ZYFAI-SS1": 4539 }, totalUsd: 72388, provenance: "backfilled" },
];

function walletStub() {
  return {
    asOf: "2026-07-07T20:12:13.482Z",
    totalUsd: HISTORY[HISTORY.length - 1]!.totalUsd,
    source: "stub",
    priceSource: "stub",
    holdings: SERIES.map((s) => ({ symbol: s.symbol, chain: "base", group: "Stable", color: s.color, amount: 1, priceUsd: 1, valueUsd: 1, priceSource: "pinned", provenance: "stub" })),
    history: HISTORY,
    historyProvenance: { live: 1, stub: 0, stale: 0, seed: 4, backfilled: 1 },
  };
}

function fmtUsd(v: number): string {
  return "$" + Number(v).toLocaleString("en-US");
}

async function stubEnvironment(page: Page) {
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({ path: join(process.cwd(), file), contentType: "application/javascript" }));
  }
  await page.route("**/api/dashboards/wallet-balances", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(walletStub()) }));
}

test("performance view draws the eight stacked series + Historical Data table from the wallet-balances history[] (issue #84)", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/performance");

  // Both stacked charts mount their canvases.
  await expect(page.locator('canvas[x-ref="aum"]')).toBeVisible();
  await expect(page.locator('canvas[x-ref="alloc"]')).toBeVisible();

  // Table column headers = Date + the eight fixed series (endpoint holdings[]
  // order: Stable→Protocol→Agent→Stocks) + Total AUM.
  const headers = page.locator("table.a2-table thead th");
  await expect(headers).toHaveText(["Date", ...SERIES.map((s) => s.symbol), "Total AUM"]);

  // Collapsed = last 5 days.
  const rows = page.locator("table.a2-table tbody tr");
  await expect(rows).toHaveCount(5);

  // The latest row's date + Total AUM come straight from history[].
  const latest = HISTORY[HISTORY.length - 1]!;
  const lastRow = rows.last();
  await expect(lastRow.locator("td.a2-sticky")).toHaveText("Jun 27");
  await expect(lastRow.locator("td.a2-total")).toHaveText(fmtUsd(latest.totalUsd));

  // Per-symbol cells reflect the sparse byAsset map: a held symbol shows its
  // USD value; an absent symbol renders the em-dash.
  const held = SERIES.findIndex((s) => s.symbol === "WETH");
  await expect(lastRow.locator("td.a2-r").nth(held)).toContainText(fmtUsd(latest.byAsset.WETH!));

  // "Show All" expands to every day the endpoint returned.
  await page.locator(".a2-table__toggle").click();
  await expect(page.locator("table.a2-table tbody tr")).toHaveCount(HISTORY.length);
  await expect(page.locator("table.a2-table tbody tr").first().locator("td.a2-sticky")).toHaveText("Mar 18");
});

// issue #614 AC5: the fixture above has a REAL ~97-day gap (2026-03-19 →
// 2026-06-24). Before this fix, chart-theme.js's monoAxis() never set a scale
// `type`, so Chart.js defaulted the x axis to "category" — spacing points by
// ARRAY INDEX. Charting `history` directly (one array slot per PERSISTED day)
// drew that 97-day hole as one ordinary-width step between two adjacent
// slots: a price-looking cliff, not six weeks of missing samples. This test
// inspects the live Chart.js instance and must FAIL against that
// implementation, where `chart.data.labels.length === HISTORY.length` (6).
test("AUM chart occupies proportional horizontal space across a real multi-week gap and renders it as a visible discontinuity, not an interpolated line (issue #614 AC5)", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/performance");
  await expect(page.locator('canvas[x-ref="aum"]')).toBeVisible();

  const expectedDenseDays = Math.round(
    (Date.parse(HISTORY[HISTORY.length - 1]!.date) - Date.parse(HISTORY[0]!.date)) / 86_400_000,
  ) + 1; // inclusive of both endpoints

  const chartState = await page.evaluate(() => {
    const canvas = document.querySelector('canvas[x-ref="aum"]') as HTMLCanvasElement;
    // Chart is a CDN global in the served page; the ambient type here only
    // declares getChart's return as `{ id: string }`, so widen to `any` for
    // the full runtime shape rather than fighting the ambient declaration.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chart = (window as any).Chart.getChart(canvas);
    return {
      labelCount: chart.data.labels.length,
      // A dataset's `spanGaps` config — must be explicitly false so Chart.js
      // never draws a line THROUGH a null (gap) point.
      spanGaps: chart.data.datasets.map((d: { spanGaps: unknown }) => d.spanGaps),
      // Every dataset's value on each label index, so the test can find the
      // gap region without hardcoding a dataset ordering assumption.
      datasetsData: chart.data.datasets.map((d: { data: (number | null)[] }) => d.data),
      labels: chart.data.labels as string[],
    };
  });

  // The core AC5 assertion: the axis is a DENSE calendar (one slot per real
  // calendar day across the full span), not a sparse array of only the
  // persisted points — this is what makes a 97-day hole occupy 97 slots of
  // horizontal space instead of collapsing to a single step.
  expect(chartState.labelCount).toBe(expectedDenseDays);
  expect(chartState.labelCount).toBeGreaterThan(HISTORY.length); // strictly denser than the sparse fixture

  // spanGaps must be false on every stacked series — a `true`/`undefined`
  // config would let Chart.js bridge the gap with an interpolated line.
  for (const sg of chartState.spanGaps) expect(sg).toBe(false);

  // At least one gap-region index (a synthesized day strictly between the two
  // persisted dates on either side of the hole) must be `null` in EVERY
  // dataset — a real discontinuity, never a fabricated/interpolated value.
  const midGapIndex = Math.floor(chartState.labelCount / 2);
  for (const data of chartState.datasetsData) {
    expect(data[midGapIndex]).toBeNull();
  }
});

// issue #614 AC5: "the UI discloses ... any unrecoverable window." The
// fixture has a genuine multi-week gap — this must render a visible
// disclosure, not silently present the series as gapless.
test("performance view discloses the unrecoverable gap window (issue #614 AC5)", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/performance");

  const seam = page.locator(".a2-seam");
  await expect(seam).toBeVisible();
  const text = await seam.textContent();
  expect(text).toMatch(/\d+ days? in this range could not be recovered/); // the ~91-day gap
});

test("the served performance view no longer bakes the frozen walletPerfView series (issue #84)", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  // walletPerfView lives in its own module since the per-view split of the old
  // monolithic views.js (review-maintainability finding 025, issue #129).
  const src = await page.evaluate(async () => (await fetch("/assets/js/app/alpine/views/wallet-perf.js")).text());
  // The retired baked arrays (a distinctive frozen totalAum literal + a labels
  // array) must be gone; the live endpoint wiring must be present.
  expect(src).not.toContain("totalAum: [72831");
  expect(src).not.toContain('labels: ["Mar 18","Mar 19"');
  expect(src).toContain("ROUTES.dashboards.walletBalances");
});
