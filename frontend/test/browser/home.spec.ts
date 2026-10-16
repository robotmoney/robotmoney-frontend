// Render spec for the Monument home page (RM-175). The page is the model
// portfolio, the agents who make it, and how to hold it; the ring, legend and
// roster read the same sources as /allocation and /swarm.
//
// Drive the live SPA at baseURL, stub the three feeds the factory reads, and
// assert on the RENDERED page (text and computed styles), never the source.
import { expect, test, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { mockVendorScripts } from "./vendor-scripts.ts";

const repoRoot = process.cwd();
const siteRoot = join(repoRoot, "frontend/public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg",
  ".xml": "application/xml", ".txt": "text/plain", ".woff2": "font/woff2",
};

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let file = join(siteRoot, normalize(decodeURIComponent(url.pathname)));
    if (!file.startsWith(siteRoot)) { res.writeHead(403).end(); return; }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (url.pathname.startsWith("/api/") || extname(url.pathname) !== "") {
        res.writeHead(404).end("not found");
        return;
      }
      file = join(siteRoot, "index.html");
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const CATEGORICAL_RGB = [
  "rgb(16, 185, 129)",
  "rgb(0, 229, 255)",
  "rgb(232, 166, 64)",
  "rgb(126, 136, 158)",
  "rgb(255, 122, 41)",
  "rgb(95, 179, 161)",
  "rgb(156, 255, 210)",
];

const SESSION_ID = "8f0d6c21-4a5e-4a1c-9f2b-7c1de2a44b10";

interface AllocationFramework {
  strategy: { label: string; targetPct: number }[];
  buckets: { key: string; label: string; items: { label: string; targetPct: number }[] }[];
  asOf: string; source: string; managed: boolean;
}

function loadGolden<T>(route: string): T {
  const goldens = JSON.parse(readFileSync(join(repoRoot, "goldens/api-goldens.json"), "utf8")) as {
    routes: Record<string, unknown>;
  };
  const payload = goldens.routes[route];
  if (!payload) throw new Error(`no ${route} golden — run \`bun run goldens:update\``);
  return payload as T;
}

function weightsSession() {
  return {
    id: SESSION_ID,
    date: "2026-09-01",
    subjectId: "robotmoney-allocation",
    subjectName: "Robot Money Allocation",
    state: "published",
    publishedAt: "2026-09-01T23:20:00.000Z",
    swarmRecommendation: {
      type: "bucket_weights",
      weights: { conservative_defi_yield: 0.9, agent_tokens: 0.05, protocol_tokens: 0.03, real_world_assets: 0.02 },
    },
  };
}

const ANALYSTS = [
  { id: "athena", handle: "athena", name: "Athena", status: "active", lens: "macro regime" },
  { id: "hermes", handle: "hermes", name: "Hermes", status: "active", lens: "on-chain flows" },
];
const JUDGE = { id: "themis", handle: "themis", name: "Themis", status: "active", role: "judge" };
const INACTIVE = { id: "retired", handle: "retired", name: "Retired", status: "inactive", lens: "gone" };

function roster(seatsAvailable = 3) {
  return { members: [...ANALYSTS, JUDGE, INACTIVE], rosterCap: 20, seatsFilled: 3, seatsAvailable };
}

async function stubHome(
  page: Page,
  {
    sessions,
    members,
    framework,
  }: {
    sessions?: unknown[] | null;
    members?: unknown | null;
    framework?: AllocationFramework | null;
  } = {},
) {
  await mockVendorScripts(page);
  const json = (payload: unknown) => ({
    status: 200, contentType: "application/json", body: JSON.stringify(payload),
  });
  // Catch-all first: later, more specific routes win (Playwright matches LIFO).
  await page.route("**/api/**", (route) => route.fulfill(json({})));
  await page.route("**/version.json", (route) => {
    if (new URL(route.request().url()).pathname !== "/version.json") return route.continue();
    return route.fulfill(json({ apiRange: "^0.5.0" }));
  });
  await page.route("**/api/version", (route) => route.fulfill(json({ api: "0.5.0", commit: null })));
  await page.route("**/api/status/maintenance", (route) =>
    route.fulfill(json({ state: "none", startsAt: null, expectedEnd: null, message: null })));
  await page.route("**/api/dashboards/allocation", (route) =>
    (framework === null
      ? route.fulfill({ status: 503, body: "down" })
      : route.fulfill(json(framework ?? loadGolden<AllocationFramework>("/api/dashboards/allocation")))));
  await page.route("**/api/swarm/sessions**", (route) => {
    if (sessions === null) return route.fulfill({ status: 503, body: "down" });
    const rows = sessions ?? [weightsSession()];
    const url = route.request().url();
    if (/\/api\/swarm\/sessions\/[^/?]+/.test(url) && !url.includes("?")) {
      return route.fulfill(json({ session: rows[0] ?? weightsSession(), takes: [] }));
    }
    return route.fulfill(json({ sessions: rows, nextCursor: null }));
  });
  await page.route("**/api/swarm/members**", (route) =>
    (members === null
      ? route.fulfill({ status: 503, body: "down" })
      : route.fulfill(json(members ?? roster()))));
}

const NETWORK_NOISE =
  /^console: Failed to load resource: (the server responded with a status of \d+|net::ERR_[A-Z_]+)/;

function failOnBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    errors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack || e.message}`));
  return errors;
}
async function expectNoBrowserErrors(errors: string[], { allowNetworkNoise = false } = {}) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const seen = allowNetworkNoise ? errors.filter((e) => !NETWORK_NOISE.test(e)) : errors;
  expect(seen).toEqual([]);
}

async function openHome(page: Page) {
  await page.goto(`${origin}/`);
  await expect(page.locator(".hm-hero__h")).toBeVisible({ timeout: 15_000 });
}

test("copy, CTAs and routes: the approved page, no em dash, coming soon only on the ways not yet live", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubHome(page);
  await openHome(page);

  const hero = page.locator(".hm-hero");
  await expect(hero.locator("h1")).toContainText("The model portfolio for crypto.");
  await expect(hero.locator("h1")).toContainText("Made by a swarm of AI agents.");
  await expect(hero.locator(".hm-hero__cta .btn-primary")).toHaveAttribute("href", "/deposit");
  await expect(hero.locator(".hm-hero__cta .btn-primary")).toContainText("Deposit USDC");
  await expect(hero.locator(".hm-hero__cta .rr-btn")).toHaveAttribute("href", "/allocation");

  // Fixed and clear over the monument: a WebGL canvas is not sampled by
  // backdrop-filter, so a frosted fill would read as a lid.
  const bar = page.locator("nav.nav");
  await expect(bar).toHaveCSS("position", "fixed");
  await expect(bar).toHaveClass(/nav--over-hero/);
  const atRest = await bar.evaluate((el) => {
    const cs = getComputedStyle(el);
    const m = cs.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/);
    return {
      a: m ? (m[4] === undefined ? 1 : Number(m[4])) : 1,
      blur: cs.backdropFilter || cs.getPropertyValue("-webkit-backdrop-filter"),
    };
  });
  expect(atRest.a).toBeLessThan(0.1);
  expect(/^(none|blur\(0px\))?$/.test(atRest.blur)).toBe(true);

  // The veil follows the scroll (2026-10-16): partial on the way down, full by
  // the time the headline meets the bar, so the logo never sits over it.
  const veilAlpha = () => bar.evaluate((el) => {
    const m = getComputedStyle(el).backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/);
    return m ? (m[4] === undefined ? 1 : Number(m[4])) : 1;
  });
  await page.evaluate(() => window.scrollTo({ top: 40, behavior: "instant" }));
  await expect.poll(veilAlpha).toBeGreaterThan(0.01);
  expect(await veilAlpha()).toBeLessThan(0.8);
  await page.evaluate(() => {
    const h = document.querySelector(".hm-hero__h");
    if (h) window.scrollTo({ top: h.getBoundingClientRect().top + window.scrollY, behavior: "instant" });
  });
  await expect.poll(veilAlpha).toBeGreaterThanOrEqual(0.8);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await expect.poll(veilAlpha).toBeLessThan(0.1);

  await expect(page.locator("#model a").filter({ hasText: "Recommendation history" }))
    .toHaveAttribute("href", "/swarm/subjects/robotmoney-allocation");
  await expect(page.locator("#made a").filter({ hasText: "Check the math" }))
    .toHaveAttribute("href", `/swarm/sessions/${SESSION_ID}`);
  await expect(page.locator("#members a").filter({ hasText: "Meet the swarm" })).toHaveAttribute("href", "/swarm");
  await expect(page.locator("#members a").filter({ hasText: "Apply for a seat" })).toHaveAttribute("href", "/swarm/apply");
  await expect(page.locator("#members a").filter({ hasText: "regime" })).toHaveAttribute("href", "/regime");
  await expect(page.locator("#members a").filter({ hasText: "Read our research" })).toHaveAttribute("href", "/blog");
  await expect(page.locator("#hold .btn-primary")).toHaveAttribute("href", "/deposit");

  // The problem comes first, then the answer: the section sits between the
  // hero and the model portfolio, and hands over to it.
  const order = await page.evaluate(() => [...document.querySelectorAll(".hm > header, .hm > section")].map((el) => el.id || el.tagName.toLowerCase()));
  expect(order.slice(0, 3)).toEqual(["header", "problem", "model"]);
  const problem = page.locator("#problem");
  await expect(problem.locator("h2")).toHaveText(/On-chain treasuries\s*are still run by hand\./);
  await expect(problem.locator(".hm-figs dt")).toHaveText(["$5.1B", "2\u00d7", "3.6%"]);
  await expect(problem.locator(".hm-answer__h")).toHaveText(/\$934B of US assets tracks a model portfolio\.\s*Crypto has none\./);
  await expect(problem.locator(".hm-answer__p")).toContainText("every treasury improvises its own.");

  // "Coming soon" marks only the two ways to hold the model portfolio that are
  // not live yet (David, 2026-10-16), as the house's one chip, never in prose.
  const soon = page.locator("#hold .rm-soon");
  await expect(soon).toHaveCount(2);
  await expect(page.locator("#hold li").filter({ hasText: "Your own account" }).locator(".rm-soon")).toHaveText("Coming soon");
  await expect(page.locator("#hold li").filter({ hasText: "Partner platforms" }).locator(".rm-soon")).toHaveText("Coming soon");
  await expect(page.locator("#hold li").filter({ hasText: "Robot Money vaults" }).locator(".rm-soon")).toHaveCount(0);
  const prose = await page.locator(".hm").evaluate((el) => {
    const c = /** @type {HTMLElement} */ (el.cloneNode(true));
    c.querySelectorAll(".rm-soon").forEach((n) => n.remove());
    return c.innerText;
  });
  expect(prose).not.toMatch(/coming soon/i);
  const body = await page.locator(".hm").innerText();
  expect(body).not.toContain("\u2014");

  await expectNoBrowserErrors(errors);
});

test("the ring has four CATEGORICAL arcs, a receipt and the history", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubHome(page);
  await openHome(page);

  await expect(page.locator(".hm-aside")).toContainText("Sep 1, 2026");
  await expect(page.locator(".hm-aside a")).toHaveAttribute("href", `/swarm/sessions/${SESSION_ID}`);

  const arcs = page.locator('.hm-ring circle[data-mark="series"]');
  await expect(arcs).toHaveCount(4);
  const strokes = await arcs.evaluateAll((els) => els.map((el) => getComputedStyle(el).stroke));
  expect(strokes).toEqual(CATEGORICAL_RGB.slice(0, 4));

  await page.locator(".hm-model").scrollIntoViewIfNeeded();
  const keys = page.locator(".hm-keys li");
  await expect(keys).toHaveCount(4);
  await expect(keys.nth(0)).toContainText("Fixed Income");
  await expect(keys.nth(0).locator(".hm-keys__pct")).toHaveText("90%", { timeout: 3_000 });
  await expect(keys.nth(1)).toContainText("Small Cap Tokens");
  await expect(keys.nth(1).locator(".hm-keys__pct")).toHaveText("5%");
  await expect(keys.nth(2)).toContainText("Protocol Tokens");
  await expect(keys.nth(2).locator(".hm-keys__pct")).toHaveText("3%");
  await expect(keys.nth(3)).toContainText("Real World Assets");
  await expect(keys.nth(3).locator(".hm-keys__pct")).toHaveText("2%");

  const swatches = await keys.locator("i[data-mark=series]").evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).backgroundColor));
  expect(swatches).toEqual(CATEGORICAL_RGB.slice(0, 4));

  await keys.locator(".hm-keys__row").first().hover();
  const tok = page.locator(".hm-ring__tok");
  await expect(tok).toHaveText("rmUSDC");
  await expect(tok).toHaveAttribute("href", "/vault/rmusdc");
  await expect(page.locator(".hm-ring circle[data-sleeve].is-muted")).toHaveCount(3);

  // Once scrolled, the bar is a dark veil over a blur, dark enough that the
  // headline sliding under it never reads through the logo (2026-10-16).
  const bar = page.locator("nav.nav");
  await expect(bar).not.toHaveClass(/nav--over-hero/);
  const glass = await bar.evaluate((el) => {
    const cs = getComputedStyle(el);
    const m = cs.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/);
    return {
      a: m ? (m[4] === undefined ? 1 : Number(m[4])) : 1,
      blur: cs.backdropFilter || cs.getPropertyValue("-webkit-backdrop-filter"),
    };
  });
  expect(glass.a).toBeGreaterThanOrEqual(0.8);
  expect(glass.a).toBeLessThan(1);
  expect(glass.blur).toMatch(/blur\(/);

  await expectNoBrowserErrors(errors);
});

test("no published recommendation: a bare ring and No recommendation yet", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubHome(page, { sessions: [] });
  await openHome(page);

  await expect(page.locator(".hm-ring__empty")).toHaveText("No recommendation yet");
  await expect(page.locator('.hm-ring circle[data-mark="series"]')).toHaveCount(0);
  await expect(page.locator(".hm-keys")).toBeHidden();
  await expect(page.locator(".hm-ring .sv__wdonut circle")).toHaveCount(1);

  await expectNoBrowserErrors(errors);
});

test("members API down: Roster unavailable, and the copy still reads", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubHome(page, { members: null });
  await openHome(page);

  await expect(page.locator(".hm-crew__empty")).toContainText("Roster unavailable");
  await expect(page.locator(".hm-crew li")).toHaveCount(0);
  await expect(page.locator(".hm-hero__h")).toContainText("The model portfolio for crypto.");

  await expectNoBrowserErrors(errors, { allowNetworkNoise: true });
});

test("no free seats: All seats filled · Judges by invitation", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubHome(page, { members: roster(0) });
  await openHome(page);

  await expect(page.locator(".hm-crew__act .hm-k")).toHaveText("All seats filled · Judges by invitation");
  await expectNoBrowserErrors(errors);
});

test("the roster lists the analysts, then the judges under their own label", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await stubHome(page);
  await openHome(page);

  const analysts = page.locator(".hm-crew:not(.hm-crew--judges) li");
  await expect(analysts).toHaveCount(2);
  await expect(analysts.nth(0).locator(".hm-crew__name")).toHaveText("Athena");
  await expect(analysts.nth(0).locator("a")).toHaveAttribute("href", "/swarm/members/athena");
  await expect(analysts.nth(0).locator(".hm-crew__mark")).toBeVisible();
  await expect(analysts.nth(0).locator("small")).toHaveText("macro regime");
  await expect(analysts.nth(1).locator(".hm-crew__name")).toHaveText("Hermes");
  const judges = page.locator(".hm-judges");
  await expect(judges.locator(".hm-k")).toHaveText("Judges");
  await expect(judges.locator("li")).toHaveCount(1);
  await expect(judges.locator(".hm-crew__name")).toHaveText("Themis");
  await expect(page.locator(".hm-crew__mark")).toHaveCount(3);
  await expect(page.locator(".hm")).not.toContainText("Retired");
  await expect(page.locator(".hm-crew__act .hm-k")).toHaveText("3 seats open · Judges by invitation");

  await expectNoBrowserErrors(errors);
});

test("the rendered page keeps the Beam/Pool/Beacon covenant", async ({ page }) => {
  await stubHome(page);
  await openHome(page);
  await expect(page.locator(".hm-keys li").first()).toBeVisible();
  await page.locator(".hm-model").scrollIntoViewIfNeeded();
  await expect(page.locator(".hm-keys__pct").first()).toHaveText("90%");

  const findings = await page.evaluate((CATEGORICAL: string[]) => {
    const CYAN = ["rgb(0, 229, 255)", "rgb(0, 184, 212)"];
    const BEACON = "rgb(255, 122, 41)";
    const out: string[] = [];
    const root = document.querySelector(".hm");
    if (!root) return ["no .hm root"];
    const digits = /[0-9]/;

    for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      if (el.tagName === "CANVAS" || el.tagName === "IMG") continue;
      const cs = getComputedStyle(el);
      const tag = `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]}`;

      if (cs.backgroundImage && cs.backgroundImage !== "none") {
        out.push(`gradient/background-image on ${tag}: ${cs.backgroundImage}`);
      }
      if (cs.boxShadow && cs.boxShadow !== "none") out.push(`box-shadow on ${tag}: ${cs.boxShadow}`);
      if (cs.textShadow && cs.textShadow !== "none") out.push(`text-shadow on ${tag}: ${cs.textShadow}`);

      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent || "").join("").trim();
      const letters = (own.match(/[A-Za-z]/g) || []).length;
      if (CYAN.includes(cs.color) && digits.test(own) && letters <= 2) {
        out.push(`cyan on a figure in ${tag}: "${own.slice(0, 40)}"`);
      }
      if (cs.color === BEACON && own.length > 2) {
        out.push(`beacon as type on ${tag}: "${own.slice(0, 40)}"`);
      }
      if (el.getAttribute("data-mark") === "series") {
        const fill = cs.backgroundColor !== "rgba(0, 0, 0, 0)" ? cs.backgroundColor
          : cs.fill && cs.fill !== "none" ? cs.fill : cs.stroke;
        if (!CATEGORICAL.includes(fill)) {
          out.push(`series mark off-palette on ${tag}: ${fill}`);
        }
      }
    }
    return out;
  }, CATEGORICAL_RGB);

  expect(findings).toEqual([]);
});

test("reduced motion holds a still frame and does not hide copy", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stubHome(page);
  await openHome(page);

  await expect(page.locator(".hm")).not.toHaveClass(/hm-anim/);
  await expect(page.locator(".hm-hero__still")).toBeVisible();
  const motion = await page.locator(".hm-hero__h").evaluate((el) => getComputedStyle(el).animationName);
  expect(motion === "none" || motion === "").toBe(true);
  await expect(page.locator(".hm-hero__h")).toContainText("The model portfolio for crypto.");
  await expect(page.locator(".hm-hero__lede")).toBeVisible();

  await expectNoBrowserErrors(errors);
});

test("a 390-wide phone has no horizontal overflow", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await stubHome(page);
  await openHome(page);
  await expect(page.locator(".hm-crew li").first()).toBeVisible();

  const box = await page.evaluate(() => ({
    clientW: document.documentElement.clientWidth,
    scrollW: document.documentElement.scrollWidth,
  }));
  expect(box.scrollW).toBeLessThanOrEqual(box.clientW);

  await expectNoBrowserErrors(errors);
});
