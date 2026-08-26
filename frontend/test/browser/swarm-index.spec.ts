import { expect, test } from "@playwright/test";

// Issue #357: GET /api/swarm/sessions now carries a slim regimeSummary
// (regime + composite, no history) per session, sourced from the exact same
// computation the detail endpoint serializes. views/swarm.html has
// carried the `<span x-show="s.regimeSummary">` markup since before the API
// served the field — every row fell back to `s.state` in practice, which is
// why the swarm index read "PUBLISHED" on every card instead of a regime
// label. This spec seeds a deterministic sessions response (mocked, since the
// live smoke stack's regime_summary contents aren't a stable thing to assert
// text against) and checks the shipped Alpine view (swarm.js's
// regimeLabel()) actually renders the label instead of the fallback.

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

// ── Derived member marks (#560, RM-48) ──────────────────────────────────────
// Three real-shaped ids: a manifest slug, a funnel UUID, and a second slug.
const MARK_MEMBERS = [
  { id: "athena", status: "active", name: "Athena", lens: "quant risk", tagline: null, biases: null, mandate: null },
  { id: "46bed5c1-f15b-49cf-ae10-29b5fae1a859", status: "active", name: "Woon", lens: "machine economy", tagline: null, biases: null, mandate: null },
  { id: "robotmoney", status: "active", name: "Robot Money", lens: "institutional treasury", tagline: null, biases: null, mandate: null },
];

// The covenant, as computed values rather than a comment. Cyan is a LINE in
// this system (views.css seams it along the avatar's top edge precisely so it
// never fills a plane) and beacon means loss, which is why subjectDot()
// already withholds it. Neither may appear in a member's figure.
const FORBIDDEN_FILLS = ["#00e5ff", "#ff7a29"];

test("swarm index: every member renders a distinct derived mark, none of it cyan or beacon", async ({ page }) => {
  await page.route("**/api/swarm/members*", (route) => route.fulfill(json({ members: MARK_MEMBERS })));
  await page.route("**/api/swarm/sessions*", (route) => route.fulfill(json({ sessions: [], nextCursor: null })));

  await page.goto("/swarm");
  const marks = page.locator(".sv__person-row .sv__avatar--mark svg");
  await expect(marks).toHaveCount(3);

  // Distinct: three members, three different marks. Compared as markup, since
  // the whole point is that the shape and hues differ, not just the seed.
  const shapes = await marks.evaluateAll((els) => els.map((el) => el.innerHTML));
  expect(new Set(shapes).size).toBe(3);

  const fills = await marks.evaluateAll((els) =>
    els.flatMap((el) => [...el.querySelectorAll("[fill]")].map((n) => n.getAttribute("fill")!.toLowerCase())));
  expect(fills.length).toBeGreaterThan(0);
  for (const forbidden of FORBIDDEN_FILLS) expect(fills).not.toContain(forbidden);

  // The mark is decorative SVG, so the row link would otherwise have no
  // accessible name at all once the initials it replaced are gone.
  await expect(page.locator('.sv__person-row .sv__avatar--mark[aria-label="Woon"]')).toHaveCount(1);
});

test("swarm index: a member's mark is the same on every load", async ({ page }) => {
  await page.route("**/api/swarm/members*", (route) => route.fulfill(json({ members: MARK_MEMBERS })));
  await page.route("**/api/swarm/sessions*", (route) => route.fulfill(json({ sessions: [], nextCursor: null })));

  const read = async () => {
    await page.goto("/swarm");
    const mark = page.locator('.sv__person-row .sv__avatar--mark[aria-label="Woon"] svg');
    await expect(mark).toBeVisible();
    return mark.innerHTML();
  };
  expect(await read()).toBe(await read());
});

// #625's precedence: manifest avatar.path first, the derived mark second.
// roster-seed.ts sets avatar.path for the three seeded members to files that
// 404 (frontend/public/avatars/ does not exist), so the precedence check must
// treat a 404 the same as "no avatar.path" rather than leaving a broken-image
// icon in the roster. The image request is routed to a real 404 (not merely
// asserted never to fire) so this exercises the actual onerror fallback, not
// just the markup memberAvatarMarkup() produced for it.
test("swarm index: a member's avatar.path that 404s falls back to the derived mark, not a broken image", async ({ page }) => {
  const AVATAR_MEMBERS = [
    { id: "athena", status: "active", name: "Athena", lens: "quant risk", tagline: null, biases: null, mandate: null, avatar: { path: "/avatars/swarm/athena.jpg", source_url: null, credit: "x" } },
  ];
  await page.route("**/api/swarm/members*", (route) => route.fulfill(json({ members: AVATAR_MEMBERS })));
  await page.route("**/api/swarm/sessions*", (route) => route.fulfill(json({ sessions: [], nextCursor: null })));
  await page.route("**/avatars/swarm/athena.jpg", (route) => route.fulfill({ status: 404, body: "not found" }));

  await page.goto("/swarm");
  const avatar = page.locator('.sv__person-row .sv__avatar--mark[aria-label="Athena"]');
  await expect(avatar.locator("img")).toHaveCount(0);
  await expect(avatar.locator("svg")).toHaveCount(1);
});

// The companion case: a real, loadable avatar.path takes precedence over the
// derived mark, per #625's AC ("manifest avatar.path ... first, derived mark
// second"). A 1x1 GIF is the smallest real image a route handler can fulfill.
const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7", "base64");

test("swarm index: a member with a loadable avatar.path renders it instead of the derived mark", async ({ page }) => {
  const AVATAR_MEMBERS = [
    { id: "athena", status: "active", name: "Athena", lens: "quant risk", tagline: null, biases: null, mandate: null, avatar: { path: "/avatars/swarm/athena.jpg", source_url: null, credit: "x" } },
  ];
  await page.route("**/api/swarm/members*", (route) => route.fulfill(json({ members: AVATAR_MEMBERS })));
  await page.route("**/api/swarm/sessions*", (route) => route.fulfill(json({ sessions: [], nextCursor: null })));
  await page.route("**/avatars/swarm/athena.jpg", (route) => route.fulfill({ status: 200, contentType: "image/gif", body: PIXEL_GIF }));

  await page.goto("/swarm");
  const avatar = page.locator('.sv__person-row .sv__avatar--mark[aria-label="Athena"]');
  await expect(avatar.locator("img")).toHaveCount(1);
  await expect(avatar.locator("svg")).toHaveCount(0);
});

// #560's precedence is uploaded art, then the derived mark, then initials.
// A row with no id at all has no seed, so it falls back rather than rendering
// an empty box.
test("swarm index: a member with no seed falls back to initials", async ({ page }) => {
  await page.route("**/api/swarm/members*", (route) =>
    route.fulfill(json({ members: [{ id: "", status: "active", name: "Nameless Agent", lens: null, tagline: null, biases: null, mandate: null }] })));
  await page.route("**/api/swarm/sessions*", (route) => route.fulfill(json({ sessions: [], nextCursor: null })));

  await page.goto("/swarm");
  const avatar = page.locator(".sv__person-row .sv__avatar--mark").first();
  await expect(avatar).toHaveText("NA");
  await expect(avatar.locator("svg")).toHaveCount(0);
});

test("swarm index renders the regime label for a session carrying regimeSummary, not the state fallback", async ({ page }) => {
  await page.route("**/api/swarm/members*", (route) =>
    route.fulfill(json({ members: [{ id: "m1", status: "active", name: "Athena", lens: "macro" }] })));

  const withRegime = {
    id: "sess-with-regime",
    date: "2026-07-15",
    subjectId: "woon",
    subjectName: "Woon",
    state: "published",
    windowClosesAt: null,
    publishedAt: "2026-07-15T12:00:00Z",
    regimeSummary: { composite: 0.42, composite_percentile: 0.7, regime: "risk_on" },
    swarmRecommendation: { quorum: { active: 3, submitted: 3, absent: 0, participation: 1 }, stances: {}, meanConfidence: 0.5, absent: [], type: "position_actions", consensus: [], disagreements: [] },
    socialDraftId: null,
    generatedAt: "2026-07-15T11:00:00Z",
  };
  const withoutRegime = {
    id: "sess-without-regime",
    date: "2026-07-14",
    subjectId: "woon",
    subjectName: "Woon",
    state: "published",
    windowClosesAt: null,
    publishedAt: "2026-07-14T12:00:00Z",
    regimeSummary: null,
    swarmRecommendation: { quorum: { active: 3, submitted: 3, absent: 0, participation: 1 }, stances: {}, meanConfidence: 0.5, absent: [], type: "position_actions", consensus: [], disagreements: [] },
    socialDraftId: null,
    generatedAt: "2026-07-14T11:00:00Z",
  };
  await page.route("**/api/swarm/sessions*", (route) =>
    route.fulfill(json({ sessions: [withRegime, withoutRegime], nextCursor: null })));

  await page.goto("/swarm");
  // swarm.html's error paragraph is x-show (always in the DOM, toggled by
  // CSS), unlike the x-if error elements on subject/session/member/take views
  // — assert hidden, not absent.
  await expect(page.locator(".sv__error")).toBeHidden();

  const cards = page.locator(".sv__session-card");
  await expect(cards).toHaveCount(2);

  // Both the regime span and the state-fallback span are always present in
  // the DOM (Alpine's x-show toggles CSS display, it does not remove the
  // node), so assertions here target VISIBILITY, not textContent — a
  // hasText/toContainText check would false-positive on the hidden sibling.
  // Cards are targeted by their session-id link (stable across row order)
  // rather than text, for the same reason.
  const regimeCard = page.locator('a.sv__session-card[href="/swarm/sessions/sess-with-regime"]');
  await expect(regimeCard).toHaveCount(1);
  const regimeSpan = regimeCard.locator(".sv__session-meta > span").first();
  await expect(regimeSpan).toBeVisible();
  await expect(regimeSpan).toContainText("regime:");
  await expect(regimeSpan).toContainText("risk-on"); // regimeLabel("risk_on") → "risk-on"
  const regimeCardStateFallback = regimeCard.locator(".sv__session-meta > span").nth(1);
  await expect(regimeCardStateFallback).toBeHidden();

  // The row backed by a session with no regimeSummary keeps the pre-#357
  // fallback: the regime span stays hidden, the raw session state renders.
  const fallbackCard = page.locator('a.sv__session-card[href="/swarm/sessions/sess-without-regime"]');
  await expect(fallbackCard).toHaveCount(1);
  const fallbackRegimeSpan = fallbackCard.locator(".sv__session-meta > span").first();
  await expect(fallbackRegimeSpan).toBeHidden();
  const fallbackStateSpan = fallbackCard.locator(".sv__session-meta > span").nth(1);
  await expect(fallbackStateSpan).toBeVisible();
  await expect(fallbackStateSpan).toHaveText("published");
});
