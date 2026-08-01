// Render + interaction tests for /submit — public intake (issue #393,
// docs/bot-analytics-ui-port-plan.md §5.17). Same harness as list-view.spec.ts
// (vendor CDN scripts served from node_modules), but no gate mock needed —
// /submit is the one dashboard route routes.js marks `gated: false`.
// GET /api/dashboards/entities is stubbed for the tag-agent Select; POST
// /api/dashboards/submissions is stubbed per-test so validation/toast paths
// are deterministic (the real backend wire contract for that endpoint is
// covered independently by backend/tests/submissions.test.ts against a real
// Postgres — this spec is UI-behavior coverage, not backend contract proof).
import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mockVendorScripts } from "./vendor-scripts.ts";
import { navigate } from "./navigation.ts";

const ENTITIES = {
  entities: [
    { id: "a1", type: "agent", name: "Agent One", ticker: null, category: "x402", href: "/agents/a1", contextual: 80, lastTxAt: null, revenue: 500, balance: null, change24h: null, sparkline: [], pending: false, refreshedAt: null, stale: false },
    { id: "a2", type: "agent", name: "Pending Agent", ticker: null, category: "x402", href: "/agents/a2", contextual: 10, lastTxAt: null, revenue: 0, balance: null, change24h: null, sparkline: [], pending: true, refreshedAt: null, stale: true },
    { id: "c1", type: "coin", name: "Coin One", ticker: "ONE", category: "base", href: "/lobster/c1", contextual: 1, lastTxAt: null, revenue: 0, balance: null, change24h: null, sparkline: [], pending: false, refreshedAt: null, stale: false },
  ],
};

function mockEntities(page: Page): void {
  page.route("**/api/dashboards/entities", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ENTITIES) }));
}

test.beforeEach(async ({ page }) => {
  await mockVendorScripts(page);
  mockEntities(page);
});

test("renders the CommitForm ungated, with only non-pending agents in the tag-agent select", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/submit");
  await expect(page.locator("[data-dash-gate]")).not.toBeVisible();
  await expect(page.locator("[data-submit-view]")).toBeVisible();

  const options = page.locator("[data-submit-agent-select] option");
  await expect(options).toHaveCount(2); // "— none —" + Agent One (Pending Agent excluded)
  await expect(page.locator("[data-submit-agent-select] option", { hasText: "Agent One" })).toHaveCount(1);
  await expect(page.locator("[data-submit-agent-select] option", { hasText: "Pending Agent" })).toHaveCount(0);
});

test("form validation: blocks submit without a handle or summary, and without a registration name for Register Agent", async ({ page }) => {
  let posted = false;
  await page.route("**/api/dashboards/submissions", (route) => {
    posted = true;
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: "s1", status: "pending" }) });
  });
  await page.goto("/");
  await navigate(page, "/submit");

  // Default actionType is register_agent (§5.17: "incl. 🤖 Register Agent"
  // as the form's leading action) — the sub-panel is open and its name field
  // empty, so submit must 400 client-side without ever reaching the network.
  await page.locator("[data-submit-submit]").click();
  await expect(page.locator('[data-submit-error="submitterHandle"]')).toBeVisible();
  await expect(page.locator('[data-submit-error="summary"]')).toBeVisible();
  await expect(page.locator('[data-submit-error="registrationName"]')).toBeVisible();
  expect(posted).toBe(false);

  await page.locator("[data-submit-handle]").fill("@tester");
  await page.locator("[data-submit-summary]").fill("Registering my agent.");
  await page.locator("[data-submit-reg-name]").fill("MoneyBot");
  await page.locator("[data-submit-submit]").click();
  await expect.poll(() => posted).toBe(true);
});

test("agent-registration sub-panel toggles with the action-type select", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/submit");

  await expect(page.locator("[data-submit-registration-panel]")).toBeVisible();
  await page.locator("[data-submit-action-select]").selectOption("general");
  await expect(page.locator("[data-submit-registration-panel]")).toHaveCount(0);
  await page.locator("[data-submit-action-select]").selectOption("register_agent");
  await expect(page.locator("[data-submit-registration-panel]")).toBeVisible();
  await expect(page.locator("[data-submit-claimed-metrics]")).toBeVisible();
});

test("the CommitForm collapses and expands via its header", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/submit");

  await expect(page.locator("[data-submit-summary]")).toBeVisible();
  await page.locator("[data-submit-collapse-toggle]").click();
  await expect(page.locator("[data-submit-summary]")).toBeHidden();
  await page.locator("[data-submit-collapse-toggle]").click();
  await expect(page.locator("[data-submit-summary]")).toBeVisible();
});

test("copy buttons on the MCP-replacement card and the Programmatic API card copy real content", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await navigate(page, "/submit");

  const mcpCopy = page.locator("[data-submit-mcp-card] [data-copy]");
  await mcpCopy.click();
  await expect(mcpCopy).toHaveClass(/is-copied/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("/api/dashboards/submissions");

  const apiCopy = page.locator("[data-submit-api-card] [data-copy]");
  await apiCopy.click();
  await expect(apiCopy).toHaveClass(/is-copied/);
  const apiClip = await page.evaluate(() => navigator.clipboard.readText());
  expect(apiClip).toContain("POST /api/dashboards/submissions");
  expect(apiClip).toContain("register_agent");
});

test("valid action_type list and back link render correctly", async ({ page }) => {
  await page.goto("/");
  await navigate(page, "/submit");

  await expect(page.locator("[data-submit-api-card]")).toContainText("register_agent");
  await expect(page.locator("[data-submit-api-card]")).toContainText("general");
  await expect(page.locator("[data-submit-back-link]")).toHaveAttribute("href", "/list");
});

// ── non-GET no-op in preview (§5.17 acceptance) ──────────────────────────────
// scripts/preview-server.ts answers every non-GET /api/* with a generic
// {ok:true, mocked:true} no-op (proven path-agnostically by
// preview-smoke.spec.ts's own "/api/test" case) — this test drives that SAME
// mock through the REAL CommitForm UI rather than a synthetic fetch, so a
// regression that made the form choke on an unexpected 200 body would be
// caught here.
test.describe("preview mode (bun run preview URL space)", () => {
  let server: ChildProcess;
  let baseUrl: string;

  test.beforeAll(async () => {
    server = spawn("bun", ["scripts/preview-server.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: "0" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    baseUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("preview server did not print its URL within 15s")), 15_000);
      let out = "";
      server.stdout!.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
        if (m) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${m[1]}`);
        }
      });
      server.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`preview server exited early (code ${code})`));
      });
    });
  });

  test.afterAll(() => {
    server?.kill();
  });

  test("submitting the CommitForm in preview mode no-ops instead of erroring", async ({ page }) => {
    await page.goto(`${baseUrl}/#/submit`);
    const iframe = page.frameLocator("#frame");
    await expect(iframe.locator("[data-submit-view]")).toBeVisible({ timeout: 15_000 });

    await iframe.locator("[data-submit-handle]").fill("@tester");
    await iframe.locator("[data-submit-summary]").fill("Registering my agent.");
    await iframe.locator("[data-submit-reg-name]").fill("MoneyBot");
    // force:true — the constrained preview iframe's cramped viewport can put
    // the site-wide sticky nav (marketing chrome every page carries, not
    // this view's own markup) over the button's scroll-into-view position;
    // unrelated to this form's own clickability, already proven by the
    // non-preview specs above.
    await iframe.locator("[data-submit-submit]").click({ force: true });

    // The mocked {ok:true, mocked:true} response (no `id`/`status` fields a
    // real Submission carries) still resolves the promise, so the form
    // treats it as success: resets and shows the success toast — it must
    // NOT surface an error toast or throw.
    await expect(iframe.locator(".a3-toast--success")).toBeVisible({ timeout: 10_000 });
    await expect(iframe.locator(".a3-toast--destructive")).toHaveCount(0);
  });
});
