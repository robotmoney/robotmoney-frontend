import { expect, test } from "@playwright/test";
import { navigate } from "./navigation.ts";

// The public application-status page (/swarm/apply/:id, docs/architecture.md
// §11 R2) renames the tab after the applying member once the status poll and
// the member projection resolve — route-level SEO would otherwise titleize the
// raw UUID in the URL.
//
// That write sits behind two awaits inside refresh(), and destroy() can only
// stop the NEXT poll: it cannot cancel a request already in flight. So before
// syncTitle()'s route guard, a slow first refresh renamed whatever page the
// visitor had moved to — the same leak swarm-member-profile.spec.ts and
// swarm-subject.spec.ts pin for the two profile pages.
test("a slow application-status fetch does not stamp its name on the route the visitor moved to", async ({ page }) => {
  const FETCH_DELAY_MS = 2500;
  const MEMBER_ID = "88efd6b9-e865-417d-afe1-45d84510338b";
  const MEMBER_NAME = "Athena";

  await page.route("**/api/swarm/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === `/api/swarm/apply/${MEMBER_ID}`) {
      await new Promise((resolve) => setTimeout(resolve, FETCH_DELAY_MS));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: MEMBER_ID, state: "approved" }),
      });
    }
    if (pathname === `/api/swarm/members/${MEMBER_ID}`) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: MEMBER_ID, name: MEMBER_NAME }),
      });
    }
    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });

  // Leave before the status resolves.
  await page.goto(`/swarm/apply/${MEMBER_ID}`);
  await navigate(page, "/faq");

  const faqTitle = await page.title();
  expect(faqTitle).not.toContain(MEMBER_NAME);
  expect(faqTitle).not.toContain("Application");

  // Outlast the fetch, then confirm nothing moved. Read after the delay rather
  // than polling for a negative, which would pass simply by being early.
  await page.waitForTimeout(FETCH_DELAY_MS + 1500);
  expect(await page.title()).toBe(faqTitle);
});
