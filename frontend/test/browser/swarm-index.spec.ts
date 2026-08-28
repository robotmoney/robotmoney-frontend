import { expect, test } from "@playwright/test";

// Issue #357: GET /api/swarm/sessions now carries a slim regimeSummary
// (regime + composite, no history) per session, sourced from the exact same
// computation the detail endpoint serializes. views/swarm.html has
// carried the `<span x-show="s.regimeSummary">` markup since before the API
// served the field — every row fell back to `s.state` in practice, which is
// why the swarm index read "PUBLISHED" on every card instead of a regime
// label. This spec seeds a deterministic sessions response (mocked, since the
// live demo stack's regime_summary contents aren't a stable thing to assert
// text against) and checks the shipped Alpine view (swarm.js's
// regimeLabel()) actually renders the label instead of the fallback.

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

// A published session as the API serves one: a spread, a quorum, a mean
// confidence, and the actions that are the actual output.
const SESSION_REC = {
  type: "position_actions",
  quorum: { active: 5, submitted: 4, absent: 1, participation: 0.8 },
  stances: { bullish: 1, neutral: 1, cautious: 2 },
  meanConfidence: 0.575,
  absent: ["draco"],
  actions: [{ token: "USDC", action: "rotate", rationale: "Route the next stable tranche into rmUSDC." }],
  consensus: [],
  disagreements: [],
  rationale: "Hold the mandate.",
};

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

// RM-100: members render as a register. The mark is decorative (aria-hidden)
// and the accessible name lives on the link beside it, so a member's mark is
// addressed through its row rather than through an aria-label on the mark.
const markFor = (page: import("@playwright/test").Page, name: string) =>
  page.locator(".sv__mtable tbody tr", { hasText: name }).locator(".sv__mmark");

test("swarm index: every member renders a distinct derived mark, none of it cyan or beacon", async ({ page }) => {
  await page.route("**/api/swarm/members*", (route) => route.fulfill(json({ members: MARK_MEMBERS })));
  await page.route("**/api/swarm/sessions*", (route) => route.fulfill(json({ sessions: [], nextCursor: null })));

  await page.goto("/swarm");
  const marks = page.locator(".sv__mtable .sv__mmark svg");
  await expect(marks).toHaveCount(3);

  // Distinct: three members, three different marks. Compared as markup, since
  // the whole point is that the shape and hues differ, not just the seed.
  const shapes = await marks.evaluateAll((els) => els.map((el) => el.innerHTML));
  expect(new Set(shapes).size).toBe(3);

  const fills = await marks.evaluateAll((els) =>
    els.flatMap((el) => [...el.querySelectorAll("[fill]")].map((n) => n.getAttribute("fill")!.toLowerCase())));
  expect(fills.length).toBeGreaterThan(0);
  for (const forbidden of FORBIDDEN_FILLS) expect(fills).not.toContain(forbidden);

  // The mark is decorative, so the accessible name has to come from the link
  // in the same cell. Assert both: exactly one Woon mark, and a named link.
  await expect(markFor(page, "Woon")).toHaveCount(1);
  await expect(page.locator('.sv__mwho a', { hasText: "Woon" })).toHaveCount(1);
});

test("swarm index: a member's mark is the same on every load", async ({ page }) => {
  await page.route("**/api/swarm/members*", (route) => route.fulfill(json({ members: MARK_MEMBERS })));
  await page.route("**/api/swarm/sessions*", (route) => route.fulfill(json({ sessions: [], nextCursor: null })));

  const read = async () => {
    await page.goto("/swarm");
    const mark = markFor(page, "Woon").locator("svg");
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
  const avatar = markFor(page, "Athena");
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
  const avatar = markFor(page, "Athena");
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
  const avatar = page.locator(".sv__mtable .sv__mmark").first();
  await expect(avatar).toHaveText("NA");
  await expect(avatar.locator("svg")).toHaveCount(0);
});

// Issue #357's guarantee, RELOCATED. The index card no longer carries a
// regime: the regime is a property of the DAY, so every session that ran on
// one printed the same label and the field distinguished nothing between
// rows. It is still the field's only browser coverage, so it follows the
// render to the session page rather than being deleted with the card.
test("a session's regimeSummary reaches the screen on the session page", async ({ page }) => {
  const session = {
    id: "sess-with-regime",
    date: "2026-07-15",
    subjectId: "woon",
    subjectName: "Woon",
    state: "published",
    windowClosesAt: null,
    publishedAt: "2026-07-15T12:00:00Z",
    regimeSummary: { composite: 0.42, composite_percentile: 0.7, regime: "risk_on" },
    swarmRecommendation: SESSION_REC,
    socialDraftId: null,
    generatedAt: "2026-07-15T11:00:00Z",
  };
  await page.route("**/api/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/swarm/members") return route.fulfill(json({ members: [] }));
    if (/^\/api\/swarm\/sessions\/\d{4}-\d{2}-\d{2}\/[^/]+$/.test(pathname)) {
      return route.fulfill(json({ session, takes: [] }));
    }
    if (pathname.startsWith("/api/")) return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    return route.continue();
  });

  await page.goto("/swarm/2026-07-15/woon");
  // regimeLabel("risk_on") -> "risk-on", in the session's fact row.
  await expect(page.locator(".sv__fact-row")).toContainText("risk-on");
});

// The card states the session's RESULT. It used to state its reasoning: a
// five-line excerpt of the synthesis, identical in shape on every row, with
// the recommendation the API had carried the whole time never rendered at all.
test("a published session's card states its recommendation, its lean and who took part", async ({ page }) => {
  await page.route("**/api/swarm/members*", (route) =>
    route.fulfill(json({ members: [{ id: "m1", status: "active", name: "Athena", lens: "macro" }] })));
  await page.route("**/api/swarm/sessions*", (route) =>
    route.fulfill(json({
      sessions: [{
        id: "sess-outcome",
        date: "2026-07-15",
        subjectId: "woon",
        subjectName: "Woon",
        state: "published",
        windowClosesAt: "2026-07-15T12:00:00Z",
        publishedAt: "2026-07-15T12:00:00Z",
        regimeSummary: null,
        swarmRecommendation: SESSION_REC,
        socialDraftId: null,
        generatedAt: "2026-07-15T11:00:00Z",
      }],
      nextCursor: null,
    })));

  await page.goto("/swarm");
  const card = page.locator(".sv__session-card").first();

  // The recommendation, which is the thing a reader came for.
  await expect(card.locator(".sv__rec")).toContainText("rotate USDC", { ignoreCase: true });

  // The spread as a segment per stance, not a mark per take: the tally this
  // replaced grew with the roster and was unreadable well before 20 seats.
  await expect(card.locator(".sv__spread i")).toHaveCount(3);
  await expect(card.locator(".sv__lean")).toHaveText("cautious lean");
  await expect(card.locator(".sv__verdict")).toContainText("4 of 5 took part");
  await expect(card.locator(".sv__verdict")).toContainText("57% mean confidence");

  // And the synthesis paragraph is gone from the row entirely.
  await expect(card.locator(".sv__session-copy")).toHaveCount(0);
});

// The takes are behind a disclosure because the list route carries counts and
// no bodies: rendering them eagerly would be one extra request per card on
// every load of the page.
test("expanding a session card loads that session's takes in place", async ({ page }) => {
  const session = {
    id: "sess-expand",
    date: "2026-07-15",
    subjectId: "woon",
    subjectName: "Woon",
    state: "published",
    windowClosesAt: "2026-07-15T12:00:00Z",
    publishedAt: "2026-07-15T12:00:00Z",
    regimeSummary: null,
    swarmRecommendation: SESSION_REC,
    socialDraftId: null,
    generatedAt: "2026-07-15T11:00:00Z",
  };
  const takes = [
    { id: "t1", memberId: "athena", memberName: "Athena", stance: "cautious", confidence: 0.55,
      body: "**REGIME**\n- boilerplate every take repeats.\n\n**SUBJECT**\n- woon through a macro lens: cautious at 0.55 confidence.\n- Concentration is the whole risk here.",
      verified: true },
  ];
  let detailCalls = 0;
  await page.route("**/api/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/swarm/members") return route.fulfill(json({ members: [] }));
    if (pathname === "/api/swarm/sessions") return route.fulfill(json({ sessions: [session], nextCursor: null }));
    if (pathname === "/api/swarm/sessions/sess-expand") {
      detailCalls += 1;
      return route.fulfill(json({ session, takes }));
    }
    if (pathname.startsWith("/api/")) return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    return route.continue();
  });

  await page.goto("/swarm");
  const card = page.locator(".sv__session-card").first();
  // Nothing fetched until asked.
  await expect(card.locator(".sv__take-row")).toHaveCount(0);
  expect(detailCalls).toBe(0);

  await card.locator(".sv__takes-btn").click();
  await expect(card.locator(".sv__take-row")).toHaveCount(1);
  await expect(card.locator(".sv__take-who")).toHaveText("Athena");

  // The excerpt skips the bullet that only restates the stance and confidence
  // the row already prints beside it.
  await expect(card.locator(".sv__take-line")).toHaveText("Concentration is the whole risk here.");

  // absent[] is why the count is 4 of 5 rather than a mystery.
  await expect(card.locator(".sv__take-absent")).toContainText("draco");

  await card.locator(".sv__takes-btn").click();
  await expect(card.locator(".sv__take-row")).toHaveCount(0);
});


// The role tooltip hangs off a `.sv__mtable th`, which is `white-space:
// nowrap` so the column headers never wrap. The bubble INHERITED that and laid
// its 218 characters out as one 1327px line inside a 272px box: one visible
// line, the rest off the side of the screen. .rm-tip__bub resets every other
// text property its host might impose (transform, tracking, weight, align)
// precisely so it can be anchored anywhere, and white-space was the one it
// missed — so this asserts the reset, not the one caller.
test("a tooltip anchored in a nowrap header still wraps its text", async ({ page }) => {
  await page.route("**/api/swarm/members*", (route) =>
    route.fulfill(json({ members: [{ id: "m1", status: "active", name: "Athena", lens: "macro" }] })));
  await page.route("**/api/swarm/sessions*", (route) => route.fulfill(json({ sessions: [], nextCursor: null })));

  await page.goto("/swarm");
  const tip = page.locator("th .rm-tip");
  await expect(tip).toHaveCount(1);
  await tip.locator(".rm-tip__btn").click();

  const bub = tip.locator(".rm-tip__bub");
  await expect(bub).toBeVisible();

  const box = await bub.evaluate((el) => ({
    overflowing: el.scrollWidth > el.clientWidth + 1,
    lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
    whiteSpace: getComputedStyle(el).whiteSpace,
    chars: el.textContent!.trim().length,
  }));

  expect(box.whiteSpace, "the bubble must not inherit the header's nowrap").toBe("normal");
  expect(box.overflowing, "the bubble's text must fit its own width").toBe(false);
  // A sentence this long cannot honestly be one or two lines at this measure.
  expect(box.chars).toBeGreaterThan(120);
  expect(box.lines).toBeGreaterThan(2);
});
