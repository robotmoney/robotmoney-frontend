import { expect, test } from "@playwright/test";

test("public committee take shows a verified badge and rendered receipt permalink", async ({ page, request }) => {
  const sessionsResponse = await request.get("/api/committee/sessions");
  expect(sessionsResponse.ok(), "committee sessions API must be available").toBe(true);
  const sessions = (await sessionsResponse.json()).sessions ?? [];

  let selected: { session: any; take: any } | null = null;
  for (const session of sessions.filter((candidate: any) => String(candidate.date) >= "2026-07-01")) {
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
  expect(selected, "live stack must expose at least one server-verified API take").not.toBeNull();

  const { session, take } = selected!;
  await page.goto(`/committee/${encodeURIComponent(session.date)}/${encodeURIComponent(session.subjectId)}`);
  const badge = page.locator(`[data-verified-badge][data-take-id="${take.id}"]`);
  await expect(badge).toContainText("verified");

  const permalink = page.locator(`[data-take-permalink][href="/committee/takes/${take.id}"]`);
  await expect(permalink).toBeVisible();
  await permalink.click();
  await expect(page).toHaveURL(new RegExp(`/committee/takes/${take.id}$`));
  await expect(page.locator("[data-committee-take-receipt]")).toBeVisible();
  await expect(page.locator("[data-committee-take-receipt] [data-verified-badge]")).toContainText("server verified");
  await expect(page.locator("body")).not.toContainText('"take":');
});
