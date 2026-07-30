import { expect, test, type Page } from "@playwright/test";

// PR #327 shipped the public subject profile (/committee/subjects/:id) with
// zero test coverage (issue #340). This spec exercises the real, shipped
// render path — not a synthetic fixture — following spa.spec.ts's
// failOnBrowserErrors/expectNoBrowserErrors pattern used for
// /committee/members/athena.
//
// The live committee API's demo-seed path (backend/src/committee/domain.ts's
// ensureDemoSubjectFixtures) only ever writes id/name/thesis_blurb — it never
// populates wallets/nft_contracts/structural_notes on a demo subject row, so
// asserting against whatever the live stack happens to have seeded would be
// non-deterministic and could pass with every optional section empty. This
// spec instead forces the page down its OTHER production data path: the
// static-archive fallback (loadArchiveSubject/archiveSnapshots/
// loadArchiveSession in static-views.js, already exercised directly by
// scripts/tests/unit/frontend-routes.test.ts), by making every
// /api/committee/* call fail. That path is real production code — the same
// fallback pre-2026-07-01 committee sessions render from everywhere else on
// the site — and it runs against the shipped archive fixtures
// (frontend/public/data/committee/manifests/subjects/woon.json + the
// per-date subjects/woon/*.json snapshots), which are the one dataset
// guaranteed to carry non-empty wallets, nft_contracts, AND structural_notes.

// The browser itself (not app code) logs a console error for every network
// request that comes back non-2xx — one per failed resource load, regardless
// of whether the app handled it gracefully. This spec deliberately forces
// every /api/committee/** call to fail (503) so the page takes its archive
// fallback, and the archive path itself makes best-effort lookups (e.g. a
// snapshot file that legitimately doesn't exist for every date) that 404 and
// are caught by the app. Both are expected, browser-generated noise — not
// evidence of a page bug — so they are filtered out here rather than in
// spa.spec.ts's failOnBrowserErrors/expectNoBrowserErrors, which never mocks
// network failures and so never needs this exclusion.
const EXPECTED_NETWORK_NOISE = /^console: Failed to load resource: the server responded with a status of \d+/;

function failOnBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.stack || error.message}`));
  return errors;
}

async function expectNoBrowserErrors(errors: string[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(errors.filter((e) => !EXPECTED_NETWORK_NOISE.test(e))).toEqual([]);
}

test("public subject profile renders holdings, wallets, NFT contracts, and structural notes from fetched (archive) data", async ({ page }) => {
  const errors = failOnBrowserErrors(page);

  // Force every committee API call to fail so subjectProfile.init() and its
  // loadSnapshots()/loadSessions() side-fetches take their real archive
  // fallback branch (the same branch every pre-2026-07-01 committee surface
  // relies on) instead of whatever the live demo stack has or hasn't seeded
  // for this id.
  await page.route("**/api/committee/**", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );

  await page.goto("/committee/subjects/woon");

  await expect(page.locator(".cv__detail-title")).toHaveText("Woon");
  await expect(page.locator(".cv__error")).toHaveCount(0);

  // Holdings table: the archived 2026-06-25 snapshot's positions (verified
  // directly against loadArchiveSnapshot in frontend-routes.test.ts).
  const holdingsRows = page.locator(".sp-holdings tbody tr");
  await expect(holdingsRows).toHaveCount(6);
  await expect(holdingsRows.first()).toContainText("WOON");
  await expect(page.locator(".cv__panel-label", { hasText: "Holdings" })).toBeVisible();

  // Concentration chart draws once there are >= 2 snapshots in the window.
  await expect(page.locator(".sp-chart__svg svg")).toBeVisible();

  // Tracked wallets: woon.json declares 3.
  const walletsPanel = page.locator(".cv__panel", { hasText: "Tracked wallets" });
  await expect(walletsPanel).toBeVisible();
  await expect(walletsPanel.locator("li")).toHaveCount(3);
  await expect(walletsPanel).toContainText("main");
  await expect(walletsPanel).toContainText("holdings-peaq");

  // NFT contracts: woon.json declares 3 (RoboFarm, RecycleMachine, ClawMachine)
  // — nft_contracts -> nftContracts is exactly the camelSubject mapping gap
  // issue #340 covers at the unit level.
  const nftPanel = page.locator(".cv__panel", { hasText: "NFT contracts" });
  await expect(nftPanel).toBeVisible();
  await expect(nftPanel.locator("li")).toHaveCount(3);
  await expect(nftPanel).toContainText("RoboFarm");
  await expect(nftPanel).toContainText("RecycleMachine");
  await expect(nftPanel).toContainText("ClawMachine");

  // Structural notes: woon.json declares 4. This is the .length-gated panel
  // (structuralNotesOf) — asserting it renders here is the positive
  // counterpart to frontend-routes.test.ts's empty-array unit case.
  const notesPanel = page.locator(".cv__panel", { hasText: "Structural notes" });
  await expect(notesPanel).toBeVisible();
  await expect(notesPanel.locator("li")).toHaveCount(4);
  await expect(notesPanel).toContainText("RoboFarm, RecycleMachine, ClawMachine");

  // Sessions: all 9 archived, published woon sessions.
  await expect(page.locator(".cv__session-card")).toHaveCount(9);

  await expectNoBrowserErrors(errors);
});

test("public subject profile hides the structural-notes panel for a subject with none declared", async ({ page }) => {
  const errors = failOnBrowserErrors(page);

  await page.route("**/api/committee/**", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );

  // robotmoney-allocation's manifest has wallets: [] and no nft_contracts key
  // at all — structuralNotes()/nftContracts()/trackedWallets() must all gate
  // their panel on .length rather than rendering an empty section.
  await page.goto("/committee/subjects/robotmoney-allocation");

  await expect(page.locator(".cv__detail-title")).toHaveText("Robot Money Allocation");
  await expect(page.locator(".cv__panel", { hasText: "NFT contracts" })).toHaveCount(0);
  await expect(page.locator(".cv__panel", { hasText: "Tracked wallets" })).toHaveCount(0);
  // robotmoney-allocation's manifest DOES declare structural notes, so that
  // panel should still render — this subject isolates the wallets/NFT gate.
  await expect(page.locator(".cv__panel", { hasText: "Structural notes" })).toBeVisible();

  await expectNoBrowserErrors(errors);
});
