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
  await expect(page.locator("#vault")).toBeVisible();
  await page.waitForTimeout(300);

  expect(houseBook, "wallet-balances / wallet-sleeves are the house book (RM-103)").toEqual([]);
  // And nothing on the page prints the house book's own vocabulary.
  await expect(page.locator("section.alp")).not.toContainText("AUM");
  await expect(page.locator("section.alp")).not.toContainText("Agent Wallet");
  await expectNoBrowserErrors(errors);
});

// ── the live bindings ───────────────────────────────────────────────────────

test("the vault section binds every adapter row to the vault-economics golden and reconciles to TVL", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  const vault = goldenVault();
  await stubEnvironment(page, { vault });
  await page.goto("/index.html");
  await navigate(page, "/allocation");

  const rows = page.locator("#vault table.alp__tbl tbody tr");
  // three adapters + idle USDC + the total row
  await expect(rows).toHaveCount(vault.adapters.length + 2);

  // Rows render in feed order. They are matched by position rather than by the
  // protocol name because the page NAMES the position rather than the protocol:
  // Morpho's is a specific curated vault, and "Gauntlet USDC Prime" is the
  // difference between "three lending venues" and "two pooled markets and a
  // vault somebody else sets the caps on".
  for (const [i, adapter] of vault.adapters.entries()) {
    const row = rows.nth(i);
    await expect(row).toContainText(usd2(adapter.balanceUsd));
    await expect(row).toContainText("$1.0000");
    await expect(row.locator("a")).toHaveAttribute("href", `https://basescan.org/address/${adapter.address}`);
  }
  // The golden's first adapter is Morpho, and the page names the POSITION, not
  // the protocol.
  await expect(rows.nth(0)).toContainText("Gauntlet USDC Prime");
  await expect(page.locator("#vault tr.tot")).toContainText(usd2(vault.tvlUsd));

  // The rail's live figure comes from the same payload.
  await expect(page.locator(".alp__stat", { hasText: "Vault TVL" }).locator("dd"))
    .toHaveText(usd2(vault.tvlUsd));
  await expectNoBrowserErrors(errors);
});

test("sleeve weights, held weights and drift are derived from the two feeds, not baked", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  const vault = goldenVault();
  const framework = goldenFramework();
  await stubEnvironment(page, { vault, framework });
  await page.goto("/index.html");
  await navigate(page, "/allocation");

  const bullets = page.locator(".alp__bullet");
  await expect(bullets).toHaveCount(framework.buckets.length);

  // The vault's assets are its funded adapters, so everything it holds sits in
  // the yield sleeve. Held is computed from the balances, which is what makes
  // "held at zero" a reading rather than a copy decision.
  const funded = vault.adapters.filter((a) => a.configured !== false && a.balanceUsd != null);
  const adapterTotal = funded.reduce((sum, a) => sum + Number(a.balanceUsd), 0);
  const heldPct = (adapterTotal / Number(vault.tvlUsd)) * 100;

  const yieldSleeve = bullets.first();
  await expect(yieldSleeve).toContainText(framework.buckets[0].label);
  await expect(yieldSleeve).toContainText(`held ${heldPct.toFixed(1)}%`);
  await expect(yieldSleeve).toContainText(`target ${String(framework.strategy[0].targetPct)}%`);
  const drift = heldPct - Number(framework.strategy[0].targetPct);
  await expect(yieldSleeve).toContainText(`${drift >= 0 ? "+" : "−"}${Math.abs(drift).toFixed(1)}pp`);

  // A sleeve with a target and nothing held reads held at zero, with its drift
  // spelled out rather than hidden.
  const agentSleeve = bullets.nth(1);
  await expect(agentSleeve).toContainText("held 0.0%");
  await expect(agentSleeve).toContainText(`target ${String(framework.strategy[1].targetPct)}%`);

  // A constituent held at zero is DRAWN, not hidden (RM-115).
  const yieldPanel = page.locator(".alp__sleeve").first();
  await expect(yieldPanel.locator(".alp__const-row")).toHaveCount(framework.buckets[0].items.length);
  await expect(yieldPanel).toContainText("Sky");
  await expectNoBrowserErrors(errors);
});

test("the latest recommendation is the session's rationale, and the page says why it is not a vector", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  const session = allocationSession();
  await stubEnvironment(page, { sessions: [session, { ...allocationSession({ id: "x", subjectId: "woon" }) }] });
  await page.goto("/index.html");
  await navigate(page, "/allocation");

  const block = page.locator(".alp__latest");
  await expect(block).toContainText("1 Sep 2026");
  await expect(block).toContainText("4 of 5 took part");
  // The ACTIONS lead: they are what the session recommended. The aggregator's
  // rationale follows as the supporting sentence.
  await expect(block.locator(".alp__latest-line")).toHaveText("rotate USDC");
  await expect(block.locator(".alp__latest-why")).toHaveText(session.swarmRecommendation.rationale);
  await expect(block).toContainText("no weight change");
  await expect(block.locator("a"))
    .toHaveAttribute("href", `/swarm/sessions/${session.id}`);
  await expect(page.locator("#latest-recommendation")).toContainText("position_actions");
  await expectNoBrowserErrors(errors);
});

test("the two figures with no route behind them render an explicit pending state", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/allocation");

  const pending = page.locator(".alp__stat dd.pend");
  await expect(pending).toHaveCount(2);
  await expect(pending.first()).toHaveText("not yet published");
  await expect(page.locator(".alp__stat", { hasText: "NAV / share" })).toContainText("recorded series");
  await expect(page.locator(".alp__stat", { hasText: "Since inception" })).toContainText("needs NAV per share");
  // The spot share price IS served, and is shown as a spot read rather than
  // stretched into the series it is not.
  const vault = goldenVault();
  await expect(page.locator(".alp__fact", { hasText: "Share price" }))
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
  const badges = page.locator("#vault .alp__cell-badge");
  await expect(badges.first()).toContainText(/^stale \(/);
  await expect(page.locator(".alp__stat", { hasText: "Vault TVL" })).toContainText("(stale)");
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
  await expect(page.locator("#vault .alp__cell-badge", { hasText: "caught up late" })).toBeVisible();
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
    await expect(page.locator(".alp__force-line")).toContainText("No session has moved these weights");
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

test("the reference series discloses the window between its last day and today", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  const seam = page.locator(".alp__seam");
  await expect(seam).toBeVisible();
  await expect(seam).toContainText("This comparison ends 26 Aug 2026");
  await expect(seam).toContainText("no collector serves these rates yet");
});

// Each feed absent, one at a time: the rest of the page stands, the missing
// half says it is missing, and nothing is fabricated in its place.
const ABSENT_FEEDS = [
  { feed: "vault" as const, stub: { vault: null } },
  { feed: "framework" as const, stub: { framework: null } },
  { feed: "sessions" as const, stub: { sessions: null } },
];

for (const { feed, stub } of ABSENT_FEEDS) {
  test(`the page stands with the ${feed} feed absent, and says which half is missing`, async ({ page }) => {
    const errors = failOnBrowserErrors(page);
    await stubEnvironment(page, stub);
    await page.goto("/index.html");
    await navigate(page, "/allocation");

    // The headline and every section still render.
    await expect(page.getByRole("heading", { name: "Asset Allocation", exact: true })).toBeVisible();
    for (const id of ["#allocation", "#inside-each-sleeve", "#what-it-pays", "#vault", "#latest-recommendation", "#exposure"]) {
      await expect(page.locator(id)).toBeVisible();
    }

    if (feed === "vault") {
      await expect(page.locator(".alp__badge", { hasText: "Vault feed unavailable" })).toBeVisible();
      await expect(page.locator(".alp__stat", { hasText: "Vault TVL" }).locator("dd")).toHaveText("—");
    }
    if (feed === "framework") {
      await expect(page.locator(".alp__badge", { hasText: "Target weights unavailable" })).toBeVisible();
      await expect(page.locator(".alp__empty").first()).toContainText("could not be read");
      await expect(page.locator(".alp__bullet")).toHaveCount(0);
    }
    if (feed === "sessions") {
      await expect(page.locator(".alp__latest-line--pend")).toContainText("could not be read");
    }

    // A 503 from a stubbed route is a network-level failure the page handles;
    // it is not a page error. Only script errors are asserted here.
    const scriptErrors = errors.filter((e) => e.startsWith("pageerror:"));
    expect(scriptErrors).toEqual([]);
  });
}

// ── the brand covenant, judged on the RENDERED page ─────────────────────────

test("the rendered page keeps the Beam/Pool/Beacon covenant", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await expect(page.locator("#vault")).toBeVisible();

  const findings = await page.evaluate(() => {
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
      // Cyan is a LINE, never a mass. Anything cyan-filled bigger than a rule.
      if (CYAN.includes(cs.backgroundColor) && box.width * box.height > 200) {
        out.push(`cyan mass on ${tag}: ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
      // Beacon is a POINT, capped about 12px.
      if (cs.backgroundColor === BEACON && (box.width > 12 || box.height > 12)) {
        out.push(`beacon larger than a point on ${tag}: ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
    }

    // The ::before markers on the two pending tiles are Beacon points and are
    // measured separately, because a pseudo-element has no element to query.
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(".alp__stat dd.pend"))) {
      const cs = getComputedStyle(el, "::before");
      const size = Math.max(parseFloat(cs.width) || 0, parseFloat(cs.height) || 0);
      if (cs.backgroundColor === BEACON && size > 12) out.push(`beacon point ${size}px`);
      if (cs.backgroundColor !== BEACON) out.push(`pending marker is not beacon: ${cs.backgroundColor}`);
      if (size === 0) out.push("pending marker renders at 0px");
    }
    return out;
  });

  expect(findings).toEqual([]);
});

test("the page carries no em dash in its own copy", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/allocation");
  await expect(page.locator("#vault")).toBeVisible();

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
  await expect(page.locator("#vault")).toBeVisible();

  // Under 640px the SVG's 16px labels would render at about 6px, so the same
  // rows render as a list instead.
  await expect(page.locator(".alp__fan > svg")).toBeHidden();
  await expect(page.locator(".alp__fan-list li")).toHaveCount(4);

  // Wide content scrolls inside its own container, never the body.
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expectNoBrowserErrors(errors);
});
