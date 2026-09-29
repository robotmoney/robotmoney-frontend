// Render spec for /deposit (RM-146): what a depositor asks before depositing.
// The hero and its install card; how it works; what a deposit buys (the
// allocation's ring and each sleeve's assets); the tokens it leaves in the
// wallet; what it earns, with a simulation beside a benchmark; TVL and
// liquidity; and a FAQ whose rows open on a click or a link.
//
// Same harness as vault-pages.spec.ts: the SPA and the view HTML come from
// baseURL, the vendor CDN scripts are fulfilled from node_modules, and every
// feed the page reads is stubbed, so the spec runs against the static preview
// and against a real backend alike. Two setups:
//   - "live": vault-economics and the allocation answer with the committed
//     goldens (the policy, 95/5/0/0, is the allocation);
//   - "devnet": the mock-data switch (?vaults=devnet, a local host only)
//     reads the shipped four-vault fixtures and the router's weights.
// The simulator reads its illustrative series on a local host, which the spec
// server is; a spec blocks it to see the empty chart production shows.
//
// Assertions are on the RENDERED page: text, attributes and computed styles.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { navigate } from "./navigation.ts";

// lib/chart-theme.js CATEGORICAL, as the browser reports them: the four
// sleeves' hues (the vaults wear them too) and the benchmark's teal. Written
// out, not imported.
const CATEGORICAL_RGB = ["rgb(16, 185, 129)", "rgb(0, 229, 255)", "rgb(232, 166, 64)", "rgb(126, 136, 158)", "rgb(95, 179, 161)"];
const CYAN = ["rgb(0, 229, 255)", "rgb(0, 184, 212)"];
const BEACON = "rgb(255, 122, 41)";

const INSTALL = "npx skills add robotmoney/robotmoney-skills-v0 --skill robotmoney-cli";
const SYMBOLS = ["rmUSDC", "rmAGENT", "rmPROTO", "rmRWA"];
const SLEEVES = ["Fixed Income", "Small Cap Tokens", "Protocol Tokens", "Real World Assets"];
const HEADINGS = ["How it works", "What you buy", "What you receive", "What it earns", "TVL and liquidity", "FAQ"];

const vendorScripts = {
  "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js": "node_modules/alpinejs/dist/cdn.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js": "node_modules/chart.js/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/p5@1.11.2/lib/p5.min.js": "node_modules/p5/lib/p5.min.js",
};

const goldens = JSON.parse(readFileSync(join(process.cwd(), "goldens/api-goldens.json"), "utf8")).routes;
const ECONOMICS = goldens["/api/dashboards/vault-economics"];
const ALLOCATION = goldens["/api/dashboards/allocation"];
const json = (payload: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(payload) });

async function stubLive(page: Page) {
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({ path: join(process.cwd(), file), contentType: "application/javascript" }));
  }
  // Every /api down first (later routes take precedence), then the two reads
  // the page makes answered with the goldens.
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, body: "down" }));
  await page.route("**/api/dashboards/vault-economics", (route) => route.fulfill(json(ECONOMICS)));
  await page.route("**/api/dashboards/allocation", (route) => route.fulfill(json(ALLOCATION)));
}

// The mode as a reader's earlier ?vaults= left it, in this tab's storage.
async function setMode(page: Page, mode: "base" | "devnet") {
  await page.addInitScript((m) => {
    try { sessionStorage.setItem("rm.vaults", m); } catch { /* storage blocked */ }
  }, mode);
}

async function openDeposit(page: Page, path = "/deposit") {
  await page.goto("/index.html");
  await navigate(page, path);
  await expect(page.locator("#view h1")).toContainText("Deposit");
  // The figures are in once the facts row has read the vaults.
  await expect(page.locator(".dp__meta .rr-meta__i").filter({ hasText: "Vaults live" }).locator("b")).not.toHaveText("—");
}

function failOnBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  // The harness's own first render of "/index.html" (see allocation-view.spec).
  const HARNESS_404 = "views/index.html.html";
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (text.includes(HARNESS_404)) return;
    // A stubbed 503 is reported without its URL; the page's handling of it is
    // what these tests assert.
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

const fact = (page: Page, label: string) => page.locator(".dp__meta .rr-meta__i").filter({ hasText: label }).locator("b");
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const faqRow = (page: Page, q: string) => page.locator(".dp__faq details").filter({ has: page.locator("summary", { hasText: q }) });

test("the hero keeps the install card beside the headline, and the facts row reads the vault feed", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubLive(page);
  await setMode(page, "base");
  await openDeposit(page);

  await expect(page.locator(".sk__install-cmd")).toHaveText(INSTALL);
  const cta = page.locator(".sk__cta");
  await expect(cta).toHaveAttribute("href", "https://github.com/robotmoney/robotmoney-skills-v0");
  // One arrow: the label types none, the site's new-tab rule draws ↗ (RM-150).
  await expect(cta).toHaveText("Install Skill");
  expect(await cta.evaluate((a) => getComputedStyle(a, "::after").content)).toContain("↗");

  await expect(fact(page, "TVL")).toHaveText(usd(ECONOMICS.tvlUsd));
  await expect(fact(page, "Vaults live")).toHaveText("1 of 4");
  await expect(fact(page, "Exit fee")).toHaveText("0.25%");

  await expect(page.locator(".dp h2")).toHaveText(HEADINGS);
  // The sections other pages link into, and the old page's ids kept as
  // landing points.
  for (const id of ["how-it-works", "allocation", "tokens", "returns", "simulate", "liquidity", "faq", "contracts", "capabilities", "mechanics", "about"]) {
    await expect(page.locator(`#view #${id}`), id).toHaveCount(1);
  }
  await expect(page.locator("#how-it-works .rr-steps > div")).toHaveCount(4);
  await expect(page.locator('#how-it-works a[href="/docs/skill/commands"]')).toBeVisible();
  await expectNoBrowserErrors(errors);
});

test("what you buy: the allocation's ring, and each sleeve's assets", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubLive(page);
  await setMode(page, "base");
  await openDeposit(page);

  const legend = page.locator("#allocation .rr-legend__row");
  await expect(legend.locator(".rr-legend__l")).toHaveText(SLEEVES);
  await expect(legend.locator(".dp__legtok")).toHaveText(SYMBOLS);
  const targets = ALLOCATION.strategy.map((s: { targetPct: number }) => `${s.targetPct}%`);
  await expect(legend.locator("b")).toHaveText(targets);
  await expect(page.locator("#allocation .rr-sec__aside")).toContainText("Allocation set");
  // Each sleeve wears its hue, in the published order.
  expect(await legend.locator("i[data-mark=series]").evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor))).toEqual(CATEGORICAL_RGB.slice(0, 4));

  // The largest sleeve rests open; a click opens another.
  const fixed = ALLOCATION.buckets[0].items.map((i: { label: string }) => i.label);
  await expect(page.locator("#allocation .rr-x__assets tbody th")).toHaveText(fixed);
  await expect(page.locator("#allocation .dp__vault")).toContainText("rmUSDC");
  await expect(page.locator("#allocation .dp__vst")).toHaveText("Live");
  await legend.nth(1).click();
  const small = ALLOCATION.buckets[1].items.map((i: { label: string }) => i.label);
  await expect(page.locator("#allocation .rr-x__assets tbody th")).toHaveText(small);
  await expect(page.locator("#allocation .dp__vst")).toHaveText("Coming soon");
  await expectNoBrowserErrors(errors);
});

test("what you receive: one token per vault, rmUSDC live with its address on Base", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubLive(page);
  await setMode(page, "base");
  await openDeposit(page);

  const rows = page.locator("#tokens tbody tr");
  await expect(rows.locator("th a")).toHaveText(SYMBOLS);
  await expect(rows.locator("td:nth-of-type(1)")).toHaveText(SLEEVES);
  await expect(rows.locator("td:nth-of-type(2)")).toHaveText(["Live", "Coming soon", "Coming soon", "Coming soon"]);
  await expect(rows.nth(0).locator("td:nth-of-type(3)")).toHaveText(Number(ECONOMICS.sharePrice).toFixed(4));
  await expect(rows.nth(0).locator("td:nth-of-type(4) a")).toHaveAttribute("href", /basescan\.org\/address\/0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd/i);
  for (const i of [1, 2, 3]) await expect(rows.nth(i).locator("td:nth-of-type(4)")).toHaveText("—");
  await expectNoBrowserErrors(errors);
});

test("the simulator: the value today beside the benchmark, the chart, and returns by period", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubLive(page);
  await setMode(page, "base");
  await openDeposit(page);

  const sim = page.locator("#simulate");
  await expect(sim.locator("[data-sim-label]")).toHaveText("Illustrative data");
  const value = sim.locator(".dp__result .rr-stat__v").first();
  await expect(value).toHaveText(/^\$[0-9,]+(\.\d\d)?$/);
  await expect(sim.locator(".dp__bench .rr-k")).toContainText("On Aave V3 USDC");
  await expect(sim.locator(".rr-area__svg polyline")).not.toHaveCount(0);

  // The amount moves the figures; a period moves the window.
  const at1000 = await value.textContent();
  await sim.locator(".rm-chip", { hasText: "$5,000" }).click();
  await expect(value).not.toHaveText(at1000 ?? "");
  const at5000 = await value.textContent();
  await sim.locator(".rm-chip", { hasText: "3M" }).click();
  await expect(value).not.toHaveText(at5000 ?? "");

  // A deposit over a vault's per-deposit cap says so.
  await sim.locator(".dp__field input").fill("10000");
  await expect(sim.locator(".rr-note").filter({ hasText: "capped" })).toHaveText("A single deposit into rmUSDC is capped at $5,000.");

  // The returns table: every sleeve, the deposit, and the benchmark, over
  // five periods.
  await expect(sim.locator(".dp__rets thead th")).toHaveText(["Returns", "Target", "24H", "7D", "30D", "6M", "1Y"]);
  await expect(sim.locator(".dp__rets tbody th")).toHaveText([...SLEEVES, "Your deposit", "Aave V3 USDC"]);
  await expect(sim.locator(".dp__rets tbody tr").nth(4).locator("td").first()).toHaveText("100%");
  await expectNoBrowserErrors(errors);
});

test("with no series to read, the simulator shows the empty chart", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubLive(page);
  await page.route("**/data/deposit/simulation-illustrative.json", (route) => route.fulfill({ status: 404, body: "" }));
  await setMode(page, "base");
  await openDeposit(page);
  await expect(page.locator("#simulate .rm-nodata__h")).toHaveText("No data yet");
  await expect(page.locator("#simulate [data-sim-label]")).toHaveCount(0);
  await expect(page.locator("#simulate .dp__rets")).toHaveCount(0);
  await expectNoBrowserErrors(errors);
});

test("TVL and liquidity: the combined figure, the terms, and a way to each vault's page", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubLive(page);
  await setMode(page, "base");
  await openDeposit(page);

  const liq = page.locator("#liquidity");
  await expect(liq.locator(".rr-stat__v")).toHaveText(usd(ECONOMICS.tvlUsd));
  await expect(liq.locator(".rr-stat__sub")).toHaveText("Across 1 of 4 vaults");
  await expect(liq.locator(".rr-dl dt")).toHaveText(["Withdrawals", "Exit fee", "Caps"]);
  await expect(liq.locator(".rr-dl dd").nth(2)).toContainText("$100,000 TVL cap");
  await expect(liq.locator(".dp__vpages a")).toHaveCount(5);
  expect(await liq.locator(".dp__vpages a").evaluateAll((as) => as.map((a) => a.getAttribute("href"))))
    .toEqual(["/swarm/subjects/robotmoney-vault", "/vault/rmusdc", "/vault/rmagent", "/vault/rmproto", "/vault/rmrwa"]);
  await expectNoBrowserErrors(errors);
});

test("the FAQ: every row closed, a click opens and closes one, and a link on the page opens its row", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubLive(page);
  await setMode(page, "base");
  await openDeposit(page);

  const rows = page.locator(".dp__faq details");
  await expect(rows).toHaveCount(7);
  expect(await rows.evaluateAll((ds) => ds.filter((d) => (d as HTMLDetailsElement).open).length)).toBe(0);

  const changes = faqRow(page, "What happens when the allocation changes?");
  await changes.locator("summary").click();
  await expect(changes).toHaveJSProperty("open", true);
  await expect(changes.locator(".dp__faq-a")).toContainText("ask your agent to rebalance");
  // Settled: the answer at its full height once the animation ends.
  await expect.poll(() => changes.locator(".dp__faq-a").evaluate((a) => a.getAnimations().length)).toBe(0);
  await changes.locator("summary").click();
  await expect(changes).toHaveJSProperty("open", false);

  // A link on the page to a row opens it.
  await page.evaluate(() => { location.hash = "#risks"; });
  await expect(page.locator("#risks")).toHaveJSProperty("open", true);
  await expectNoBrowserErrors(errors);
});

test("a link from another page to /deposit#contracts lands on the contracts, open", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubLive(page);
  await setMode(page, "base");
  await openDeposit(page, "/deposit#contracts");
  await expect(page.locator("#contracts")).toHaveJSProperty("open", true);
  await expect.poll(() => page.locator("#contracts").evaluate((d) => Math.round(d.getBoundingClientRect().top))).toBeLessThan(844);
  await expect(page.locator("#contracts tbody th").first()).toHaveText("RobotMoneyVault (rmUSDC)");
  await expect(page.locator("#contracts tbody td a").first()).toHaveAttribute("href", /basescan\.org\/address\/0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd/i);
  await expectNoBrowserErrors(errors);
});

test("on the devnet: four live vaults at the router's weights, labelled as test data", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubLive(page);
  await setMode(page, "devnet");
  await openDeposit(page);

  await expect(fact(page, "Vaults live")).toHaveText("4 of 4");
  await expect(page.locator(".dp__meta [data-vault-label] b")).toHaveText("Devnet test data");
  await expect(page.locator("#tokens tbody td:nth-of-type(2)")).toHaveText(["Live", "Live", "Live", "Live"]);
  await expect(page.locator("#allocation .rr-legend__row b")).toHaveText(["70%", "10%", "15%", "5%"]);
  await expect(page.locator("#simulate .dp__rets tbody tr").nth(4).locator("td").first()).toHaveText("100%");
  await expectNoBrowserErrors(errors);
});

// The covenant on the rendered page, every visible element under the view:
// no gradient, no shadow and square corners; cyan fills only the install
// card's button and a declared series mark, whose fill is a categorical hue;
// no cyan on a figure; and no Beacon, since this page marks no loss.
async function covenantFindings(page: Page): Promise<string[]> {
  return page.evaluate(([CYAN, HUES, BEACON]) => {
    const out: string[] = [];
    const root = document.querySelector("#view .dp");
    if (!root) return ["no view"];
    for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
      if (!el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      const tag = `${el.tagName.toLowerCase()}.${(el.getAttribute("class") || "").split(" ")[0]}`;
      if (cs.backgroundImage && cs.backgroundImage !== "none") out.push(`gradient on ${tag}: ${cs.backgroundImage}`);
      if (cs.boxShadow && cs.boxShadow !== "none") out.push(`shadow on ${tag}: ${cs.boxShadow}`);
      // The (i) tip's button is the site's one round control (components.css).
      if (!el.matches(".rm-tip__btn") && ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"]
        .some((k) => cs[k as "borderTopLeftRadius"] !== "0px")) out.push(`rounded ${tag}: ${cs.borderRadius}`);

      const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent || "").join("").trim();
      const letters = (own.match(/[A-Za-z]/g) || []).length;
      if ((CYAN as string[]).includes(cs.color) && /[0-9]/.test(own) && letters <= 2) out.push(`cyan on a figure in ${tag}: "${own}"`);

      const svg = el instanceof SVGElement;
      const paints = [cs.backgroundColor, svg ? cs.fill : "", svg ? cs.stroke : ""];
      if (el.getAttribute("data-mark") === "series") {
        if (!paints.some((p) => (HUES as string[]).includes(p))) out.push(`series mark off the categorical hues on ${tag}: ${paints.join(" / ")}`);
      } else if (!el.matches(".sk__cta")) {
        if (paints.some((p) => (CYAN as string[]).includes(p))) out.push(`cyan fill on ${tag}`);
      }
      if ([cs.color, cs.backgroundColor, cs.borderTopColor, cs.borderBottomColor, cs.outlineColor, svg ? cs.fill : "", svg ? cs.stroke : ""].includes(BEACON as string)) {
        out.push(`beacon on ${tag}`);
      }
    }
    return out;
  }, [CYAN, CATEGORICAL_RGB, BEACON] as const);
}

// Copy on the rendered page: no em dash in a sentence, no promise, no
// narration of the page itself.
async function copyFindings(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const root = document.querySelector("#view .dp");
    if (!root) return ["no view"];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || !parent.getClientRects().length || parent.closest("style, script")) continue;
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (text.length > 3 && text.includes("—")) out.push(`em dash: "${text}"`);
      if (/(?<!not )guarantee|principal[- ]protected|\bwill\b/i.test(text)) out.push(`promise: "${text}"`);
      if (/\bthis (table|chart|section|page|figure|list)\b|\bshows\b|\bclick/i.test(text)) out.push(`narration: "${text}"`);
    }
    return out;
  });
}

for (const mode of ["base", "devnet"] as const) {
  test(`the covenant and the copy on the rendered page, and no sideways scroll on a phone (${mode})`, async ({ page }) => {
    const errors = failOnBrowserErrors(page);
    await stubLive(page);
    await setMode(page, mode);
    await openDeposit(page);
    expect(await covenantFindings(page)).toEqual([]);
    expect(await copyFindings(page)).toEqual([]);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    expect(await sideways(page)).toBe(0);
    expect(await covenantFindings(page)).toEqual([]);
    await expectNoBrowserErrors(errors);
  });
}
