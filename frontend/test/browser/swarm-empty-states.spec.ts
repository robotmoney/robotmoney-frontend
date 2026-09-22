import { expect, test, type Page } from "@playwright/test";

// Every chart and table on the swarm pages keeps its frame when it has
// nothing to show, and states what is not there in one line (RM-121): a table
// keeps its head and gets one row, a ring is its bare track with the line in
// its centre, and a chart or a list of cards keeps a frame of its size.
//
// The API is stubbed so each page is reached with nothing in it. The subject,
// session and member used here are not in the shipped archive, which the
// archived four fall back to when the API has nothing for them.

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const notFound = { status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) };

async function stub(page: Page, routes: Record<string, unknown>): Promise<void> {
  await page.route("**/api/**", (route) => {
    const { pathname } = new URL(route.request().url());
    return pathname in routes ? route.fulfill(json(routes[pathname])) : route.fulfill(notFound);
  });
}

const emptyRow = (page: Page, section: string) => page.locator(`${section} .rr-table__empty`);
const emptyRing = (page: Page, section: string) => page.locator(`${section} .rr-ring--empty figcaption`);

test("the swarm with no members and no session keeps every table and the ring, each saying what is missing", async ({ page }) => {
  await stub(page, {
    "/api/swarm/members": { members: [], rosterCap: 10, seatsFilled: 0, seatsAvailable: 10 },
    "/api/swarm/sessions": { sessions: [], nextCursor: null, nextSessionAt: null },
  });
  await page.goto("/swarm");

  await expect(emptyRow(page, "#members")).toHaveText("No members yet");
  await expect(emptyRing(page, "#allocation")).toHaveText("No recommendation yet");
  await expect(emptyRow(page, "#portfolios")).toHaveText("No portfolio reviewed yet");
  await expect(emptyRow(page, "#history")).toHaveText("No session published yet");
  // The heads stay, so a reader sees what each table will hold.
  await expect(page.locator("#portfolios thead th")).toHaveCount(4);
  await expect(page.locator("#history thead th").first()).toHaveText("Session");
});

test("a subject with no session and no book keeps its ring, positions and history, and draws no empty chart twice", async ({ page }) => {
  await stub(page, {
    "/api/swarm/subjects/empty-co": {
      id: "empty-co", status: "active", name: "Empty Co Treasury", operator: "empty-co", source: { type: "rpc" },
      recommendationType: "position_actions", wallets: [{ chain: "base", label: "main", address: "0x1111111111111111111111111111111111111111" }],
    },
    "/api/swarm/sessions": { sessions: [], nextCursor: null, nextSessionAt: null },
    "/api/swarm/subjects/empty-co/snapshots": { snapshots: [] },
    "/api/swarm/members": { members: [] },
  });
  await page.goto("/swarm/subjects/empty-co");

  await expect(emptyRing(page, "#latest")).toHaveText("No recommendation yet");
  await expect(emptyRow(page, "#holdings .rr-positions")).toHaveText("No holdings read yet");
  // With no reading at all the positions row has said it: no chart frame to
  // say it again.
  await expect(page.locator("#holdings .rr-area")).toHaveCount(0);
  await expect(emptyRow(page, "#history")).toHaveText("No session published yet");
});

test("a book read once draws the chart's frame, saying a line needs another reading", async ({ page }) => {
  await stub(page, {
    "/api/swarm/subjects/empty-co": {
      id: "empty-co", status: "active", name: "Empty Co Treasury", operator: "empty-co", source: { type: "rpc" }, recommendationType: "position_actions",
    },
    "/api/swarm/sessions": { sessions: [], nextCursor: null, nextSessionAt: null },
    "/api/swarm/subjects/empty-co/snapshots": {
      snapshots: [{ id: "s1", subjectId: "empty-co", date: "2026-09-18", totalValueUsd: 1000, positions: [{ token: "USDC", chain: "base", value_usd: 1000 }] }],
    },
    "/api/swarm/members": { members: [] },
  });
  await page.goto("/swarm/subjects/empty-co");

  await expect(page.locator("#holdings .rr-positions tbody tr")).toHaveCount(1);
  await expect(page.locator("#holdings .rr-area .rr-empty__t")).toHaveText("One reading so far");
  await expect(page.locator("#holdings .rr-area .rr-area__head")).toContainText("Over time");
});

test("a session whose window just opened keeps the recommendation ring and the takes' frame", async ({ page }) => {
  const closes = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  await stub(page, {
    "/api/swarm/sessions/2026-09-19/empty-co": {
      session: { id: "2026-09-19-empty-co", date: "2026-09-19", subject_id: "empty-co", subject_name: "Empty Co Treasury", state: "collecting", window_closes_at: closes, swarm_recommendation: null },
      takes: [],
    },
    "/api/swarm/members": { members: [{ id: "athena", status: "active", name: "Athena" }] },
  });
  await page.goto("/swarm/2026-09-19/empty-co");

  await expect(emptyRing(page, "#recommendation")).toHaveText("Not published yet");
  await expect(page.locator("#takes .rr-empty__t")).toHaveText("No takes filed yet");
  await expect(page.locator(".rr-meta").first()).toContainText("Takes 0 of 1");
});

test("a member with no take keeps the track record's frame", async ({ page }) => {
  await stub(page, {
    "/api/swarm/members/newbie": { id: "newbie", handle: "newbie", status: "active", name: "Newbie", lens: "yield" },
    "/api/swarm/members/newbie/takes": { takes: [] },
  });
  await page.goto("/swarm/members/newbie");

  await expect(page.locator("#record .rr-empty__t")).toHaveText("No takes filed yet");
});
