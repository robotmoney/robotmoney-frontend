// Render tests for the ENRICHED analytics views (/regime + the two research
// signals). Same harness pattern as spa.spec.ts: the SPA + view HTML are served by
// the backend at baseURL (BACKEND_URL), vendor CDN scripts are fulfilled from
// node_modules, and here we additionally STUB the dashboard API with the vendored
// regime-snapshot shape + the ported research payload shape so the assertions are
// deterministic and network-free. We verify the NEW enrichment actually reaches the
// DOM: macro/onchain panel indices, per-indicator panel WEIGHTS, and the new
// research gauges (Top-7 basket vs SPY / Stablecoin vs QQQ flow) with their
// values + read labels. Selectors/classes match the shipped views (rv__panel*, rs__*).
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const vendorScripts = {
  "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js":
    "node_modules/alpinejs/dist/cdn.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js":
    "node_modules/chart.js/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/p5@1.11.2/lib/p5.min.js":
    "node_modules/p5/lib/p5.min.js",
};

// The committed ground-truth regime snapshot (vendored, gzipped in the backend test
// fixtures). We map its snake_case shape to the /api/dashboards/regime-snapshots
// DTO ({ latest, history }) the regimeView() factory consumes.
function loadRegimeStub() {
  const gz = join(process.cwd(), "backend/tests/fixtures/regime/regime-snapshot.json.gz");
  const snap = JSON.parse(gunzipSync(readFileSync(gz)).toString("utf8"));
  const latest = {
    date: snap.asof,
    composite: snap.composite,
    compositePercentile: snap.composite_percentile,
    regime: snap.regime,
    macroRegime: snap.macro_regime,
    onchainRegime: snap.onchain_regime,
    macroIndex: snap.macro_index,
    onchainIndex: snap.onchain_index,
    macroPercentile: snap.macro_percentile,
    onchainPercentile: snap.onchain_percentile,
    version: "v3",
    // Rich per-indicator objects already carry id/name/panel/panel_weight/percentile/
    // signed_percentile — exactly what the view renders.
    indicators: snap.indicators,
  };
  const history = (snap.history ?? [])
    .map((h: any) => ({ date: h.date, composite: h.composite }))
    .slice(-180);
  return { latest, history };
}

// Ported research payload shape (analytics/analyze/research-signals.ts). The
// vendored research JSON predates the gauges, so we assert against the SHIPPED
// gauge contract with the two NEW gauges the enrichment added.
const CHANNEL_PAYLOAD = {
  asof: "2026-06-29",
  title: "Channel divergence",
  question: "Is the easy-money → crypto transmission channel breaking down?",
  gauges: [
    { id: "BTC_BETA", name: "BTC beta vs risk appetite", value: 0.412, percentile: 0.55, read: "softening" },
    { id: "BTC_QQQ_RATIO", name: "BTC/QQQ relative strength", value: 0.62, percentile: 0.71, read: "channel intact" },
    { id: "STABLES_QQQ_FLOW", name: "Stablecoin vs QQQ flow (90d)", value: 0.0137, percentile: 0.21, read: "breaking down" },
    { id: "CHANNEL", name: "Composite channel health", value: 0.49, percentile: 0.49, read: "softening" },
  ],
  series: {
    label: "BTC/QQQ ratio",
    points: [
      { date: "2026-06-27", value: 0.61 },
      { date: "2026-06-28", value: 0.62 },
      { date: "2026-06-29", value: 0.63 },
    ],
  },
  indicators: {
    btc_beta_vs_risk_appetite: [{ date: "2026-06-28", value: 0.41 }, { date: "2026-06-29", value: 0.412 }],
    btc_qqq_ratio_percentile: [{ date: "2026-06-28", value: 0.7 }, { date: "2026-06-29", value: 0.71 }],
    stables_vs_qqq_flow: [{ date: "2026-06-28", value: 0.012 }, { date: "2026-06-29", value: 0.0137 }],
  },
};

const LATECYCLE_PAYLOAD = {
  asof: "2026-06-29",
  title: "Late-cycle signals",
  question: "How late in the cycle is this rally?",
  gauges: [
    { id: "CONCENTRATION", name: "Index concentration (SPY/RSP)", value: 1.2841, percentile: 0.88, read: "saturated (late-cycle)" },
    { id: "TOP7_VS_SPY", name: "Top-7 basket vs SPY", value: 1.8342, percentile: 0.91, read: "saturated (late-cycle)" },
    { id: "MNA", name: "M&A activity (S-4 filings)", value: 42, percentile: 0.63, read: "elevated" },
    { id: "MARGIN", name: "Margin debt YoY", value: 0.1523, percentile: 0.74, read: "saturated (late-cycle)" },
    { id: "CONF", name: "Consumer confidence (UMich)", value: 61.7, percentile: 0.32, read: "benign" },
  ],
  series: {
    label: "Index concentration (SPY/RSP)",
    points: [
      { date: "2026-06-27", value: 1.27 },
      { date: "2026-06-28", value: 1.28 },
      { date: "2026-06-29", value: 1.2841 },
    ],
  },
  indicators: {
    concentration_top7_vs_spy: [{ date: "2026-06-28", value: 1.83 }, { date: "2026-06-29", value: 1.8342 }],
    mna_pct: [{ date: "2026-06-28", value: 0.62 }, { date: "2026-06-29", value: 0.63 }],
  },
};

async function stubEnvironment(page: Page) {
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({
      path: join(process.cwd(), file),
      contentType: "application/javascript",
    }));
  }
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

  await page.route("**/api/dashboards/regime-snapshots*", (route) => route.fulfill(json(loadRegimeStub())));
  await page.route("**/api/dashboards/research-signals/channel-divergence*", (route) =>
    route.fulfill(json({ signalKey: "channel-divergence", date: CHANNEL_PAYLOAD.asof, payload: CHANNEL_PAYLOAD })));
  await page.route("**/api/dashboards/research-signals/late-cycle-signals*", (route) =>
    route.fulfill(json({ signalKey: "late-cycle-signals", date: LATECYCLE_PAYLOAD.asof, payload: LATECYCLE_PAYLOAD })));
}

// SPA navigation via the history router (matches spa.spec.ts).
async function navigate(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState({}, "", p);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

test("regime view renders panel indices + per-indicator panel weights (enriched)", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/regime");

  const stub = loadRegimeStub();

  // Header as-of + composite card.
  await expect(page.locator(".rv__title")).toContainText("Regime");
  await expect(page.locator(".rv__card").first()).toContainText(`${Math.round(stub.latest.composite * 100)}%`);

  // Both panel sections render with their index/percentile meta.
  const panels = page.locator(".rv__panel");
  await expect(panels).toHaveCount(2);
  const macroMeta = page.locator(".rv__panel", { hasText: "Macro" }).locator(".rv__panel-meta");
  await expect(macroMeta).toContainText(`${Math.round(stub.latest.macroIndex * 100)}%`);
  const onchainMeta = page.locator(".rv__panel", { hasText: "On-chain" }).locator(".rv__panel-meta");
  await expect(onchainMeta).toContainText(`${Math.round(stub.latest.onchainIndex * 100)}%`);

  // Per-indicator panel WEIGHTS surface (the enrichment). Every indicator row shows
  // a "weight NN%" chip; at least one has a real (non-dash) weight.
  const weights = page.locator(".rv__ind-weight");
  await expect(weights.first()).toBeVisible();
  const weightTexts = await weights.allTextContents();
  expect(weightTexts.length).toBeGreaterThan(10);
  expect(weightTexts.every((t) => t.includes("weight"))).toBe(true);
  expect(weightTexts.some((t) => /weight \d+%/.test(t))).toBe(true);

  // A named indicator from the vendored snapshot renders in the macro panel.
  await expect(page.locator(".rv__ind-name", { hasText: "yield curve" }).first()).toBeVisible();
});

test("channel-divergence view renders the Stablecoin-vs-QQQ-flow gauge with value + read", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/research/channel-divergence");

  await expect(page.locator(".rs__title")).toContainText("Channel divergence");
  const gauges = page.locator(".rs__gauge");
  await expect(gauges).toHaveCount(4);

  const flow = page.locator(".rs__gauge", { hasText: "Stablecoin vs QQQ flow" });
  await expect(flow.locator(".rs__gauge-val")).toHaveText("0.0137");
  await expect(flow.locator(".rs__gauge-pct")).toContainText("21%");
  await expect(flow.locator(".read")).toHaveText("breaking down");
  await expect(flow.locator(".read")).toHaveClass(/read--warn/);

  // The richer indicator-series section renders one labelled canvas per series,
  // including the new stables_vs_qqq_flow series.
  await expect(page.locator('.rs__series-canvas canvas[data-series="stables_vs_qqq_flow"]')).toHaveCount(1);
});

test("late-cycle view renders the Top-7-vs-SPY gauge with value + read", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/research/late-cycle-signals");

  await expect(page.locator(".rs__title")).toContainText("Late-cycle");
  const gauges = page.locator(".rs__gauge");
  await expect(gauges).toHaveCount(5);

  const top7 = page.locator(".rs__gauge", { hasText: "Top-7 basket vs SPY" });
  await expect(top7.locator(".rs__gauge-val")).toHaveText("1.8342");
  await expect(top7.locator(".rs__gauge-pct")).toContainText("91%");
  await expect(top7.locator(".read")).toHaveText("saturated (late-cycle)");
});
