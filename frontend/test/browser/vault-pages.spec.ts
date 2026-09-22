// Render spec for the four-vault work (docs/plans/vault-pages.md): each
// vault's page (/vault/:slug), the Vaults section of /allocation, the Robot
// Money Vault subject's Holdings grouped by vault, and the mock-data switch
// that drives all three.
//
// Same harness as allocation-view.spec.ts: the SPA and the view HTML come from
// baseURL, the vendor CDN scripts are fulfilled from node_modules, and every
// feed the page reads is stubbed, so the spec runs against the static preview
// and against a real backend alike.
//
// The data switch (lib/vault-source.js) is driven the way a reader drives it:
// the mode sits in this tab's sessionStorage ("rm.vaults"), set before the
// page loads, or arrives as ?vaults=<mode> on the first URL. Two base setups:
//   - "saved": every /api answers 503, so a local host shows the saved Base
//     snapshot (data/vaults/base/vault-economics.json), the shipped
//     manifest's policy (95/5/0/0) as the vaults' target, the archive's
//     2026-06-24 recommendation and the archive's subject;
//   - "live": the four-vault route is absent (404), vault-economics and the
//     allocation answer with the committed goldens (the allocation's policy,
//     95/5/0/0, is the vaults' target), and the allocation's sessions with
//     one published bucket_weights session.
// Nothing on Base applies weights, so on Base the target is the published
// policy's; on the devnet it is the router's applied weights (RM-115).
// Devnet reads the shipped fixtures under data/vaults/devnet/. A production
// host never reads them; that gate is pure logic and is covered in
// scripts/tests/unit/vault-data.test.ts, since this preview only answers on a
// local host.
//
// Assertions are on the RENDERED page: text, attributes and computed styles.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { navigate } from "./navigation.ts";

// lib/chart-theme.js CATEGORICAL[0..3], as the browser reports them: the four
// sleeves' hues, which the four vaults wear too. Written out, not imported.
const CATEGORICAL_RGB = [
  "rgb(16, 185, 129)",  // rmUSDC  · Conservative DeFi Yield
  "rgb(0, 229, 255)",   // rmAGENT · Agent Tokens
  "rgb(232, 166, 64)",  // rmPROTO · Protocol Tokens
  "rgb(126, 136, 158)", // rmRWA   · Real World Assets
];

const vendorScripts = {
  "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js":
    "node_modules/alpinejs/dist/cdn.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js":
    "node_modules/chart.js/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/p5@1.11.2/lib/p5.min.js":
    "node_modules/p5/lib/p5.min.js",
};

const publicDir = join(process.cwd(), "frontend/public");
const readJson = (rel: string): any => JSON.parse(readFileSync(join(publicDir, rel), "utf8"));
const DEVNET = readJson("data/vaults/devnet/overview.json");
const SAVED_BASE = readJson("data/vaults/base/vault-economics.json");

function loadGolden<T>(route: string): T {
  const goldens = JSON.parse(readFileSync(join(process.cwd(), "goldens/api-goldens.json"), "utf8")) as {
    routes: Record<string, unknown>;
  };
  const payload = goldens.routes[route];
  if (!payload) throw new Error(`no ${route} golden — run \`bun run goldens:update\``);
  return payload as T;
}
const goldenVault = () => loadGolden<any>("/api/dashboards/vault-economics");

type Mode = "base" | "devnet" | "devnet-unreadable" | "devnet-no-recommendation" | "devnet-stale" | "devnet-paused";

const SLUGS = [
  { slug: "rmusdc", symbol: "rmUSDC", name: "Conservative DeFi Yield" },
  { slug: "rmagent", symbol: "rmAGENT", name: "Agent Tokens" },
  { slug: "rmproto", symbol: "rmPROTO", name: "Protocol Tokens" },
  { slug: "rmrwa", symbol: "rmRWA", name: "Real World Assets" },
];
const SYMBOLS = SLUGS.map((v) => v.symbol);

// One published bucket_weights session on the allocation subject, with a
// real session id, so its date links to the session.
const LIVE_SESSION = {
  id: "8f0d6c21-4a5e-4a1c-9f2b-7c1de2a44b10",
  date: "2026-09-01",
  subjectId: "robotmoney-allocation",
  state: "published",
  publishedAt: "2026-09-01T23:20:00.000Z",
  swarmRecommendation: {
    type: "bucket_weights",
    weights: { conservative_defi_yield: 0.9, agent_tokens: 0.05, protocol_tokens: 0.03, real_world_assets: 0.02 },
  },
};

const json = (payload: unknown, status = 200) => ({
  status, contentType: "application/json", body: JSON.stringify(payload),
});

async function stubVendors(page: Page) {
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({ path: join(process.cwd(), file), contentType: "application/javascript" }));
  }
}

// The mode as a reader's earlier ?vaults= left it: in this tab's storage.
// Re-applied on every full load, so a test that moves between modes by query
// does not use it.
async function setMode(page: Page, mode: Mode) {
  await page.addInitScript((m) => {
    try { sessionStorage.setItem("rm.vaults", m); } catch { /* storage blocked */ }
  }, mode);
}

// The mode as a reader switches it: on the first URL. Built by concatenation
// on purpose: the e2e route guard resolves only plain literal routes.
async function openWithQuery(page: Page, path: string, mode: Mode) {
  await page.goto(path + "?vaults=" + mode);
}

// Every /api down, the swarm's included, so the subject reads the archive.
// Registered first: later routes take precedence.
async function stubSaved(page: Page) {
  await stubVendors(page);
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, body: "down" }));
}

async function stubLive(page: Page, economics: unknown = goldenVault()) {
  await stubSaved(page);
  await page.route("**/api/dashboards/vault-economics", (route) => route.fulfill(json(economics)));
  await page.route("**/api/dashboards/allocation", (route) => route.fulfill(json(loadGolden("/api/dashboards/allocation"))));
  await page.route("**/api/swarm/sessions**", (route) => route.fulfill(json({ sessions: [LIVE_SESSION], nextCursor: null })));
}

async function openVault(page: Page, slug: string) {
  await page.goto("/index.html");
  await navigate(page, `/vault/${slug}`);
  await expect(page.locator(".cv--detail h1")).toBeVisible();
}

function failOnBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  // The harness's own first render of "/index.html" (see allocation-view.spec).
  const HARNESS_404 = "views/index.html.html";
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (text.includes(HARNESS_404)) return;
    // A stubbed 503 or 404 is reported without its URL; the page's handling of
    // it is what these tests assert.
    if (text.startsWith("Failed to load resource") && !text.includes("/api/")) return;
    errors.push(`console: ${text}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack || e.message}`));
  return errors;
}
async function expectNoBrowserErrors(errors: string[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(errors).toEqual([]);
}

const pct = (bps: number | null) => (bps == null ? "—" : `${Number((bps / 100).toFixed(1))}%`);
const dollars = (s: string) => Number(s.replace(/[$,]/g, ""));
const usd2 = (n: number) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
// A weight in whole dollars at a combined TVL, and a gap in dollars: the
// difference of the two rounded figures beside it, signed.
const usdAt = (pct: number, tvl: number) => Math.round((pct / 100) * tvl);
const signedUsd = (d: number) => (d === 0 ? "$0" : `${d > 0 ? "+" : "−"}${usd2(Math.abs(d))}`);
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
// This vault's weight at one layer, as the Allocation ring's legend reads it:
// Actual is the focused row's figure, the basis (Target, or Recommended when
// no target can be read) its second column, and a layer the legend does not
// carry is a fact under the ring.
const thisVault = (page: Page) => page.locator("#allocation .rr-legend__row.is-active");
const layerRow = (page: Page, label: string) =>
  label === "Actual"
    ? thisVault(page).locator("> b")
    : page.locator("#allocation .rr-legend--cols").filter({ has: page.locator(".rr-legend__head", { hasText: label }) })
      .locator(".rr-legend__row.is-active .rr-legend__was > span:last-child")
      .or(page.locator("#allocation .rr-meta__i").filter({ hasText: label }).locator("b"));
const gapOf = (page: Page) => thisVault(page).locator(".rr-legend__d");
// The facts under the ring, once there is a target: Recommended and the
// governance gap.
const pipelineFact = (page: Page, label: string) => page.locator("#allocation .rr-meta .rr-meta__i").filter({ hasText: label });
const fact = (page: Page, label: string) => page.locator(".rr-head + .rr-meta .rr-meta__i").filter({ hasText: label });
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

// /allocation's Vaults section. Its cells in order: Recommended, Target,
// Actual, Governance gap, Drift; with no target to read, Recommended,
// Actual, Gap. Each cell is its figure, then its whole dollars at the
// combined TVL under it (Actual's are the vault's own TVL).
const vaultRows = (page: Page) => page.locator("#vaults tbody tr");
const vaultCol = (page: Page, n: number) => page.locator(`#vaults tbody tr td:nth-of-type(${n}) > span:first-child`);
const vaultUsd = (page: Page, n: number) => page.locator(`#vaults tbody tr td:nth-of-type(${n}) > small`);
const vaultFact = (page: Page, label: string) => page.locator("#vaults .rr-meta .rr-meta__i").filter({ hasText: label });
const VAULT_HEADS = ["Vault", "Recommended", "Target", "Actual", "Governance gap", "Drift"];

// The section paints its four rows from the first frame with "—"; the
// overview has answered once the Network fact has a value.
async function vaultsLoaded(page: Page) {
  await expect(vaultRows(page)).toHaveCount(4);
  await expect(vaultFact(page, "Network").locator("b")).not.toHaveText("—");
}
async function openAllocation(page: Page) {
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await vaultsLoaded(page);
}

// The Robot Money Vault subject's Vaults legend. Each row: the vault's
// value, its share of the book (the row's bright figure), and the weight in
// force.
const byVault = (page: Page) => page.locator("#holdings .rr-legend__row");
const byVaultValue = (page: Page) => byVault(page).locator(".rr-legend__was:not(:last-child)");
const byVaultTarget = (page: Page) => byVault(page).locator(".rr-legend__was:last-child");

// The Robot Money Vault subject. Off the devnet switch its Holdings are the
// vault feed, one reading, and they and their target follow the page's first
// paint, once the vault overview answers.
async function subjectLoaded(page: Page) {
  await expect(page.locator(".sv__detail-title")).toHaveText("Robot Money Vault");
  await expect(page.locator("#holdings tr.rr-group").first()).toBeVisible();
  await expect(page.locator("#holdings .rr-legend__head")).toHaveText(/^VaultValueShare(Applied|Target)$/);
  await expect(byVaultTarget(page).first()).toHaveText(/^(Target|Applied) \d/);
}

// ── the devnet stack ────────────────────────────────────────────────────────

for (const [i, v] of SLUGS.entries()) {
  test(`${v.slug} on the devnet: its hue, its three layers, labelled once as test data`, async ({ page }) => {
    const errors = failOnBrowserErrors(page);
    await stubSaved(page);
    await setMode(page, "devnet");
    await openVault(page, v.slug);
    const row = DEVNET.vaults.find((r: any) => r.slug === v.slug);
    const detail = readJson(`data/vaults/devnet/${v.slug}.json`);

    await expect(page.locator("h1")).toHaveText(v.symbol);
    await expect(page.locator(".rr-head .sv__eyebrow")).toContainText(v.name);
    expect(await page.locator(".rr-head .rr-dot").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(CATEGORICAL_RGB[i]);
    expect(await page.locator('meta[name="robots"]').getAttribute("content")).toBe("noindex, follow");
    expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toBe(`https://robotmoney.network/vault/${v.slug}`);

    await expect(fact(page, "Network")).toContainText("Staging devnet");
    await expect(fact(page, "Status")).toContainText("Active");

    await expect(layerRow(page, "Recommended")).toHaveText(pct(row.recommendedBps));
    // The devnet router reports its weights: they are the target.
    await expect(layerRow(page, "Target")).toHaveText(pct(row.appliedBps));
    await expect(layerRow(page, "Actual")).toHaveText(pct(row.actualBps));
    // Its arc and its swatch in the vault's hue, and its row in focus.
    expect(await page.locator(`#allocation circle[data-sleeve="${v.slug}"]`).evaluate((el) => getComputedStyle(el).stroke)).toBe(CATEGORICAL_RGB[i]);
    expect(await thisVault(page).locator("> i").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(CATEGORICAL_RGB[i]);

    // The holdings reconcile to the vault's TVL, in whole dollars as the
    // swarm pages state a book: each figure rounds by at most half a dollar.
    await expect(page.locator("#holdings .rr-stat__v")).toHaveText(`$${row.tvlUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
    const values = await page.locator(".rr-holdings tbody td:nth-child(3)").allTextContents();
    expect(values.length).toBeGreaterThan(0);
    expect(Math.abs(values.reduce((s, x) => s + dollars(x), 0) - row.tvlUsd)).toBeLessThanOrEqual(values.length * 0.5);

    // Fifteen daily readings draw one line, in the vault's hue.
    await expect(page.locator("#history polyline")).toHaveCount(1);
    await expect(page.locator("#history .rr-area__pt")).toHaveCount(0);
    expect(await page.locator("#history polyline").evaluate((el) => getComputedStyle(el).stroke)).toBe(CATEGORICAL_RGB[i]);

    // More than ten events, ten to a page. No event has a transaction, so
    // there is no Transaction column.
    expect(detail.activity.length).toBeGreaterThan(10);
    await expect(page.locator("#activity tbody tr")).toHaveCount(10);
    await expect(page.locator("#activity thead th:visible")).toHaveText(["Date", "Event", "Amount"]);
    await page.locator("#activity .rr-btn", { hasText: "Older" }).click();
    await expect(page.locator("#activity tbody tr")).toHaveCount(detail.activity.length - 10);

    // The router's weights, one reading; the one recommendation is the
    // Recommendation row, so no list of them.
    await expect(page.locator("#vault-router-weights tbody tr")).toHaveCount(1);
    await expect(page.locator("#vault-receipts")).toHaveCount(0);

    // The label is one fact in the facts row.
    await expect(page.locator("[data-vault-label]")).toHaveCount(1);
    await expect(fact(page, "Devnet test data")).toHaveCount(1);

    // No deposit path on test data; the devnet router is live.
    await expect(page.locator(".rr-cta")).toHaveCount(0);
    await expect(page.locator("#deposit")).toHaveCount(0);
    await expect(page.locator("#mechanics .rr-dl")).toContainText("Routes new deposits by the applied weights.");
    await expectNoBrowserErrors(errors);
  });
}

test("rmUSDC's devnet gaps and recommendation read as the overview states them", async ({ page }) => {
  await stubSaved(page);
  await setMode(page, "devnet");
  await openVault(page, "rmusdc");
  // Drift is the ring's Drift column for this vault; the governance gap,
  // which the legend does not carry, a fact under it.
  const gaps = page.locator("#allocation .rr-meta");
  await expect(gaps.locator(".rr-meta__i", { hasText: "Governance gap" })).toContainText("+5 pp");
  await expect(gapOf(page)).toHaveText("Drift +2 pp");
  await expect(page.locator("#allocation .rr-meta .alp__mv.up, #allocation .rr-legend__row.is-active .alp__mv.up")).toHaveCount(2);
  // A synthetic recommendation has no session to open: a date, not a link.
  const dl = page.locator("#allocation .rr-dl");
  await expect(dl).toContainText("Sep 16, 2026");
  await expect(dl.locator("a")).toHaveCount(0);
  await expect(dl).toContainText("Released on chain");
});

test("rmPROTO's zero governance gap reads as a reading, not as missing", async ({ page }) => {
  await stubSaved(page);
  await setMode(page, "devnet");
  await openVault(page, "rmproto");
  const gov = page.locator("#allocation .rr-meta .rr-meta__i", { hasText: "Governance gap" });
  await expect(gov).toContainText("0 pp");
  await expect(gov.locator(".alp__mv.flat")).toHaveCount(1);
});

// ── production-like: rmUSDC alone on Base ───────────────────────────────────

// rmUSDC on Base, from whichever Base feed answered: the adapters by name with
// their BaseScan links, the contract, the share price, the deposit skill, and
// no router (nothing on Base applies weights yet).
async function expectRmusdcOnBase(page: Page, economics: any) {
  await expect(page.locator("h1")).toHaveText("rmUSDC");
  await expect(fact(page, "Network")).toContainText("Base");
  await expect(fact(page, "Status")).toContainText("Active");
  await expect(fact(page, "Share price")).toContainText(`$${economics.sharePrice.toFixed(4)}`);
  await expect(fact(page, "Contract").locator("a")).toHaveAttribute("href", "https://basescan.org/address/0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd");

  await expect(page.locator("#holdings .rr-stat__v")).toHaveText(usd2(economics.tvlUsd));
  const positions = page.locator(".rr-holdings tbody th");
  await expect(positions).toHaveCount(3);
  await expect(positions.nth(0)).toContainText("Gauntlet USDC Prime");
  await expect(positions.nth(1)).toContainText("Aave V3 USDC");
  await expect(positions.nth(2)).toContainText("Compound III USDC");
  for (const [n, a] of economics.adapters.entries()) {
    await expect(positions.nth(n).locator("a")).toHaveAttribute("href", `https://basescan.org/address/${a.address}`);
  }

  // No router on Base: the target is the published policy's, 95% for rmUSDC,
  // and the gap is actual against it. Recommended and the governance gap,
  // which the legend does not carry, are the facts under the ring.
  await expect(page.locator("#allocation .rr-legend__head")).toHaveText("VaultActualTargetDrift");
  await expect(layerRow(page, "Target")).toHaveText("95%");
  await expect(layerRow(page, "Actual")).toHaveText("100%");
  await expect(gapOf(page)).toHaveText("Drift +5 pp");
  await expect(page.locator("#allocation .rr-meta .rr-meta__i")).toHaveText([/^Recommended/, /^Governance gap/]);
  await expect(page.locator("#allocation")).not.toContainText("Applied");

  // The Base feed serves no history, activity or router weights: no empty
  // sections standing in for them.
  expect(await page.locator("section.rr-sec").evaluateAll((els) => els.map((e) => e.id))).toEqual(["holdings", "allocation", "mechanics", "deposit"]);
  await expect(page.locator(".rr-disc")).toHaveCount(0);

  const mech = page.locator("#mechanics .rr-dl");
  await expect(mech).toContainText("Exit fee");
  await expect(mech).toContainText("0.25%");
  await expect(mech).not.toContainText("Routes new deposits");
  await expect(mech).not.toContainText("Venues");

  const cta = page.locator("#deposit .rr-cta");
  await expect(cta).toHaveAttribute("href", "/skills");
  await expect(cta).toHaveText(/^Deposit skill\s*→$/);

  await expect(page.locator("#view")).not.toContainText("Devnet test data");
  await expect(page.locator("#view")).not.toContainText("$72,000");
}

test("rmUSDC on Base from the saved snapshot: the adapters, the contract, the deposit skill", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubSaved(page);
  await setMode(page, "base");
  await page.goto("/index.html");
  await navigate(page, "/vault/rmusdc");

  await expectRmusdcOnBase(page, SAVED_BASE);
  await expect(page.locator("[data-vault-label]").first()).toHaveText("Saved Base snapshot");
  // The archive's 2026-06-24 recommendation, 95/3/0/2: rmUSDC's 95% is its
  // target too, so its governance gap is a zero reading.
  await expect(layerRow(page, "Recommended")).toHaveText("95%");
  await expect(pipelineFact(page, "Governance gap")).toContainText("0 pp");
  await expect(page.locator("#allocation .rr-dl a")).toHaveAttribute("href", "/swarm/2026-06-24/robotmoney-allocation");
  await expectNoBrowserErrors(errors);
});

test("rmUSDC on Base from the live feed: the same vault, and no data label", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  const golden = goldenVault();
  await stubLive(page, golden);
  await setMode(page, "base");
  await openVault(page, "rmusdc");
  await expectRmusdcOnBase(page, golden);
  await expect(page.locator("[data-vault-label]")).toHaveCount(0);
  // The stubbed session's weights, linked to the session itself: 90%
  // against the policy's 95%.
  await expect(layerRow(page, "Recommended")).toHaveText("90%");
  await expect(pipelineFact(page, "Governance gap")).toContainText("+5 pp");
  await expect(page.locator("#allocation .rr-dl a")).toHaveAttribute("href", `/swarm/sessions/${LIVE_SESSION.id}`);
  await expect(page.locator("#allocation .rr-dl a")).toHaveText("Sep 1, 2026");
  await expectNoBrowserErrors(errors);
});

test("a stub feed and a stale adapter read say so", async ({ page }) => {
  const golden = goldenVault();
  golden.source = "stub";
  golden.adapters[0].provenance = "stale";
  golden.adapters[0].balanceObservedAt = "2026-07-30T16:20:13.069Z";
  await stubLive(page, golden);
  await setMode(page, "base");
  await openVault(page, "rmusdc");
  await expect(page.locator("[data-vault-label]").first()).toHaveText("Stub data");
  await expect(page.locator(".rr-holdings tbody th").first().locator("small")).toHaveText("stale (Jul 30 16:20 UTC)");
  // Stub figures are test data: no deposit path.
  await expect(page.locator("#deposit")).toHaveCount(0);
});

// Moved from allocation-view.spec (issue #614 AC4): a scheduler catch-up is a
// live read that arrived late, distinct from stale and from stub.
test("a scheduler catch-up reads as caught up late, not as stale or stub", async ({ page }) => {
  const golden = goldenVault();
  golden.adapters[0].provenance = "backfilled";
  await stubLive(page, golden);
  await setMode(page, "base");
  await openVault(page, "rmusdc");
  const notes = page.locator(".rr-holdings tbody th small");
  await expect(notes).toHaveCount(1);
  await expect(notes).toHaveText("caught up late");
  await expect(page.locator("[data-vault-label]")).toHaveCount(0);
});

test("rmAGENT on Base is not live: its allocation and mechanics, nothing to hold", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubSaved(page);
  await setMode(page, "base");
  await page.goto("/index.html");
  await navigate(page, "/vault/rmagent");
  // "Not live", beside the Network fact that names Base.
  await expect(fact(page, "Status").locator("b")).toHaveText("Not live");
  await expect(fact(page, "Network").locator("b")).toHaveText("Base");
  await expect(fact(page, "Share price")).toHaveCount(0);
  // Nothing to hold, so no Holdings. Nothing stated about its mechanics, so
  // its risk line stands alone, with no heading over one line.
  expect(await page.locator("section.rr-sec").evaluateAll((els) => els.map((e) => e.id))).toEqual(["allocation"]);
  await expect(page.locator("#mechanics h2")).toHaveCount(0);
  await expect(page.locator("#mechanics .rr-note")).toContainText("Capital and returns are not guaranteed.");
  // The archive's 3% against the policy's 5%, and nothing held against the
  // 5%.
  await expect(layerRow(page, "Recommended")).toHaveText("3%");
  await expect(pipelineFact(page, "Governance gap")).toContainText("+2 pp");
  await expect(layerRow(page, "Target")).toHaveText("5%");
  await expect(layerRow(page, "Actual")).toHaveText("0%");
  await expect(gapOf(page)).toContainText("−5 pp");
  await expect(page.locator(".rr-disc")).toHaveCount(0);
  await expect(page.locator(".rr-cta")).toHaveCount(0);
  await expectNoBrowserErrors(errors);
});

// A production-like host reads nothing but the API; with it down, the page
// still names the vault from its slug and states the gap where the facts
// would be. Simulated here by the overview failing outright.
test("the vaults unreadable: the head from the slug, the error in place of the facts", async ({ page }) => {
  await stubSaved(page);
  await setMode(page, "base");
  await page.route("**/data/vaults/**", (route) => route.fulfill({ status: 404, body: "gone" }));
  await openVault(page, "rmagent");
  await expect(page.locator(".rr-crumbs a")).toHaveAttribute("href", "/allocation#vaults");
  await expect(page.locator("h1")).toHaveText("rmAGENT");
  await expect(page.locator(".rr-head .sv__eyebrow")).toContainText("Agent Tokens");
  await expect(page.locator(".sv__error")).toHaveText("Vault data unavailable");
  await expect(page.locator(".rr-meta")).toBeHidden();
  await expect(page.locator("section.rr-sec")).toHaveCount(0);
});

test("an unknown vault slug renders not found", async ({ page }) => {
  await stubSaved(page);
  await page.goto("/vault/nope");
  await expect(page.locator("#view")).toContainText("Page not found");
  expect(await page.title()).toBe("Page Not Found — Robot Money");
});

test("bare /vault moves to /allocation#vaults, scrolled to it, canonical /allocation", async ({ page }) => {
  await stubSaved(page);
  await page.goto("/vault");
  await expect(page).toHaveURL(/\/allocation#vaults$/);
  await expect(page.locator("#vaults")).toBeInViewport();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://robotmoney.network/allocation");
});

// ── /allocation: the Vaults section ─────────────────────────────────────────

test("/allocation on the devnet: four vaults against the recommendation, labelled as test data", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubSaved(page);
  await setMode(page, "devnet");
  await openAllocation(page);

  const rows = vaultRows(page);
  await expect(rows.locator("th a")).toHaveText(SYMBOLS);
  for (const [i, v] of SLUGS.entries()) {
    await expect(rows.nth(i).locator("th a")).toHaveAttribute("href", `/vault/${v.slug}`);
    await expect(rows.nth(i).locator("th small")).toHaveText(v.name);
  }
  // The router's applied weights are the target. Each figure carries its
  // dollars at the combined TVL; Actual's are the vault's own TVL, and a
  // gap's the difference of the two beside it.
  await expect(page.locator("#vaults thead th")).toHaveText(VAULT_HEADS);
  await expect(rows.nth(0).locator("td > span:first-child")).toHaveText(["65%", "70%", "72%", "+5 pp", "+2 pp"]);
  await expect(rows.nth(0).locator("td > small")).toHaveText(["$65,000", "$70,000", "$72,000", "+$5,000", "+$2,000"]);
  await expect(rows.nth(0).locator(".alp__mv.up")).toHaveCount(2);
  // A zero gap is a reading: "0 pp", flat, with no arrow, and "$0".
  const protoGov = rows.nth(2).locator("td").nth(3);
  await expect(protoGov.locator(".alp__mv")).toHaveText("0 pp");
  await expect(protoGov.locator(".alp__mv")).toHaveClass(/\bflat\b/);
  await expect(protoGov.locator(".alp__mv i")).toHaveCount(0);
  await expect(protoGov.locator("small")).toHaveText("$0");

  await expect(vaultFact(page, "Combined TVL")).toContainText("$100,000");
  await expect(vaultFact(page, "Vaults live")).toHaveCount(0);
  // Half the flow gaps: (2 + 1 + 1 + 0) / 2.
  await expect(vaultFact(page, "Tracking error").locator("b")).toHaveText("2%");
  // A synthetic recommendation has no session to open: a date, not a link.
  const rec = vaultFact(page, "Recommendation");
  await expect(rec).toContainText("Sep 16, 2026");
  await expect(rec.locator("a")).toHaveCount(0);
  await expect(vaultFact(page, "Released on chain")).toContainText("No");
  await expect(vaultFact(page, "Network")).toContainText("Staging devnet");
  // The router holds nothing: a status, never a figure.
  await expect(page.locator(".alp__meta")).toContainText("Router Live");

  await expect(page.locator("[data-vault-label]")).toHaveCount(1);
  await expect(page.locator("#vaults [data-vault-label]")).toHaveText("Devnet test data");

  // A sleeve's recipe names its vault by symbol, exactly, and states no
  // status. The ring's Actual column is each vault's share of the TVL.
  await expect(page.locator(".alp__ring .rr-legend__row").nth(0).locator(".rr-legend__was")).toHaveText("Actual 72%");
  await page.locator(".alp__ring .rr-legend__row").nth(1).click();
  const vault = page.locator(".alp__ring .rr-x__head a");
  await expect(vault).toHaveAttribute("href", "/vault/rmagent");
  expect(await vault.innerText()).toBe("rmAGENT");
  await expect(page.locator(".alp__ring .rr-x__panel")).not.toContainText("Status");
  await expectNoBrowserErrors(errors);
});

test("/allocation from the saved Base snapshot: rmUSDC alone, the archive's recommendation, no devnet figure", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubSaved(page);
  await setMode(page, "base");
  await openAllocation(page);

  const rows = vaultRows(page);
  // No router on Base: the target is the published policy's, the shipped
  // manifest's on this local host (95/5/0/0), so three layers and the
  // governance and flow gaps between them.
  await expect(page.locator("#vaults thead th")).toHaveText(VAULT_HEADS);
  await expect(rows.nth(0).locator("td > span:first-child")).toHaveText(["95%", "95%", "100%", "0 pp", "+5 pp"]);
  const tvl = SAVED_BASE.tvlUsd;
  const usd = { recommended: usdAt(95, tvl), target: usdAt(95, tvl), actual: Math.round(tvl) };
  await expect(rows.nth(0).locator("td > small")).toHaveText([
    usd2(usd.recommended), usd2(usd.target), usd2(usd.actual),
    signedUsd(usd.target - usd.recommended), signedUsd(usd.actual - usd.target),
  ]);
  for (const i of [1, 2, 3]) {
    await expect(rows.nth(i).locator("th small")).toContainText("Not live");
    await expect(rows.nth(i).locator("td").nth(2).locator("> span")).toHaveText("0%");
    await expect(rows.nth(i).locator("td").nth(2).locator("small")).toHaveText("$0");
  }
  await expect(vaultCol(page, 1)).toHaveText(["95%", "3%", "0%", "2%"]);
  await expect(vaultCol(page, 2)).toHaveText(["95%", "5%", "0%", "0%"]);
  await expect(vaultCol(page, 4)).toHaveText(["0 pp", "+2 pp", "0 pp", "−2 pp"]);
  await expect(vaultCol(page, 5)).toHaveText(["+5 pp", "−5 pp", "0 pp", "0 pp"]);
  await expect(vaultRows(page).filter({ hasText: "Not live" })).toHaveCount(3);
  const rec = vaultFact(page, "Recommendation").locator("a");
  await expect(rec).toHaveText("Jun 24, 2026");
  await expect(rec).toHaveAttribute("href", "/swarm/2026-06-24/robotmoney-allocation");
  await expect(page.locator("[data-vault-label]")).toHaveCount(1);
  await expect(page.locator("#vaults [data-vault-label]")).toHaveText("Saved Base snapshot");
  await expect(page.locator(".alp__meta")).toContainText("Router Not live on Base");
  // A vault's status is the Vaults table's, stated once.
  await expect(page.locator(".alp__ring")).not.toContainText("Not live");

  // The recipe renders on the static preview, from the archived framework.
  await expect(page.locator(".alp__ring .rr-legend__row")).toHaveCount(4);
  await page.locator(".alp__ring .rr-legend__row").first().click();
  await expect(page.locator(".alp__ring .rr-x__assets tbody tr")).not.toHaveCount(0);
  for (const devnetOnly of ["Devnet test data", "$72,000", "$100,000", "Staging devnet"]) {
    await expect(page.locator("#view")).not.toContainText(devnetOnly);
  }
  await expectNoBrowserErrors(errors);
});

test("/allocation from the live Base feed: no label, the golden's TVL, and no house-book request", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  const golden = goldenVault();
  const houseBook: string[] = [];
  page.on("request", (r) => { if (/\/api\/dashboards\/wallet-/.test(r.url())) houseBook.push(r.url()); });
  await stubLive(page, golden);
  await setMode(page, "base");
  await openAllocation(page);

  // rmUSDC's Actual is the golden's TVL.
  await expect(vaultUsd(page, 3).first()).toHaveText(usd2(golden.tvlUsd));
  await expect(vaultFact(page, "Combined TVL")).toContainText(usd2(golden.tvlUsd));
  await expect(vaultCol(page, 1)).toHaveText(["90%", "5%", "3%", "2%"]);
  // The allocation golden's policy is the target.
  await expect(vaultCol(page, 2)).toHaveText(["95%", "5%", "0%", "0%"]);
  // Actual 100/0/0/0 against the target 95/5/0/0: (5 + 5) / 2.
  await expect(vaultFact(page, "Tracking error").locator("b")).toHaveText("5%");
  await expect(vaultFact(page, "Recommendation").locator("a")).toHaveAttribute("href", `/swarm/sessions/${LIVE_SESSION.id}`);
  await expect(page.locator("[data-vault-label]")).toHaveCount(0);
  expect(houseBook).toEqual([]);
  await expectNoBrowserErrors(errors);
});

// ── the switch ──────────────────────────────────────────────────────────────

test("?vaults=devnet persists for the tab: a later page with no query stays on the devnet", async ({ page }) => {
  await stubSaved(page);
  await openWithQuery(page, "/vault/rmusdc", "devnet");
  await expect(page.locator("#holdings .rr-stat__v")).toHaveText("$72,000");
  await page.locator(".rr-crumbs a").click();
  await expect(page).toHaveURL(/\/allocation#vaults$/);
  await navigate(page, "/vault/rmagent");
  await expect(page.locator("#holdings .rr-stat__v")).toHaveText("$9,000");
  await expect(page.locator("[data-vault-label]").first()).toHaveText("Devnet test data");
});

test("the switch carries from /allocation to a vault by its link, survives a reload, and ?vaults=base turns it off", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubSaved(page);
  await openWithQuery(page, "/allocation", "devnet");
  await vaultsLoaded(page);
  await expect(vaultFact(page, "Combined TVL")).toContainText("$100,000");

  // Internal links carry no query: the tab's storage holds the mode.
  await page.locator('#vaults tbody a[href="/vault/rmagent"]').click();
  await expect(page).toHaveURL(/\/vault\/rmagent$/);
  await expect(page.locator("h1")).toHaveText("rmAGENT");
  await expect(page.locator("#holdings .rr-stat__v")).toHaveText("$9,000");
  await expect(page.locator("[data-vault-label]").first()).toHaveText("Devnet test data");

  await page.reload();
  await expect(page.locator("#holdings .rr-stat__v")).toHaveText("$9,000");

  await openWithQuery(page, "/allocation", "base");
  await vaultsLoaded(page);
  await expect(vaultFact(page, "Network")).toContainText("Base");
  for (const devnetOnly of ["Devnet test data", "$72,000", "$100,000", "Staging devnet"]) {
    await expect(page.locator("#view")).not.toContainText(devnetOnly);
  }
  await navigate(page, "/vault/rmagent");
  await expect(fact(page, "Status").locator("b")).toHaveText("Not live");
  await expect(page.locator("#holdings")).toHaveCount(0);
  await expectNoBrowserErrors(errors);
});

test("a deep link to a section lands on it once the vault has loaded", async ({ page }) => {
  await stubSaved(page);
  await setMode(page, "devnet");
  await page.goto("/vault/rmusdc" + "#holdings");
  await expect(page.locator("#holdings")).toBeInViewport();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

// ── review states ───────────────────────────────────────────────────────────

test("devnet-unreadable: rmPROTO cannot be read, so no vault has an actual weight", async ({ page }) => {
  await stubSaved(page);
  await setMode(page, "devnet-unreadable");
  await openVault(page, "rmproto");
  await expect(fact(page, "Status")).toContainText("Data unavailable");
  // Its Holdings keep their frame and say so once: History and Activity come
  // from the same read, so they do not repeat it.
  expect(await page.locator("section.rr-sec").evaluateAll((els) => els.map((e) => e.id))).toEqual(["holdings", "allocation", "mechanics"]);
  await expect(page.locator("#holdings .rr-empty__t")).toHaveText("Holdings unavailable");
  await expect(page.locator("#holdings .rr-stat__v")).toHaveCount(0);
  await expect(layerRow(page, "Actual")).toHaveText("—");
  await navigate(page, "/vault/rmusdc");
  await expect(layerRow(page, "Actual")).toHaveText("—");
  // No actual, no gap: the cell stays empty rather than inventing one.
  await expect(gapOf(page).locator(".alp__mv")).toHaveCount(0);
});

test("devnet-unreadable on /allocation: Actual, the combined TVL and the tracking error are missing", async ({ page }) => {
  await stubSaved(page);
  await setMode(page, "devnet-unreadable");
  await openAllocation(page);
  await expect(vaultCol(page, 3)).toHaveText(["—", "—", "—", "—"]);
  await expect(vaultCol(page, 5)).toHaveText(["—", "—", "—", "—"]);
  await expect(vaultFact(page, "Combined TVL").locator("b")).toHaveText("—");
  await expect(vaultFact(page, "Tracking error").locator("b")).toHaveText("—");
  await expect(vaultRows(page).nth(2).locator("th small")).toContainText("Data unavailable");
  // Recommended and the router's target do not depend on the vaults' reads;
  // with no combined TVL, no figure has dollars.
  await expect(vaultCol(page, 1)).toHaveText(["65%", "15%", "15%", "5%"]);
  await expect(vaultCol(page, 2)).toHaveText(["70%", "10%", "15%", "5%"]);
  await expect(vaultUsd(page, 1)).toHaveText(["", "", "", ""]);
  await expect(vaultUsd(page, 2)).toHaveText(["", "", "", ""]);
});

test("devnet-no-recommendation: Recommended and the governance gap are missing, not zero", async ({ page }) => {
  await stubSaved(page);
  await setMode(page, "devnet-no-recommendation");
  await openVault(page, "rmrwa");
  await expect(layerRow(page, "Recommended")).toHaveText("—");
  const gaps = page.locator("#allocation .rr-meta");
  await expect(gaps.locator(".rr-meta__i", { hasText: "Governance gap" })).toContainText("—");
  // On its target: the Gap cell is empty, as a legend leaves a sleeve that
  // did not move, beside the two figures that say so.
  await expect(thisVault(page).locator(".rr-legend__was")).toHaveText("Target 5%");
  await expect(layerRow(page, "Actual")).toHaveText("5%");
  await expect(gapOf(page).locator(".alp__mv")).toHaveCount(0);
  await expect(page.locator("#allocation .rr-dl")).toContainText("No recommendation published");
});

test("devnet-no-recommendation on /allocation: Recommended and the governance gap are missing, the flow gap is not", async ({ page }) => {
  await stubSaved(page);
  await setMode(page, "devnet-no-recommendation");
  await openAllocation(page);
  await expect(vaultCol(page, 1)).toHaveText(["—", "—", "—", "—"]);
  await expect(vaultUsd(page, 1)).toHaveText(["", "", "", ""]);
  await expect(vaultCol(page, 4)).toHaveText(["—", "—", "—", "—"]);
  await expect(vaultRows(page).nth(3).locator("td").nth(4).locator(".alp__mv")).toHaveText("0 pp");
  await expect(vaultFact(page, "Recommendation")).toContainText("No recommendation published");
  // The tracking error is the flow gaps', actual against the target: it
  // stands without a recommendation.
  await expect(vaultFact(page, "Tracking error").locator("b")).toHaveText("2%");
});

test("devnet-stale and devnet-paused show in the facts", async ({ page }) => {
  await stubSaved(page);
  await setMode(page, "devnet-stale");
  await openVault(page, "rmusdc");
  await expect(fact(page, "Read")).toContainText("stale");
  await openWithQuery(page, "/vault/rmusdc", "devnet-paused");
  await expect(fact(page, "Status")).toContainText("Paused");
});

test("devnet-stale and devnet-paused on /allocation: the read says stale, rmUSDC says paused", async ({ page }) => {
  await stubSaved(page);
  await openWithQuery(page, "/allocation", "devnet-stale");
  await vaultsLoaded(page);
  await expect(vaultFact(page, "Read")).toContainText("· stale");
  await openWithQuery(page, "/allocation", "devnet-paused");
  await vaultsLoaded(page);
  await expect(vaultFact(page, "Read")).not.toContainText("stale");
  await expect(vaultRows(page).nth(0).locator("th small")).toContainText("Paused");
  await expect(page.locator(".alp__ring")).not.toContainText("Paused");
});

test("32 holdings show 8 until asked; 3 readings draw as square points", async ({ page }) => {
  await stubSaved(page);
  await setMode(page, "devnet");
  const detail = readJson("data/vaults/devnet/rmusdc.json");
  detail.holdings = Array.from({ length: 32 }, (_, n) => ({
    kind: "token", label: `TOK${n}`, symbol: `TOK${n}`, address: null, balance: null,
    valueUsd: 2250, weightBps: 312.5, targetBps: null, priceSource: null, note: null,
  }));
  detail.history.tvl = detail.history.tvl.slice(0, 3);
  await page.route("**/data/vaults/devnet/rmusdc.json", (route) => route.fulfill(json(detail)));
  await openVault(page, "rmusdc");
  await expect(page.locator(".rr-holdings tbody tr")).toHaveCount(8);
  await page.locator("#holdings .rr-more", { hasText: "Show all 32" }).click();
  await expect(page.locator(".rr-holdings tbody tr")).toHaveCount(32);
  await expect(page.locator("#history polyline")).toHaveCount(0);
  const points = page.locator("#history .rr-area__pt");
  await expect(points).toHaveCount(3);
  expect(await points.evaluateAll((els) => els.map((el) => [
    getComputedStyle(el).backgroundColor, getComputedStyle(el).borderRadius, el.getAttribute("data-mark"),
  ]))).toEqual(Array(3).fill([CATEGORICAL_RGB[0], "0px", "series"]));
});

test("the detail failing leaves the overview's figures and names the gap where the detail would be", async ({ page }) => {
  await stubSaved(page);
  await setMode(page, "devnet");
  await page.route("**/data/vaults/devnet/rmusdc.json", (route) => route.fulfill({ status: 503, body: "down" }));
  await openVault(page, "rmusdc");
  await expect(page.locator("#holdings .rr-stat__v")).toHaveText("$72,000");
  // Named once, in the Holdings frame: History and Activity are the same
  // read, so they are not drawn to repeat it.
  await expect(page.locator("#holdings .rr-empty__t")).toHaveText("Vault detail unavailable");
  await expect(page.locator("#history, #activity")).toHaveCount(0);
  await expect(layerRow(page, "Actual")).toHaveText("72%");
});

// ── the Robot Money Vault subject: one book, grouped by vault ───────────────
// Every /api answers 503 (stubSaved), the swarm's included, so the subject
// and its sessions come from the shipped archive. Off the devnet switch its
// Holdings are the vault feed, here the saved Base snapshot: one reading, not
// the subject's archived book.

test("the vault subject on the devnet: the router and four vaults, one book grouped by vault", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubSaved(page);
  await openWithQuery(page, "/swarm/subjects/robotmoney-vault", "devnet");
  await subjectLoaded(page);
  const hold = page.locator("#holdings");

  // Read from: the router, by its role and holding nothing, then the four
  // vaults. One chain and no addresses: no Chain or Address column; the
  // total's line names the chain once, with the reading's date.
  const sources = hold.locator(".rr-sources tbody tr");
  await expect(sources).toHaveCount(5);
  await expect(hold.locator(".rr-sources thead th:visible")).toHaveText(["Name", "Value"]);
  await expect(sources.nth(0).locator("th")).toHaveText("Router");
  await expect(sources.nth(0).locator("td:nth-of-type(1)")).toHaveText("—");
  await expect(sources.nth(0).locator("a, .rr-dot")).toHaveCount(0);
  await expect(sources.locator("th a")).toHaveText(SYMBOLS);
  for (const [i, v] of SLUGS.entries()) {
    await expect(sources.nth(i + 1).locator("th a")).toHaveAttribute("href", `/vault/${v.slug}`);
    await expect(sources.nth(i + 1).locator("th small")).toHaveText(v.name);
    await expect(sources.nth(i + 1).locator("td:nth-of-type(1)")).toHaveText(usd2(DEVNET.vaults[i].tvlUsd));
  }

  await expect(hold.locator(".rr-stat__v")).toHaveText("$100,000");
  await expect(hold.locator(".rr-stat__sub")).toHaveText("Staging devnet · Sep 17, 2026");
  await expect(hold).not.toContainText("PortfolioRouter");

  // The ring: each vault's value and its share of the book beside the
  // router's applied weight, named as such. No delta: the latest
  // recommendation gives the gap.
  const ring = byVault(page);
  await expect(ring).toHaveCount(4);
  await expect(ring.locator(".rr-legend__l")).toHaveText(SYMBOLS);
  await expect(hold.locator(".rr-legend__head")).toHaveText("VaultValueShareApplied");
  await expect(byVaultValue(page)).toHaveText(DEVNET.vaults.map((r: any) => `Value ${usd2(r.tvlUsd)}`));
  await expect(byVaultTarget(page)).toHaveText(["Applied 70%", "Applied 10%", "Applied 15%", "Applied 5%"]);
  await expect(ring.locator(".alp__mv")).toHaveCount(0);
  await expect(ring.nth(0).locator("b")).toHaveText("Share 72%");
  await expect(hold.locator(".rr-ring figcaption")).toHaveText("Share");

  // A vault opens onto its positions, each a share of the vault, by the
  // names its vault page gives them.
  await hold.locator('.rr-legend__row[data-sleeve-btn="rmproto"]').click();
  const panel = hold.locator("#vault-rmproto");
  const proto = readJson("data/vaults/devnet/rmproto.json");
  await expect(panel.locator("tbody th")).toHaveText(proto.holdings.map((h: any) => h.label));
  await expect(panel.locator(".rr-x__head a")).toHaveAttribute("href", "/vault/rmproto");

  // The positions, grouped under their vault: the groups add up to the book.
  const groups = hold.locator("tr.rr-group");
  await expect(groups).toHaveCount(4);
  await expect(groups.locator("th a")).toHaveText(SYMBOLS);
  for (const g of await groups.all()) expect(await g.locator(":scope > th, :scope > td").count()).toBe(6);
  const values = await groups.locator("td:nth-child(5)").allTextContents();
  expect(values.reduce((s, x) => s + dollars(x), 0)).toBe(100000);
  await expect(hold.locator("tr.rr-in")).not.toHaveCount(0);
  await expect(hold.locator(".rr-positions thead th:visible")).toHaveText(["Position", "Amount", "Price", "Value", "Share"]);
  const usdc = readJson("data/vaults/devnet/rmusdc.json");
  await expect(hold.locator("tr.rr-in").filter({ hasText: "Gauntlet" }).locator("th")).toHaveText(usdc.holdings[0].label);
  await expect(hold.locator("tr.rr-in th").filter({ hasText: /^USDC$/ })).toHaveCount(0);

  // The chart stacks the four vaults with the target drawn over them.
  await expect(hold.locator(".rr-area__head .rr-subhead__h")).toHaveText("Vaults over time");
  await expect(hold.locator(".rr-area__legend li")).toHaveText([...SYMBOLS, "Applied"]);
  await expect(hold.locator(".rr-area__legend li i.is-target")).toHaveCount(1);
  await expect(hold.locator('.rr-area__svg polyline[data-token="target"]')).toHaveCount(3);

  await expect(page.locator("[data-vault-label]")).toHaveCount(1);
  await expect(hold.locator("[data-vault-label]")).toHaveText("Devnet test data");

  // The latest recommendation is the real session: the devnet fixture never
  // reaches it, and its Book and Change columns, which measure the real book,
  // go blank while the book below is the fixture's.
  const latest = page.locator("#latest");
  await expect(latest.locator(".rr-legend__row").first()).toContainText("95%");
  await expect(latest.locator(".rr-legend__was").first()).toContainText("—");
  await expect(latest.locator(".rr-legend__d .alp__mv")).toHaveCount(0);
  await expect(latest).not.toContainText("$72,000");
  // The subject is stated, not the weights or the Base contract.
  await expect(page.locator(".rr-head .sv__lede")).not.toContainText("0x4f83");
  await expect(page.locator(".rr-head .sv__lede")).not.toContainText("95%");
  await expectNoBrowserErrors(errors);
});

test("the vault subject on Base: rmUSDC alone, against the weights in force", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubSaved(page);
  await openWithQuery(page, "/swarm/subjects/robotmoney-vault", "base");
  await subjectLoaded(page);
  const hold = page.locator("#holdings");

  const sources = hold.locator(".rr-sources tbody tr");
  await expect(sources).toHaveCount(1);
  await expect(hold.locator(".rr-sources thead th:visible")).toHaveText(["Name", "Value", "Address"]);
  await expect(sources.locator("th a")).toHaveAttribute("href", "/vault/rmusdc");
  await expect(sources.locator("td a")).toHaveAttribute("href", "https://basescan.org/address/0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd");
  // One reading, the vault feed's: the book is rmUSDC's TVL on the feed's
  // date, as its vault page reads it, not the subject's archived book (its
  // last, $154 on Jun 25).
  await expect(hold.locator(".rr-stat__v")).toHaveText(usd2(SAVED_BASE.tvlUsd));
  await expect(hold.locator(".rr-stat__sub")).toHaveText(`Base · ${day(SAVED_BASE.asOf)}`);
  await expect(sources.locator("td:nth-of-type(1)")).toHaveText(usd2(SAVED_BASE.tvlUsd));
  await expect(hold).not.toContainText("$154");

  // The framework in force since Jun 2, 2026: 95/5/0/0, named as the target.
  // No delta: the latest recommendation above gives the gap, measured its own
  // way, and a second one here would point the other way.
  const ring = byVault(page);
  await expect(ring).toHaveCount(4);
  await expect(hold.locator(".rr-legend__head")).toHaveText("VaultValueShareTarget");
  await expect(byVaultValue(page)).toHaveText([`Value ${usd2(SAVED_BASE.tvlUsd)}`, "Value $0", "Value $0", "Value $0"]);
  await expect(ring.nth(0).locator("b")).toHaveText("Share 100%");
  await expect(byVaultTarget(page)).toHaveText(["Target 95%", "Target 5%", "Target 0%", "Target 0%"]);
  await expect(ring.locator(".alp__mv")).toHaveCount(0);
  await expect(hold.locator(".rr-ring figcaption")).toHaveText("Share");
  const first = page.locator("#latest .rr-legend__row").first();
  await expect(first.locator(".rr-legend__was")).toHaveText("Book 100%");
  await expect(first.locator(".rr-legend__d")).toContainText("−5 pp");

  // The adapters by the names rmUSDC's page gives them, largest first, with
  // no idle USDC to list, and no Notable list restating the weights.
  await expect(hold.locator("tr.rr-in th")).toHaveText(["Gauntlet USDC Prime", "Compound III USDC", "Aave V3 USDC"]);
  await expect(hold).not.toContainText("Notable");

  await expect(hold.locator("tr.rr-group")).toHaveCount(1);
  // A line needs two readings: the chart's frame says there is one.
  await expect(hold.locator(".rr-area__head .rr-subhead__h")).toHaveText("Vaults over time");
  await expect(hold.locator(".rr-area .rr-empty__t")).toHaveText("One reading so far");
  await expect(hold.locator(".rr-area__legend")).toHaveCount(0);
  await expect(page.locator("[data-vault-label]")).toHaveCount(0);
  await expect(page.locator("#view")).not.toContainText("Staging devnet");
  await expectNoBrowserErrors(errors);
});

// ── the colour covenant ─────────────────────────────────────────────────────

// Inside `root`: every element painted in a vault hue (background, SVG fill or
// SVG stroke) declares itself a series mark, every series mark is painted in a
// vault hue, cyan (rmAGENT's hue, and the interface's) never colours a figure,
// nothing carries a gradient, and the marks this work adds are square.
async function covenantFindings(page: Page, root: string): Promise<string[]> {
  return page.evaluate(([sel, HUES]) => {
    const CYAN = ["rgb(0, 229, 255)", "rgb(0, 184, 212)"];
    const SQUARE = ".rr-dot, .rr-legend__row > i, .rr-area__pt, .rr-stat";
    const out: string[] = [];
    const roots = Array.from(document.querySelectorAll(sel as string));
    if (!roots.length) return [`no ${sel}`];
    for (const r of roots) {
      for (const el of [r, ...Array.from(r.querySelectorAll("*"))]) {
        if (!el.getClientRects().length) continue;
        const cs = getComputedStyle(el);
        const tag = `${el.tagName.toLowerCase()}.${(el.getAttribute("class") || "").split(" ")[0]}`;
        if (cs.backgroundImage && cs.backgroundImage !== "none") out.push(`gradient on ${tag}: ${cs.backgroundImage}`);
        if (el.matches(SQUARE) && cs.borderRadius !== "0px") out.push(`rounded ${tag}: ${cs.borderRadius}`);

        const own = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent || "").join("").trim();
        const letters = (own.match(/[A-Za-z]/g) || []).length;
        if (CYAN.includes(cs.color) && /[0-9]/.test(own) && letters <= 2) out.push(`cyan on a figure in ${tag}: "${own}"`);

        const svg = el instanceof SVGElement;
        const paints = [cs.backgroundColor, svg ? cs.fill : "", svg ? cs.stroke : ""];
        const hued = paints.filter((p) => (HUES as string[]).includes(p));
        if (el.getAttribute("data-mark") === "series") {
          if (!hued.length) out.push(`series mark off the vault hues on ${tag}: ${paints.join(" / ")}`);
        } else if (hued.length) {
          out.push(`vault hue with no data-mark on ${tag}: ${hued.join(" / ")}`);
        }
      }
    }
    return out;
  }, [root, CATEGORICAL_RGB] as const);
}

const paintOf = (page: Page, selector: string, prop: "backgroundColor" | "fill" | "stroke") =>
  page.locator(selector).evaluateAll((els, p) => els.map((el) => getComputedStyle(el)[p as "fill"]), prop);

for (const mode of ["devnet", "base"] as const) {
  test(`each vault keeps one hue on /allocation, its page and the vault subject (${mode})`, async ({ page }) => {
    const errors = failOnBrowserErrors(page);
    await stubSaved(page);
    await setMode(page, mode);

    await openAllocation(page);
    await expect(vaultFact(page, "Combined TVL").locator("b")).not.toHaveText("—");
    expect(await paintOf(page, "#vaults tbody .rr-dot", "backgroundColor")).toEqual(CATEGORICAL_RGB);
    expect(await covenantFindings(page, "#vaults")).toEqual([]);

    // rmAGENT is cyan: the one hue the interface also uses.
    const slug = mode === "devnet" ? "rmagent" : "rmusdc";
    const i = SLUGS.findIndex((v) => v.slug === slug);
    await navigate(page, `/vault/${slug}`);
    await expect(page.locator("h1")).toHaveText(SYMBOLS[i]);
    await expect(page.locator("#holdings .rr-stat__v")).not.toHaveText("—");
    expect(await paintOf(page, ".cv--detail .rr-head .rr-dot", "backgroundColor")).toEqual([CATEGORICAL_RGB[i]]);
    expect(new Set(await paintOf(page, "#allocation .rr-legend__row.is-active > i, .rr-holdings .rr-share i", "backgroundColor")))
      .toEqual(new Set([CATEGORICAL_RGB[i]]));
    if (mode === "devnet") expect(await paintOf(page, "#history polyline", "stroke")).toEqual([CATEGORICAL_RGB[i]]);
    expect(await covenantFindings(page, ".cv--detail")).toEqual([]);

    await navigate(page, "/swarm/subjects/robotmoney-vault");
    await subjectLoaded(page);
    const held = mode === "devnet" ? SLUGS : SLUGS.slice(0, 1);
    for (const [n, v] of held.entries()) {
      expect(await paintOf(page, `#holdings .rr-ring circle[data-sleeve="${v.slug}"]`, "stroke")).toEqual([CATEGORICAL_RGB[n]]);
      // The chart's bands need two readings: the devnet fixture's fifteen,
      // not the Base feed's one.
      expect(await paintOf(page, `#holdings .rr-area__svg polygon[data-token="${v.slug}"]`, "fill"))
        .toEqual(mode === "devnet" ? [CATEGORICAL_RGB[n]] : []);
    }
    expect(await paintOf(page, "#holdings tr.rr-group .rr-dot", "backgroundColor")).toEqual(CATEGORICAL_RGB.slice(0, held.length));
    // The target is one neutral line, never a vault's hue.
    for (const stroke of await paintOf(page, '#holdings polyline[data-token="target"]', "stroke")) {
      expect(CATEGORICAL_RGB).not.toContain(stroke);
    }
    expect(await covenantFindings(page, "#holdings")).toEqual([]);
    await expectNoBrowserErrors(errors);
  });
}

// ── copy ────────────────────────────────────────────────────────────────────

// Rendered prose inside `root`: no em dash in a run of words (a lone "—" is
// the missing-value mark), no protection or guarantee claim beyond the risk
// note's "not guaranteed", and nothing that narrates the page.
async function copyFindings(page: Page, root: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    const roots = Array.from(document.querySelectorAll(sel));
    if (!roots.length) return [`no ${sel}`];
    for (const r of roots) {
      const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || !parent.getClientRects().length) continue;
        // A session's rationale is quoted as its author wrote it; the rules
        // are for the page's own copy.
        if (parent.closest(".rr-prose")) continue;
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        if (text.length > 3 && text.includes("—")) out.push(`em dash: "${text}"`);
        if (/principal[- ]protected/i.test(text)) out.push(`protection claim: "${text}"`);
        if (/guarantee/i.test(text) && !/\bnot guaranteed\b/i.test(text)) out.push(`guarantee: "${text}"`);
        if (/\bthis (table|chart|section|page|figure|list)\b|\bshows\b|\bclick/i.test(text)) out.push(`narration: "${text}"`);
      }
    }
    return out;
  }, root);
}

test("the vault copy states facts: no em dash, no guarantee, no narration", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubSaved(page);
  for (const mode of ["base", "devnet"] as const) {
    await openWithQuery(page, "/allocation", mode);
    await vaultsLoaded(page);
    expect(await copyFindings(page, "#vaults, .alp__ring")).toEqual([]);
    for (const slug of ["rmusdc", "rmagent"]) {
      await navigate(page, `/vault/${slug}`);
      await expect(page.locator(".cv--detail h1")).toBeVisible();
      await expect(page.locator("#mechanics .rr-note")).toBeVisible();
      expect(await copyFindings(page, ".cv--detail")).toEqual([]);
    }
  }
  // The risk note says what is not promised, once.
  await expect(page.locator("#mechanics .rr-note")).toHaveText(
    "Vault holdings carry smart contract, liquidity and valuation risk. Capital and returns are not guaranteed.");
  await navigate(page, "/swarm/subjects/robotmoney-vault");
  await subjectLoaded(page);
  expect(await copyFindings(page, "#holdings")).toEqual([]);
  await expectNoBrowserErrors(errors);
});

// ── a desktop and a phone ───────────────────────────────────────────────────

for (const width of [1440, 390]) {
  for (const mode of ["base", "devnet"] as const) {
    test(`at ${width}px (${mode}): /allocation, /vault/rmusdc and the vault subject, no errors and no sideways scroll`, async ({ page }) => {
      const errors = failOnBrowserErrors(page);
      await page.setViewportSize({ width, height: 900 });
      await stubSaved(page);

      await openWithQuery(page, "/allocation", mode);
      await vaultsLoaded(page);
      await expect(vaultFact(page, "Network").locator("b")).toHaveText(mode === "devnet" ? "Staging devnet" : "Base");
      expect(await sideways(page)).toBe(0);
      // On a phone the Vaults table fits: the two gaps give way to the three
      // layers, on the devnet (the router's target) and on Base (the policy's)
      // alike. Nothing hides behind a sideways scroll.
      if (width === 390) {
        await expect(page.locator("#vaults thead th:visible")).toHaveText(["Vault", "Recommended", "Target", "Actual"]);
        const [sw, cw] = await page.locator("#vaults .rr-tablewrap").evaluate((el) => [el.scrollWidth, el.clientWidth]);
        expect(sw).toBeLessThanOrEqual(cw);
      }

      await navigate(page, "/vault/rmusdc");
      await expect(page.locator("#holdings .rr-stat__v")).toHaveText(mode === "devnet" ? "$72,000" : usd2(SAVED_BASE.tvlUsd));
      await expect(page.locator(".rr-holdings")).toBeVisible();
      expect(await sideways(page)).toBe(0);
      // On a phone the vault's Holdings keeps Share and drops Type.
      expect(await page.locator(".rr-holdings thead th").evaluateAll((els) => els.map((e) => getComputedStyle(e).display)))
        .toEqual(width === 390 ? ["table-cell", "none", "table-cell", "table-cell"] : Array(4).fill("table-cell"));

      await navigate(page, "/swarm/subjects/robotmoney-vault");
      await subjectLoaded(page);
      expect(await sideways(page)).toBe(0);
      // A vault's row lines up with the header and the positions under it,
      // column for column, whatever the breakpoint hides.
      const cols = await page.locator("#holdings .rr-positions table").evaluate((t) => {
        const shown = (el: Element) => getComputedStyle(el).display !== "none";
        const left = (el: Element) => Math.round(el.getBoundingClientRect().left);
        return {
          head: Array.from(t.querySelectorAll("thead th")).filter(shown).map(left),
          rows: Array.from(t.querySelectorAll("tr.rr-group, tr.rr-in")).map((tr) => Array.from(tr.children).filter(shown).map(left)),
        };
      });
      // One chain: no Chain column at any width; a phone also drops Price.
      expect(cols.head).toHaveLength(width === 390 ? 4 : 5);
      for (const row of cols.rows) expect(row).toEqual(cols.head);
      await expectNoBrowserErrors(errors);
    });
  }
}
