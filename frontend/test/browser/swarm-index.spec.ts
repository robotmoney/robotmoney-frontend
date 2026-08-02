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
