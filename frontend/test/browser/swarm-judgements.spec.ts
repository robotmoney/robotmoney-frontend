import { expect, test, type Page } from "@playwright/test";

// The consensus judge in public (lib/judgements.js). A judgement is its own
// record with its own page, as a take is; a session judged by several judges
// shows each judge's opinion, one row per judge; the release call is a Hold
// or Update badge where the recommendation moves the target, the data's
// "safe" never printed (on a money page it reads as a safety claim), and
// several judges' calls make the session's by the any-Hold-holds rule. A seated judge
// files no take, so it is neither absent from a session nor a seat in any
// "n of m".
//
// The backend half (#1017) is not deployed: production answers 404 on the
// judgement routes, and those pages must read exactly as they do today. The
// API is stubbed per test; every route a test does not name answers 404.

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const notFound = { status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) };

async function stub(page: Page, routes: Record<string, unknown>, seen: string[] = []): Promise<void> {
  await page.route("**/api/**", (route) => {
    const { pathname } = new URL(route.request().url());
    seen.push(pathname);
    if (!(pathname in routes)) return route.fulfill(notFound);
    const body = routes[pathname];
    return typeof body === "number" ? route.fulfill({ status: body, contentType: "application/json", body: "{}" }) : route.fulfill(json(body));
  });
}

const S1 = "5d0c6d9e-1111-4a4b-9c9c-000000000001";
const S2 = "5d0c6d9e-2222-4a4b-9c9c-000000000002";

const ROSTER = {
  members: [
    { id: "m-athena", handle: "athena", status: "active", role: "member", name: "Athena", lens: "macro" },
    { id: "m-woon", handle: "woon", status: "active", role: "member", name: "Woon", lens: "treasury" },
    { id: "m-shodai", handle: "shodai", status: "active", role: "member", name: "ShodAI", lens: "risk" },
    { id: "m-max", handle: "maximus", status: "active", role: "member", name: "Maximus", lens: "swarm" },
    { id: "m-dual", handle: "dualmint", status: "active", role: "member", name: "DualMint", lens: "swarm" },
    { id: "m-themis", handle: "themis", status: "active", role: "judge", name: "Themis", lens: "consensus arbitration" },
  ],
};

const TAKES = [
  ["m-athena", "athena", "Athena", "constructive", 0.62],
  ["m-woon", "woon", "Woon", "constructive", 0.58],
  ["m-shodai", "shodai", "ShodAI", "neutral", 0.6],
].map(([memberId, memberHandle, memberName, stance, confidence]) => ({
  id: `take-${memberHandle}`, memberId, memberHandle, memberName, stance, confidence,
  body: `${String(memberName).toUpperCase()} BODY`, verified: true, archival: false,
}));

const DISAGREEMENT = {
  topic: "Whether the agent-token sleeve earns its 5%",
  positions: [
    { member_id: "m-athena", view: "The sleeve is sized for optionality, and 5% is that." },
    { member_id: "m-shodai", view: "SHODAI BODY" },
  ],
  what_settles: "Whether agent-token volume holds above its 90-day median through the next session.",
};

const THIN_HOLD = {
  release: "hold", thinly_supported: true, take_count: 3, min_takes: 4,
  concerns: [
    "Thinly supported: 3 takes submitted, below the minimum of 4 for this session.",
    "The takes do not address the brief's liquidity question.",
  ],
};
const SAFE = { release: "safe", thinly_supported: false, take_count: 3, min_takes: 3, concerns: [] };

const THEMIS_PROSE = "Three takes read the regime as risk-on and keep the book in conservative yield; none argues for moving the target.";
const HOUSE_PROSE = "The takes agree on the target and differ only on how long the agent-token sleeve should stay small.";

// A published allocation session a seated judge worked on, as the aggregator
// writes it today: the judge is counted in quorum.active and listed absent.
function judgedSession(id: string, judge: Record<string, unknown> | null) {
  return {
    id, date: "2026-09-17", subjectId: "robotmoney-allocation", subjectName: "Robot Money Allocation", state: "published",
    generatedAt: "2026-09-17T09:00:00Z", windowClosesAt: "2026-09-17T09:40:00Z",
    regimeSummary: null,
    synthesis: "3 of 6 members (50% participation) reviewed Robot Money Allocation.",
    swarmRecommendation: {
      type: "bucket_weights",
      // Moves the target, so the judges' calls have something to act on.
      weights: { conservative_defi_yield: 0.9, agent_tokens: 0.1, protocol_tokens: 0, real_world_assets: 0 },
      quorum: { active: 6, submitted: 3, absent: 3, participation: 0.5 },
      stances: { constructive: 2, neutral: 1 },
      meanConfidence: 0.6,
      absent: ["m-themis", "m-max", "m-dual"],
      consensus: ["3 of 6 members submitted."],
      rationale: judge ? THEMIS_PROSE : "Majority stance is constructive (2 of 3 submitted takes), mean confidence 0.60.",
      disagreements: judge ? [DISAGREEMENT] : [],
      ...(judge ? { release_safety: THIN_HOLD, judge } : {}),
    },
  };
}

const THEMIS_BLOCK = {
  source: "model", model: "deepseek-v4-flash", prompt_hash: "a".repeat(64), inputs_digest: "b".repeat(64),
  judged_by: "m-themis", judged_by_member_id: "m-themis",
};

const judgement = (over: Record<string, unknown>) => ({
  id: "41", sessionId: S1, subjectId: "robotmoney-allocation", sessionDate: "2026-09-17",
  judgedBy: "m-themis", judgedByMemberId: "m-themis", source: "model", model: "deepseek-v4-flash",
  promptHash: "3f9a1c0e5b7d2a64c1e8f0b39d7a5c2e1f4b6a8d0c3e5f7a9b1d3c5e7f9a0b2c",
  inputsDigest: "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d",
  rationale: THEMIS_PROSE, disagreements: [DISAGREEMENT], releaseSafety: THIN_HOLD, createdAt: "2026-09-17T10:00:00Z",
  ...over,
});
const THEMIS_J = judgement({});
const HOUSE_J = judgement({
  id: "42", judgedBy: "robotmoney-in-house", judgedByMemberId: null, rationale: HOUSE_PROSE,
  disagreements: [], releaseSafety: SAFE, createdAt: "2026-09-17T10:05:00Z",
});

const noSafe = async (page: Page) => {
  const text = await page.locator("body").innerText();
  expect(text, "the word 'safe' must never print").not.toMatch(/\bsafe\b/i);
};

const judgeRows = (page: Page) => page.locator("#reasoning .rr-judges__t tbody tr");

test("a session one judge worked on: its row, its account under it, named in the facts, and never absent", async ({ page }) => {
  await stub(page, {
    [`/api/swarm/sessions/${S1}`]: { session: judgedSession(S1, THEMIS_BLOCK), takes: TAKES },
    [`/api/swarm/sessions/${S1}/judgements`]: { judgements: [THEMIS_J] },
    "/api/swarm/members": ROSTER,
  });
  await page.goto(`/swarm/sessions/${S1}`);

  const rows = judgeRows(page);
  await expect(rows).toHaveCount(1);
  const row = rows.first();
  await expect(row.locator("th .rm-role")).toHaveText("Judge");
  await expect(row.locator("th a")).toHaveText("Themis");
  await expect(row.locator("th a")).toHaveAttribute("href", "/swarm/members/themis");
  // The call and its first reason; the backend's own sentence for the count
  // is not listed again.
  await expect(row.locator(".rr-advice-badge--hold")).toHaveText("Hold");
  await expect(row.locator("td").nth(1)).toHaveText("3 takes, below the minimum of 4");
  await expect(row.locator("td").nth(2)).toHaveText("1");
  await expect(row.locator("td a")).toHaveAttribute("href", "/swarm/judgements/41");
  // One judge: no session call over the table, its rows say it.
  await expect(page.locator(".rr-judges__call")).toHaveCount(0);
  // Its other reasons and its own account, under the table.
  await expect(page.locator(".rr-judge__concerns li")).toHaveText(["The takes do not address the brief's liquidity question."]);
  await expect(page.locator(".rr-judge .rr-prose")).toContainText("none argues for moving the target");
  // Its disagreements, matched to the takes on the page.
  await page.getByRole("button", { name: "Where views differ" }).click();
  await page.getByRole("button", { name: /Whether the agent-token sleeve/ }).click();
  // One row per member: the stance and confidence their take filed, their
  // words only when they are not the take's own body, and one way to the take.
  const views = page.locator("#reasoning .rr-views-t tbody tr");
  await expect(views.nth(0).locator("th > span")).toHaveText("Athena");
  await expect(views.nth(0).locator("th small")).toContainText("sized for optionality");
  await expect(views.nth(0).locator(".sv__stance-badge")).toHaveText("constructive");
  await expect(views.nth(0).locator("td.q").first()).toHaveText("62%");
  await expect(views.nth(0).locator("a.rr-lnk")).toHaveAttribute("href", "#take-m-athena");
  await expect(views.nth(1).locator("th small")).toHaveCount(0);
  await expect(views.nth(1).locator(".sv__stance-badge")).toHaveText("neutral");
  await expect(views.nth(1).locator("a.rr-lnk")).toHaveText("Read take");
  await expect(page.locator("#reasoning .rr-settles", { hasText: "Resolves when" })).toContainText("90-day median");
  // With one judge, who raised a question needs no saying.
  await expect(page.locator("#reasoning .rr-settles", { hasText: "Raised by" })).toHaveCount(0);

  // The facts row names the judge, a way to its row.
  const judgedBy = page.locator(".rr-meta__i", { hasText: "Judged by" });
  await expect(judgedBy.locator("a")).toHaveText(["Themis"]);
  await expect(judgedBy.locator("a")).toHaveAttribute("href", "#judge-41");

  // The adopted opinion is not printed a second time beside the ring.
  await expect(page.locator("#recommendation")).not.toContainText("none argues for moving the target");
  // A judge is not absent, and not a seat: 3 of the 5 who file took part.
  const absent = page.locator("#takes .rr-vote__sum .rr-meta__i", { hasText: "Absent" }).locator("a");
  await expect(absent).toHaveText(["Maximus", "DualMint"]);
  await expect(page.locator("#recommendation .rr-counts em")).toContainText("3 of 5 took part");
  await noSafe(page);
});

test("two judges, two rows, and the session's call: any Hold holds", async ({ page }) => {
  await stub(page, {
    [`/api/swarm/sessions/${S1}`]: { session: judgedSession(S1, THEMIS_BLOCK), takes: TAKES },
    [`/api/swarm/sessions/${S1}/judgements`]: { judgements: [HOUSE_J, THEMIS_J] },
    "/api/swarm/members": ROSTER,
  });
  await page.goto(`/swarm/sessions/${S1}`);

  const rows = judgeRows(page);
  await expect(rows).toHaveCount(2);
  await expect(rows.locator("th")).toHaveText(["Judge RM Protocol Labs", "Judge Themis"]);
  // The house judge has no member page. Its call clears the recommendation:
  // Update, with no reason; the data's word is not printed.
  await expect(rows.nth(0).locator("th a")).toHaveCount(0);
  await expect(rows.nth(0).locator(".rr-advice-badge--update")).toHaveText("Update");
  await expect(rows.nth(0).locator("td").nth(1)).toHaveText("");
  await expect(rows.nth(1).locator(".rr-advice-badge--hold")).toHaveText("Hold");
  // One Hold holds the target: the session's call is Hold.
  const call = page.locator(".rr-judges__call");
  await expect(call.locator(".rr-advice-badge--hold")).toHaveText("Hold");
  await expect(call).toContainText("1 of 2 advise holding");
  // Several judges: each account is on its judgement page, not stacked here.
  await expect(page.locator(".rr-judge")).toHaveCount(0);
  await expect(page.locator("#reasoning")).not.toContainText(HOUSE_PROSE);
  await expect(page.locator(".rr-meta__i", { hasText: "Judged by" }).locator("a")).toHaveText(["RM Protocol Labs", "Themis"]);
  // One question, raised by one of them, named.
  await expect(page.locator(".rr-meta__i", { hasText: "Disagreements" }).locator("b")).toHaveText("1");
  await page.getByRole("button", { name: "Where views differ" }).click();
  await page.getByRole("button", { name: /Whether the agent-token sleeve/ }).click();
  await expect(page.locator("#reasoning .rr-settles", { hasText: "Raised by" })).toContainText("Themis");
  await noSafe(page);
});

test("a question two judges both raised is one question, raised by both", async ({ page }) => {
  const second = judgement({ id: "43", judgedBy: "robotmoney-in-house", judgedByMemberId: null, releaseSafety: SAFE, createdAt: "2026-09-17T10:06:00Z" });
  await stub(page, {
    [`/api/swarm/sessions/${S1}`]: { session: judgedSession(S1, THEMIS_BLOCK), takes: TAKES },
    [`/api/swarm/sessions/${S1}/judgements`]: { judgements: [second, THEMIS_J] },
    "/api/swarm/members": ROSTER,
  });
  await page.goto(`/swarm/sessions/${S1}`);
  await expect(page.locator(".rr-meta__i", { hasText: "Disagreements" }).locator("b")).toHaveText("1");
  await page.getByRole("button", { name: "Where views differ" }).click();
  await expect(page.locator("#reasoning .rr-q")).toHaveCount(1);
  await page.getByRole("button", { name: /Whether the agent-token sleeve/ }).click();
  await expect(page.locator("#reasoning .rr-settles", { hasText: "Raised by" })).toContainText("RM Protocol Labs, Themis");
});

test("a session that published no weights has nothing to update: the judge's reasons, no call", async ({ page }) => {
  const session = judgedSession(S1, THEMIS_BLOCK);
  delete (session.swarmRecommendation as Record<string, unknown>).weights;
  await stub(page, {
    [`/api/swarm/sessions/${S1}`]: { session, takes: TAKES },
    [`/api/swarm/sessions/${S1}/judgements`]: { judgements: [HOUSE_J, THEMIS_J] },
    "/api/swarm/members": ROSTER,
  });
  await page.goto(`/swarm/sessions/${S1}`);
  const rows = judgeRows(page);
  await expect(rows).toHaveCount(2);
  await expect(page.locator("#reasoning .rr-advice-badge")).toHaveCount(0);
  await expect(page.locator(".rr-judges__call")).toHaveCount(0);
  await expect(rows.nth(1).locator("td").nth(1)).toHaveText("3 takes, below the minimum of 4");
  await noSafe(page);
});

test("the judgement routes answering 404: the judge the recommendation names stands in, with no page to link", async ({ page }) => {
  await stub(page, {
    [`/api/swarm/sessions/${S1}`]: { session: judgedSession(S1, THEMIS_BLOCK), takes: TAKES },
    "/api/swarm/members": ROSTER,
  });
  await page.goto(`/swarm/sessions/${S1}`);

  const rows = judgeRows(page);
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator("th")).toHaveText("Judge Themis");
  await expect(rows.first().locator(".rr-advice-badge--hold")).toHaveText("Hold");
  await expect(rows.first().locator("td").nth(1)).toHaveText("3 takes, below the minimum of 4");
  await expect(rows.first().locator("td a")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Where views differ" })).toBeVisible();
  await expect(page.locator(".rr-meta__i", { hasText: "Disagreements" }).locator("b")).toHaveText("1");
  await noSafe(page);
});

test("a session no judge worked on asks for no judgements and reads as it does today", async ({ page }) => {
  const seen: string[] = [];
  await stub(page, {
    [`/api/swarm/sessions/${S2}`]: { session: judgedSession(S2, null), takes: TAKES },
    "/api/swarm/members": ROSTER,
  }, seen);
  await page.goto(`/swarm/sessions/${S2}`);

  await expect(page.locator("#takes .rr-vote")).toBeVisible();
  await expect(page.locator(".rr-judge")).toHaveCount(0);
  // Nothing written and no market reading: no reasoning section, as today.
  await expect(page.locator(".rr-sec__h")).toHaveText(["The recommendation", "Member takes", "Evidence & provenance"]);
  await expect(page.locator(".rr-meta")).not.toContainText("Judged by");
  // The template rationale stays hidden.
  await expect(page.locator("body")).not.toContainText("Majority stance is constructive");
  expect(seen.filter((p) => p.includes("/judgements"))).toEqual([]);
});

test("a judgement's own page: who, which session, its advice, its questions, and what pins it", async ({ page }) => {
  await stub(page, {
    "/api/swarm/judgements/41": THEMIS_J,
    [`/api/swarm/sessions/${S1}`]: { session: judgedSession(S1, THEMIS_BLOCK), takes: TAKES },
    "/api/swarm/members": ROSTER,
  });
  await page.goto("/swarm/judgements/41");

  await expect(page.locator("h1")).toHaveText("Themis");
  await expect(page).toHaveTitle("Judgement by Themis, Sep 17, 2026: Robot Money Investment Swarm");
  const crumbs = page.locator(".rr-crumbs");
  await expect(crumbs.locator("a")).toHaveText(["Swarm", "Robot Money Allocation", "Sep 17, 2026"]);
  await expect(crumbs.locator("[aria-current]")).toHaveText("Judgement");

  const fact = (k: string) => page.locator(".rr-meta .rr-meta__i", { hasText: k });
  await expect(fact("Session").locator("a")).toHaveAttribute("href", `/swarm/sessions/${S1}`);
  await expect(fact("Subject").locator("a")).toHaveAttribute("href", "/swarm/subjects/robotmoney-allocation");
  await expect(fact("Judge").locator("a")).toHaveAttribute("href", "/swarm/members/themis");
  await expect(fact("Model").locator("b")).toHaveText("deepseek-v4-flash");
  await expect(fact("Recorded").locator("b")).toHaveText("Sep 17, 2026 10:00 UTC");

  await expect(page.locator("#judgement .rr-advice-badge--hold")).toHaveText("Hold");
  await expect(page.locator("#judgement .rr-advice__l")).toHaveText("AdviceHold3 takes, below the minimum of 4");
  await expect(page.locator("#judgement .rr-prose")).toContainText(THEMIS_PROSE);

  // Each member's row: the stance its take filed, and one way to the take,
  // its receipt when it has one.
  const views = page.locator("#differ .rr-views-t tbody tr");
  await expect(views.nth(0).locator(".sv__stance-badge")).toHaveText("constructive");
  await expect(views.nth(0).locator("a.rr-lnk")).toHaveAttribute("href", "/swarm/takes/take-athena");
  await expect(views.nth(1).locator("a.rr-lnk")).toHaveText("Read take");
  await expect(page.locator("#differ .rr-settles")).toContainText("Resolves when");
  await expect(page.locator("#differ .rr-settles")).toContainText("90-day median");

  const prompt = page.locator("#provenance dd").first();
  await expect(prompt).toHaveText("3f9a1c0e5b7d…7f9a0b2c");
  await expect(prompt).toHaveAttribute("title", THEMIS_J.promptHash);
  await expect(page.locator("#provenance a")).toHaveAttribute("href", "/api/swarm/judgements/41");
  await noSafe(page);
  expect(await page.locator(".cv--detail article").innerText(), "no em dash in the record").not.toContain("—");
});

test("a judgement that does not exist says so; one that cannot be read says that", async ({ page }) => {
  await stub(page, { "/api/swarm/judgements/77": 500 });
  await page.goto("/swarm/judgements/99");
  await expect(page.locator(".sv__error")).toHaveText("Judgement not found");
  await expect(page).toHaveTitle("Judgement not found: Robot Money Investment Swarm");

  await page.goto("/swarm/judgements/77");
  await expect(page.locator(".sv__error")).toHaveText("This judgement could not be loaded.");
});

test("a judge's page: the role, the sessions it judged instead of takes, and its advice", async ({ page }) => {
  const seen: string[] = [];
  const S3 = "5d0c6d9e-3333-4a4b-9c9c-000000000003";
  await stub(page, {
    "/api/swarm/members/themis": ROSTER.members[5],
    "/api/swarm/members/themis/judgements": {
      judgements: [THEMIS_J, judgement({ id: "38", sessionId: S3, subjectId: "woon", sessionDate: "2026-09-16", releaseSafety: SAFE, disagreements: [] })],
    },
    "/api/swarm/subjects/robotmoney-allocation": { id: "robotmoney-allocation", name: "Robot Money Allocation", source: { type: "framework" } },
    "/api/swarm/subjects/woon": { id: "woon", name: "Woon Treasury", source: { type: "rpc" } },
  }, seen);
  await page.goto("/swarm/members/themis");

  // The role pill beside the name, as every member's page wears one.
  await expect(page.locator(".rr-profile .rm-named .rm-role")).toHaveText("Judge");
  const fact = (k: string) => page.locator(".rr-meta .rr-meta__i", { hasText: k }).locator("b");
  await expect(fact("Sessions judged")).toHaveText("2");
  await expect(fact("Holds advised")).toHaveText("1");
  await expect(page.locator(".rr-meta")).not.toContainText("Takes filed");

  // The analysts' record cards: subject and date, the call where a stance
  // sits, the disagreements where a confidence sits, and for a hold its reason.
  const cards = page.locator("#record .rr-take");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).locator(".rr-take__name")).toHaveText("Robot Money Allocation");
  await expect(cards.nth(0).locator(".mp-take__date")).toHaveText("Sep 17, 2026");
  await expect(cards.nth(0).locator(".rr-advice-badge--hold")).toHaveText("Hold");
  await expect(cards.nth(0).locator(".rr-conf")).toHaveText("Disagreements 1");
  await expect(cards.nth(0).locator(".rr-advice__why")).toHaveText("3 takes, below the minimum of 4");
  await expect(cards.nth(0).locator("a.rr-take__act")).toHaveAttribute("href", "/swarm/judgements/41");
  // A call that clears, and no disagreement: the badge alone.
  await expect(cards.nth(1).locator(".rr-take__name")).toHaveText("Woon Treasury");
  await expect(cards.nth(1).locator(".rr-advice-badge--update")).toHaveText("Update");
  await expect(cards.nth(1).locator(".rr-conf, .rr-advice__why")).toHaveCount(0);
  // A judge files no takes, so none are asked for.
  expect(seen.filter((p) => p.endsWith("/takes"))).toEqual([]);
  await noSafe(page);
});

test("a judge with nothing published keeps the record's frame", async ({ page }) => {
  await stub(page, {
    "/api/swarm/members/themis": ROSTER.members[5],
    "/api/swarm/members/themis/judgements": { judgements: [] },
  });
  await page.goto("/swarm/members/themis");
  await expect(page.locator("#record .rr-take")).toHaveCount(0);
  await expect(page.locator("#record .rr-empty__t")).toHaveText("No judgement published yet");
  await expect(page.locator(".rr-meta")).not.toContainText("Sessions judged");
});

test("a member's page before the role existed reads as it always has", async ({ page }) => {
  const seen: string[] = [];
  await stub(page, {
    "/api/swarm/members/athena": { id: "m-athena", handle: "athena", status: "active", name: "Athena", lens: "macro" },
    "/api/swarm/members/athena/takes": { takes: [] },
  }, seen);
  await page.goto("/swarm/members/athena");
  await expect(page.locator("#record .rr-empty__t")).toHaveText("No takes filed yet");
  await expect(page.locator(".rr-profile .rm-named .rm-role")).toHaveText("Analyst");
  expect(seen.filter((p) => p.includes("/judgements"))).toEqual([]);
});

test("a take's receipt links its session, and names each question a judge found it on one side of", async ({ page }) => {
  await stub(page, {
    "/api/swarm/takes/take-athena": {
      sessionId: S1,
      take: { id: "take-athena", member_id: "m-athena", member_handle: "athena", member_name: "Athena", stance: "constructive", confidence: 0.62, body: "ATHENA BODY", verified: true, archival: false, received_at: "2026-09-17T09:12:00Z" },
      memo: null,
      signer: { id: "m-athena", handle: "athena", name: "Athena", publicKeyFingerprint: "ab:cd" },
    },
    [`/api/swarm/sessions/${S1}`]: { session: judgedSession(S1, THEMIS_BLOCK), takes: TAKES },
    [`/api/swarm/sessions/${S1}/judgements`]: { judgements: [THEMIS_J, HOUSE_J] },
    "/api/swarm/members": ROSTER,
  });
  await page.goto("/swarm/takes/take-athena");

  const session = page.locator(".rr-meta .rr-meta__i", { hasText: "Session" }).locator("a");
  await expect(session).toHaveText("Sep 17, 2026");
  await expect(session).toHaveAttribute("href", `/swarm/sessions/${S1}`);
  await expect(page.locator(".rr-recnav a", { hasText: "The session" })).toHaveAttribute("href", `/swarm/sessions/${S1}`);
  const lines = page.locator(".tk-dis p");
  await expect(lines).toHaveText(["In disagreement: Whether the agent-token sleeve earns its 5% · Themis"]);
  await expect(lines.locator("a")).toHaveAttribute("href", "/swarm/judgements/41");
  await noSafe(page);
});

test("a take no judge placed in a disagreement shows no line", async ({ page }) => {
  await stub(page, {
    "/api/swarm/takes/take-woon": {
      sessionId: S1,
      take: { id: "take-woon", member_id: "m-woon", member_handle: "woon", member_name: "Woon", stance: "constructive", confidence: 0.58, body: "WOON BODY", verified: true, archival: false, received_at: "2026-09-17T09:14:00Z" },
      memo: null,
      signer: { id: "m-woon", handle: "woon", name: "Woon", publicKeyFingerprint: "ef:01" },
    },
    [`/api/swarm/sessions/${S1}`]: { session: judgedSession(S1, THEMIS_BLOCK), takes: TAKES },
    [`/api/swarm/sessions/${S1}/judgements`]: { judgements: [THEMIS_J] },
    "/api/swarm/members": ROSTER,
  });
  await page.goto("/swarm/takes/take-woon");
  await expect(page.locator(".rr-meta .rr-meta__i", { hasText: "Session" }).locator("a")).toHaveText("Sep 17, 2026");
  await expect(page.locator(".tk-dis")).toHaveCount(0);
});

test("/swarm: a judge's role, members counted without it, and its words on the allocation named", async ({ page }) => {
  const row = { ...judgedSession(S1, THEMIS_BLOCK), publishedAt: "2026-09-17T10:10:00Z", takes: 3 };
  row.swarmRecommendation = { ...row.swarmRecommendation, quorum: { active: 6, submitted: 4, absent: 2, participation: 0.67 }, absent: ["m-themis", "m-max"], stances: { constructive: 3, neutral: 1 } };
  await stub(page, {
    "/api/swarm/members": ROSTER,
    "/api/swarm/sessions": { sessions: [row], nextCursor: null },
    "/api/swarm/subjects/robotmoney-allocation": { id: "robotmoney-allocation", name: "Robot Money Allocation", operator: "robotmoney", source: { type: "framework" } },
  });
  await page.goto("/swarm");

  const themis = page.locator(".rr-members tbody tr", { hasText: "Themis" });
  await expect(themis.locator("td .rm-role")).toHaveText("Judge");
  // Every seat wears its role in the same pill: an analyst unless it judges.
  await expect(page.locator(".rr-members tbody tr", { hasText: "Athena" }).locator("td .rm-role")).toHaveText("Analyst");
  await expect(page.locator(".rr-members thead .rm-tip__bub")).toContainText("A judge files no take. It explains the takes and advises on release.");
  await expect(page.locator(".rr-meta .rr-meta__i", { hasText: "Members" }).locator("b")).toHaveText("5");

  const alloc = page.locator("#allocation");
  await expect(alloc.locator(".rr-k", { hasText: "Judge" })).toHaveText("Judge Themis");
  await expect(alloc.locator(".rr-prose")).toContainText("none argues for moving the target");
  await expect(alloc.locator(".rr-counts em")).toHaveText("4 of 5 took part · 60% mean confidence");
  await noSafe(page);
});

test("a judged session not yet published reads as aggregation under way, not as a closed orphan", async ({ page }) => {
  const session = { ...judgedSession(S2, null), state: "judged", swarmRecommendation: null };
  await stub(page, {
    [`/api/swarm/sessions/${S2}`]: { session, takes: TAKES },
    "/api/swarm/members": ROSTER,
  });
  await page.goto(`/swarm/sessions/${S2}`);
  await expect(page.locator(".rr-when .rm-sphase")).toHaveText("aggregating");
  await expect(page.locator(".rr-when .rm-sphase")).toHaveClass(/rm-sphase--aggregating/);
  // While the window is being worked on, the takes count against the members
  // who file them: five, not the six seats on the roster.
  await expect(page.locator(".rr-meta .rr-meta__i", { hasText: "Takes" }).locator("b")).toHaveText("3 of 5");
});
