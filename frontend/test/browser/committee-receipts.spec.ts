import { expect, test } from "@playwright/test";

// The badge (frontend/public/views/committee/{session,member,take}.html) is a
// drawn mark, a one-word label, and an explanatory line shown on hover/focus.
//
// Its text is therefore NOT a safe discriminator, and the original hazard this
// file guards against got worse rather than better: the old pair was
// `✓ verified` / `✕ not verified`, and the current pair is `verified` /
// `unverified` — which still contains "verified" as a substring. So assert the
// machine-readable state instead, plus the negative class directly, and a take
// that rendered as NOT verified can never satisfy a "verified" assertion.
async function expectPositiveBadge(badge: ReturnType<import("@playwright/test").Page["locator"]>) {
  await expect(badge).toHaveAttribute("data-verified-state", "verified");
  await expect(badge).not.toHaveClass(/cv__vfy--bad/);
}

async function expectNegativeBadge(badge: ReturnType<import("@playwright/test").Page["locator"]>) {
  await expect(badge).toHaveAttribute("data-verified-state", "unverified");
  await expect(badge).toHaveClass(/cv__vfy--bad/);
}

test("public committee take shows an exact verified badge on the session view, member view, and rendered receipt permalink", async ({
  page,
  request,
}) => {
  // ?state=published (issue #243): the default list response is now a light,
  // paginated (20-most-recent, ANY state) projection — on a long-running demo
  // stack the newest 20 sessions across every state could easily contain fewer
  // than 2 published ones, even though plenty of published history exists.
  // Ask the server to filter to `published` directly instead of relying on
  // client-side filtering of an unfiltered top-20 page.
  const sessionsResponse = await request.get("/api/committee/sessions?state=published&limit=50");
  expect(sessionsResponse.ok(), "committee sessions API must be available").toBe(true);
  const sessions = (await sessionsResponse.json()).sessions ?? [];

  let selected: { session: any; take: any } | null = null;
  for (const session of sessions.filter(
    // Match the member-profile view's own eligibility filter (recentTakes() only
    // considers `state === "published"` sessions) so the take we assert on the
    // session view is guaranteed to also surface on the member view below.
    // (state === "published" is now also enforced server-side above.)
    (candidate: any) => String(candidate.date) >= "2026-07-01" && candidate.state === "published",
  )) {
    const detailResponse = await request.get(
      `/api/committee/sessions/${encodeURIComponent(session.date)}/${encodeURIComponent(session.subjectId)}`,
    );
    expect(detailResponse.ok(), `session read failed for ${session.date}/${session.subjectId}`).toBe(true);
    const detail = await detailResponse.json();
    const take = (detail.takes ?? []).find((candidate: any) => candidate.verified === true);
    if (take) {
      selected = { session, take };
      break;
    }
  }
  expect(selected, "live stack must expose at least one server-verified API take on a published session").not.toBeNull();

  const { session, take } = selected!;

  // 1. Public session view: exact positive badge text, no negative class.
  await page.goto(`/committee/${encodeURIComponent(session.date)}/${encodeURIComponent(session.subjectId)}`);
  const sessionBadge = page.locator(`[data-verified-badge][data-take-id="${take.id}"]`);
  await expectPositiveBadge(sessionBadge);

  // 2. Public member view: the same take's badge and permalink must also render
  // the exact positive state (issue #207 Behaviour: "On the public session AND
  // member views each take shows a verified badge").
  await page.goto(`/committee/members/${encodeURIComponent(take.memberId)}`);
  const memberBadge = page.locator(`[data-verified-badge][data-take-id="${take.id}"]`);
  await expectPositiveBadge(memberBadge);
  const memberPermalink = page.locator(`[data-take-permalink][href="/committee/takes/${take.id}"]`);
  await expect(memberPermalink).toBeVisible();

  // 3. Per-take permalink: a real rendered page (not raw JSON), exact positive
  // badge text, no negative class.
  await page.goto(`/committee/${encodeURIComponent(session.date)}/${encodeURIComponent(session.subjectId)}`);
  const permalink = page.locator(`[data-take-permalink][href="/committee/takes/${take.id}"]`);
  await expect(permalink).toBeVisible();
  await permalink.click();
  await expect(page).toHaveURL(new RegExp(`/committee/takes/${take.id}$`));
  await expect(page.locator("[data-committee-take-receipt]")).toBeVisible();
  const receiptBadge = page.locator("[data-committee-take-receipt] [data-verified-badge]");
  await expectPositiveBadge(receiptBadge);
  await expect(page.locator("body")).not.toContainText('"take":');
});

test("public session view renders an unverified/tampered take as NOT verified", async ({ page }) => {
  // The Postgres read-time tamper case is covered by backend/tests/committee.test.ts
  // (mutating a stored payload after insert and asserting verified===false on
  // read). This case exercises the OTHER half of the Behaviour contract: that the
  // public session view actually renders whatever verified value the API returns
  // as the negative state, rather than defaulting to "verified" or matching the
  // negative label via loose substring assertions.
  const date = "2026-07-22";
  const subjectId = "e2e-tampered-fixture";
  const tamperedTakeId = "e2e-tampered-take-fixture";

  await page.route(`**/api/committee/sessions/${date}/${subjectId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session: {
          date,
          subjectId,
          subjectName: "Tampered Fixture Subject",
          state: "published",
        },
        takes: [
          {
            id: tamperedTakeId,
            memberId: "athena",
            memberName: "Athena",
            stance: "neutral",
            confidence: 0.5,
            body: "This take's stored payload no longer matches its signature.",
            verified: false,
          },
        ],
      }),
    }),
  );

  await page.goto(`/committee/${date}/${subjectId}`);
  const badge = page.locator(`[data-verified-badge][data-take-id="${tamperedTakeId}"]`);
  await expectNegativeBadge(badge);
});
