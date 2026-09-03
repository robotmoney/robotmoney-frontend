import { expect, test, type Page } from "@playwright/test";
import { navigate } from "./navigation.ts";

// PR #327 shipped the public subject profile (/swarm/subjects/:id) with
// zero test coverage (issue #340). This spec exercises the real, shipped
// render path — not a synthetic fixture — following spa.spec.ts's
// failOnBrowserErrors/expectNoBrowserErrors pattern used for
// /swarm/members/athena.
//
// The live swarm API's smoke-seed path (backend/src/swarm/domain.ts's
// ensureSmokeSubjectFixtures) only ever writes id/name/thesis_blurb — it never
// populates wallets/nft_contracts/structural_notes on a smoke subject row, so
// asserting against whatever the live stack happens to have seeded would be
// non-deterministic and could pass with every optional section empty. This
// spec instead forces the page down its OTHER production data path: the
// static-archive fallback (loadArchiveSubject/archiveSnapshots/
// loadArchiveSession in static-views.js, already exercised directly by
// scripts/tests/unit/frontend-routes.test.ts), by making every
// /api/swarm/* call fail. That path is real production code — the same
// fallback pre-2026-07-01 swarm sessions render from everywhere else on
// the site — and it runs against the shipped archive fixtures
// (frontend/public/data/swarm/manifests/subjects/woon.json + the
// per-date subjects/woon/*.json snapshots), which are the one dataset
// guaranteed to carry non-empty wallets, nft_contracts, AND structural_notes.

// The browser itself (not app code) logs a console error for every network
// request that comes back non-2xx — one per failed resource load, regardless
// of whether the app handled it gracefully. This spec deliberately forces
// every /api/swarm/** call to fail (503) so the page takes its archive
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

  // Force every swarm API call to fail so subjectProfile.init() and its
  // loadSnapshots()/loadSessions() side-fetches take their real archive
  // fallback branch (the same branch every pre-2026-07-01 swarm surface
  // relies on) instead of whatever the live smoke stack has or hasn't seeded
  // for this id.
  await page.route("**/api/swarm/**", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );

  await page.goto("/swarm/subjects/woon");

  // The archive branch takes its name from the subject MANIFEST
  // (loadArchiveSubject -> /data/swarm/manifests/subjects/woon.json), so this
  // asserts the portfolio's current name and not the member named Woon.
  await expect(page.locator(".sv__detail-title")).toHaveText("Woon Treasury");
  await expect(page.locator(".sv__error")).toHaveCount(0);

  // Holdings table: the archived 2026-06-25 snapshot's positions (verified
  // directly against loadArchiveSnapshot in frontend-routes.test.ts).
  const holdingsRows = page.locator(".sp-holdings tbody tr");
  await expect(holdingsRows).toHaveCount(6);
  await expect(holdingsRows.first()).toContainText("WOON");
  await expect(page.locator(".sv__panel-label", { hasText: "Holdings" })).toBeVisible();

  // Concentration chart draws once there are >= 2 snapshots in the window.
  await expect(page.locator(".sp-chart__svg svg")).toBeVisible();
  // Stacked bands, not lines: positions at equal weight drew exactly on top of
  // each other as strokes (the vault's three 33.3% holdings rendered as ONE
  // line), and share-of-NAV is an area question.
  await expect(page.locator(".sp-chart__svg svg polygon").first()).toBeVisible();
  await expect(page.locator(".sp-chart__svg svg polyline")).toHaveCount(0);

  // The legend is the whole point of the rebuild — the panel previously drew
  // unlabelled lines whose only key was a rule in the table further down.
  const legend = page.locator(".sp-legend li");
  await expect(legend.first()).toBeVisible();
  await expect(page.locator(".sp-legend")).toContainText("WOON");
  // Every row carries its CURRENT share, not just a name.
  await expect(legend.first()).toContainText("%");

  // A token's colour comes from assetDot(), so it is the same colour here, in
  // the holdings table, and on /allocation — it used to be indexed by the
  // position's RANK, which meant the colour said "second-biggest today" and
  // moved whenever two holdings swapped places.
  const usdcBand = await page.locator(".sp-legend li").filter({ hasText: "USDC" })
    .locator(".sp-legend__key").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(usdcBand).toBe("rgb(16, 185, 129)"); // #10b981, USDC's entry in ASSET_DOT

  // Tracked wallets: woon.json declares 3.
  const walletsPanel = page.locator(".sv__panel", { hasText: "Tracked wallets" });
  await expect(walletsPanel).toBeVisible();
  await expect(walletsPanel.locator("li")).toHaveCount(3);
  await expect(walletsPanel).toContainText("main");
  await expect(walletsPanel).toContainText("holdings-peaq");

  // NFT contracts: woon.json declares 3 (RoboFarm, RecycleMachine, ClawMachine)
  // — nft_contracts -> nftContracts is exactly the camelSubject mapping gap
  // issue #340 covers at the unit level.
  const nftPanel = page.locator(".sv__panel", { hasText: "NFT contracts" });
  await expect(nftPanel).toBeVisible();
  await expect(nftPanel.locator("li")).toHaveCount(3);
  await expect(nftPanel).toContainText("RoboFarm");
  await expect(nftPanel).toContainText("RecycleMachine");
  await expect(nftPanel).toContainText("ClawMachine");

  // Structural notes: woon.json declares 4. This is the .length-gated panel
  // (structuralNotesOf) — asserting it renders here is the positive
  // counterpart to frontend-routes.test.ts's empty-array unit case.
  const notesPanel = page.locator(".sv__panel", { hasText: "Structural notes" });
  await expect(notesPanel).toBeVisible();
  await expect(notesPanel.locator("li")).toHaveCount(4);
  await expect(notesPanel).toContainText("RoboFarm, RecycleMachine, ClawMachine");

  // Sessions: all 9 archived, published woon sessions.
  await expect(page.locator(".sv__session-card")).toHaveCount(9);

  await expectNoBrowserErrors(errors);
});

// The optional panels gate on .length rather than rendering an empty section.
// This used to be asserted against robotmoney-allocation, whose archive
// manifest is the only one carrying `wallets: []` with no `nft_contracts` key
// — and RM-115 redirected that address to /allocation/history, because the
// allocation is a framework rather than a book and this template had nothing
// to show for it. The two gates are covered separately now: the NFT one off
// the archive, which is the fixture that has it, and the wallets one off a
// stubbed API subject, which is the path production actually takes.
test("public subject profile hides the NFT panel for an archived subject with none declared", async ({ page }) => {
  const errors = failOnBrowserErrors(page);

  await page.route("**/api/swarm/**", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );

  // robotmoney-vault's manifest declares one wallet, four structural notes and
  // no nft_contracts key at all.
  await page.goto("/swarm/subjects/robotmoney-vault");

  await expect(page.locator(".sv__detail-title")).toHaveText("Robot Money Vault");
  await expect(page.locator(".sv__panel", { hasText: "NFT contracts" })).toHaveCount(0);
  await expect(page.locator(".sv__panel", { hasText: "Tracked wallets" })).toBeVisible();
  await expect(page.locator(".sv__panel", { hasText: "Structural notes" })).toBeVisible();

  await expectNoBrowserErrors(errors);
});

test("public subject profile hides the wallets panel for a subject serving an empty wallet list", async ({ page }) => {
  const errors = failOnBrowserErrors(page);

  await page.route("**/api/swarm/**", (route) => {
    if (/\/api\/swarm\/subjects\/mav$/.test(new URL(route.request().url()).pathname)) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "mav", name: "Mav Treasury", thesis_blurb: "",
          wallets: [], nft_contracts: [], structural_notes: ["One note."],
        }),
      });
    }
    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });

  // `mav` has no archive manifest, so nothing can merge wallets back in behind
  // the served payload.
  await page.goto("/swarm/subjects/mav");

  await expect(page.locator(".sv__detail-title")).toHaveText("Mav Treasury");
  await expect(page.locator(".sv__panel", { hasText: "Tracked wallets" })).toHaveCount(0);
  await expect(page.locator(".sv__panel", { hasText: "NFT contracts" })).toHaveCount(0);
  await expect(page.locator(".sv__panel", { hasText: "Structural notes" })).toBeVisible();

  await expectNoBrowserErrors(errors);
});

// The same late-write leak swarm-member-profile.spec.ts pins for the member
// page. subjectProfile.init() renames the tab after the subject once the fetch
// resolves, and that fetch is not cancelled when the router tears the view
// down — so before the route guard, a slow response stamped a subject's name
// onto whatever page the visitor had moved to.
test("a slow subject fetch does not stamp its name on the route the visitor moved to", async ({ page }) => {
  const FETCH_DELAY_MS = 2500;
  const SUBJECT_NAME = "Woon";

  await page.route("**/api/swarm/**", async (route) => {
    if (/\/api\/swarm\/subjects\/woon$/.test(new URL(route.request().url()).pathname)) {
      await new Promise((resolve) => setTimeout(resolve, FETCH_DELAY_MS));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "woon", name: SUBJECT_NAME, thesis_blurb: "" }),
      });
    }
    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });

  // Leave before the subject resolves.
  await page.goto("/swarm/subjects/woon");
  await navigate(page, "/faq");

  const faqTitle = await page.title();
  expect(faqTitle).not.toContain(SUBJECT_NAME);

  // Outlast the fetch, then confirm nothing moved. Read after the delay rather
  // than polling for a negative, which would pass simply by being early.
  await page.waitForTimeout(FETCH_DELAY_MS + 1500);
  expect(await page.title()).toBe(faqTitle);
});
