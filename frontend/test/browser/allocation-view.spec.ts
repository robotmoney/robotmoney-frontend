// Render spec for /allocation, the product sheet (RM-115), and its Vaults
// section (docs/plans/vault-pages.md).
//
// The page this replaced reported two pools of money under one heading and
// read four dashboard feeds. RM-115 splits them: the allocation is a POLICY
// and this page is the policy and the four vaults that carry it out. The house
// book (wallet-balances / wallet-sleeves) belongs to RM-103 and is not read
// here at all — the first test below asserts that as the absence of the
// REQUEST, because a page that fetched the house book and merely declined to
// print it would still be one edit from printing it again.
//
// Same harness pattern as the spec it replaces: the SPA and the view HTML are
// served by the backend at baseURL, the vendor CDN scripts are fulfilled from
// node_modules, and every live surface is stubbed:
//   - GET /api/dashboards/robotmoney-vaults → 404: the four-vault route is not
//     served yet, so lib/vault-source.js reads the Base feed below;
//   - GET /api/dashboards/vault-economics → the COMMITTED GOLDEN
//     (goldens/api-goldens.json), the single source of truth per
//     docs/architecture.md's preview section, or a degraded variant of it;
//   - GET /api/dashboards/allocation → the committed golden: the policy the
//     ring draws, whose sleeve targets are also the vaults' Target, since
//     nothing on Base applies weights (RM-115);
//   - GET /api/swarm/sessions → an inline stub (the golden's sessions are on
//     other portfolios, and the allocation's own published sessions are what
//     the Vaults section's Recommended and the latest recommendation beside
//     the ring read).
// The page is served from a local host, so the mock-data switch applies; no
// test here sets it, so every one runs in base mode. The devnet and review
// states, and each vault's own page, are vault-pages.spec.ts's.
//
// Assertions are on the RENDERED page — text and computed styles — never on
// the source. Two real defects on the committee tree were invisible in the CSS
// and obvious in getComputedStyle.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { navigate } from "./navigation.ts";

// lib/chart-theme.js CATEGORICAL, as the browser reports it. Written out
// rather than imported so a silent edit to the palette shows up here as a
// failing render rather than as two files agreeing with each other.
const CATEGORICAL_RGB = [
  "rgb(16, 185, 129)",  // emerald — Pool, the value anchor
  "rgb(0, 229, 255)",   // cyan    — Beam
  "rgb(232, 166, 64)",  // sand
  "rgb(126, 136, 158)", // slate   — neutral secondary
  "rgb(255, 122, 41)",  // beacon
  "rgb(95, 179, 161)",  // teal
  "rgb(156, 255, 210)", // mint
];

const vendorScripts = {
  "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js":
    "node_modules/alpinejs/dist/cdn.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js":
    "node_modules/chart.js/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/p5@1.11.2/lib/p5.min.js":
    "node_modules/p5/lib/p5.min.js",
};

interface VaultEconomicsAdapter {
  name: string; address: string; configured?: boolean; balanceUsd: number | null;
  balanceObservedAt?: string | null; provenance?: string;
}
interface VaultEconomics {
  asOf: string; stale: boolean; source?: "live" | "stub"; tvlUsd: number | null; sharePrice: number | null;
  totalShares: number | null; idleUsdc: number | null; apy7d: number | null;
  adapters: VaultEconomicsAdapter[];
}
interface AllocationFramework {
  strategy: { label: string; targetPct: number }[];
  buckets: { key: string; label: string; items: { label: string; targetPct: number }[] }[];
  asOf: string; source: string; managed: boolean;
}

function loadGolden<T>(route: string): T {
  const goldens = JSON.parse(readFileSync(join(process.cwd(), "goldens/api-goldens.json"), "utf8")) as {
    routes: Record<string, unknown>;
  };
  const payload = goldens.routes[route];
  if (!payload) throw new Error(`no ${route} golden — run \`bun run goldens:update\``);
  return payload as T;
}

// One published session on the allocation subject. The committed sessions
// golden carries woon/mav rows only, so the allocation's own history has to be
// stubbed for the "latest recommendation" line to have anything to read.
function allocationSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "8f0d6c21-4a5e-4a1c-9f2b-7c1de2a44b10",
    date: "2026-09-01",
    subjectId: "robotmoney-allocation",
    subjectName: "Robot Money Allocation",
    state: "published",
    windowClosesAt: "2026-09-01T22:45:00.000Z",
    publishedAt: "2026-09-01T23:20:00.000Z",
    regimeSummary: { regime: "risk_on", composite: 0.5241, composite_percentile: 0.6151 },
    synthesis: "",
    swarmRecommendation: {
      type: "position_actions",
      quorum: { absent: 1, active: 5, submitted: 4, participation: 0.8 },
      stances: { bullish: 1, neutral: 1, cautious: 2 },
      actions: [{ token: "USDC", action: "rotate", rationale: "Route the next tranche into rmUSDC." }],
      rationale: "Swarm holds 95/5/0/0 with composite at the 62nd percentile; no tilt licensed.",
    },
    generatedAt: "2026-09-01T23:19:00.000Z",
    ...overrides,
  };
}

// The same session publishing the four sleeve weights: what the Vaults
// section's Recommended column reads.
function weightsSession() {
  return allocationSession({
    swarmRecommendation: {
      type: "bucket_weights",
      weights: { conservative_defi_yield: 0.9, agent_tokens: 0.05, protocol_tokens: 0.03, real_world_assets: 0.02 },
    },
  });
}

async function stubEnvironment(
  page: Page,
  {
    vault,
    framework,
    sessions,
  }: {
    vault?: VaultEconomics | null;
    framework?: AllocationFramework | null;
    sessions?: unknown[] | null;
  } = {},
) {
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({
      path: join(process.cwd(), file),
      contentType: "application/javascript",
    }));
  }
  const json = (payload: unknown) => ({
    status: 200, contentType: "application/json", body: JSON.stringify(payload),
  });
  // The four-vault route is not served yet: its absence sends the page to the
  // Base feed, the way production reads today.
  await page.route("**/api/dashboards/robotmoney-vaults**", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) }));
  // `null` means "this feed is DOWN", which is a different state from "this
  // feed returned an empty payload" and the page has to distinguish them.
  await page.route("**/api/dashboards/vault-economics", (route) =>
    (vault === null ? route.fulfill({ status: 503, body: "down" }) : route.fulfill(json(vault ?? goldenVault()))));
  await page.route("**/api/dashboards/allocation", (route) =>
    (framework === null ? route.fulfill({ status: 503, body: "down" }) : route.fulfill(json(framework ?? goldenFramework()))));
  await page.route("**/api/swarm/sessions**", (route) =>
    (sessions === null
      ? route.fulfill({ status: 503, body: "down" })
      : route.fulfill(json({ sessions: sessions ?? [allocationSession()], nextCursor: null }))));
}

const goldenVault = () => loadGolden<VaultEconomics>("/api/dashboards/vault-economics");
const goldenFramework = () => loadGolden<AllocationFramework>("/api/dashboards/allocation");

function failOnBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  // The harness's own artifact, not the page's: these specs load the shell by
  // FILE path (`/index.html`) rather than by route, so the router's first
  // render resolves "/index.html" through the catch-all to
  // `/views/index.html.html` and gets a 404 before any navigate() runs. It is
  // the same on every spec that boots this way and says nothing about the view
  // under test.
  const HARNESS_404 = "views/index.html.html";
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (text.includes(HARNESS_404)) return;
    // Chrome reports a failed subresource without naming it in the message, so
    // the bare resource-load error that follows that 404 is filtered by shape.
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

// Whole dollars, as vault-data's fmtUsd states a book.
function usd2(v: number | null): string {
  return v == null ? "—" : "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
// A weight in whole dollars at a combined TVL, and a gap in dollars: the
// difference of the two rounded figures beside it, signed.
const usdAt = (pct: number, tvl: number) => Math.round((pct / 100) * tvl);
const signedUsd = (d: number) => (d === 0 ? "$0" : `${d > 0 ? "+" : "−"}${usd2(Math.abs(d))}`);

// ── the constraint a reviewer checks first ──────────────────────────────────

test("the product sheet never requests the house book (RM-115, RM-103)", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  const houseBook: string[] = [];
  await stubEnvironment(page);
  // Registered BEFORE the navigation and left in place for the whole render, so
  // a late fetch fired after the first paint is caught too.
  await page.route("**/api/dashboards/wallet-*", (route) => {
    houseBook.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await expect(page.locator(".alp__ring .rr-legend__row").first()).toBeVisible();
  await page.waitForTimeout(300);

  expect(houseBook, "wallet-balances / wallet-sleeves are the house book (RM-103)").toEqual([]);
  // And nothing on the page prints the house book's own vocabulary.
  await expect(page.locator("section.alp")).not.toContainText("AUM");
  await expect(page.locator("section.alp")).not.toContainText("Agent Wallet");
  await expectNoBrowserErrors(errors);
});

// ── the live bindings ───────────────────────────────────────────────────────

// The Vaults section's rows, and one row's figures: each cell is its figure,
// then its whole dollars at the combined TVL under it.
const vaultRows = (page: Page) => page.locator("#vaults tbody tr");
const figures = (page: Page, i: number) => vaultRows(page).nth(i).locator("td > span:first-child");
const vaultFact = (page: Page, label: string) => page.locator("#vaults .rr-meta .rr-meta__i").filter({ hasText: label });
const VAULT_HEADS = ["Vault", "Recommended", "Target", "Actual", "Governance gap", "Flow gap"];
// The overview has answered once the combined TVL has a value.
async function vaultsLoaded(page: Page) {
  await expect(vaultRows(page)).toHaveCount(4);
  await expect(vaultFact(page, "Combined TVL").locator("b")).not.toHaveText("—");
}

// Where the recommendation meets execution. Production today is rmUSDC alone
// on Base, read from vault-economics; the other three vaults are not on Base.
// Nothing on Base applies weights, so the target is the published policy's
// (the allocation golden, 95/5/0/0): Recommended, Target and Actual, the
// governance gap between the first two and the flow gap between the last
// two. Asset-level holdings are on /vault/rmusdc, not here.
test("the Vaults section binds rmUSDC to the golden and states the other three as not live on Base", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  const vault = goldenVault();
  await stubEnvironment(page, { vault });
  await page.goto("/index.html");
  await navigate(page, "/allocation");

  const rows = vaultRows(page);
  await expect(rows).toHaveCount(4);
  await expect(rows.locator("th a")).toHaveText(["rmUSDC", "rmAGENT", "rmPROTO", "rmRWA"]);
  for (const [i, slug] of ["rmusdc", "rmagent", "rmproto", "rmrwa"].entries()) {
    await expect(rows.nth(i).locator("th a")).toHaveAttribute("href", `/vault/${slug}`);
  }
  // With no recommendation, Recommended and the governance gap are missing,
  // not zero; the flow gap is actual against the policy's target.
  await expect(page.locator("#vaults thead th")).toHaveText(VAULT_HEADS);
  await expect(figures(page, 0)).toHaveText(["—", "95%", "100%", "—", "+5 pp"]);
  // rmUSDC's Actual is the golden's TVL; a missing figure has no dollars.
  await expect(rows.nth(0).locator("td").nth(2).locator("small")).toHaveText(usd2(vault.tvlUsd));
  await expect(rows.nth(0).locator("td").nth(0).locator("small")).toHaveText("");
  for (const i of [1, 2, 3]) {
    // "Not live": the Network fact above the table names Base.
    await expect(rows.nth(i).locator("th small")).toContainText("Not live");
    await expect(rows.nth(i).locator("th small")).not.toContainText("on Base");
  }
  await expect(figures(page, 1)).toHaveText(["—", "5%", "0%", "—", "−5 pp"]);
  await expect(figures(page, 2)).toHaveText(["—", "0%", "0%", "—", "0 pp"]);
  await expect(figures(page, 3)).toHaveText(["—", "0%", "0%", "—", "0 pp"]);
  await expect(rows.nth(0).locator("th small")).toHaveText("Conservative DeFi Yield");

  await expect(vaultFact(page, "Combined TVL")).toContainText(usd2(vault.tvlUsd));
  // No "Vaults live" count: each row already says which vault is not live.
  await expect(vaultFact(page, "Vaults live")).toHaveCount(0);
  await expect(vaultFact(page, "Network")).toContainText("Base");
  // The only published session carries position actions, not weights.
  await expect(vaultFact(page, "Recommendation")).toContainText("No recommendation published");
  await expect(page.locator(".alp__rec")).toHaveText("No recommendation published");
  // The tracking error is the flow gaps', so it stands without a
  // recommendation: (5 + 5) / 2.
  await expect(vaultFact(page, "Tracking error").locator("b")).toHaveText("5%");
  // A live chain read carries no data label.
  await expect(page.locator("[data-vault-label]")).toHaveCount(0);

  // The meta rail's Contract became the router, which holds nothing and is
  // not on Base.
  await expect(page.locator(".alp__meta")).toContainText("Router");
  await expect(page.locator(".alp__meta")).toContainText("Not live on Base");
  await expect(page.locator(".alp__meta")).not.toContainText("Deployed");

  // #vault, cited by the deposit skill and the swarm's vault row, lands on the
  // Vaults heading; no holdings table or NAV line is left on this page.
  await expect(page.locator("#vaults #vault")).toBeVisible();
  await expect(page.locator(".alp__hold, .alp__pending")).toHaveCount(0);
  await expectNoBrowserErrors(errors);
});

// Recommended is the latest published robotmoney-allocation recommendation,
// laid over the Base feed and set against the target in force, the policy's:
// the governance gap is target minus recommended, the flow gap actual minus
// target, and the tracking error half the absolute flow gaps. Each figure's
// dollars are its weight of the combined TVL, Actual's the vault's own TVL,
// and a gap's the difference of the two beside it. Every number is derived:
// nothing here may be a copywritten constant.
test("a published recommendation sets Recommended, the gaps and the tracking error", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  const session = weightsSession();
  const vault = goldenVault();
  const target = goldenFramework().strategy.map((s) => s.targetPct);
  await stubEnvironment(page, { vault, sessions: [session] });
  await page.goto("/index.html");
  await navigate(page, "/allocation");

  const rows = vaultRows(page);
  await expect(page.locator("#vaults thead th")).toHaveText(VAULT_HEADS);
  await expect(rows.locator("td:nth-of-type(1) > span")).toHaveText(["90%", "5%", "3%", "2%"]);
  await expect(rows.locator("td:nth-of-type(2) > span")).toHaveText(target.map((t) => `${t}%`));
  // The target 95/5/0/0 against 90/5/3/2, and actual 100/0/0/0 against the
  // target.
  await expect(rows.locator("td:nth-of-type(4) .alp__mv")).toHaveText(["+5 pp", "0 pp", "−3 pp", "−2 pp"]);
  await expect(rows.locator("td:nth-of-type(5) .alp__mv")).toHaveText(["+5 pp", "−5 pp", "0 pp", "0 pp"]);
  // (5 + 5 + 0 + 0) / 2.
  await expect(vaultFact(page, "Tracking error").locator("b")).toHaveText("5%");

  const tvl = vault.tvlUsd!;
  const usd = { recommended: usdAt(90, tvl), target: usdAt(target[0], tvl), actual: Math.round(tvl) };
  await expect(rows.nth(0).locator("td > small")).toHaveText([
    usd2(usd.recommended), usd2(usd.target), usd2(usd.actual),
    signedUsd(usd.target - usd.recommended), signedUsd(usd.actual - usd.target),
  ]);

  const rec = vaultFact(page, "Recommendation").locator("a");
  await expect(rec).toHaveText("Sep 1, 2026");
  await expect(rec).toHaveAttribute("href", `/swarm/sessions/${session.id}`);
  // Beside the ring, the same recommendation and the way to its session. It
  // is the newest allocation session, so nothing held the target since.
  const latest = page.locator(".alp__rec");
  await expect(latest.locator(".rr-k")).toHaveText("Latest recommendation");
  await expect(latest.locator(".rr-meta")).toHaveCount(0);
  await expect(latest.locator(".rr-cta")).toHaveText("Read the Sep 1, 2026 session→");
  await expect(latest.locator(".rr-cta")).toHaveAttribute("href", `/swarm/sessions/${session.id}`);
  await expectNoBrowserErrors(errors);
});

// A newer allocation session that published no weights held the target: the
// panel beside the ring names it above the recommendation that stands.
test("a later session with no weights reads as the target held since the last recommendation", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  const held = allocationSession({ id: "3c1f9a70-2d4b-4e8a-9b6c-51e0f7a2d913", date: "2026-09-08", publishedAt: "2026-09-08T23:20:00.000Z" });
  const standing = weightsSession();
  await stubEnvironment(page, { sessions: [held, standing] });
  await page.goto("/index.html");
  await navigate(page, "/allocation");

  const latest = page.locator(".alp__rec");
  const facts = latest.locator(".rr-meta .rr-meta__i");
  await expect(facts).toHaveText(["Latest session Sep 8, 2026", "Recommendation Target held", "Since Sep 1, 2026"]);
  await expect(facts.first().locator("a")).toHaveAttribute("href", `/swarm/sessions/${held.id}`);
  await expect(latest.locator(".rr-cta")).toHaveAttribute("href", `/swarm/sessions/${standing.id}`);
  // The Vaults section's Recommended is the standing recommendation's.
  await expect(vaultRows(page).locator("td:nth-of-type(1) > span")).toHaveText(["90%", "5%", "3%", "2%"]);
  await expectNoBrowserErrors(errors);
});

// A sleeve's recipe opens from the ring: its target constituents, what the
// sleeve is, and the vault that implements it by symbol, to its page. What
// the vault holds is on that page, and its status is the Vaults table's.
test("a sleeve's recipe opens from the ring and names its vault, with no status and no holdings", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  const framework = goldenFramework();
  await stubEnvironment(page, { framework });
  await page.goto("/index.html");
  await navigate(page, "/allocation");

  const rows = page.locator(".alp__ring .rr-legend__row");
  await expect(rows).toHaveCount(4);
  await rows.nth(1).click();
  const panel = page.locator(".alp__ring .rr-x__panel");
  await expect(panel).toBeVisible();
  // Exactly the symbol, to its page.
  const vault = panel.locator(".rr-x__head a");
  await expect(vault).toHaveText("rmAGENT");
  expect(await vault.innerText()).toBe("rmAGENT");
  await expect(vault).toHaveAttribute("href", "/vault/rmagent");
  await expect(panel).not.toContainText("Not live");
  await expect(panel).not.toContainText("Status");
  // What the sleeve is, one hover away, and every constituent it targets.
  await expect(panel.locator(".rm-tip__bub")).toContainText("$ROBOTMONEY");
  await expect(panel.locator("tbody tr")).toHaveCount(framework.buckets[1].items.length);
  await expectNoBrowserErrors(errors);
});

test("the ring draws one arc per funded sleeve, on the categorical palette, not normalised to its own sum", async ({ page }) => {
  const framework = goldenFramework();
  await stubEnvironment(page, { framework });
  await page.goto("/index.html");
  await navigate(page, "/allocation");

  // The ring every swarm page draws (lib/sleeve-explorer.js, ringSvg).
  const ring = page.locator(".alp__ring .rr-ring");
  await expect(ring).toBeVisible();

  // One arc per sleeve with a target above zero, and none for a sleeve without
  // one: 95/5/0/0 is two arcs, and the sliver is the truth about this
  // allocation rather than something to round away.
  const funded = framework.strategy.filter((row) => row.targetPct > 0);
  const arcs = ring.locator("circle[data-sleeve]");
  await expect(arcs).toHaveCount(funded.length);

  // Arcs come from lib/chart-theme.js CATEGORICAL, separated by HUE, keyed on
  // POSITION, so a sleeve keeps its hue when another one's weight changes.
  const strokes = await arcs.evaluateAll((els) => els.map((el) => getComputedStyle(el).stroke));
  expect(strokes).toEqual(CATEGORICAL_RGB.slice(0, funded.length));

  // The track underneath is the full ring, so a policy that does not add to
  // 100 shows the remainder rather than being rescaled to look complete; at
  // rest the centre names what the ring is, or the remainder when there is one.
  await expect(ring.locator("circle:not([data-sleeve])")).toHaveCount(1);
  await expect(ring.locator("figcaption")).toHaveText("In force");

  // The legend keys every sleeve, funded or not, and a sleeve at zero keeps
  // its hue: it holds nothing, which is not the same as having no identity.
  const legend = page.locator(".alp__ring .rr-legend__row");
  await expect(legend).toHaveCount(framework.strategy.length);
  await expect(legend.first()).toContainText(framework.strategy[0].label);
  // A row carries its figures and nothing under them: what a sleeve holds is
  // its recipe, opened from the row.
  await expect(legend.locator("small")).toHaveCount(0);
  const swatchFill = await legend.nth(2).locator("> i").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(CATEGORICAL_RGB).toContain(swatchFill);

  // Hovering a sleeve names it in the centre, as on /swarm.
  await legend.first().hover();
  await expect(ring.locator("figcaption")).toContainText(framework.strategy[0].label);
});

// Where the money is, beside the target: each sleeve's vault's share of the
// combined TVL and the gap in points. On Base only rmUSDC is live, holding
// everything against a 95% target.
test("the ring's legend sets each sleeve's actual share against its target", async ({ page }) => {
  await stubEnvironment(page, { sessions: [weightsSession()] });
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await vaultsLoaded(page);

  await expect(page.locator(".alp__ring .rr-legend__head")).toHaveText("SleeveTargetActualGap");
  const rows = page.locator(".alp__ring .rr-legend__row");
  await expect(rows.nth(0).locator("> b")).toHaveText("95%");
  await expect(rows.nth(0).locator(".rr-legend__was")).toHaveText("Actual 100%");
  await expect(rows.nth(0).locator(".rr-legend__d")).toHaveText("Gap +5 pp");
  await expect(rows.nth(1).locator(".rr-legend__d")).toHaveText("Gap −5 pp");
  // No gap, no figure: an empty cell rather than "0 pp".
  await expect(rows.nth(2).locator(".rr-legend__d .alp__mv")).toHaveCount(0);
  // The four vaults' combined holdings are the vault subject's.
  await expect(page.locator('#vaults a.rr-meta__lnk')).toHaveText("Combined holdings");
  await expect(page.locator('#vaults a.rr-meta__lnk')).toHaveAttribute("href", "/swarm/subjects/robotmoney-vault#holdings");
});

// Constituents restart at the front of the palette inside their own sleeve,
// keyed on their position in the POLICY, so a name keeps its hue in the bar
// and in the list under it whatever order a feed returns.
test("a constituent keeps its hue in its sleeve's recipe, and reads against the sleeve and the whole", async ({ page }) => {
  const framework = goldenFramework();
  await stubEnvironment(page, { framework });
  await page.goto("/index.html");
  await navigate(page, "/allocation");

  await page.locator(".alp__ring .rr-legend__row").first().click();
  const assets = page.locator(".alp__ring .rr-x__assets tbody tr");
  const items = framework.buckets[0].items;
  await expect(assets).toHaveCount(items.length);
  const fills = await assets.locator("th i").evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).backgroundColor));
  expect(fills).toEqual(CATEGORICAL_RGB.slice(0, items.length));
  // % of sleeve is the policy's own figure; % of allocation is it times the
  // sleeve's target.
  const pct = (v: number) => `${v.toFixed(1).replace(/\.0$/, "")}%`;
  const sleeve = Number(framework.strategy[0].targetPct);
  const first = Number(items[0].targetPct);
  await expect(assets.first().locator("td").nth(0)).toHaveText(pct(first));
  await expect(assets.first().locator("td").nth(1)).toHaveText(pct((first * sleeve) / 100));
});

// A vault wears its sleeve's hue: the Vaults table's dot, the sleeve's arc
// and its legend swatch are one colour (lib/vault-data.js VAULTS[i].color
// === CATEGORICAL[i]).
test("each vault keeps its sleeve's hue, square", async ({ page }) => {
  await stubEnvironment(page, { sessions: [weightsSession()] });
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await vaultsLoaded(page);

  const dots = page.locator("#vaults tbody .rr-dot");
  const dotStyles = await dots.evaluateAll((els) =>
    els.map((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).borderRadius]));
  expect(dotStyles).toEqual(CATEGORICAL_RGB.slice(0, 4).map((c) => [c, "0px"]));
  const swatches = await page.locator(".alp__ring .rr-legend__row > i").evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).backgroundColor));
  expect(swatches).toEqual(CATEGORICAL_RGB.slice(0, 4));
});

// The section that replaced the bullet bars. Every row reads flat today, and
// that is the finding rather than a reason to hide the table: the baseline is
// the row in force, because `allocation_framework` holds exactly one.
test("the change ledger reports was, now and a flat move for every sleeve", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  const framework = goldenFramework();
  await stubEnvironment(page, { framework });
  await page.goto("/index.html");
  await navigate(page, "/allocation");

  const rows = page.locator(".alp__tbl--led tbody tr");
  await expect(rows).toHaveCount(framework.strategy.length);
  for (const [i, sleeve] of framework.strategy.entries()) {
    const row = rows.nth(i);
    await expect(row).toContainText(sleeve.label);
    // Was and now are the same row today, and the page says so in the copy
    // rather than implying it read two versions.
    const cells = await row.locator("td").allTextContents();
    expect(cells[1].trim()).toBe(cells[2].trim());
    await expect(row.locator(".alp__mv")).toHaveText("—");
    await expect(row.locator(".alp__mv")).toHaveClass(/flat/);
  }
  // A flat move is muted, never coloured: green on a change that did not
  // happen would be a claim.
  const flatColour = await rows.first().locator(".alp__mv")
    .evaluate((el) => getComputedStyle(el).color);
  expect(flatColour).toBe("rgb(143, 154, 176)");

  // Four columns and no fifth. The Note column carried vault status, which
  // the Vaults table states.
  await expect(page.locator("#what-changed thead th")).toHaveCount(4);
  await expectNoBrowserErrors(errors);
});

// The page reports the allocation. It does not explain the swarm that sets it
// and it does not recap one session's metadata: /swarm and /regime are their
// own pages and the nav reaches both. The last-review panel restated a
// session's quorum beside a table of four flat rows, which is one finding
// stated twice.
test("the page reports the allocation and narrates neither the swarm nor the backend", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubEnvironment(page, { sessions: [allocationSession()] });
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await expect(page.locator(".alp__ring .rr-legend__row").first()).toBeVisible();

  // The latest recommendation is the panel beside the ring, as /swarm sets
  // it; no second section repeats it.
  await expect(page.locator(".alp__latest")).toHaveCount(0);
  await expect(page.locator(".alp__rec")).toHaveCount(1);
  // The one link out of the ledger: every session that has reviewed these
  // weights. The allocation's own decision log is not built, so that is the
  // swarm's page for the subject and not a page of this branch's own.
  await expect(page.locator('#what-changed a[href="/swarm/subjects/robotmoney-allocation"]'))
    .toBeVisible();

  // The mechanism CLOSES the page. It led it for one commit, where it put a
  // third page's subject between the headline and the weights.
  const how = page.locator("#how-weights-are-set");
  for (const step of ["Regime", "Takes", "Consensus"]) {
    await expect(how).toContainText(step);
  }
  // No role nobody holds: the mechanism describes the analysts that file.
  await expect(how).not.toContainText("Validators");
  await expect(how.locator('a[href="/regime"]')).toBeVisible();
  await expect(how.locator('a[href="/swarm"]')).toBeVisible();
  // Last, and after the section it explains.
  const isLast = await how.evaluate((el) => el === el.parentElement?.lastElementChild);
  expect(isLast, "the mechanism must be the last section on the page").toBe(true);
  const [changed, mech] = await Promise.all([
    page.locator("#what-changed").boundingBox(),
    how.boundingBox(),
  ]);
  expect(mech!.y).toBeGreaterThan(changed!.y);
  // Schema names, table names and route behaviour are not the reader's
  // business. The page says what is true about the allocation; how the backend
  // stores or types it is ours to know.
  const copy = (await page.locator("section.alp").innerText()).toLowerCase();
  for (const leak of ["position_actions", "allocation_framework", "vault_share_price_history", "public route"]) {
    expect(copy, `implementation detail leaked into the page: ${leak}`).not.toContain(leak);
  }
  await expectNoBrowserErrors(errors);
});

// ── degradation, one state per test ─────────────────────────────────────────
// The vault feed's per-position states (a stale adapter read, a scheduler
// catch-up) are on /vault/rmusdc beside the positions they describe
// (vault-pages.spec.ts). Here the whole section carries its source.

test("a stub vault feed is labelled on the Vaults section, not presented as a chain read (issue #50)", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubEnvironment(page, { vault: { ...goldenVault(), source: "stub" } });
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await expect(page.locator("[data-vault-label]")).toHaveCount(1);
  await expect(page.locator("#vaults [data-vault-label]")).toHaveText("Stub data");
  await expectNoBrowserErrors(errors);
});

test("a stale vault feed says so beside the time it was read", async ({ page }) => {
  await stubEnvironment(page, { vault: { ...goldenVault(), stale: true } });
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await expect(vaultFact(page, "Read")).toContainText("Jul 30, 2026 16:20 UTC · stale");
});

// This spec's host is a local one, so a Base feed that is down falls back to
// the saved snapshot, and says so. A production host says "Vault data
// unavailable" instead (scripts/tests/unit/vault-data.test.ts).
test("the vault feed down: the saved Base snapshot, labelled as such", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubEnvironment(page, { vault: null });
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await expect(page.locator("#vaults [data-vault-label]")).toHaveText("Saved Base snapshot");
  // rmUSDC's Actual, in dollars, is the snapshot's TVL.
  await expect(vaultRows(page).nth(0).locator("td").nth(2).locator("small")).toHaveText("$200");
  await expectNoBrowserErrors(errors);
});

test("no vault read at all: the section names the gap and prints no figure", async ({ page }) => {
  await stubEnvironment(page, { vault: null });
  await page.route("**/data/vaults/**", (route) => route.fulfill({ status: 404, body: "gone" }));
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await expect(page.locator("#vaults .alp__empty")).toHaveText("Vault data unavailable");
  await expect(page.locator("#vaults .rr-meta")).toBeHidden();
  await expect(page.locator("#vaults table")).toBeHidden();
  await expect(page.locator("[data-vault-label]")).toHaveCount(0);
  await expect(page.locator(".alp__meta")).toContainText("Router —");
  // The policy does not depend on the vaults.
  await expect(page.locator(".alp__ring circle[data-sleeve]").first()).toBeVisible();
});

// The chip is the one place on this page it would be easy to lie, so it gets
// its own test per state. `source` on this DTO is the BASE RPC source and
// `managed` is hardcoded true, so neither may drive it: keying on either one
// would print "swarm-managed" on production for a row the seed wrote.
test("the state chip reads seeded whatever source and managed say", async ({ page }) => {
  for (const framework of [
    { ...goldenFramework(), source: "stub", managed: true },
    { ...goldenFramework(), source: "live", managed: true },
  ]) {
    await stubEnvironment(page, { framework });
    await page.goto("/index.html");
    await navigate(page, "/allocation");
    await expect(page.locator(".alp__chip")).toHaveText("seeded");
    // The date the weights have been in force is a fact about the weights, so
    // it is a rail item and not a sentence restating the rail beside it.
    await expect(page.locator(".alp__meta")).toContainText("In force since");
    // The month-first date every other date on the page carries.
    await expect(page.locator(".alp__meta")).toContainText(/In force since\s*[A-Z][a-z]{2} \d{1,2}, \d{4}/);
  }
});

test("the chip flips to swarm-managed the moment a row carries a session's provenance", async ({ page }) => {
  // The field RM-115's closing backend ask has to add. Nothing writes it
  // today, which is why the chip reads "seeded"; this pins that the chip is
  // derived and not hardcoded, so the flip needs no edit here.
  await stubEnvironment(page, {
    framework: {
      ...goldenFramework(),
      source: "live",
      provenance: { sessionId: "8f0d6c21-4a5e-4a1c-9f2b-7c1de2a44b10", receiptDigest: "sha256:deadbeef" },
    } as unknown as AllocationFramework,
  });
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await expect(page.locator(".alp__chip")).toHaveText("swarm-managed");
});

test("the rendered page keeps the Beam/Pool/Beacon covenant", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await expect(page.locator(".alp__ring .rr-legend__row").first()).toBeVisible();

  const findings = await page.evaluate((CATEGORICAL: string[]) => {
    const CYAN = ["rgb(0, 229, 255)", "rgb(0, 184, 212)"];
    const BEACON = "rgb(255, 122, 41)";
    const out: string[] = [];
    const root = document.querySelector("section.alp");
    if (!root) return ["no .alp root"];
    const digits = /[0-9]/;

    for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const tag = `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]}`;

      // No gradients, no glow. Both are decor the covenant does not spend.
      if (cs.backgroundImage && cs.backgroundImage !== "none") {
        out.push(`gradient/background-image on ${tag}: ${cs.backgroundImage}`);
      }
      if (cs.boxShadow && cs.boxShadow !== "none") out.push(`box-shadow on ${tag}: ${cs.boxShadow}`);
      if (cs.textShadow && cs.textShadow !== "none") out.push(`text-shadow on ${tag}: ${cs.textShadow}`);

      // Cyan never touches a figure. Checked on the element's OWN text, so a
      // container inheriting nothing is not blamed for a child's digits.
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent || "").join("").trim();
      // A FIGURE, not merely a string with a digit in it: "Aave V3 USDC" is a
      // name and may carry the interface hue, "$200" and "95%" may not. The
      // rule is digits present and at most two letters, which admits a unit
      // suffix (pp, %) and excludes every label on the page.
      const letters = (own.match(/[A-Za-z]/g) || []).length;
      if (CYAN.includes(cs.color) && digits.test(own) && letters <= 2) {
        out.push(`cyan on a figure in ${tag}: "${own.slice(0, 40)}"`);
      }
      // Beacon is never a run of TYPE either. It marks a point of attention,
      // and colouring five characters of drift with it made a designed gap
      // read as an alarm.
      if (cs.color === BEACON && own.length > 2) {
        out.push(`beacon as type on ${tag}: "${own.slice(0, 40)}"`);
      }
      // A SERIES MARK is a data encoding, not interface chrome, and the two
      // rules below do not apply to it: lib/chart-theme.js spends Beam and
      // Beacon as slice hues on purpose, so that seven categories stay
      // tellable apart, and the mini bucket pies on this site already do it.
      // The exemption is not a hole, because it is paired with the STRONGER
      // assertion underneath: a mark that opts out of the geometry rules must
      // be painted from the sanctioned palette and nothing else. An element
      // cannot use data-mark to smuggle in a hue of its own.
      if (el.getAttribute("data-mark") === "series") {
        // A box by its background, a shape by its fill, and a ring's arc,
        // which is a stroked circle with no fill, by its stroke.
        const fill = cs.backgroundColor !== "rgba(0, 0, 0, 0)" ? cs.backgroundColor
          : cs.fill && cs.fill !== "none" ? cs.fill : cs.stroke;
        if (!CATEGORICAL.includes(fill)) {
          out.push(`series mark off-palette on ${tag}: ${fill}`);
        }
        continue;
      }

      // Cyan is a LINE, never a mass. Anything cyan-filled bigger than a rule.
      if (CYAN.includes(cs.backgroundColor) && box.width * box.height > 200) {
        out.push(`cyan mass on ${tag}: ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
      // Beacon is a POINT, capped about 12px.
      if (cs.backgroundColor === BEACON && (box.width > 12 || box.height > 12)) {
        out.push(`beacon larger than a point on ${tag}: ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
      // SVG fills were never checked, which is how a cyan donut slice would
      // have walked past this whole test. They are checked now, and a slice
      // that is not declared a series mark has no business carrying the hue.
      if (cs.fill && (CYAN.includes(cs.fill) || cs.fill === BEACON) && box.width * box.height > 200) {
        out.push(`undeclared cyan/beacon fill on ${tag}: ${cs.fill}`);
      }
    }

    return out;
  }, CATEGORICAL_RGB);

  expect(findings).toEqual([]);
});

// The exemption above is only sound if the marks it exempts actually exist and
// actually opt in, so this pins both: the ring's arcs and the sleeve bars
// declare themselves, and every declared mark is on-palette.
test("every categorical fill on the page declares itself a series mark", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await expect(page.locator(".alp__ring .rr-legend__row").first()).toBeVisible();

  const marks = page.locator('section.alp [data-mark="series"]');
  expect(await marks.count()).toBeGreaterThan(8);
  await expect(page.locator('.alp__ring circle[data-sleeve][data-mark="series"]')).toHaveCount(2);
  await page.locator(".alp__ring .rr-legend__row").first().click();
  await expect(page.locator('.alp__ring .rr-x__assets i:not([data-mark="series"])')).toHaveCount(0);
  // The Vaults section: a dot per vault, and nothing else in a vault's hue.
  await vaultsLoaded(page);
  await expect(page.locator('#vaults .rr-dot[data-mark="series"]')).toHaveCount(4);
  await expect(page.locator('#vaults [data-mark="series"]')).toHaveCount(4);
  await expect(page.locator('#vaults i[style]:not([data-mark="series"])')).toHaveCount(0);
});

test("the page carries no em dash in its own copy", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await expect(page.locator(".alp__ring .rr-legend__row").first()).toBeVisible();

  // The em dash is also the site's null glyph (fmtUsd returns "—"), so only
  // runs of PROSE are checked: a lone "—" in a cell is a missing value, not
  // punctuation.
  const offenders = await page.evaluate(() => {
    const root = document.querySelector("section.alp");
    if (!root) return ["no .alp root"];
    const bad: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = (node.textContent || "").trim();
      if (text.length > 3 && text.includes("—")) bad.push(text.slice(0, 80));
    }
    return bad;
  });
  expect(offenders).toEqual([]);
});

// ── responsive ──────────────────────────────────────────────────────────────

test("on a phone the ring keeps its size and nothing scrolls the page sideways", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await expect(page.locator(".alp__ring .rr-legend__row").first()).toBeVisible();

  // The ring keeps its size above its legend rather than being swapped for a
  // list, which is what the fan it replaced had to do.
  const ring = page.locator(".alp__ring .rr-ring svg");
  await expect(ring).toBeVisible();
  const ringBox = await ring.boundingBox();
  expect(ringBox!.width).toBeGreaterThan(120);
  expect(ringBox!.width).toBeLessThanOrEqual(390);
  await expect(page.locator(".alp__ring .rr-legend__row")).toHaveCount(4);

  // The Vaults table fits the phone rather than hiding columns behind a
  // sideways scroll: the two gaps give way (each vault's page carries them),
  // and every column left is on screen.
  await expect(vaultRows(page)).toHaveCount(4);
  await expect(page.locator("#vaults thead th:visible")).toHaveText(["Vault", "Recommended", "Target", "Actual"]);
  const wrap = await page.locator("#vaults .rr-tablewrap").evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(wrap[0]).toBeLessThanOrEqual(wrap[1]);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expectNoBrowserErrors(errors);
});





