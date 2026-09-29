// Render spec for /deposit (RM-146): the four vaults a deposit goes into,
// read through the same data layer as /allocation and every /vault/:slug,
// and what their contracts set, from the registry.
//
// Same harness as vault-pages.spec.ts: the SPA and the view HTML come from
// baseURL, the vendor CDN scripts are fulfilled from node_modules, and every
// feed the page reads is stubbed, so the spec runs against the static preview
// and against a real backend alike. Two setups:
//   - "live": the four-vault route is absent, vault-economics and the
//     allocation answer with the committed goldens (the policy, 95/5/0/0, is
//     the weights in force);
//   - "devnet": the mock-data switch (?vaults=devnet, a local host only)
//     reads the shipped four-vault fixtures, the router's weights in force.
//
// Assertions are on the RENDERED page: text, attributes and computed styles.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { navigate } from "./navigation.ts";

// lib/chart-theme.js CATEGORICAL[0..3], as the browser reports them: the four
// sleeves' hues, which the four vaults wear too. Written out, not imported.
const CATEGORICAL_RGB = ["rgb(16, 185, 129)", "rgb(0, 229, 255)", "rgb(232, 166, 64)", "rgb(126, 136, 158)"];
const CYAN = ["rgb(0, 229, 255)", "rgb(0, 184, 212)"];
const BEACON = "rgb(255, 122, 41)";

const INSTALL = "npx skills add robotmoney/robotmoney-skills-v0 --skill robotmoney-cli";
const SYMBOLS = ["rmUSDC", "rmAGENT", "rmPROTO", "rmRWA"];
const SLEEVES = ["Fixed Income", "Small Cap Tokens", "Protocol Tokens", "Real World Assets"];

const vendorScripts = {
  "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js": "node_modules/alpinejs/dist/cdn.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js": "node_modules/chart.js/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/p5@1.11.2/lib/p5.min.js": "node_modules/p5/lib/p5.min.js",
};

const publicDir = join(process.cwd(), "frontend/public");
const DEVNET = JSON.parse(readFileSync(join(publicDir, "data/vaults/devnet/overview.json"), "utf8"));
const goldens = JSON.parse(readFileSync(join(process.cwd(), "goldens/api-goldens.json"), "utf8")).routes;
const ECONOMICS = goldens["/api/dashboards/vault-economics"];
const json = (payload: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(payload) });

async function stubVendors(page: Page) {
  for (const [url, file] of Object.entries(vendorScripts)) {
    await page.route(url, (route) => route.fulfill({ path: join(process.cwd(), file), contentType: "application/javascript" }));
  }
}

// Every /api down first (later routes take precedence), then the two reads
// the page makes answered with the goldens.
async function stubLive(page: Page) {
  await stubVendors(page);
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, body: "down" }));
  await page.route("**/api/dashboards/vault-economics", (route) => route.fulfill(json(ECONOMICS)));
  await page.route("**/api/dashboards/allocation", (route) => route.fulfill(json(goldens["/api/dashboards/allocation"])));
}

// The mode as a reader's earlier ?vaults= left it, in this tab's storage.
async function setMode(page: Page, mode: "base" | "devnet") {
  await page.addInitScript((m) => {
    try { sessionStorage.setItem("rm.vaults", m); } catch { /* storage blocked */ }
  }, mode);
}

async function openDeposit(page: Page) {
  await page.goto("/index.html");
  await navigate(page, "/deposit");
  await expect(page.locator("#view h1")).toHaveText("Deposit USDC");
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

const rows = (page: Page) => page.locator("#vaults tbody tr");
const cell = (page: Page, n: number) => page.locator(`#vaults tbody tr td:nth-of-type(${n})`);
const fact = (page: Page, label: string) => page.locator(".rr-head + .rr-meta .rr-meta__i").filter({ hasText: label });
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const asOf = (iso: string) => {
  const d = new Date(iso);
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${M} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${hh}:${mm} UTC`;
};

// The covenant on the rendered page, every visible element under the view:
// no gradient, no shadow and square corners; cyan fills only the one primary
// button and a declared series mark, whose fill is a vault's hue; no cyan on a
// figure; and no Beacon at all, since this page marks no loss.
async function covenantFindings(page: Page): Promise<string[]> {
  return page.evaluate(([CYAN, HUES, BEACON]) => {
    const out: string[] = [];
    const root = document.querySelector("#view .cv--detail");
    if (!root) return ["no view"];
    for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
      if (!el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      const tag = `${el.tagName.toLowerCase()}.${(el.getAttribute("class") || "").split(" ")[0]}`;
      if (cs.backgroundImage && cs.backgroundImage !== "none") out.push(`gradient on ${tag}: ${cs.backgroundImage}`);
      if (cs.boxShadow && cs.boxShadow !== "none") out.push(`shadow on ${tag}: ${cs.boxShadow}`);
      if (["borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"]
        .some((k) => cs[k as "borderTopLeftRadius"] !== "0px")) out.push(`rounded ${tag}: ${cs.borderRadius}`);

      const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent || "").join("").trim();
      const letters = (own.match(/[A-Za-z]/g) || []).length;
      if ((CYAN as string[]).includes(cs.color) && /[0-9]/.test(own) && letters <= 2) out.push(`cyan on a figure in ${tag}: "${own}"`);

      const svg = el instanceof SVGElement;
      const paints = [cs.backgroundColor, svg ? cs.fill : "", svg ? cs.stroke : ""];
      if (el.getAttribute("data-mark") === "series") {
        if (!paints.some((p) => (HUES as string[]).includes(p))) out.push(`series mark off the vault hues on ${tag}: ${paints.join(" / ")}`);
      } else {
        if (paints.some((p) => (CYAN as string[]).includes(p)) && !el.matches(".btn-primary")) out.push(`cyan fill on ${tag}`);
        if (paints.some((p) => (HUES as string[]).includes(p) && !(CYAN as string[]).includes(p))) out.push(`vault hue with no data-mark on ${tag}`);
      }
      if ([cs.color, cs.backgroundColor, cs.borderTopColor, cs.borderBottomColor, cs.outlineColor, svg ? cs.fill : "", svg ? cs.stroke : ""].includes(BEACON as string)) {
        out.push(`beacon on ${tag}`);
      }
    }
    return out;
  }, [CYAN, CATEGORICAL_RGB, BEACON] as const);
}

test("on Base: the four vaults in order, rmUSDC live and the rest coming soon, with its figures, fee and caps", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubLive(page);
  await setMode(page, "base");
  await openDeposit(page);

  await expect(rows(page)).toHaveCount(4);
  await expect(page.locator("#vaults tbody th a")).toHaveText(SYMBOLS);
  await expect(page.locator("#vaults tbody th small")).toHaveText(SLEEVES);
  for (const [i, s] of SYMBOLS.entries()) {
    await expect(rows(page).nth(i).locator("th a")).toHaveAttribute("href", `/vault/${s.toLowerCase()}`);
  }
  await expect(page.locator("#vaults thead th")).toHaveText(["Vault", "Status", "Weight in force", "Share price", "TVL", "Exit fee", "Per-deposit cap", "TVL cap"]);
  await expect(cell(page, 1)).toHaveText(["Live", "Coming soon", "Coming soon", "Coming soon"]);
  await expect(rows(page).nth(0).locator(".rm-live .rm-pulse")).toHaveCount(1);
  await expect(page.locator("#vaults tbody .rm-pill")).toHaveCount(3);
  // The weights in force: the published policy, as the allocation page reads it.
  await expect(cell(page, 2)).toHaveText(["95%", "5%", "0%", "0%"]);
  await expect(rows(page).nth(0).locator("td")).toHaveText(["Live", "95%", `$${ECONOMICS.sharePrice.toFixed(4)}`, "$200", "0.25%", "$5,000", "$100,000"]);
  // A vault not live has none of the figures: "—", muted.
  for (const i of [1, 2, 3]) {
    const figs = rows(page).nth(i).locator("td:nth-of-type(n+3)");
    await expect(figs).toHaveText(["—", "—", "—", "—", "—"]);
    for (const c of await figs.all()) await expect(c).toHaveClass(/is-zero/);
  }
  expect(await page.locator("#vaults tbody .rr-dot").evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor))).toEqual(CATEGORICAL_RGB);

  // The ring: the weights in force, each vault in its hue.
  const arcs = page.locator("#vaults .rr-ring circle[data-sleeve]");
  await expect(arcs).toHaveCount(2);
  await expect(page.locator("#vaults .rr-legend__row > b")).toHaveText(["95%", "5%", "0%", "0%"]);
  await expect(page.locator("#vaults .rr-ring figcaption")).toHaveText("In force");
  await expect(page.locator("#vaults .rr-subhead").filter({ hasText: "Weights in force" }).locator(".rr-sec__aside")).toHaveText("In force since Jun 2, 2026");

  // The two ways in: the router not on Base, one vault into rmUSDC.
  await expect(page.locator('[data-path="router"] .rr-paths__st')).toHaveText("Not on Base");
  await expect(page.locator('[data-path="vault"] .rr-paths__st')).toHaveText("Live rmUSDC");
  await expectNoBrowserErrors(errors);
});

test("the facts row, the install card and the sections the site links into", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubLive(page);
  await setMode(page, "base");
  await openDeposit(page);

  await expect(page.locator(".rr-crumbs a")).toHaveAttribute("href", "/allocation#vaults");
  await expect(fact(page, "Network").locator("b")).toHaveText("Base");
  await expect(fact(page, "Asset").locator("a")).toHaveAttribute("href", "https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  await expect(fact(page, "Vaults live").locator("b")).toHaveText("1 of 4");
  await expect(fact(page, "Router").locator("b")).toHaveText("Not on Base");
  await expect(fact(page, "As of").locator("b")).toHaveText(asOf(ECONOMICS.asOf));
  await expect(page.locator("[data-vault-label]")).toHaveCount(0);

  for (const id of ["vaults", "how-it-works", "mechanics", "contracts"]) await expect(page.locator(`section#${id}`)).toHaveCount(1);
  await expect(page.locator("section.rr-sec h2")).toHaveText(["Vaults", "Deposit with your agent", "Before you deposit", "Contracts"]);

  // The one filled button, compact, to the skill's repository.
  const primary = page.locator("#view .btn-primary");
  await expect(primary).toHaveCount(1);
  await expect(primary).toHaveAttribute("href", "https://github.com/robotmoney/robotmoney-skills-v0");
  const w = await primary.evaluate((el) => el.getBoundingClientRect().width);
  expect(w).toBeLessThan(300);

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await expect(page.locator(".rr-install code")).toHaveText(INSTALL);
  await page.getByRole("button", { name: "Copy the install command" }).click();
  await expect(page.getByRole("button", { name: "Command copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(INSTALL);

  // Before you deposit: the registry's facts for rmUSDC, the one deployed vault.
  const mech = page.locator("#mechanics .rr-dl");
  await expect(mech.locator("dt")).toHaveText(["Standard", "Withdrawals", "Exit fee", "Caps", "Venues", "Admin", "Audit"]);
  await expect(mech.locator('[data-fact="exit-fee"] dd')).toContainText("rmUSDC0.25%");
  await expect(mech.locator('[data-fact="caps"] dd')).toHaveText(/rmUSDC\s*\$100,000 TVL cap, \$5,000 per deposit/);
  await expect(mech.locator('[data-fact="venues"] dd')).toHaveText(/Morpho Gauntlet USDC Prime, Aave V3 and Compound V3, in equal parts/);
  await expect(mech.locator('[data-fact="admin"] a')).toHaveAttribute("href", "https://basescan.org/address/0x88bA7364cC6cE5054981d571b33f8fb3E91475A0");
  await expect(mech.locator('[data-fact="audit"] a')).toHaveAttribute("href", "https://github.com/robotmoney/robotmoney-core/blob/dev/docs/audits.md");
  await expect(mech.locator('[data-fact="audit"] a')).toHaveText("Audited");

  // Contracts: the registry, deployed ones to BaseScan, the rest not on Base.
  const con = page.locator("#contracts tbody tr");
  await expect(con.locator("th")).toHaveText([
    "RobotMoneyVault (rmUSDC)", "MorphoAdapter", "AaveV3Adapter", "CompoundV3Adapter", "Multisig (Admin)",
    "Router", "Vault (rmAGENT)", "Vault (rmPROTO)", "Vault (rmRWA)",
  ]);
  await expect(con.nth(0).locator("a")).toHaveAttribute("href", "https://basescan.org/address/0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd");
  for (const i of [5, 6, 7, 8]) await expect(con.nth(i).locator("td")).toHaveText("Not on Base");

  // The links on: the skill, the vault, SKILL.md.
  await expect(page.locator("nav.rr-recnav--flow a")).toHaveText(["The skill on GitHub", "rmUSDC on BaseScan", "SKILL.md"]);
  // Nothing of the basket, the 95/5 split or the old slogans.
  await expect(page.locator("#view")).not.toContainText(/basket|95%\s*\/\s*5%|Skill loads\.|All verified/i);
  await expectNoBrowserErrors(errors);
});

test("on the devnet: four live vaults at the router's weights, labelled as test data", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubLive(page);
  await page.goto("/deposit" + "?vaults=devnet");
  await expect(page.locator("#view h1")).toHaveText("Deposit USDC");

  await expect(cell(page, 1)).toHaveText(["Live", "Live", "Live", "Live"]);
  const applied = DEVNET.vaults.map((v: any) => `${v.appliedBps / 100}%`);
  await expect(cell(page, 2)).toHaveText(applied);
  await expect(cell(page, 4)).toHaveText(DEVNET.vaults.map((v: any) => `$${v.tvlUsd.toLocaleString("en-US")}`));
  await expect(page.locator("[data-vault-label]")).toHaveText("Devnet test data");
  await expect(fact(page, "Network").locator("b")).toHaveText("Staging devnet");
  await expect(fact(page, "Vaults live").locator("b")).toHaveText("4 of 4");
  await expect(fact(page, "Router").locator("b")).toHaveText("Live");
  await expect(page.locator('[data-path="vault"] .rr-paths__st a')).toHaveText(SYMBOLS);
  await expect(page.locator("#vaults .rr-ring circle[data-sleeve]")).toHaveCount(4);
  expect(await covenantFindings(page)).toEqual([]);
  await expectNoBrowserErrors(errors);
});

// Rendered copy: no em dash in a run of words (a lone "—" is the missing-value
// mark), and nothing that narrates the page or makes a promise.
async function copyFindings(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const root = document.querySelector("#view .cv--detail");
    if (!root) return ["no view"];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || !parent.getClientRects().length) continue;
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (text.length > 3 && text.includes("—")) out.push(`em dash: "${text}"`);
      if (/guarantee|principal[- ]protected|\bsoon\b.*\b(fee|launch)|\bwill\b/i.test(text)) out.push(`promise: "${text}"`);
      if (/\bthis (table|chart|section|page|figure|list)\b|\bshows\b|\bclick/i.test(text)) out.push(`narration: "${text}"`);
    }
    return out;
  });
}

for (const mode of ["base", "devnet"] as const) {
  test(`the covenant on the rendered page, and no sideways scroll on a phone (${mode})`, async ({ page }) => {
    const errors = failOnBrowserErrors(page);
    await stubLive(page);
    await setMode(page, mode);
    await openDeposit(page);
    await expect(fact(page, "Vaults live").locator("b")).not.toHaveText("—");
    expect(await covenantFindings(page)).toEqual([]);
    expect(await copyFindings(page)).toEqual([]);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    expect(await sideways(page)).toBe(0);
    expect(await covenantFindings(page)).toEqual([]);
    await expectNoBrowserErrors(errors);
  });
}
