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
import { mapEqSnapshotToDto } from "../../../backend/src/analytics/report/regime-eq-map.ts";
import { navigate } from "./navigation.ts";

const vendorScripts = {
  "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js":
    "node_modules/alpinejs/dist/cdn.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js":
    "node_modules/chart.js/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/p5@1.11.2/lib/p5.min.js":
    "node_modules/p5/lib/p5.min.js",
};

// The committed ground-truth regime snapshot (vendored eq variant, gzipped in the
// backend test fixtures — 3 panels incl. factor, 3 backtests, correlations, price
// extras, per-indicator sparklines). We run it through the SAME pure mapper the
// live endpoint uses so the stubbed { latest, history } DTO is byte-identical to
// production. This is exactly what the regimeView() dashboard renders.
function loadRegimeStub() {
  const gz = join(process.cwd(), "backend/tests/fixtures/regime/regime-eq-snapshot.json.gz");
  const snap = JSON.parse(gunzipSync(readFileSync(gz)).toString("utf8"));
  return mapEqSnapshotToDto(snap);
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
// The research heading (.rs__title) is declared with var(--font-display) —
// the condensed grotesque all headings share sitewide since PR #244's
// typography unification (it previously used the one-off var(--font-serif)
// italic treatment; that's been deliberately retired). getComputedStyle
// reports the declared font-family stack and text-transform regardless of
// whether the @font-face glyph data actually loaded, so this assertion is
// network-independent and safe to run hermetically in CI.
async function expectResearchTitleUsesDisplayFont(page: Page, selector = ".rs__title") {
  const style = await page.locator(selector).evaluate((el) => {
    const cs = getComputedStyle(el);
    return { fontFamily: cs.fontFamily, textTransform: cs.textTransform };
  });
  expect(style.fontFamily).toContain("Helvetica Neue Condensed");
  expect(style.textTransform).toBe("uppercase");
}

test("regime dashboard renders 3 panels, sparklines, correlations + backtests (enriched)", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/regime");

  const latest = loadRegimeStub().latest!;

  // Hero title + live-composite header.
  await expect(page.locator(".rv__title")).toContainText("Regime");
  await expect(page.locator(".rv__dash-title")).toContainText("Daily regime classification");

  // Summary cards: the top-line regime pill + one index card per panel (4 total
  // for the eq snapshot). The regime card shows the composite level in its foot.
  await expect(page.locator(".rv__cards .rv__card")).toHaveCount(4);
  await expect(page.locator(".rv__card--regime")).toContainText(latest.composite!.toFixed(2));

  // All three panel tables render (headers carry just the panel title now, matching
  // the source PanelTable), including the equity factor panel (eq snapshot only).
  const panels = page.locator(".rv__panel-card");
  await expect(panels).toHaveCount(3);
  await expect(page.locator(".rv__panel-card", { hasText: "Macro panel" })).toBeVisible();
  await expect(page.locator(".rv__panel-card", { hasText: "Equity factor panel" })).toBeVisible();
  // The macro panel index surfaces in its summary index card (value to 2dp).
  await expect(page.locator(".rv__cards")).toContainText(latest.macroIndex!.toFixed(2));

  // Per-indicator inline-SVG sparklines render (the enrichment).
  await expect(page.locator(".rv__spark-svg").first()).toBeVisible();
  expect(await page.locator(".rv__spark-svg").count()).toBeGreaterThan(10);

  // A named indicator from the vendored snapshot renders in the macro panel.
  await expect(page.locator(".rv__ind-name", { hasText: "yield curve" }).first()).toBeVisible();

  // Predictive-power table + all three backtest cards (eth / sp500 / mixed).
  await expect(page.locator(".rv__corr-card")).toHaveCount(1);
  await expect(page.locator(".rv__corr-card")).toContainText("Predictive power");
  await expect(page.locator(".rv__bt-card:visible")).toHaveCount(3);
  await expect(page.locator(".rv__bt-card", { hasText: "Backtest · ETH / cash" })).toBeVisible();

  // Charts instantiate: full-history canvas + one equity-curve canvas per backtest.
  expect(await page.locator("canvas").count()).toBeGreaterThanOrEqual(4);
});

// Regression guard for the dropped-`panels` bug: the live backend used to serve
// `panels: null` even though the Equity factor index was computed & present, so the
// /regime view fell back to only two panel cards (macro + on-chain) and silently
// hid the third. The fix emits `panels: ["macro","onchain","factor"]` on the asof
// row AND hardens panelsList() to append "factor" whenever factorIndex is present.
// This test forces the WORST case — a payload with `panels` nulled everywhere but a
// real factorIndex — and asserts all THREE panel index cards render, incl. the
// "Equity factor" label. (loadRegimeStub carries panels populated, so nulling it
// here specifically exercises the fallback path, not the happy path.)
function loadRegimeStubNullPanels() {
  const dto = loadRegimeStub();
  if (dto.latest) dto.latest.panels = null;
  for (const row of dto.history) row.panels = null;
  return dto;
}

test("regime view surfaces the Equity factor panel even when `panels` is null (dropped-field fallback)", async ({ page }) => {
  await stubEnvironment(page);
  // Override the regime route with the panels-nulled payload for THIS test only.
  await page.route("**/api/dashboards/regime-snapshots*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(loadRegimeStubNullPanels()) }));
  await page.goto("/");
  await navigate(page, "/regime");

  const latest = loadRegimeStubNullPanels().latest!;
  expect(latest.panels).toBeNull();
  expect(latest.factorIndex).not.toBeNull();

  // THREE panel index summary cards (macro + on-chain + equity factor) — plus the
  // top-line regime card = 4 total, exactly the happy-path count despite null panels.
  await expect(page.locator(".rv__cards .rv__card")).toHaveCount(4);
  const indexCards = page.locator(".rv__card:not(.rv__card--regime)");
  await expect(indexCards).toHaveCount(3);
  await expect(page.locator(".rv__card-eyebrow", { hasText: "Equity factor index" })).toBeVisible();

  // And all three per-panel tables render, including the equity factor panel.
  await expect(page.locator(".rv__panel-card")).toHaveCount(3);
  await expect(page.locator(".rv__panel-card", { hasText: "Equity factor panel" })).toBeVisible();
});

test("channel-divergence view renders the Stablecoin-vs-QQQ-flow gauge with value + read", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/research/channel-divergence");

  // The long-form restoration (#331/#333) retitled the page; "Channel
  // divergence" is now only the eyebrow/API title, not the on-page <h1>.
  await expect(page.locator(".rs__title")).toContainText("Is the macro–to–crypto channel breaking?");
  await expectResearchTitleUsesDisplayFont(page);
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

test("late-cycle view renders the static four-gauge readings table", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/research/late-cycle-signals");

  // late-cycle-signals was fully converted to static long-form prose (#333,
  // synced in #353): no researchView wiring, no live payload, so there is no
  // .rs__title/.rs__gauge at all anymore — only the ported stub__ markup that
  // demo-frontend-check.ts also asserts against (stub__title/stub__table/stub__series).
  await expect(page.locator(".stub__title")).toContainText("How late in the rally");
  await expectResearchTitleUsesDisplayFont(page, ".stub__title");
  await expect(page.locator(".rs__gauge")).toHaveCount(0);

  // The four-gauge readings table, ported verbatim from the published page.
  const rows = page.locator(".stub__table tbody tr");
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: "Concentration" }).locator(".stub__num")).toHaveText("53%");
  await expect(rows.filter({ hasText: "M&A activity" }).locator(".stub__num")).toHaveText("94%");
  await expect(rows.filter({ hasText: "Margin debt" }).locator(".stub__num")).toHaveText("+9.9%");
  await expect(rows.filter({ hasText: "Consumer conf." }).locator(".stub__num")).toHaveText("44.8");

  // And one stub__series write-up block per gauge (four numbered sections).
  await expect(page.locator(".stub__series")).toHaveCount(4);
  const concentration = page.locator(".stub__sec", { hasText: "Index concentration" });
  await expect(concentration.locator(".stub__read")).toContainText("late-cycle configuration");
});

// The loud-staleness surface: when the analytics pipeline stops refreshing in a
// deployment, the served snapshot freezes and the API reports staleness. The
// dashboard must warn the viewer LOUDLY rather than render the frozen charts as
// current (the reported bug). The later-registered route wins in Playwright, so
// these override the default fresh stub from stubEnvironment().
test("regime dashboard shows a loud staleness banner when the API reports stale data", async ({ page }) => {
  await stubEnvironment(page);
  const stale = { ...loadRegimeStub(), staleness: { asof: "2026-06-29", serverDate: "2026-07-14", ageDays: 15, stale: true, thresholdDays: 3 } };
  await page.route("**/api/dashboards/regime-snapshots*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(stale) }));
  await page.goto("/");
  await navigate(page, "/regime");

  const banner = page.locator(".rv__stale");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("15 days stale");
  await expect(banner).toContainText("2026-06-29");
  // The charts still render beneath the warning (data is shown, just flagged).
  await expect(page.locator(".rv__dash-title")).toBeVisible();
});

test("regime dashboard hides the staleness banner when data is fresh", async ({ page }) => {
  await stubEnvironment(page);
  const fresh = { ...loadRegimeStub(), staleness: { asof: "2026-07-14", serverDate: "2026-07-14", ageDays: 0, stale: false, thresholdDays: 3 } };
  await page.route("**/api/dashboards/regime-snapshots*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fresh) }));
  await page.goto("/");
  await navigate(page, "/regime");

  await expect(page.locator(".rv__dash-title")).toBeVisible();
  await expect(page.locator(".rv__stale")).toBeHidden();
});
