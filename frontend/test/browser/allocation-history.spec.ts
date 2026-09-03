// Render spec for /allocation/history, the allocation's decision log (RM-115).
//
// The page is an INDEX: one row per published session on the allocation
// subject, each linking to /swarm/sessions/<uuid>, which already renders the
// full receipt. So the assertions here are about what the rows SAY and what
// the page refuses to say: no takes, no member cards, no synthesis prose, no
// weight vector where none was published, no NAV column where no route serves
// the series, and "unchanged" on every row because nothing writes the target
// weights.
//
// Same harness as allocation-view.spec.ts: the SPA and the view HTML come from
// the backend at baseURL, vendor CDN scripts are fulfilled from node_modules,
// and both feeds the page reads are stubbed. Assertions are on the RENDERED
// page, including computed styles for the covenant checks.
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

interface AllocationFramework {
  strategy: { label: string; targetPct: number }[];
  buckets: unknown[];
  asOf: string; source: string; managed: boolean;
}

function goldenFramework(): AllocationFramework {
  const goldens = JSON.parse(readFileSync(join(process.cwd(), "goldens/api-goldens.json"), "utf8")) as {
    routes: Record<string, unknown>;
  };
  const payload = goldens.routes["/api/dashboards/allocation"];
  if (!payload) throw new Error("no /api/dashboards/allocation golden — run `bun run goldens:update`");
  return payload as AllocationFramework;
}

const ALLOCATION_SUBJECT = "robotmoney-allocation";

function session(over: Record<string, unknown> = {}) {
  return {
    id: "8f0d6c21-4a5e-4a1c-9f2b-7c1de2a44b10",
    date: "2026-09-01",
    subjectId: ALLOCATION_SUBJECT,
    subjectName: "Robot Money Allocation",
    state: "published",
    windowClosesAt: "2026-09-01T22:45:00.000Z",
    publishedAt: "2026-09-01T23:20:00.000Z",
    regimeSummary: { regime: "risk_on", composite: 0.5241, composite_percentile: 0.6151 },
    synthesis: "Members converge on holding the mandate.",
    swarmRecommendation: {
      type: "position_actions",
      quorum: { absent: 1, active: 5, submitted: 4, participation: 0.8 },
      stances: { bullish: 1, neutral: 1, cautious: 2 },
      meanConfidence: 0.575,
      actions: [{ token: "USDC", action: "rotate", rationale: "Route the next tranche into rmUSDC." }],
      rationale: "Swarm holds 95/5/0/0 with composite at the 62nd percentile; no tilt is licensed.",
    },
    generatedAt: "2026-09-01T23:19:00.000Z",
    ...over,
  };
}

// The set the page must filter down to two rows: two published allocation
// sessions, one COLLECTING allocation session, and one published session on a
// different portfolio.
function mixedFeed() {
  return [
    session(),
    session({ id: "b2b0a3d4-1111-4a1c-9f2b-7c1de2a44b11", date: "2026-08-31", subjectId: "woon", subjectName: "Woon Treasury" }),
    session({ id: "c3c1b4e5-2222-4a1c-9f2b-7c1de2a44b12", date: "2026-08-30", state: "collecting" }),
    session({
      id: "d4d2c5f6-3333-4a1c-9f2b-7c1de2a44b13",
      date: "2026-08-29",
      regimeSummary: { regime: "risk_off", composite: 0.2, composite_percentile: 0.1104 },
    }),
  ];
}

async function stubEnvironment(
  page: Page,
  { sessions, framework, pages }: {
    sessions?: unknown[] | null;
    framework?: AllocationFramework | null;
    pages?: Array<{ sessions: unknown[]; nextCursor: string | null }>;
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
  await page.route("**/api/dashboards/allocation", (route) =>
    (framework === null ? route.fulfill({ status: 503, body: "down" }) : route.fulfill(json(framework ?? goldenFramework()))));

  let hit = 0;
  await page.route("**/api/swarm/sessions**", (route) => {
    if (sessions === null) return route.fulfill({ status: 503, body: "down" });
    if (pages) {
      const page_ = pages[Math.min(hit, pages.length - 1)];
      hit += 1;
      return route.fulfill(json(page_));
    }
    return route.fulfill(json({ sessions: sessions ?? mixedFeed(), nextCursor: null }));
  });
}

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

// ── the index ───────────────────────────────────────────────────────────────

test("one row per PUBLISHED session on the allocation, and nothing else", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/allocation/history");

  await expect(page.getByRole("heading", { name: "Allocation history", exact: true })).toBeVisible();
  const rows = page.locator("table.alh__tbl tbody tr");
  // Two of the four feed rows qualify: the other portfolio's session and the
  // still-collecting one are both out.
  await expect(rows).toHaveCount(2);
  await expect(page.locator("table.alh__tbl")).not.toContainText("Woon");
  // Newest first.
  await expect(rows.first()).toContainText("1 Sep 2026");
  await expect(rows.nth(1)).toContainText("29 Aug 2026");
  await expectNoBrowserErrors(errors);
});

test("a row carries date, regime with its percentile, quorum, the rationale, the resulting allocation and a link to the session", async ({ page }) => {
  await stubEnvironment(page);
  const framework = goldenFramework();
  await page.goto("/index.html");
  await navigate(page, "/allocation/history");

  const row = page.locator("table.alh__tbl tbody tr").first();
  await expect(row).toContainText("1 Sep 2026");
  await expect(row).toContainText("risk-on");
  await expect(row).toContainText("62nd pct");
  await expect(row).toContainText("4 / 5");
  // Actions, not the aggregator's rationale: that sentence restates the stance
  // split, the quorum and the percentile, and this row already has two of the
  // three as columns of their own.
  await expect(row.locator(".alh__rec")).toHaveText("rotate USDC");
  await expect(row).not.toContainText("no tilt is licensed");
  // Mean confidence is the one thing the rationale carried that no column did.
  await expect(row).toContainText("57%");
  // The resulting allocation is the seeded row, the same on every session
  // because there is only one row.
  const resulting = framework.strategy.map((s) => String(s.targetPct)).join(" / ");
  await expect(row).toContainText(resulting);
  await expect(row).toContainText("unchanged");
  await expect(row.locator("a.alh__link"))
    .toHaveAttribute("href", "/swarm/sessions/8f0d6c21-4a5e-4a1c-9f2b-7c1de2a44b10");
});

test("the page is an index: no takes, no member cards, no synthesis prose", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/allocation/history");
  await expect(page.locator("table.alh__tbl tbody tr")).toHaveCount(2);

  // The session detail page's own render surfaces, none of which belong here.
  for (const selector of [".sv__take", ".sv__stance-badge", ".sv__take-lens", ".sv__member-link"]) {
    await expect(page.locator(selector)).toHaveCount(0);
  }
  // The synthesis is on the stubbed rows and must not be rendered.
  await expect(page.locator("section.alh")).not.toContainText("Members converge");
});

test("no session has changed the allocation, and the page says so rather than implying movement", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/allocation/history");

  await expect(page.locator(".alh__state")).toContainText("2 sessions, no change");
  await expect(page.locator(".alh__state")).toContainText("applying a recommendation is not built yet");
  const flags = page.locator(".alh__flag");
  await expect(flags).toHaveCount(2);
  await expect(flags.first()).toHaveText("unchanged");
  await expect(page.locator(".alh__flag--proposal")).toHaveCount(0);
});

test("a session that DOES publish a vector is reported as a proposal, not as a change", async ({ page }) => {
  // The subject is typed position_actions today, so no session carries
  // weights. The column is still computed rather than assumed: this pins the
  // behaviour for the day RM-115's third backend ask retypes the subject.
  await stubEnvironment(page, {
    sessions: [session({
      swarmRecommendation: {
        type: "bucket_weights",
        quorum: { absent: 0, active: 5, submitted: 5, participation: 1 },
        weights: {
          conservative_defi_yield: 0.8, agent_tokens: 0.1, protocol_tokens: 0.1, real_world_assets: 0,
        },
      },
    })],
  });
  await page.goto("/index.html");
  await navigate(page, "/allocation/history");

  const row = page.locator("table.alh__tbl tbody tr").first();
  await expect(row).toContainText("80 / 10 / 10 / 0");
  await expect(row.locator(".alh__flag")).toHaveText("proposed a change");
  await expect(page.locator(".alh__state")).toContainText("none was applied");
});

test("target weights over time is drawn flat, and the caption says why", async ({ page }) => {
  await stubEnvironment(page);
  const framework = goldenFramework();
  await page.goto("/index.html");
  await navigate(page, "/allocation/history");

  const chart = page.locator(".alh__chart svg");
  await expect(chart).toBeVisible();
  // One level per published sleeve, all horizontal: a flat line is the finding.
  const levels = await chart.locator("line[stroke-width]").evaluateAll((els) =>
    els.filter((el) => el.getAttribute("y1") === el.getAttribute("y2")
      && (el.getAttribute("stroke-width") || "") !== "1").length);
  expect(levels).toBe(framework.strategy.length);
  await expect(chart).toHaveAttribute("aria-label", /flat throughout/);
  await expect(page.locator("#weights-over-time")).toContainText("The lines are flat because nothing has changed them");
});

test("NAV over time renders an explicit pending state, never an empty chart", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/allocation/history");

  const pending = page.locator(".alh__pending");
  await expect(pending).toBeVisible();
  await expect(pending).toContainText("not yet published");
  await expect(pending).toContainText("vault_share_price_history");
  // No chart frame is drawn for a series that does not exist.
  await expect(page.locator("#nav-over-time svg")).toHaveCount(0);
  // And no NAV column is claimed on the rows.
  await expect(page.locator("table.alh__tbl thead")).not.toContainText("NAV");
});

test("the receipt route is never requested, because it errors on every published session", async ({ page }) => {
  const receiptHits: string[] = [];
  await stubEnvironment(page);
  await page.route("**/api/swarm/sessions/*/consensus-receipt", (route) => {
    receiptHits.push(route.request().url());
    return route.fulfill({ status: 500, body: "boom" });
  });
  await page.goto("/index.html");
  await navigate(page, "/allocation/history");
  await expect(page.locator("table.alh__tbl tbody tr")).toHaveCount(2);
  await page.waitForTimeout(300);
  expect(receiptHits).toEqual([]);
});

// ── degradation ─────────────────────────────────────────────────────────────

test("with no published allocation session the page says so instead of rendering an empty table", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubEnvironment(page, { sessions: [] });
  await page.goto("/index.html");
  await navigate(page, "/allocation/history");

  await expect(page.locator("table.alh__tbl")).toBeHidden();
  await expect(page.locator(".alh__empty--nosessions"))
    .toContainText("No session has published a recommendation on the allocation yet");
  // The chart still stands: the published allocation is a fact independent of
  // whether anyone has reviewed it.
  await expect(page.locator(".alh__chart svg")).toBeVisible();
  await expectNoBrowserErrors(errors);
});

test("with the session feed down the page reports it and keeps the weights it does have", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubEnvironment(page, { sessions: null });
  await page.goto("/index.html");
  await navigate(page, "/allocation/history");

  await expect(page.locator(".alh__error").first()).toContainText("could not be read");
  await expect(page.locator(".alh__chart svg")).toBeVisible();
  await expect(page.locator("table.alh__tbl")).toBeHidden();
  const scriptErrors = errors.filter((e) => e.startsWith("pageerror:"));
  expect(scriptErrors).toEqual([]);
});

test("with the framework feed down the rows survive and the resulting-allocation column blanks honestly", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubEnvironment(page, { framework: null });
  await page.goto("/index.html");
  await navigate(page, "/allocation/history");

  await expect(page.locator("table.alh__tbl tbody tr")).toHaveCount(2);
  await expect(page.locator("table.alh__tbl tbody tr").first()).toContainText("—");
  await expect(page.locator("#weights-over-time .alh__empty"))
    .toContainText("could not be read");
  await expect(page.locator(".alh__chart svg line")).toHaveCount(0);
  const scriptErrors = errors.filter((e) => e.startsWith("pageerror:"));
  expect(scriptErrors).toEqual([]);
});

test("the log walks the cursor rather than presenting a first page as the whole record", async ({ page }) => {
  await stubEnvironment(page, {
    pages: [
      { sessions: [session()], nextCursor: "page-2" },
      { sessions: [session({ id: "e5e3d6a7-4444-4a1c-9f2b-7c1de2a44b14", date: "2026-08-20" })], nextCursor: null },
    ],
  });
  await page.goto("/index.html");
  await navigate(page, "/allocation/history");
  await expect(page.locator("table.alh__tbl tbody tr")).toHaveCount(2);
  await expect(page.locator(".alh__count")).toContainText("2 published sessions");
});

// ── the redirect this page exists to give a destination ─────────────────────

test("/swarm/subjects/robotmoney-allocation moves here, URL and all", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/allocation/history");
  // Arriving at the old address from inside the app.
  await page.evaluate(() => {
    history.pushState({}, "", "/swarm/subjects/robotmoney-allocation");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  await expect(page.getByRole("heading", { name: "Allocation history", exact: true })).toBeVisible();
  // The address bar is corrected, so the URL a reader copies is the real one.
  expect(new URL(page.url()).pathname).toBe("/allocation/history");
  // The portfolio template must not render for a subject with no portfolio.
  await expect(page.locator(".sv__holdings, .sv__concentration")).toHaveCount(0);
  await expectNoBrowserErrors(errors);
});

test("following the old address leaves no back-button trap", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/index.html");
  // Any page with a link to the old address will do; /faq reads no feed, so
  // the only thing under test here is the history stack.
  await navigate(page, "/faq");
  const before = await page.evaluate(() => history.length);

  // Exactly what router.js's onClick does for a same-origin link: push the
  // href, then render it. The redirect happens inside that render.
  await page.evaluate(() => {
    history.pushState({}, "", "/swarm/subjects/robotmoney-allocation");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("heading", { name: "Allocation history", exact: true })).toBeVisible();

  // replaceState, not pushState: the redirect corrects the entry the click
  // created instead of adding a second one, so one press of Back reaches the
  // page the reader came from rather than bouncing forward off the redirect.
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await page.goBack();
  expect(new URL(page.url()).pathname).toBe("/faq");
});

// ── the brand covenant, judged on the RENDERED page ─────────────────────────

test("the rendered page keeps the Beam/Pool/Beacon covenant", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/allocation/history");
  await expect(page.locator("table.alh__tbl")).toBeVisible();

  const findings = await page.evaluate(() => {
    const CYAN = ["rgb(0, 229, 255)", "rgb(0, 184, 212)"];
    const BEACON = "rgb(255, 122, 41)";
    const out: string[] = [];
    const root = document.querySelector("section.alh");
    if (!root) return ["no .alh root"];
    const digits = /[0-9]/;

    for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const tag = `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]}`;
      if (cs.backgroundImage && cs.backgroundImage !== "none") {
        out.push(`gradient/background-image on ${tag}: ${cs.backgroundImage}`);
      }
      if (cs.boxShadow && cs.boxShadow !== "none") out.push(`box-shadow on ${tag}: ${cs.boxShadow}`);
      if (cs.textShadow && cs.textShadow !== "none") out.push(`text-shadow on ${tag}: ${cs.textShadow}`);

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
      if (CYAN.includes(cs.backgroundColor) && box.width * box.height > 200) {
        out.push(`cyan mass on ${tag}: ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
      if (cs.backgroundColor === BEACON && (box.width > 12 || box.height > 12)) {
        out.push(`beacon larger than a point on ${tag}: ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
    }

    // The regime dot is a POINT and has to actually render: a stance dot sized
    // 0x0 was a real defect on the committee tree, invisible in the CSS.
    for (const dot of Array.from(root.querySelectorAll<HTMLElement>(".alh__dot"))) {
      const box = dot.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) out.push("regime dot renders at 0x0");
      if (box.width > 12 || box.height > 12) out.push(`regime dot is ${box.width}px, over the point cap`);
      // Round, because a ROUND dot is a reading and a SQUARE one is an
      // identity: this dot is a reading of the market.
      if (parseFloat(getComputedStyle(dot).borderTopLeftRadius) < box.width / 2 - 0.5) {
        out.push("regime dot is not round");
      }
    }
    return out;
  });

  expect(findings).toEqual([]);
});

test("the page carries no em dash in its own copy", async ({ page }) => {
  await stubEnvironment(page);
  await page.goto("/index.html");
  await navigate(page, "/allocation/history");
  await expect(page.locator("table.alh__tbl")).toBeVisible();

  // The em dash is also the site's null glyph, so only runs of PROSE are
  // checked: a lone "—" in a cell is a missing value, not punctuation.
  const offenders = await page.evaluate(() => {
    const root = document.querySelector("section.alh");
    if (!root) return ["no .alh root"];
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

test("on a phone the log scrolls inside its own container, not the page", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // A session with no actions, so the cell falls back to the long rationale:
  // that is the value the wrap and the clamp exist for.
  await stubEnvironment(page, {
    sessions: [session({
      swarmRecommendation: {
        type: "position_actions",
        quorum: { absent: 1, active: 5, submitted: 4, participation: 0.8 },
        meanConfidence: 0.575,
        rationale: "Majority stance is constructive (3 of 5 submitted takes), mean confidence "
          + "0.57, regime composite at the 66th percentile on Robot Money Allocation, and the "
          + "load-bearing action is routing the next stable tranche into rmUSDC.",
      },
    })],
  });
  await page.goto("/index.html");
  await navigate(page, "/allocation/history");
  await expect(page.locator("table.alh__tbl")).toBeVisible();

  const wrap = page.locator(".alh__tblwrap");
  expect(await wrap.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  // The rationale cell WRAPS and then clamps, rather than pushing the row to the
  // height of a paragraph or, as it did until the specificity of
  // `table.alh__tbl td { white-space: nowrap }` was noticed, running off the
  // cell edge as one clipped line with the clamp doing nothing.
  const rec = page.locator(".alh__rec").first();
  const box = await rec.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      height: el.getBoundingClientRect().height,
      lineHeight: parseFloat(cs.lineHeight),
      whiteSpace: cs.whiteSpace,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    };
  });
  expect(box.whiteSpace).not.toBe("nowrap");
  expect(box.height).toBeGreaterThan(box.lineHeight * 1.5);
  expect(box.height).toBeLessThanOrEqual(box.lineHeight * 2 + 2);
  // Wrapped, not overflowing sideways inside its own cell.
  expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
  await expectNoBrowserErrors(errors);
});
