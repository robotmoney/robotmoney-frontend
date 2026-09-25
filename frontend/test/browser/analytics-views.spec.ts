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
  await expect(page.locator("#daily-regime-classification")).toContainText("Daily regime classification");

  // Summary cards: the top-line regime pill + one index card per panel (4 total
  // for the eq snapshot). The regime card shows the composite level in its foot.
  // Today: the top-line regime with the composite under it, and one index row
  // per panel (3 for the eq snapshot).
  await expect(page.locator("#composite .rv__today-v")).toBeVisible();
  await expect(page.locator("#composite")).toContainText(latest.composite!.toFixed(2));
  await expect(page.locator("#composite .rv__idx-row")).toHaveCount(3);

  // All three panel tables render (headers carry just the panel title now, matching
  // the source PanelTable), including the equity factor panel (eq snapshot only).
  // One at a time, behind tabs: macro first, the others one click away.
  const panels = page.locator(".rv__panel");
  await expect(panels).toHaveCount(3);
  await expect(page.locator(".rv__panel", { hasText: "Macro panel" })).toBeVisible();
  await expect(page.locator(".rv__panel", { hasText: "Equity factor panel" })).toBeHidden();
  await page.getByRole("tab", { name: /Equity factor/ }).click();
  await expect(page.locator(".rv__panel", { hasText: "Equity factor panel" })).toBeVisible();
  await expect(page.locator(".rv__panel", { hasText: "Macro panel" })).toBeHidden();
  await page.getByRole("tab", { name: /Macro/ }).click();
  // The macro panel index surfaces in its summary index card (value to 2dp).
  await expect(page.locator("#composite")).toContainText(latest.macroIndex!.toFixed(2));

  // Per-indicator inline-SVG sparklines render (the enrichment).
  await expect(page.locator(".rv__spark-svg").first()).toBeVisible();
  expect(await page.locator(".rv__spark-svg").count()).toBeGreaterThan(10);

  // A named indicator from the vendored snapshot renders in the macro panel.
  await expect(page.locator(".rv__ind-name", { hasText: "yield curve" }).first()).toBeVisible();

  // Predictive-power table + all three backtest cards (eth / sp500 / mixed).
  await expect(page.locator("#predictive-power")).toHaveCount(1);
  await expect(page.locator("#predictive-power")).toContainText("Predictive power");
  // All three markets are in the page, one on show behind the switch.
  await expect(page.locator(".rv__market")).toHaveCount(3);
  await expect(page.locator(".rv__market:visible")).toHaveCount(1);
  await expect(page.locator(".rv__market", { hasText: "Backtest · ETH / cash" })).toBeVisible();
  await page.getByRole("button", { name: "S&P 500 / cash" }).click();
  await expect(page.locator(".rv__market", { hasText: "Backtest · SP500 / cash" })).toBeVisible();

  // The charts draw on the site's own chart: the history and the market on show.
  await expect(page.locator(".rr-area__plot:visible")).toHaveCount(2);
  expect(await page.locator("#history-sec .rr-area__svg polyline").count()).toBeGreaterThanOrEqual(4);
});

// The panel row's three ways out to more detail. Each one was inert before:
// the glossary link hung off an 11px icon rather than the name, the row tooltip
// recited the sign convention instead of saying what the indicator was, and the
// source label's `x-if="ind.source_url"` branch never fired because the payload
// did not carry the field. The last two are fixed at the source — the snapshot
// now serialises `description` and `source_url` — so this asserts against the
// vendored snapshot, which has carried both all along.
test("regime panel rows link out to the glossary, the prose and the upstream source", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/regime");

  const row = page.locator(".rv__panel", { hasText: "Macro panel" })
    .locator("tbody tr", { hasText: "10y–2y yield curve" });

  // The NAME is the link, and it lands on that indicator's own section.
  const name = row.locator("a.rv__ind-name");
  await expect(name).toHaveAttribute("href", "/regime/indicators#T10Y2Y");
  await expect(name).toContainText("10y–2y yield curve");
  // One link over name + glyph, not two to the same place.
  await expect(row.locator(".rv__ind-tipwrap a")).toHaveCount(1);

  // The tooltip leads with what the indicator IS, then its orientation.
  const tip = row.locator(".rv__tip");
  await expect(tip).toContainText("10-year and 2-year US Treasury yields");
  await expect(tip).toContainText("Sign +1");

  // The provenance line's source label is a real link to the upstream series.
  await expect(row.locator(".rv__ind-src a")).toHaveAttribute(
    "href", "https://fred.stlouisfed.org/series/T10Y2Y");
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
  await expect(page.locator("#composite .rv__today-v")).toBeVisible();
  const indexCards = page.locator("#composite .rv__idx-row");
  await expect(indexCards).toHaveCount(3);
  await expect(page.locator(".rv__idx-l", { hasText: "Equity factor index" })).toBeVisible();

  // And all three per-panel tables render, including the equity factor panel.
  await expect(page.locator(".rv__panel")).toHaveCount(3);
  await page.getByRole("tab", { name: /Equity factor/ }).click();
  await expect(page.locator(".rv__panel", { hasText: "Equity factor panel" })).toBeVisible();
});

// issue #624: regime.js shared wallet-perf.js's pre-fix category-axis defect —
// charting `history` directly (one array slot per PERSISTED date) spaces points
// by ARRAY INDEX, so a gap between two adjacent persisted rows would draw
// compressed to one ordinary-width step instead of a real time gap. The
// analytics pipeline currently always recomputes + upserts the FULL history
// every run, so this fixture can't come from production data — it's a
// synthetic 30-day excision from the vendored daily snapshot, exactly like
// performance-view.spec.ts's AC5 gap fixture, to exercise the chart's own
// dense-axis behaviour independent of that backend guarantee.
const GAP_START_INDEX = 1500;
const GAP_DAYS = 30;
function loadRegimeStubWithGap() {
  const dto = loadRegimeStub();
  dto.history.splice(GAP_START_INDEX, GAP_DAYS);
  return dto;
}

test("regime history chart occupies proportional horizontal space across a gap and renders it as a visible discontinuity (issue #624)", async ({ page }) => {
  await stubEnvironment(page);
  const dto = loadRegimeStubWithGap();
  await page.route("**/api/dashboards/regime-snapshots*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dto) }));
  await page.goto("/");
  await navigate(page, "/regime");
  await expect(page.locator("#history-sec .rr-area__plot")).toBeVisible();
  // The whole history, where the hole is. It is past a year, so the lines
  // take one reading a week; the axis is still one unit per calendar day.
  await page.locator("#history-sec .rm-chip", { hasText: /^All$/ }).click();

  const expectedDenseDays = Math.round(
    (Date.parse(dto.history[dto.history.length - 1]!.date) - Date.parse(dto.history[0]!.date)) / 86_400_000,
  ) + 1; // inclusive of both endpoints

  const state = await page.evaluate(() => {
    const fig = document.querySelector("#history-sec figure") as HTMLElement;
    const lines = [...fig.querySelectorAll(".rr-area__svg polyline")].map((l) => ({
      token: l.getAttribute("data-token"),
      xs: (l.getAttribute("points") || "").trim().split(/\s+/).map((pt) => Number(pt.split(",")[0])),
    }));
    return { days: Number(fig.dataset.days), lines };
  });

  // The core assertion: the axis is a DENSE calendar (one unit per real
  // calendar day across the full span), not a sparse array of only the
  // persisted points, so the 30-day hole takes 30 days of horizontal space
  // instead of collapsing to a single step.
  expect(state.days).toBe(expectedDenseDays);
  expect(state.days).toBeGreaterThan(dto.history.length);

  // Every line breaks at the hole: more than one run per series, and no drawn
  // point strictly inside it (a real discontinuity, never an interpolated
  // value). The vendored snapshot's daily history is contiguous before the
  // excision, so the day index equals the original array index up through
  // GAP_START_INDEX.
  const toDay = (x: number) => (x / 1000) * (state.days - 1);
  for (const token of ["composite", "macro", "onchain"]) {
    const runs = state.lines.filter((l) => l.token === token);
    expect(runs.length, token).toBeGreaterThan(1);
    for (const r of runs) for (const x of r.xs) {
      const d = toDay(x);
      expect(d > GAP_START_INDEX + 0.5 && d < GAP_START_INDEX + GAP_DAYS - 1.5, `${token} point at day ${d}`).toBe(false);
    }
  }
});

// The history chart's controls redraw it, and past a year the lines are
// weekly while the bands stay day by day.
test("regime history chart: toggles redraw it, ranges set its span, weekly past a year", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/regime");
  const fig = page.locator("#history-sec figure");
  await expect(fig).toBeVisible();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const state = () => fig.evaluate((f) => ({
    days: Number((f as HTMLElement).dataset.days),
    bands: f.querySelectorAll(".rv__bands i").length,
    composite: [...f.querySelectorAll('.rr-area__svg polyline[data-token="composite"]')].reduce((n, l) => n + (l.getAttribute("points") || "").trim().split(/\s+/).length, 0),
    macro: f.querySelectorAll('.rr-area__svg polyline[data-token="macro"]').length,
  }));

  // One year by default, a point a day.
  let s = await state();
  expect(s.days).toBe(366);
  expect(s.composite).toBe(366);
  expect(s.bands).toBeGreaterThan(0);
  await expect(page.locator("#history-sec .rv__chart-meta")).toHaveText("Daily");

  await page.getByRole("button", { name: "Regime bands" }).click();
  expect((await state()).bands).toBe(0);
  await page.getByRole("button", { name: "Regime bands" }).click();
  expect((await state()).bands).toBeGreaterThan(0);

  const macro = page.locator("#history-sec .rv__lg", { hasText: "Macro" });
  await macro.click();
  expect((await state()).macro).toBe(0);
  await expect(macro).toHaveAttribute("aria-pressed", "false");
  await macro.click();
  expect((await state()).macro).toBeGreaterThan(0);

  // Past a year the lines are weekly and the bands stay daily.
  await page.locator("#history-sec .rm-chip", { hasText: /^3Y$/ }).click();
  s = await state();
  expect(s.days).toBe(1097);
  expect(s.composite).toBe(157);
  await expect(page.locator("#history-sec .rv__chart-meta")).toHaveText("One reading a week");

  // The crosshair reads the day under the pointer.
  const plot = page.locator("#history-sec .rr-area__plot");
  const box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator("#history-sec .rr-area__tip li")).toHaveCount(4);
  expect(errors).toEqual([]);
});

// Every predictive-power figure says what it means in words, from its own
// sign and whether it clears the 0.15 noise line.
test("each predictive-power figure carries its reading in words", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/regime");
  const tips = page.locator("#predictive-power .rv__rho .rm-tip__bub");
  expect(await tips.count()).toBeGreaterThan(10);
  const texts = await tips.allTextContents();
  for (const t of texts) expect(t).toMatch(/: (no reading|[−+]?\d\.\d\d)\./);
  expect(texts.some((t) => t.includes("no relation beyond noise"))).toBe(true);
  // The notes are folded, and every one of them is still there.
  const disc = page.locator("#predictive-power .rr-disc__btn");
  await expect(disc).toHaveAttribute("aria-expanded", "false");
  await disc.click();
  await expect(page.locator("#corr-notes")).toContainText("Effective independent observations");
});

// A link to a panel opens its tab: session pages link their market context
// rows to #panel-<key>.
test("a link to a regime panel opens that panel's tab", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/regime#panel-onchain");
  await expect(page.locator("#panel-onchain")).toBeVisible();
  await expect(page.locator("#panel-macro")).toBeHidden();
  await expect(page.getByRole("tab", { name: /On-chain/ })).toHaveAttribute("aria-selected", "true");
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

test("late-cycle view renders live gauges, and no hardcoded readings beside them", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/");
  await navigate(page, "/research/late-cycle-signals");

  // The long-form prose (stub__ markup, which smoke-frontend-check.ts also
  // asserts against) is unchanged; what this page gained is the researchView
  // wiring that R4 added, so the numbers now come from the signal payload.
  await expect(page.locator(".stub__title")).toContainText("How late in the rally");
  await expectResearchTitleUsesDisplayFont(page, ".stub__title");

  // One live gauge per gauge in the payload — five, including TOP7_VS_SPY,
  // which the old hardcoded table omitted entirely.
  const gauges = page.locator(".rs__gauge");
  await expect(gauges).toHaveCount(LATECYCLE_PAYLOAD.gauges.length);
  await expect(page.locator(".rs__asof")).toContainText(LATECYCLE_PAYLOAD.asof);

  const concentrationGauge = page.locator(".rs__gauge", { hasText: "Index concentration" });
  await expect(concentrationGauge.locator(".rs__gauge-val")).toHaveText("1.2841");
  await expect(concentrationGauge.locator(".rs__gauge-pct")).toContainText("88%");
  await expect(page.locator(".rs__gauge", { hasText: "Top-7 basket vs SPY" })).toHaveCount(1);

  // The table beside them is now a legend, not a second set of readings: one
  // row per gauge naming what it measures, and NO numeric reading column. The
  // previous version of this test pinned "53%", "94%", "+9.9%" and "44.8" —
  // figures hardcoded at authoring time that had drifted so far from the live
  // signal (concentration 53% vs 70.8%) that the table contradicted the page's
  // own conclusion. A test that asserts a stale number keeps it alive, so the
  // assertion is now that no such number is there.
  const rows = page.locator(".stub__table tbody tr");
  await expect(rows).toHaveCount(LATECYCLE_PAYLOAD.gauges.length);
  await expect(page.locator(".stub__table .stub__num")).toHaveCount(0);
  await expect(page.locator(".stub__caption")).toHaveText("What each gauge measures");
  await expect(rows.filter({ hasText: "Index concentration" })).toContainText("SPY/RSP ratio, 3y percentile");
  await expect(rows.filter({ hasText: "Top-7 basket vs SPY" })).toContainText("NVDA");

  // And one stub__series write-up block per gauge (four numbered sections).
  await expect(page.locator(".stub__series")).toHaveCount(4);
  const concentration = page.locator(".stub__sec", { hasText: "Index concentration" });
  await expect(concentration.locator(".stub__read")).toContainText("late-cycle configuration");
});

// A research chart with nothing to draw keeps its box and says so with the
// shared empty chart (.rm-nodata), and so does the live panel: a failed read
// is "No data available" in every one of them, never the API's own error text.
test("research views state a failed read in the live panel and every chart, captions kept", async ({ page }) => {
  await stubEnvironment(page);
  await page.route("**/api/dashboards/research-signals/**", (route) =>
    route.fulfill({ status: 503, contentType: "text/plain", body: "down" }));
  await page.goto("/");

  await navigate(page, "/research/channel-divergence");
  await expect(page.locator(".rs__series-canvas .rm-nodata--fill .rm-nodata__h")).toHaveText(Array(3).fill("No data available"));
  await expect(page.locator(".rs__gauges .rm-nodata__h")).toHaveText("No data available");
  await expect(page.locator(".rs__gauge-val")).toHaveCount(0);
  await expect(page.locator(".rm-nodata__d:visible")).toHaveCount(0);
  await expect(page.locator(".rs__figure .rs__figcap")).toHaveCount(3);
  await expect(page.locator(".rs__figure .rs__note")).toHaveCount(3);
  await expect(page.locator("#view")).not.toContainText("503");

  await navigate(page, "/research/late-cycle-signals");
  await expect(page.locator(".rs__series-canvas .rm-nodata__h")).toHaveText(Array(5).fill("No data available"));
  await expect(page.locator(".rs__gauges .rm-nodata__h")).toHaveText("No data available");
  await expect(page.locator(".stub__series-label")).toHaveCount(5);
});

test("research charts say no data yet for a missing series and not enough for one reading, and draw the rest", async ({ page }) => {
  await stubEnvironment(page);
  const payload = {
    ...CHANNEL_PAYLOAD,
    indicators: {
      btc_beta_vs_risk_appetite: [{ date: "2026-06-29", value: 0.412 }],
      // All gaps is no data, the same as absent (stables_vs_qqq_flow).
      btc_qqq_ratio_percentile: [{ date: "2026-06-28", value: null }, { date: "2026-06-29", value: null }],
    },
  };
  await page.route("**/api/dashboards/research-signals/channel-divergence*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ signalKey: "channel-divergence", date: payload.asof, payload }) }));
  await page.goto("/");
  await navigate(page, "/research/channel-divergence");

  const chart = (key: string) => page.locator(".rs__series-canvas", { has: page.locator(`canvas[data-series="${key}"]`) });
  await expect(chart("btc_beta_vs_risk_appetite").locator(".rm-nodata__h")).toHaveText("Not enough data yet");
  await expect(chart("btc_beta_vs_risk_appetite").locator(".rm-nodata__d")).toHaveText("One reading so far");
  await expect(chart("btc_qqq_ratio_percentile").locator(".rm-nodata__h")).toHaveText("No data yet");
  await expect(chart("stables_vs_qqq_flow").locator(".rm-nodata__h")).toHaveText("No data yet");
  // The box keeps its size with nothing drawn in it.
  const box = await chart("stables_vs_qqq_flow").boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(120);
  // The gauges still render: only the charts are empty.
  await expect(page.locator(".rs__gauge-val")).toHaveCount(CHANNEL_PAYLOAD.gauges.length);
  await expect(page.locator(".rs__gauges .rm-nodata")).toHaveCount(0);

  // A series with two readings draws, and carries no empty state.
  await navigate(page, "/research/late-cycle-signals");
  const mna = page.locator(".rs__series-canvas", { has: page.locator('canvas[data-series="mna_pct"]') });
  await expect(mna.locator(".rm-nodata")).toHaveCount(0);
  await expect.poll(() => mna.locator("canvas").evaluate((c) => Boolean((window as any).Chart?.getChart(c)))).toBe(true);
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
  await expect(banner).toContainText("15 days old");
  await expect(banner).toContainText("2026-06-29");
  // The charts still render beneath the warning (data is shown, just flagged).
  await expect(page.locator("#daily-regime-classification")).toBeVisible();
});

test("regime dashboard hides the staleness banner when data is fresh", async ({ page }) => {
  await stubEnvironment(page);
  const fresh = { ...loadRegimeStub(), staleness: { asof: "2026-07-14", serverDate: "2026-07-14", ageDays: 0, stale: false, thresholdDays: 3 } };
  await page.route("**/api/dashboards/regime-snapshots*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fresh) }));
  await page.goto("/");
  await navigate(page, "/regime");

  await expect(page.locator("#daily-regime-classification")).toBeVisible();
  await expect(page.locator(".rv__stale")).toBeHidden();
});

// Row-level provenance badge (issue #397): the served snapshot's `source`
// ('live' | 'hermetic' | 'fixture' | 'seed') renders as a small badge next to
// the as-of label, distinct from the per-indicator upstream-vendor label
// (FRED/Yahoo/…) already shown in each panel row. `null`/absent hides it
// entirely — a pre-migration row is honestly unlabeled, never assumed live.
test("regime dashboard renders the provenance badge when the API reports a data source", async ({ page }) => {
  await stubEnvironment(page);
  const hermetic = { ...loadRegimeStub() };
  hermetic.latest = { ...hermetic.latest!, source: "hermetic" };
  await page.route("**/api/dashboards/regime-snapshots*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hermetic) }));
  await page.goto("/");
  await navigate(page, "/regime");

  const badge = page.locator(".rv__prov");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("Demo data (hermetic)");
  await expect(badge).toHaveClass(/rv__prov--hermetic/);
});

test("regime dashboard hides the provenance badge when the API reports no source (pre-migration row)", async ({ page }) => {
  await stubEnvironment(page);
  const noSource = { ...loadRegimeStub() };
  noSource.latest = { ...noSource.latest!, source: null };
  await page.route("**/api/dashboards/regime-snapshots*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(noSource) }));
  await page.goto("/");
  await navigate(page, "/regime");

  await expect(page.locator("#daily-regime-classification")).toBeVisible();
  await expect(page.locator(".rv__prov")).toBeHidden();
});
