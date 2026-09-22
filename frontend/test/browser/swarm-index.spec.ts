import { expect, test } from "@playwright/test";

// /swarm, as a research record (RM-121): a row of facts, the Members register,
// the flagship Latest allocation, the Portfolios table, the Recommendation history
// across every subject, and How it works. Each test seeds a deterministic
// members and sessions response (mocked, since the live smoke stack's roster
// and sessions are not a stable thing to assert text against) and checks the
// shipped Alpine view (views/swarm.js) renders it.
//
// Issue #357's regimeSummary check lives here too, on the session page: the
// regime is a property of the DAY, so it left the index row (see below).

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

// An allocation session's aggregate: the four sleeve weights ARE the
// recommendation, with the same spread, quorum and mean confidence.
const WEIGHTS_REC = {
  type: "bucket_weights",
  weights: { conservative_defi_yield: 0.9, agent_tokens: 0.1, protocol_tokens: 0, real_world_assets: 0 },
  quorum: { active: 5, submitted: 4, absent: 1, participation: 0.8 },
  stances: { bullish: 1, neutral: 1, cautious: 2 },
  meanConfidence: 0.575,
  absent: ["draco"],
  rationale: "Hold the mandate.",
};

// A portfolio recommendation its members wrote: actions and no aggregate. A
// rollup's actions (SESSION_REC's, marked by quorum/stances) are template rows
// derived from no member input, so the history row draws only these.
const AUTHORED_REC = {
  type: "position_actions",
  actions: [
    { token: "USDC", action: "rotate", rationale: "Route the next stable tranche into rmUSDC." },
    { token: "PEAQ", action: "hold", rationale: "Keep the position." },
  ],
  rationale: "Route the stable tranche; keep PEAQ.",
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

// RM-100: members render as a register (the Members table). The mark is
// decorative (aria-hidden) and the accessible name lives on the link beside
// it, so a member's mark is addressed through its row rather than through an
// aria-label on the mark.
const markFor = (page: import("@playwright/test").Page, name: string) =>
  page.locator(".rr-members tbody tr", { hasText: name }).locator(".sv__mmark");

test("swarm index: every member renders a distinct derived mark, none of it cyan or beacon", async ({ page }) => {
  await page.route("**/api/swarm/members*", (route) => route.fulfill(json({ members: MARK_MEMBERS })));
  await page.route("**/api/swarm/sessions*", (route) => route.fulfill(json({ sessions: [], nextCursor: null })));

  await page.goto("/swarm");
  const marks = page.locator(".rr-members .sv__mmark svg");
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
  await expect(page.locator(".rr-members__who a", { hasText: "Woon" })).toHaveCount(1);
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
  const avatar = page.locator(".rr-members .sv__mmark").first();
  await expect(avatar).toHaveText("NA");
  await expect(avatar.locator("svg")).toHaveCount(0);
});

// Issue #357's guarantee, RELOCATED. The index row carries no regime: the
// regime is a property of the DAY, so every session that ran on one printed
// the same label and the field distinguished nothing between rows. It is still
// the field's only browser coverage, so it follows the render to the session
// page rather than being deleted with the row.
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
  // regimeLabel("risk_on") -> "risk-on", in the session's row of facts.
  const regime = page.locator(".rr-meta .rr-meta__i", { hasText: "Regime" });
  await expect(regime).toHaveCount(1);
  await expect(regime.locator("b")).toHaveText("risk-on");
  // The composite rides beside it, from the same summary.
  await expect(page.locator(".rr-meta .rr-meta__i", { hasText: "Composite" }).locator("b")).toHaveText("0.420");
});

// A history row states the session's RESULT. The index used to state its
// reasoning: a five-line excerpt of the synthesis, identical in shape on every
// row, with the recommendation the API had carried the whole time never
// rendered at all.
test("a published session's history row states its recommendation, its lean and who took part", async ({ page }) => {
  const session = (id: string, subjectId: string, subjectName: string, rec: unknown) => ({
    id,
    date: "2026-07-15",
    subjectId,
    subjectName,
    state: "published",
    windowClosesAt: "2026-07-15T12:00:00Z",
    publishedAt: "2026-07-15T12:00:00Z",
    regimeSummary: null,
    swarmRecommendation: rec,
    // The aggregator's joined take bodies. Reasoning, not the result.
    synthesis: "Members converged on concentration as the whole risk.",
    socialDraftId: null,
    generatedAt: "2026-07-15T11:00:00Z",
  });
  await page.route("**/api/swarm/members*", (route) =>
    route.fulfill(json({ members: [{ id: "m1", status: "active", name: "Athena", lens: "macro" }] })));
  // A row names its subject from the SUBJECT RECORD (sessionSubjectName reads
  // subjectCache first), not from the session's denormalised subjectName, so a
  // subject the test does not stub resolves against whatever the preview
  // server serves and the assertions below drift with the goldens. Stub both,
  // and give the sessions stale denormalised names to prove which one wins.
  await page.route("**/api/swarm/subjects/woon", (route) =>
    route.fulfill(json({ id: "woon", name: "Woon", operator: "peaq", source: { type: "rpc" } })));
  await page.route("**/api/swarm/subjects/robotmoney-allocation", (route) =>
    route.fulfill(json({ id: "robotmoney-allocation", name: "Robot Money Allocation", operator: "Robot Money", source: { type: "framework" } })));
  await page.route("**/api/swarm/sessions*", (route) =>
    route.fulfill(json({
      sessions: [
        session("sess-alloc", "robotmoney-allocation", "committee allocation", WEIGHTS_REC),
        session("sess-outcome", "woon", "woon (test)", AUTHORED_REC),
      ],
      nextCursor: null,
    })));

  await page.goto("/swarm");
  const hist = page.locator(".rr-hist");
  const rows = hist.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  // The lean has its own column, headed the way the session page states it.
  await expect(hist.locator("thead th")).toHaveText(["Session", "Subject", "Consensus", "Recommendation"]);

  // A weights session: the stance wears the badge a take wears, the row counts
  // the takes filed, and the recommendation is one word. It moved sleeves
  // against the target it was handed (90/10 against 95/5), so it rebalances;
  // which sleeves and by how much is its session page's to say.
  const alloc = rows.nth(0);
  await expect(alloc.locator(".rr-hist__subj")).toHaveText("Robot Money Allocation");
  // The subject is a way to its own page, as the session date is to its.
  await expect(alloc.locator(".rr-hist__subj a")).toHaveAttribute("href", "/swarm/subjects/robotmoney-allocation");
  await expect(alloc.locator("th a")).toHaveText("Jul 15, 2026");
  await expect(alloc.locator("th small")).toHaveText("12:00 UTC · 4 takes");
  await expect(alloc.locator(".sv__stance-badge")).toHaveText("cautious");
  await expect(alloc.locator("td.rr-verdict")).toHaveText("Rebalance");
  await expect(alloc.locator("td.rr-verdict .rr-mixline, td.rr-verdict .alp__mv")).toHaveCount(0);

  // A portfolio session that rotates a position rebalances too; no position,
  // action chip or held count is listed in the row.
  const woon = rows.nth(1);
  await expect(woon.locator(".rr-hist__subj")).toHaveText("Woon");
  await expect(woon.locator("td.rr-verdict")).toHaveText("Rebalance");
  await expect(woon.locator("td.rr-verdict .rr-act, td.rr-verdict .rr-held")).toHaveCount(0);

  // Who took part, and how sure they were, stated with the allocation's
  // latest recommendation. The spread is a count per stance, not a mark per
  // take: a tally that grows with the roster is unreadable well before 20
  // seats.
  const counts = page.locator("#allocation .rr-counts");
  await expect(counts.locator("> span")).toHaveCount(3);
  await expect(counts.locator("em")).toHaveText("4 of 5 took part · 57% mean confidence");

  // Neither the synthesis nor a closed window is the result, and no row
  // prints either.
  await expect(hist).not.toContainText("concentration as the whole risk");
  await expect(hist).not.toContainText("window closed", { ignoreCase: true });
});

// The history's recommendation is one word, and never a claim the record does
// not support: Hold only when nothing moved against something to measure by.
test("a history row's verdict: hold, no calls, nothing published", async ({ page }) => {
  const session = (id: string, subjectId: string, rec: unknown) => ({
    id, date: "2026-07-15", subjectId, subjectName: subjectId, state: "published",
    windowClosesAt: "2026-07-15T12:00:00Z", publishedAt: "2026-07-15T12:00:00Z",
    regimeSummary: null, swarmRecommendation: rec, synthesis: "", socialDraftId: null, generatedAt: "2026-07-15T11:00:00Z",
  });
  await page.route("**/api/swarm/members*", (route) => route.fulfill(json({ members: [] })));
  await page.route("**/api/swarm/sessions*", (route) =>
    route.fulfill(json({
      sessions: [
        // The target in force on the day (the published 95/5/0/0), kept as is.
        session("s-hold", "robotmoney-allocation", { type: "bucket_weights", weights: { conservative_defi_yield: 0.95, agent_tokens: 0.05, protocol_tokens: 0, real_world_assets: 0 }, rationale: "Hold." }),
        // Every position held.
        session("s-held", "woon", { type: "position_actions", actions: [{ token: "PEAQ", action: "hold" }, { token: "WOON", action: "hold" }], rationale: "Keep both." }),
        // A live rollup: its rationale restates the tally and it named no position.
        session("s-rollup", "robotmoney-treasury", { type: "position_actions", stances: { cautious: 1, neutral: 1 }, rationale: "Majority stance is cautious (1 of 2 submitted takes)." }),
        session("s-none", "robotmoney-vault", null),
      ],
      nextCursor: null,
    })));

  await page.goto("/swarm");
  const verdicts = page.locator(".rr-hist tbody tr td.rr-verdict");
  await expect(verdicts).toHaveText(["Hold", "Hold", "No actions", "No recommendation published"]);
  await expect(page.locator(".rr-hist")).not.toContainText("Majority stance");
});

// The takes live on the session page, one click from each history row. The
// list route carries counts and no bodies, so loading them on /swarm would be
// one extra request per row on every load of the page.
test("the history loads no session's takes; its row opens the session, which does", async ({ page }) => {
  // A real session id is a uuid, and only that shape routes to the session
  // page (routes.js); a subject can convene twice a day, so the row links by id.
  const SESSION_ID = "5f0c2b7e-3a41-4d6e-9b8a-2c7d1e4f6a90";
  const session = {
    id: SESSION_ID,
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
    if (pathname === "/api/swarm/members") {
      return route.fulfill(json({
        members: [
          { id: "athena", status: "active", name: "Athena", handle: "athena", lens: "macro" },
          { id: "draco", status: "active", name: "Draco", handle: "draco", lens: "macro" },
        ],
      }));
    }
    if (pathname === "/api/swarm/sessions") return route.fulfill(json({ sessions: [session], nextCursor: null }));
    if (pathname === `/api/swarm/sessions/${SESSION_ID}`) {
      detailCalls += 1;
      return route.fulfill(json({ session, takes }));
    }
    if (pathname.startsWith("/api/")) return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    return route.continue();
  });

  await page.goto("/swarm");
  const row = page.locator(".rr-hist tbody tr");
  await expect(row).toHaveCount(1);
  // The count comes from the list route; the bodies were never asked for.
  await expect(row.locator("th small")).toContainText("4 takes");
  await expect(page.locator(".rr-take")).toHaveCount(0);
  await expect(page.locator(".sv__body")).not.toContainText("Concentration is the whole risk here.");
  expect(detailCalls).toBe(0);

  const link = row.locator("th a");
  await expect(link).toHaveAttribute("href", `/swarm/sessions/${SESSION_ID}`);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/swarm/sessions/${SESSION_ID}$`));

  // One request, for the session the reader opened, and its take is there.
  const take = page.locator(".rr-take");
  await expect(take).toHaveCount(1);
  await expect(take.locator(".rr-take__name")).toHaveText("Athena");
  expect(detailCalls).toBe(1);

  // absent[] is member ids; it is why the count is 4 of 5 rather than a
  // mystery. Resolved to the roster name, linked to the member page.
  const absent = page.locator(".rr-vote__sum .rr-meta__i", { hasText: "Absent" }).locator("a");
  await expect(absent).toHaveText("Draco");
  await expect(absent).toHaveAttribute("href", "/swarm/members/draco");
});


// Allocation sessions used to be dropped from this list and only reachable
// from the panel link. They belong here: the chips separate targets from
// holdings, the history itself does not.
test("allocation sessions are listed, and the chips keep them off the vault", async ({ page }) => {
  const session = (id: string, subjectId: string, subjectName: string, rec: unknown) => ({
    id,
    date: "2026-08-29",
    subjectId,
    subjectName,
    state: "published",
    windowClosesAt: "2026-08-29T12:00:00Z",
    publishedAt: "2026-08-29T12:00:00Z",
    regimeSummary: null,
    swarmRecommendation: rec,
    socialDraftId: null,
    generatedAt: "2026-08-29T11:00:00Z",
  });
  await page.route("**/api/swarm/members*", (route) =>
    route.fulfill(json({ members: [{ id: "m1", status: "active", name: "Athena", lens: "macro" }] })));
  await page.route("**/api/swarm/sessions*", (route) =>
    route.fulfill(json({
      sessions: [
        session("sess-alloc", "robotmoney-allocation", "Robot Money Allocation", WEIGHTS_REC),
        session("sess-vault", "robotmoney-vault", "Robot Money Vault", SESSION_REC),
      ],
      nextCursor: null,
    })));
  await page.route("**/api/swarm/subjects/robotmoney-allocation", (route) =>
    route.fulfill(json({
      id: "robotmoney-allocation",
      name: "Robot Money Allocation",
      operator: "Robot Money",
      source: { type: "framework" },
    })));
  await page.route("**/api/swarm/subjects/robotmoney-vault", (route) =>
    route.fulfill(json({
      id: "robotmoney-vault",
      name: "Robot Money Vault",
      operator: "Robot Money",
      source: { type: "vault_tvl" },
    })));

  await page.goto("/swarm");

  // The total is stated once, in the row of facts and on the All chip; the
  // section head does not repeat it.
  await expect(page.locator("#history .rr-sec__aside")).toHaveCount(0);
  await expect(page.locator(".rr-meta__i", { hasText: /^Sessions/ }).locator("b")).toHaveText("2");
  await expect(page.locator(".rr-hist .rr-hist__subj")).toHaveText([
    "Robot Money Allocation",
    "Robot Money Vault",
  ]);

  const chips = page.locator(".mp-filter .mp-chip");
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(0)).toContainText("All");
  await expect(chips.nth(0).locator(".mp-chip__n")).toHaveText("2");
  await expect(chips.nth(1)).toContainText("Robot Money Allocation");
  await expect(chips.nth(2)).toContainText("Robot Money Vault");

  // Folded framework sessions are not a second portfolio, and they do not
  // inflate the vault's session count.
  const ports = page.locator(".rr-ports tbody tr");
  await expect(ports).toHaveCount(1);
  // The rows are the count: no aside restates it.
  await expect(page.locator("#portfolios .rr-sec__aside")).toHaveCount(0);
  await expect(ports.locator("th a")).toHaveText("Robot Money Vault");
  // The vault's session count is its history chip's, which the table no
  // longer repeats in a column.
  await expect(chips.nth(2).locator(".mp-chip__n")).toHaveText("1");

  await chips.nth(1).click();
  await expect(page.locator(".rr-hist tbody tr")).toHaveCount(1);
  await expect(page.locator(".rr-hist .rr-hist__subj")).toHaveText("Robot Money Allocation");
  // Filtered, the pressed chip names the subject; the column would repeat it on every row.
  await expect(chips.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".rr-hist .rr-hist__subj")).toBeHidden();
});


// The role tooltip hangs off a Members column header. The register this table
// replaced set its headers `white-space: nowrap` so they never wrapped, and the
// bubble INHERITED that and laid its sentence out as one 1327px line inside a
// 272px box: one visible line, the rest off the side of the screen.
// .rm-tip__bub resets every other text property its host might impose
// (transform, tracking, weight, align) precisely so it can be anchored
// anywhere, and white-space was the one it missed — so this asserts the reset,
// not the one caller. The .rr-table header does not set nowrap today, so the
// test sets it on the host: without that, a lost reset would pass unnoticed.
test("a tooltip anchored in a nowrap header still wraps its text", async ({ page }) => {
  await page.route("**/api/swarm/members*", (route) =>
    route.fulfill(json({ members: [{ id: "m1", status: "active", name: "Athena", lens: "macro" }] })));
  await page.route("**/api/swarm/sessions*", (route) => route.fulfill(json({ sessions: [], nextCursor: null })));

  await page.goto("/swarm");
  const tip = page.locator(".rr-members th .rm-tip");
  await expect(tip).toHaveCount(1);
  const host = page.locator(".rr-members thead th", { has: page.locator(".rm-tip") });
  await host.evaluate((el) => { (el as HTMLElement).style.whiteSpace = "nowrap"; });
  await expect(host).toHaveCSS("white-space", "nowrap");
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
  // (79 characters since the bubble dropped the validator role nobody holds
  // and the sentence describing the column.)
  expect(box.chars).toBeGreaterThan(70);
  expect(box.lines).toBeGreaterThan(2);
});

// Read from the shipped archive (32 sessions, the 2026-06-24 allocation
// session the latest): each fact once, where it is most useful. The legend's
// rows carry the allocation's moves, so no headline counts them and a sleeve
// that did not move prints its weight alone; the history's one count is how
// far into the list the reader is, which the rows cannot say.
test("the latest allocation and the history state each fact once", async ({ page }) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));

  await page.goto("/swarm");

  const alloc = page.locator("#allocation");
  const row = (name: string) => alloc.locator(".rr-legend__row").filter({ hasText: name });
  await expect(row("Agent Tokens").locator(".rr-legend__was")).toHaveText("Target 5%");
  await expect(row("Agent Tokens").locator(".alp__mv")).toHaveText("−2 pp");
  await expect(row("Real World Assets").locator(".alp__mv")).toHaveText("+2 pp");
  await expect(row("Conservative DeFi Yield").locator("b")).toHaveText("95%");
  await expect(row("Conservative DeFi Yield").locator(".rr-legend__d .alp__mv")).toHaveCount(0);
  await expect(alloc.locator("p.rr-k.rr-sub")).toHaveCount(0);
  await expect(alloc).not.toContainText(/sleeves? moves?/i);

  const history = page.locator("#history");
  await expect(history.locator(".rr-hist tbody tr")).toHaveCount(20);
  await expect(history.locator(".rr-pager > span")).toHaveText("20 of 32");
  await history.getByRole("button", { name: "Show more" }).click();
  await expect(history.locator(".rr-hist tbody tr")).toHaveCount(32);
  await expect(history.locator(".rr-pager")).toHaveCount(0);
});
