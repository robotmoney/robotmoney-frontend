// Render spec for /allocation, the product sheet (RM-115).
//
// The page this replaced reported two pools of money under one heading and
// read four dashboard feeds. RM-115 splits them: the allocation is a POLICY
// and this page is the policy, its implementation in the vault, and what it
// pays. The house book (wallet-balances / wallet-sleeves) belongs to RM-103
// and is not read here at all — the first test below asserts that as the
// absence of the REQUEST, because a page that fetched the house book and
// merely declined to print it would still be one edit from printing it again.
//
// Same harness pattern as the spec it replaces: the SPA and the view HTML are
// served by the backend at baseURL, the vendor CDN scripts are fulfilled from
// node_modules, and both live surfaces are stubbed:
//   - GET /api/dashboards/vault-economics → the COMMITTED GOLDEN
//     (goldens/api-goldens.json), the single source of truth per
//     docs/architecture.md's preview section, or a degraded variant of it;
//   - GET /api/dashboards/allocation → the committed golden;
//   - GET /api/swarm/sessions → an inline stub (the golden's sessions are on
//     other portfolios, and the allocation's own session set is what the
//     "latest recommendation" line reads).
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

function usd2(v: number | null): string {
  return v == null ? "—" : "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

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
  await expect(page.locator("#inside-each-sleeve .alp__card").first()).toBeVisible();
  await page.waitForTimeout(300);

  expect(houseBook, "wallet-balances / wallet-sleeves are the house book (RM-103)").toEqual([]);
  // And nothing on the page prints the house book's own vocabulary.
  await expect(page.locator("section.alp")).not.toContainText("AUM");
  await expect(page.locator("section.alp")).not.toContainText("Agent Wallet");
  await expectNoBrowserErrors(errors);
});

// ── the live bindings ───────────────────────────────────────────────────────

// The holdings table moved out of a Vault SECTION and into the sleeve that
// owns it, merged with the policy it is measured against. Two tables made the
// reader join four identical row labels by eye, two screens apart. The section
// is gone and id="vault" moved onto that card, because /allocation#vault is
// cited by the deposit skill and by the swarm's vault row.
test("the sleeve's vault table binds every adapter to the golden, and reconciles to TVL", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  const vault = goldenVault();
  const framework = goldenFramework();
  await stubEnvironment(page, { vault, framework });
  await page.goto("/index.html");
  await navigate(page, "/allocation");

  const card = page.locator(".alp__card").first();
  await card.locator(".alp__hold-sum").click();
  const rows = card.locator(".alp__hold tbody tr");
  // One row per POLICY constituent, held or not, plus the total. Sky is in the
  // policy and not in the vault, and its row is the largest drift on the page:
  // dropping it would hide the finding.
  await expect(rows).toHaveCount(framework.buckets[0].items.length + 1);

  // Rows follow the POLICY's order, not the feed's, so the table reads in the
  // same order as the bar above it and the colours line up. The golden serves
  // Morpho first and the policy lists Aave first, so this is a real assertion
  // rather than a coincidence of two lists agreeing.
  for (const [i, item] of framework.buckets[0].items.entries()) {
    const adapter = vault.adapters.find((a) => a.name.toLowerCase() === item.label.toLowerCase());
    const row = rows.nth(i);
    if (!adapter) {
      // A policy name the vault does not hold keeps its row, with dashes where
      // a balance would be. It is the largest drift on the page.
      await expect(row).toContainText(item.label);
      await expect(row).toContainText("not held");
      await expect(row.locator("a")).toHaveCount(0);
      continue;
    }
    await expect(row).toContainText(usd2(adapter.balanceUsd));
    await expect(row).toContainText("$1.0000");
    await expect(row.locator("a")).toHaveAttribute("href", `https://basescan.org/address/${adapter.address}`);
  }
  // The page names the POSITION, not the protocol: Morpho's is a specific
  // curated vault, and that is the difference between "three lending venues"
  // and "two pooled markets and a vault somebody else sets the caps on".
  await expect(rows).toContainText([/Aave V3 USDC/, /Gauntlet USDC Prime/, /Compound III USDC/, /Sky/, /Vault TVL/]);
  await expect(card.locator("tr.tot")).toContainText(usd2(vault.tvlUsd));

  // The meta rail's live figure comes from the same payload.
  await expect(page.locator(".alp__meta")).toContainText(`Deployed ${usd2(vault.tvlUsd)}`);
  await expectNoBrowserErrors(errors);
});

// The subtraction the section exists for. Every number is derived from the two
// feeds: nothing here may be a copywritten constant, because the day Sky is
// wired up these all have to move on their own.
test("drift is computed from the two feeds, and names what is missing", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  const vault = goldenVault();
  const framework = goldenFramework();
  await stubEnvironment(page, { vault, framework });
  await page.goto("/index.html");
  await navigate(page, "/allocation");

  const items = framework.buckets[0].items;
  const tvl = Number(vault.tvlUsd);
  const expected = items.map((item) => {
    const adapter = vault.adapters.find(
      (a) => a.name.toLowerCase() === item.label.toLowerCase() && a.configured !== false,
    );
    const held = adapter?.balanceUsd == null ? 0 : Number(adapter.balanceUsd);
    return { label: item.label, policy: Number(item.targetPct), actual: (held / tvl) * 100 };
  });
  // Half the sum of absolute deviations: the standard reading of how far a
  // book sits from its policy.
  const te = expected.reduce((sum, r) => sum + Math.abs(r.actual - r.policy), 0) / 2;

  const card = page.locator(".alp__card").first();
  // The headline rides on the summary, so the finding is legible without
  // opening anything.
  await expect(card.locator(".alp__hold-sum"))
    .toContainText(`${te.toFixed(2)}% off target`);
  await card.locator(".alp__hold-sum").click();

  // By index, not by label: the row NAMES the position rather than the
  // protocol, so "Morpho" appears in the policy and "Gauntlet USDC Prime" in
  // the row, and matching on text would quietly find nothing.
  for (const [i, row] of expected.entries()) {
    const drift = row.actual - row.policy;
    const tr = card.locator(".alp__hold tbody tr").nth(i);
    await expect(tr).toContainText(`${row.policy.toFixed(2)}%`);
    await expect(tr).toContainText(`${row.actual.toFixed(2)}%`);
    await expect(tr).toContainText(`${drift > 0 ? "+" : "−"}${Math.abs(drift).toFixed(2)}`);
  }
  // A policy name the vault does not hold is marked on its own row. It was
  // also stated as a sentence under the table, which narrated the table.
  const missingIndex = expected.findIndex((r) => r.actual === 0);
  expect(missingIndex, "the golden should carry a policy name the vault does not hold")
    .toBeGreaterThan(-1);
  await expect(card.locator(".alp__hold tbody tr").nth(missingIndex))
    .toContainText("not held");
  await expect(card.locator(".alp__vd")).toHaveCount(0);

  // A sleeve with no contract says so, and offers no comparison and no
  // invented receipt symbol for an address nobody has deployed.
  // A sleeve with no contract shows NOTHING about a vault: no rail, no chip, no
  // sentence. It used to say the same thing three ways, and the donut legend
  // and the meta rail each state it once already.
  const agent = page.locator(".alp__card").nth(1);
  await expect(agent.locator(".alp__vrail")).toHaveCount(0);
  await expect(agent.locator(".alp__hold")).toHaveCount(0);
  await expect(agent).not.toContainText("rm");
  // What it DOES say is what the sleeve is.
  await expect(agent.locator(".alp__card-what")).toContainText("$ROBOTMONEY");
  await expectNoBrowserErrors(errors);
});

test("the donut draws one arc per funded sleeve, on the categorical palette, not normalised to its own sum", async ({ page }) => {
  const framework = goldenFramework();
  await stubEnvironment(page, { framework });
  await page.goto("/index.html");
  await navigate(page, "/allocation");

  const donut = page.locator(".alp__donut svg");
  await expect(donut).toBeVisible();

  // One arc per sleeve with a target above zero, and none for a sleeve without
  // one: 95/5/0/0 is two arcs, and the sliver is the truth about this
  // allocation rather than something to round away.
  const funded = framework.strategy.filter((row) => row.targetPct > 0);
  await expect(donut.locator("path")).toHaveCount(funded.length);

  // Slices come from lib/chart-theme.js CATEGORICAL, separated by HUE. This
  // page drew a green LUMINANCE ramp until it was measured: four green steps
  // separate at CVD dE 7.1 against 18.2 for these four, and a normal-vision
  // floor below 15 means full-colour readers cannot tell the pair apart
  // either. The palette's own comment names that mistake as the reason it
  // exists.
  const fills = await donut.locator("path").evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).fill));
  for (const fill of fills) expect(CATEGORICAL_RGB).toContain(fill);
  // Keyed on POSITION, so a sleeve keeps its hue when another one's weight
  // changes. Colour follows the entity, never its rank.
  expect(fills).toEqual(CATEGORICAL_RGB.slice(0, funded.length));

  // The ring underneath is the full 360, so a policy that does not add to 100
  // shows the remainder rather than being rescaled to look complete.
  await expect(donut.locator("circle")).toHaveCount(1);

  // The hole carries what the ring adds up to, which is the one fact the ring
  // cannot state for itself: it is drawn to the full 360, so a policy adding
  // to less than 100 leaves an arc unfilled and the hole names the remainder.
  await expect(donut).toContainText("ALLOCATED");
  await expect(donut).toContainText("100%");

  // The legend keys every sleeve, funded or not, and a sleeve at zero keeps
  // its hue: it holds nothing, which is not the same as having no identity.
  const legend = page.locator(".alp__legend-list li");
  await expect(legend).toHaveCount(framework.strategy.length);
  await expect(legend.first()).toContainText(framework.strategy[0].label);
  await expect(legend.first()).toContainText("vault live");
  await expect(legend.nth(2)).toContainText("vault pending");
  const swatchFill = await legend.nth(2).locator(".alp__swatch")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(CATEGORICAL_RGB).toContain(swatchFill);
});

// Constituents restart at the front of the palette inside their own sleeve,
// keyed on their position in the POLICY. The vault table keys on the same
// index, which is what makes a venue one colour wherever it appears: colouring
// by the holdings feed's order would let the API repaint it.
test("a constituent keeps one hue in its sleeve's bar and in its vault row", async ({ page }) => {
  const framework = goldenFramework();
  await stubEnvironment(page, { framework });
  await page.goto("/index.html");
  await navigate(page, "/allocation");

  const card = page.locator(".alp__card").first();
  const items = framework.buckets[0].items;
  const segments = card.locator(".alp__stk > span");
  await expect(segments).toHaveCount(items.length);
  const barFills = await segments.evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).backgroundColor));
  expect(barFills).toEqual(CATEGORICAL_RGB.slice(0, items.length));

  await card.locator(".alp__hold-sum").click();
  const rowDots = card.locator(".alp__hold tbody tr .alp__dot");
  const rowFills = await rowDots.evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).backgroundColor));
  expect(rowFills).toEqual(barFills);
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
  // each sleeve's own card states beside the vault it is about.
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
  await expect(page.locator("#inside-each-sleeve .alp__card").first()).toBeVisible();

  await expect(page.locator(".alp__latest")).toHaveCount(0);
  await expect(page.locator(".alp__how")).toHaveCount(0);
  // The one link out: every session that has reviewed these weights. The
  // allocation's own decision log is not built, so that is the swarm's page
  // for the subject and not a page of this branch's own.
  await expect(page.locator('#what-changed a[href="/swarm/subjects/robotmoney-allocation"]'))
    .toBeVisible();
  // Schema names, table names and route behaviour are not the reader's
  // business. The page says what is true about the allocation; how the backend
  // stores or types it is ours to know.
  const copy = (await page.locator("section.alp").innerText()).toLowerCase();
  for (const leak of ["position_actions", "allocation_framework", "vault_share_price_history", "public route"]) {
    expect(copy, `implementation detail leaked into the page: ${leak}`).not.toContain(leak);
  }
  await expectNoBrowserErrors(errors);
});

test("the two figures with no route behind them render an explicit pending state", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/allocation");

  // One line, not two tiles set in display type. A figure that does not exist
  // does not earn the top of a page, and the Beacon point is what marks it.
  const pending = page.locator(".alp__pending");
  await expect(pending).toHaveCount(1);
  await expect(pending).toContainText("not published");
  // No marker. Every clarification on this page used to wear a coloured bullet,
  // which put Beacon in four places it did not belong on a page already
  // carrying five categorical hues. The words carry it now.
  await expect(pending.locator("i")).toHaveCount(0);

  // The spot share price IS served, and is shown as a spot read rather than
  // stretched into the series it is not. It sits with the holdings it belongs
  // to now, not in a facts panel of its own.
  const vault = goldenVault();
  await page.locator(".alp__card .alp__hold-sum").first().click();
  await expect(page.locator(".alp__hold-foot").first())
    .toContainText(`$${Number(vault.sharePrice).toFixed(4)}`);
  await expectNoBrowserErrors(errors);
});

// ── degradation, one state per test ─────────────────────────────────────────

test("a stub vault feed is flagged non-live rather than presented as a chain read (issue #50)", async ({ page }) => {
  await stubEnvironment(page, { vault: { ...goldenVault(), source: "stub" } });
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await expect(page.locator(".alp-vault-nonlive")).toBeVisible();
  await expect(page.locator(".alp-vault-nonlive")).toContainText("non-live (stub) data");
});

test("a stale vault feed is flagged, and every degraded row names its observation time", async ({ page }) => {
  const vault = goldenVault();
  await stubEnvironment(page, {
    vault: {
      ...vault,
      stale: true,
      adapters: vault.adapters.map((a) => ({ ...a, provenance: "stale" })),
    },
  });
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await expect(page.locator(".alp-vault-stale")).toBeVisible();
  // "stale" as a DATE, not as an adjective: the carried-over sleeveStaleLabel().
  // The rows moved into the sleeve that owns them, so the badge moved with
  // them; degrading a row is exactly the thing that must survive a redesign.
  await page.locator(".alp__card .alp__hold-sum").first().click();
  const badges = page.locator(".alp__card .alp__cell-badge", { hasText: /^stale \(/ });
  await expect(badges.first()).toBeVisible();
  await expect(page.locator(".alp__hold-foot").first()).toContainText("(stale)");
});

test("a scheduler catch-up is flagged as backfilled, distinct from stale and from stub (issue #614 AC4)", async ({ page }) => {
  const vault = goldenVault();
  await stubEnvironment(page, {
    vault: { ...vault, adapters: vault.adapters.map((a, i) => (i === 0 ? { ...a, provenance: "backfilled" } : a)) },
  });
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await expect(page.locator(".alp-vault-backfilled")).toBeVisible();
  await expect(page.locator(".alp-vault-backfilled")).toContainText("caught up late");
  await expect(page.locator(".alp-vault-stale")).toBeHidden();
  await expect(page.locator(".alp-vault-nonlive")).toBeHidden();
  await page.locator(".alp__card .alp__hold-sum").first().click();
  await expect(page.locator(".alp__card .alp__cell-badge", { hasText: "caught up late" })).toBeVisible();
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
  await expect(page.locator("#inside-each-sleeve .alp__card").first()).toBeVisible();

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
      // name and may carry the interface hue, "$199.70" and "95%" may not. The
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
        const fill = cs.backgroundColor === "rgba(0, 0, 0, 0)" ? cs.fill : cs.backgroundColor;
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
// actually opt in, so this pins both: the donut's slices and the sleeve bars
// declare themselves, and every declared mark is on-palette.
test("every categorical fill on the page declares itself a series mark", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await expect(page.locator("#inside-each-sleeve .alp__card").first()).toBeVisible();

  const marks = page.locator('section.alp [data-mark="series"]');
  expect(await marks.count()).toBeGreaterThan(8);
  await expect(page.locator('.alp__donut svg path[data-mark="series"]')).toHaveCount(2);
  await expect(page.locator('.alp__stk > span:not([data-mark="series"])')).toHaveCount(0);
});

test("the page carries no em dash in its own copy", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await expect(page.locator("#inside-each-sleeve .alp__card").first()).toBeVisible();

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

test("on a phone the fan becomes a list and nothing scrolls the page sideways", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await expect(page.locator("#inside-each-sleeve .alp__card").first()).toBeVisible();

  // The donut scales rather than being swapped for a list, which is what the
  // fan it replaced had to do: its 16px in-diagram labels rendered at ~6px.
  const donut = page.locator(".alp__donut svg");
  await expect(donut).toBeVisible();
  const donutBox = await donut.boundingBox();
  expect(donutBox!.width).toBeGreaterThan(120);
  expect(donutBox!.width).toBeLessThanOrEqual(390);
  await expect(page.locator(".alp__legend-list li")).toHaveCount(4);

  // Wide content scrolls inside its own container, never the body.
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expectNoBrowserErrors(errors);
});




