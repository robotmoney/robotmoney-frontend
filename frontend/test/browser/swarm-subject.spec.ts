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

test("public subject profile renders holdings, wallets, NFT contracts and the swarm brief from fetched (archive) data", async ({ page }) => {
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

  // The structural notes are the operator's brief TO THE SWARM, and woon.json
  // declares 4. They ride in a disclosure that says so and starts CLOSED: open
  // and headed "Structural notes", they read as the page annotating itself.
  const brief = page.locator(".sp-brief");
  await expect(brief.locator(".sp-brief__sum")).toContainText("Brief to the swarm · 4 notes");
  await expect(brief.locator(".sp-brief__sum")).toHaveAttribute("aria-expanded", "false");
  // Closed means closed to a reader AND to the keyboard: the region collapses
  // to nothing and is inert, so the notes are not tab-reachable behind it.
  const region = brief.locator(".sp-brief__anim");
  await expect(region).toHaveAttribute("inert", /.*/);
  expect(await region.boundingBox().then((b) => b?.height ?? 0)).toBeLessThan(1);

  // ...and opens to the notes themselves, with what they are for said plainly.
  await brief.locator(".sp-brief__sum").click();
  await expect(brief.locator(".sp-brief__sum")).toHaveAttribute("aria-expanded", "true");
  await expect(brief).toContainText("Instructions the operator gives the agents");
  await expect(brief.locator("li")).toHaveCount(4);
  await expect(brief).toContainText("RoboFarm, RecycleMachine, ClawMachine");

  // Sessions: all 9 archived, published woon sessions.
  await expect(page.locator(".sv__session-card")).toHaveCount(9);

  // And their takes open from the archive too. The expander's fallback is a
  // fetch against the API, which has no row for an archived session — so
  // without the bodies carried onto the row this reported "These takes could
  // not be loaded" over takes already in memory.
  const first = page.locator(".sv__session-card").first();
  const btn = first.locator(".sv__takes-btn");
  await expect(btn).not.toBeDisabled();
  await btn.click();
  await expect(first.locator(".sv__take-row").first()).toBeVisible();
  await expect(first.locator(".sv__take-line").first()).not.toHaveText("");
  // :visible, not a count — the loading and error lines are x-show, so both
  // are in the DOM either way. What matters is that neither is on screen.
  await expect(first.locator(".sv__unset:visible")).toHaveCount(0);

  await expectNoBrowserErrors(errors);
});

// The optional panels gate on .length rather than rendering an empty section.
// This used to be asserted against robotmoney-allocation, whose archive
// manifest is the only one carrying `wallets: []` with no `nft_contracts` key.
// The two gates are covered separately now: the NFT one off
// the archive, which is the fixture that has it, and the wallets one off a
// stubbed API subject, which is the path production actually takes.
test("public subject profile hides the NFT panel for an archived subject with none declared", async ({ page }) => {
  const errors = failOnBrowserErrors(page);

  await page.route("**/api/swarm/**", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );

  // robotmoney-vault's manifest declares one wallet and no nft_contracts key
  // at all, so the wallets panel below is the positive control: the NFT
  // absence is a gate firing, not a page that never drew its panels.
  await page.goto("/swarm/subjects/robotmoney-vault");

  await expect(page.locator(".sv__detail-title")).toHaveText("Robot Money Vault");
  await expect(page.locator(".sv__panel", { hasText: "NFT contracts" })).toHaveCount(0);
  await expect(page.locator(".sv__panel", { hasText: "Tracked wallets" })).toBeVisible();

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
  // mav gates off every panel there is, so the positive control has to sit
  // past them: the sessions empty state proves the body rendered the whole
  // way down, and the absences above are gates firing rather than a page
  // that never drew.
  await expect(page.locator(".sv__empty")).toBeVisible();

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

// A subject profile lists the same sessions /swarm does, and used to read them
// a different way: /swarm showed the stance spread, the consensus lean, the
// quorum and what the session decided, while the profile showed a take count
// and five lines of synthesis. Same session, two stories, depending on which
// page you arrived from.
//
// Both surfaces now derive those from lib/session-summary.js. The data was
// never the obstacle: loadSessions() already fetched each session's FULL
// detail and discarded everything but `synthesis`.
//
// Stubbed rather than archive-driven on purpose: the checked-in archive
// sessions carry a recommendation but no `stances`, `quorum` or
// `meanConfidence`, so the archive path cannot exercise the consensus half of
// the card at all.
test("a subject's session card carries the consensus and the decision, as /swarm does", async ({ page }) => {
  const session = {
    id: "3f2b9c10-77aa-4d1e-9a3c-0b5e6f8d2c41",
    date: "2026-09-01",
    subject_id: "robotmoney-allocation",
    subject_name: "Robot Money Allocation",
    state: "published",
    synthesis: "The swarm held the 95/5/0/0 frame.",
    swarm_recommendation: {
      type: "bucket_weights",
      weights: {
        conservative_defi_yield: 0.95,
        agent_tokens: 0.05,
        protocol_tokens: 0,
        real_world_assets: 0,
      },
      stances: { constructive: 4, cautious: 1 },
      quorum: { submitted: 5, active: 7 },
      meanConfidence: 0.62,
    },
  };

  await page.route("**/api/swarm/subjects/robotmoney-allocation", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "robotmoney-allocation",
        name: "Robot Money Allocation",
        source: { type: "framework" },
        structural_notes: [],
        wallets: [],
      }),
    }));
  await page.route("**/api/swarm/subjects/robotmoney-allocation/snapshots", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ snapshots: [] }) }));
  await page.route("**/api/swarm/sessions?**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [session], nextCursor: null }) }));
  await page.route("**/api/swarm/sessions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [session], nextCursor: null }) }));
  // Counted so the expander can be shown NOT to re-fetch what the page already
  // holds: this same response is what built the card.
  let detailFetches = 0;
  await page.route("**/api/swarm/sessions/2026-09-01/robotmoney-allocation", (route) => {
    detailFetches += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session,
        takes: [
          { id: "t1", member_id: "athena", member_name: "Athena", stance: "constructive", confidence: 0.8,
            body: "**SUBJECT**\n- Conservative DeFi still carries the book at this size." },
          { id: "t2", member_id: "woon", member_name: "Woon", stance: "cautious", confidence: 0.4,
            body: "**SUBJECT**\n- The agent sleeve is thin enough to ignore." },
          { id: "t3" }, { id: "t4" }, { id: "t5" },
        ],
      }),
    });
  });

  await page.goto("/index.html");
  await navigate(page, "/swarm/subjects/robotmoney-allocation");
  const card = page.locator(".sv__session-card").first();
  await expect(card).toBeVisible();

  // The date is the identity here, not the subject's name: on this page every
  // row would carry the same name.
  await expect(card.locator(".sv__session-title")).toHaveText(/Sep 1, 2026/);
  await expect(card.locator(".sv__session-title"))
    .toHaveAttribute("href", `/swarm/sessions/${session.id}`);

  // One bar segment per stance that was actually filed.
  await expect(card.locator(".sv__spread > i")).toHaveCount(2);
  // The consensus, in the same three parts /swarm prints.
  await expect(card.locator(".sv__stance-badge")).toHaveText("constructive");
  await expect(card).toContainText("5 of 7 took part");
  await expect(card).toContainText("62% mean confidence");
  // What it DECIDED, in the subject's own units.
  await expect(card.locator(".sv__rec-n")).toHaveText("95 / 5 / 0 / 0");
  // The foot /swarm carries: the takes expander and the way through to the
  // session itself.
  const takesBtn = card.locator(".sv__takes-btn");
  await expect(takesBtn).toHaveText(/5 takes/);
  await expect(takesBtn).toHaveAttribute("aria-expanded", "false");
  await expect(card.locator(".sv__live-lnk")).toHaveAttribute("href", `/swarm/sessions/${session.id}`);

  // The page already fetched this session's full detail to build the card, so
  // opening the takes must not buy the same response twice.
  const before = detailFetches;
  await takesBtn.click();
  await expect(takesBtn).toHaveAttribute("aria-expanded", "true");
  const rows = card.locator(".sv__take-row");
  await expect(rows).toHaveCount(5);
  expect(detailFetches).toBe(before);

  // Loudest first, and each row is a member, a stance and one line of what
  // they actually said — not the whole memo.
  await expect(rows.first()).toContainText("Athena");
  await expect(rows.first().locator(".sv__stance-badge")).toHaveText("constructive");
  await expect(rows.first()).toContainText("confidence");
  await expect(rows.first().locator(".sv__take-line"))
    .toHaveText("Conservative DeFi still carries the book at this size.");
  await expect(rows.nth(1)).toContainText("Woon");

  // And it closes again.
  await takesBtn.click();
  await expect(takesBtn).toHaveAttribute("aria-expanded", "false");
});

// The archive fallback was keyed on the REQUEST failing. This route answers
// 200 with a `null` body for an id it does not have, so the promise resolved,
// camelSubject(null) returned null, and the fallback never ran: the page read
// "Subject not found" for every subject absent from the database, with the
// checked-in manifest describing it one fetch away. That is the whole local
// demo stack, where /swarm/subjects/robotmoney-allocation was unreachable.
test("a subject the API answers 200 null for still renders from the archive", async ({ page }) => {
  await page.route("**/api/swarm/subjects/woon", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "null" }));
  // Everything else fails, so only the null-body path is under test here.
  await page.route(/\/api\/swarm\/(?!subjects\/woon$).*/, (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));

  await page.goto("/index.html");
  await navigate(page, "/swarm/subjects/woon");

  // The archive manifest's own name, which is how we know the render came
  // from it and not from the (null) API answer.
  await expect(page.locator(".sv__detail-title")).toHaveText("Woon Treasury");
  await expect(page.locator(".sv__error")).toHaveCount(0);
});

// A label with nothing under it reads as a figure that failed to load. Every
// static-archive session row carries the recommendation but no stances, no
// quorum and no mean confidence, and the three facts under the kicker were
// each gated separately — so the word "Consensus" printed over empty space on
// every archived row of every subject.
test("a session with no consensus to report prints no Consensus kicker", async ({ page }) => {
  const errors = failOnBrowserErrors(page);

  await page.route("**/api/swarm/**", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );

  await page.goto("/swarm/subjects/robotmoney-allocation");
  await expect(page.locator(".sv__session-card").first()).toBeVisible();

  // The rows are here, and they do carry the decision...
  await expect(page.locator(".sv__rec").first()).toContainText("Target weights");
  // ...but not a consensus, so the kicker is absent rather than empty.
  await expect(page.locator(".sv__session-kicker", { hasText: "Consensus" })).toHaveCount(0);

  await expectNoBrowserErrors(errors);
});

// A framework subject has no book, and this one says so in its own brief: "no
// portfolio to scrape — the subject IS the allocation.json framework state".
// Production published a $42,688 holdings table on it anyway. The numbers come
// from ensureSmokeSubjectFixtures() (backend/src/swarm/domain.ts), which writes
// a deterministic fake basket into swarm_subject_snapshots for every subject
// that is not woon or mav, and which a release cutover runs against the
// production database. The top position read "ROBOT 50%" — not a token, but
// `subjectId.slice(0, 5).toUpperCase()` of "robotmoney-allocation".
//
// Cleaning that row up is a data fix elsewhere. This is the page refusing to
// print a book for a subject that declares it holds nothing, whatever the API
// hands it.
test("a framework subject renders no book, even when the API serves it one", async ({ page }) => {
  const errors = failOnBrowserErrors(page);

  let snapshotsRequested = false;
  await page.route("**/api/swarm/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (/\/api\/swarm\/subjects\/fw$/.test(pathname)) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "fw", name: "Framework Subject", thesis_blurb: "",
          wallets: [], nft_contracts: [], structural_notes: [],
          source: { type: "framework" },
        }),
      });
    }
    if (/\/snapshots$/.test(pathname)) {
      snapshotsRequested = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          snapshots: [
            {
              date: "2026-08-05", total_value_usd: 42688,
              positions: [{ token: "FW", chain: "base", value_usd: 42688 }],
              notable: ["FW 100% is the anchor position."],
            },
            {
              date: "2026-08-06", total_value_usd: 42688,
              positions: [{ token: "FW", chain: "base", value_usd: 42688 }],
              notable: ["FW 100% is the anchor position."],
            },
          ],
        }),
      });
    }
    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });

  await page.goto("/swarm/subjects/fw");
  await expect(page.locator(".sv__detail-title")).toHaveText("Framework Subject");

  // No holdings table, no notable list, no concentration chart, and no
  // holdings figure among the facts.
  await expect(page.locator(".sp-holdings")).toHaveCount(0);
  await expect(page.locator(".sv__notables")).toHaveCount(0);
  await expect(page.locator(".sp-chart__svg svg")).toHaveCount(0);
  await expect(page.locator(".sv__fact-row")).not.toContainText("holdings");
  // Two snapshots would otherwise be enough to draw the chart, so this is a
  // gate firing rather than a fixture too thin to render.
  await expect(page.locator(".sv__fact-row")).toContainText("sessions");

  // And the request is never made: a subject with no book has none to fetch.
  expect(snapshotsRequested).toBe(false);

  await expectNoBrowserErrors(errors);
});
