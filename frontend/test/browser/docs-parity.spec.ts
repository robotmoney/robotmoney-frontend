// Issue #354 compliance-FAIL regression guards, browser half.
//
// PR #328's acceptance criteria for /skill.md and /articles/treasury-allocation
// were checked off on the strength of a prior worker's manual browser-rendering
// pass alone — no executed test navigated either URL. These two specs exercise
// the real dev/smoke backend (same baseURL every other frontend/test/browser
// spec runs against — see playwright.config.ts) so a future regression that
// reintroduces either 404 fails CI, not just a human's memory of having once
// checked it.
import { expect, test } from "@playwright/test";

test("GET /skill.md returns 200 with the full robotmoney-cli manifest", async ({ page }) => {
  const response = await page.request.get("/skill.md");
  expect(response.status()).toBe(200);

  const body = await response.text();
  // Frontmatter identity — the manifest's name/description block, not just
  // "some text came back".
  expect(body).toContain("name: robotmoney-cli");
  expect(body).toContain("# robotmoney-cli");
  // The CLI's never-holds-keys invariant, called out explicitly in the
  // manifest body — a stronger content check than a bare substring of the
  // frontmatter alone.
  expect(body).toContain("The CLI never holds private keys");
});

test("/articles/treasury-allocation renders the treasury-allocation article, not a 404", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/articles/treasury-allocation");

  await expect(page.locator(".blog-research__title")).toContainText("Treasury Allocation for");
  await expect(page.locator(".blog-research__title")).toContainText("On-Chain Businesses");
  // frontend/public/views/not-found.html (<h1>Page not found</h1>, an
  // .eyebrow of literal "404") is what the router falls back to on a
  // missing/failed fragment fetch — assert its absence so this test would
  // actually fail if the route regressed to dropping through the client
  // router's not-found path instead of rendering the real article.
  await expect(page.getByRole("heading", { name: "Page not found" })).toHaveCount(0);
  await expect(page.locator(".eyebrow", { hasText: "404" })).toHaveCount(0);

  expect(errors).toEqual([]);
});
