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

  // No "What the swarm is given" section any more. Woon is not the framework,
  // so it has no targets card; the same latest review renders on its own, in
  // the slot that section held, and its handover is a record of that brief.
  await expect(page.locator(".sp-brief__sum-k")).toHaveText(["What the swarm was handed"]);
  const review = page.locator(".sp-review .sr");
  await expect(review).toBeVisible();
  await expect(review.locator(".sr__k")).toHaveText(["Signal", "Reasoning"]);
  const hand = review.locator(".sp-brief");
  await expect(hand.locator(".sp-brief__sum")).toHaveAttribute("aria-expanded", "false");
  await expect(hand.locator(".sp-brief__anim")).toHaveAttribute("inert", /.*/);
  await hand.locator(".sp-brief__sum").click();
  await expect(hand.locator('[data-part="notes"] li')).toHaveCount(4);
  await expect(hand).toContainText("RoboFarm, RecycleMachine, ClawMachine");
  // A research item links when the site has a page for it, and the archive's
  // articles all do.
  await expect(hand.locator('[data-part="research"] .hand__links a').first()).toHaveAttribute("href", /^\//);

  // Sessions: all 9 archived, published woon sessions.
  await expect(page.locator(".sv__session-card")).toHaveCount(9);

  // And their takes open from the archive too. The expander's fallback is a
  // fetch against the API, which has no row for an archived session — so
  // without the bodies carried onto the row this reported "These takes could
  // not be loaded" over takes already in memory.
  const first = page.locator(".sv__session-card").first();

  // The consensus is DERIVED from the takes here. The static archive stores no
  // aggregate stances, quorum or mean confidence, so every archived card had no
  // consensus at all — over stances sitting on the takes in the same object.
  // No stance spread bar on this page: it competed with the target ring, which
  // IS the decision, while saying what the badge below says in a word.
  await expect(first.locator(".sv__spread")).toHaveCount(0);
  await expect(first.locator(".sv__session-kicker")).toHaveText("Consensus");
  await expect(first.locator(".sv__card-verdict")).toContainText("took part");
  await expect(first.locator(".sv__card-verdict")).toContainText("mean confidence");

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

  // The consensus, in the same three parts /swarm prints.
  await expect(card.locator(".sv__stance-badge")).toHaveText("constructive");
  await expect(card).toContainText("5 of 7 took part");
  await expect(card).toContainText("62% mean confidence");
  // What it DECIDED, in the subject's own units.
  // Drawn, not spelled: one band per sleeve, in /allocation's own colours, with
  // the figures beside their names. "95 / 5 / 0 / 0" made a reader map four
  // numbers back onto four names they were holding in their head.
  const keys = card.locator(".sv__wkeys li");
  await expect(keys).toHaveCount(4);
  await expect(keys.nth(0)).toContainText("Conservative DeFi Yield");
  await expect(keys.nth(0)).toContainText("95%");
  await expect(keys.nth(1)).toContainText("Agent Tokens");
  await expect(keys.nth(1)).toContainText("5%");
  // A sleeve at zero keeps its row, marked as held there on purpose...
  await expect(keys.nth(2)).toContainText("Protocol Tokens 0%");
  await expect(keys.nth(2)).toHaveClass(/is-zero/);
  // ...and draws no arc, so the ring never shows a sliver for nothing. Two
  // sleeves are funded here, so two arcs sit on the track.
  const arcs = card.locator(".sv__wdonut circle[pathLength]");
  await expect(arcs).toHaveCount(2);
  // An arc's length IS its percentage, because the circle carries
  // pathLength="100" — the geometry cannot drift out of step with the radius.
  // The small sleeve is drawn at its true length; the gaps between arcs come
  // out of the largest one alone (95 - 2 x 1.2).
  await expect(arcs.nth(1)).toHaveAttribute("stroke-dasharray", /^5 /);
  await expect(arcs.first()).toHaveAttribute("stroke-dasharray", /^92\.6 /);
  // Colour follows the sleeve's published POSITION, so it is the hue this
  // sleeve wears on /allocation's donut and a weight change never repaints the
  // sleeves that did not move.
  await expect(arcs.first()).toHaveAttribute("stroke", "#10b981"); // CATEGORICAL[0]
  await expect(card.locator(".sv__wdonut-host")).toHaveAttribute("aria-label", /Conservative DeFi Yield 95%/);
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

  // A row the index lists but whose detail fetch fails: the card still renders
  // from what the index carries, with no stances, no quorum, no confidence and
  // no takes to derive any of them from. This is the case the gate is for. An
  // ARCHIVED session is no longer one — its takes carry stances, and the card
  // derives the consensus from them.
  const row = {
    id: "8e1f0c22-4a55-4f30-b7c1-2d9e6a4b1f88",
    date: "2026-09-02",
    subject_id: "robotmoney-allocation",
    state: "published",
    swarm_recommendation: { type: "bucket_weights", weights: { conservative_defi_yield: 0.95, agent_tokens: 0.05 } },
  };
  await page.route("**/api/swarm/**", (route) => {
    const { pathname, search } = new URL(route.request().url());
    if (pathname === "/api/swarm/sessions") {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ sessions: [row], nextCursor: null }),
      });
    }
    // The detail resolves — with the decision, and with NO takes and none of
    // the aggregates. That is the shape the kicker has to survive.
    if (pathname === "/api/swarm/sessions/2026-09-02/robotmoney-allocation") {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ session: row, takes: [] }),
      });
    }
    if (pathname === "/api/swarm/subjects/robotmoney-allocation") {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          id: "robotmoney-allocation", name: "Robot Money Allocation",
          source: { type: "framework" }, wallets: [], structural_notes: [],
        }),
      });
    }
    void search;
    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });

  await page.goto("/swarm/subjects/robotmoney-allocation");
  const card = page.locator(".sv__session-card").first();
  await expect(card).toBeVisible();

  // The row is here, and it does carry the decision...
  await expect(card.locator(".sv__wkeys li").first()).toContainText("Conservative DeFi Yield 95%");
  // ...but nothing to say about the consensus, so the kicker is absent rather
  // than a label standing over empty space.
  await expect(card.locator(".sv__session-kicker")).toHaveCount(0);
  // And the spread bar has nothing to draw either.
  await expect(card.locator(".sv__spread > i")).toHaveCount(0);

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

// The subject IS the published allocation, so its page opens with the weights
// in force. A reader landing here was shown six sessions ABOUT the weights
// before being shown the weights. Same .sv__alloc card /swarm carries, minus
// the eyebrow and title that name which subject it is for — this page's own H1
// already said that.
test("the allocation subject opens with the weights in force, and no other subject does", async ({ page }) => {
  const errors = failOnBrowserErrors(page);

  let frameworkFetches = 0;
  await page.route("**/api/dashboards/allocation", (route) => {
    frameworkFetches += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        asOf: "2026-06-02",
        strategy: [
          { label: "Conservative DeFi Yield", targetPct: 95 },
          { label: "Agent Tokens", targetPct: 5 },
          { label: "Protocol Tokens", targetPct: 0 },
          { label: "Real World Assets", targetPct: 0 },
        ],
      }),
    });
  });
  await page.route("**/api/swarm/**", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );

  await page.goto("/swarm/subjects/robotmoney-allocation");
  const card = page.locator(".sv__alloc");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Unchanged since");

  // The card's own register, not the handover's copy of the targets further
  // down the same card.
  const rows = card.locator(".sv__alloc-reg .sv__sleeve:not(.sv__sleeve--head)");
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText("Conservative DeFi Yield");
  await expect(rows.first()).toContainText("95%");

  // A published zero draws an empty TRACK rather than no track: an absent
  // target renders an em dash and no track, and the two must not look alike.
  await expect(rows.nth(2)).toContainText("0%");
  await expect(rows.nth(2).locator(".sv__sleeve-track")).toHaveCount(1);
  await expect(card).toContainText("targets, not gaps");

  // /swarm points here for the history, so this points at the product page.
  await expect(card.locator('a[href="/allocation"]')).toBeVisible();

  // A subject that is NOT the framework is a book the framework does not
  // describe: it gets no card, and never asks for one.
  frameworkFetches = 0;
  await page.goto("/swarm/subjects/robotmoney-vault");
  await expect(page.locator(".sv__detail-title")).toHaveText("Robot Money Vault");
  await expect(page.locator(".sv__alloc")).toHaveCount(0);
  expect(frameworkFetches).toBe(0);

  await expectNoBrowserErrors(errors);
});

// The card's heading has to stay true in both states. "Latest swarm
// recommendation" is right for weights a session published and wrong for the
// seeded row in force today — and the card's own note says, two lines below,
// that no session has changed them. So the heading follows provenance, and it
// follows provenance.sessionId rather than the DTO's top-level `managed`,
// which is true today and is about the VAULT being managed.
test("the allocation card names who set the weights, and never overclaims", async ({ page }) => {
  const errors = failOnBrowserErrors(page);

  // Widened so the second half can add `provenance`: this is a .ts spec, so a
  // JSDoc cast does not apply to a `let` initializer the way it would in JS.
  let framework: Record<string, unknown> = {
    asOf: "2026-06-02",
    managed: true, // true today, and NOT about who wrote the targets
    strategy: [
      { label: "Conservative DeFi Yield", targetPct: 95 },
      { label: "Agent Tokens", targetPct: 5 },
    ],
  };
  await page.route("**/api/dashboards/allocation", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(framework) }),
  );
  await page.route("**/api/swarm/**", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );

  // Seeded: no provenance, so no claim of a recommendation — even though the
  // feed says managed: true.
  await page.goto("/swarm/subjects/robotmoney-allocation");
  await expect(page.locator(".sv__alloc-t")).toHaveText("Target weights in force");
  await expect(page.locator(".sv__alloc")).toContainText("No session has changed these weights yet");

  // A session wrote them: now it IS the latest swarm recommendation.
  framework = { ...framework, provenance: { sessionId: "3f2b9c10-77aa-4d1e-9a3c-0b5e6f8d2c41" } };
  await page.goto("/swarm");
  await page.goto("/swarm/subjects/robotmoney-allocation");
  await expect(page.locator(".sv__alloc-t")).toHaveText("Latest swarm recommendation");

  await expectNoBrowserErrors(errors);
});

// ── The latest review, inside the targets card (RM-121) ───────────────────
// Live-shaped: the real 2026-09-10 allocation session.
const LR_ID = "4cf025d6-8b53-4e7b-85a8-3843f2aa1609";
const LR_ROW = {
  id: LR_ID, date: "2026-09-10", subjectId: "robotmoney-allocation", subjectName: "Robot Money Allocation", state: "published",
  regimeSummary: {
    composite: 0.5978, composite_percentile: 0.8324, regime: "risk_on",
    macro_percentile: 0.8991, onchain_percentile: 0.5648, factor_percentile: 0.6845,
    macro_regime: "risk_on", onchain_regime: "neutral", factor_regime: "risk_on",
  },
  swarmRecommendation: {
    type: "position_actions",
    stances: { bullish: 1, neutral: 1, constructive: 3 },
    quorum: { active: 7, submitted: 5, absent: 2 },
    meanConfidence: 0.638,
  },
};
const LR_TAKES = [
  { id: "t1", member_id: "m1", member_handle: "noop-analyst", member_name: "Noop Analyst", stance: "constructive", confidence: 0.6 },
  { id: "t2", member_id: "m2", member_handle: "robotmoney", member_name: "Robot Money", stance: "constructive", confidence: 0.62 },
  { id: "t3", member_id: "m3", member_handle: "athena", member_name: "Athena", stance: "constructive", confidence: 0.62 },
  { id: "t4", member_id: "m4", member_handle: "woon", member_name: "Woon", stance: "bullish", confidence: 0.67 },
  { id: "t5", member_id: "m5", member_handle: "shodai", member_name: "ShodAI", stance: "neutral", confidence: 0.68 },
];

test("the targets card carries the latest review under its note: signal, reasoning, what the swarm was handed", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await page.route("**/api/**", (route) => {
    const u = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (u.pathname === "/api/swarm/subjects/robotmoney-allocation") {
      return json({ id: "robotmoney-allocation", name: "Robot Money Allocation", source: { type: "framework" }, wallets: [], structural_notes: [] });
    }
    if (u.pathname === "/api/swarm/sessions") {
      return json({ sessions: [LR_ROW, { id: "50b833d3-6e85-4b60-8d93-8a140755fe67", date: "2026-09-10", subjectId: "woon", subjectName: "Woon Treasury", state: "published" }], nextCursor: null });
    }
    if (u.pathname === "/api/swarm/sessions/2026-09-10/robotmoney-allocation") return json({ session: LR_ROW, takes: LR_TAKES });
    if (u.pathname === "/api/swarm/brief" && u.searchParams.get("session") === LR_ID) {
      return json({
        prompt: { user: "Review the supplied swarm context for Robot Money Allocation on 2026-09-10 and return one take matching takeSchema." },
        regime: { regime: "risk_on", composite: "0.6044609980607236", macro_regime: "risk_on", onchain_regime: "neutral" },
        subject: { structuralNotes: ["no portfolio to scrape"] },
        researchSignals: [{ signalKey: "channel-divergence" }, { signalKey: "late-cycle-signals" }],
        recentSessions: [{ date: "2026-09-10T00:00:00.000Z", subject_id: "woon" }],
        takeSchema: { stance: {}, confidence: {}, body: {}, weights: {} },
      });
    }
    if (u.pathname === "/api/dashboards/allocation") {
      return json({ asOf: "2026-06-02", strategy: [{ label: "Conservative DeFi Yield", targetPct: 95 }, { label: "Agent Tokens", targetPct: 5 }] });
    }
    return json({}, 503);
  });
  await page.goto("/swarm/subjects/robotmoney-allocation");

  // Inside the targets card, directly after its note.
  const review = page.locator(".sv__alloc .sr");
  await expect(review).toBeVisible();
  // After the note, in document order, inside the card.
  const afterNote = await page.locator(".sv__alloc .sv__sleeve-note").evaluate((note) => {
    const sr = note.closest(".sv__alloc")?.querySelector(".sr");
    if (!sr) return false;
    return Boolean(note.compareDocumentPosition(sr) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(afterNote).toBe(true);
  // The allocation link sits beside the card's title, not at its foot.
  await expect(page.locator(".sp-alloc__head a.sv__cov-lnk")).toHaveAttribute("href", "/allocation");
  await expect(page.locator(".sv__alloc > a.sv__cov-lnk")).toHaveCount(0);
  // One brief section on the page: the old "What the swarm is given" is gone.
  await expect(page.locator(".sp-brief__sum-k")).toHaveText(["What the swarm was handed"]);
  await expect(review.locator(".sr__meta a")).toHaveAttribute("href", `/swarm/sessions/${LR_ID}`);

  // SIGNAL: a one-word state, then dots on one percentile axis.
  await expect(review.locator(".sr__k")).toHaveText(["Signal", "Reasoning"]);
  const signal = review.locator(".sr__col").first();
  await expect(signal.locator(".sr__state")).toContainText("risk-on");
  await expect(signal.locator(".sr__state")).toContainText("83rd percentile");
  await expect(signal.locator(".sig__l")).toHaveText(["Composite", "Macro", "On-chain", "Factor"]);
  await expect(signal.locator(".sig__v")).toHaveText(["83rd", "90th", "56th", "68th"]);
  await expect(signal.locator(".sig__row").first().locator(".sig__dot")).toHaveAttribute("style", /left:\s*83\.2%/);
  // On the published method factor is context, not an input, and is drawn so.
  await expect(signal.locator(".sig__row").nth(3)).toHaveClass(/is-context/);
  await expect(signal.locator(".sr__foot")).toContainText("Factor is context");
  // This reading carries no cuts, and none are hard-coded in their place.
  await expect(signal.locator(".sig__zone")).toHaveCount(0);

  // REASONING: each member in their stance's column.
  const reasoning = review.locator(".sr__col").nth(1);
  await expect(reasoning.locator(".sr__state")).toContainText("constructive");
  await expect(reasoning.locator(".sr__state")).toContainText("3 of 5");
  await expect(reasoning.locator(".vote__col.is-lead .vote__m")).toHaveCount(3);
  await expect(reasoning.locator(".vote__m", { hasText: "Noop Analyst" })).toHaveAttribute("href", "/swarm/members/noop-analyst");
  await expect(reasoning.locator(".sr__foot")).toContainText("5 of 7 took part");

  // WHAT THE SWARM WAS HANDED: closed, then a record of that brief's parts.
  const hand = review.locator(".sp-brief");
  await expect(hand.locator(".sp-brief__sum")).toHaveAttribute("aria-expanded", "false");
  await hand.locator(".sp-brief__sum").click();
  const keys = await hand.locator(".hand__row").evaluateAll((els) => els.map((e) => e.getAttribute("data-part")));
  expect(keys).toEqual(["instruction", "regime", "research", "recent", "notes", "returns"]);
  // The regime in the session page's own chips: every reading wears its dot,
  // the composite (a number) does not.
  const regime = hand.locator('[data-part="regime"] .sv__fact');
  await expect(regime.locator("em")).toHaveText(["composite", "regime", "macro", "onchain"]);
  await expect(regime.locator("b")).toHaveText(["0.604", "risk-on", "risk-on", "neutral"]);
  await expect(regime.first().locator(".sv__fact-dot")).toHaveCount(0);
  await expect(regime.locator(".sv__fact-dot")).toHaveCount(3);
  // A recent session links to its session, by the dated address.
  const recent = hand.locator('[data-part="recent"] a.hand__pill');
  await expect(recent).toHaveText(["Sep 10 · Woon Treasury"]);
  await expect(recent).toHaveAttribute("href", "/swarm/2026-09-10/woon");
  // Each signal links to its reader page, under that page's own name, in a
  // list rather than as pills. The brief's own href is the JSON route, which
  // is not a page.
  const research = hand.locator('[data-part="research"] .hand__links a');
  await expect(research).toHaveText(["Channel Divergence", "Late-Cycle Signals"]);
  await expect(research.first()).toHaveAttribute("href", "/research/channel-divergence");

  await expectNoBrowserErrors(errors);
});

test("on a v0 archive reading, factor is drawn as the input it was", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await page.route("**/api/swarm/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  await page.route("**/api/dashboards/allocation", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ asOf: "2026-06-02", strategy: [{ label: "Conservative DeFi Yield", targetPct: 95 }] }),
  }));
  await page.goto("/swarm/subjects/robotmoney-allocation");

  // The 2026-06-24 archive session: its composite averaged macro, on-chain AND
  // factor, so saying "factor is context" here would be wrong.
  const signal = page.locator(".sv__alloc .sr .sr__col").first();
  await expect(signal.locator(".sr__k")).toHaveText("Signal");
  await expect(signal.locator(".sig__row").nth(3)).not.toHaveClass(/is-context/);
  await expect(signal.locator(".sr__foot")).not.toContainText("Factor is context");

  // That brief carried the targets in force when it opened: drawn as the
  // card's register, each sleeve in the hue it wears in the card above.
  const hand = page.locator(".sv__alloc .sr .sp-brief");
  await hand.locator(".sp-brief__sum").click();
  const bars = hand.locator('[data-part="targets"] .sv__sleeve');
  await expect(bars.locator(".sv__sleeve-n")).toHaveText(["Conservative DeFi Yield", "Agent Tokens", "Protocol Tokens", "Real World Assets"]);
  await expect(bars.locator(".sv__sleeve-v")).toHaveText(["95%", "5%", "0%", "0%"]);
  await expect(bars.first().locator(".sv__sleeve-track i")).toHaveAttribute("style", /width:\s*95%/);
  const cardHue = await page.locator(".sp-alloc__body .sv__bucket-dot").first().getAttribute("style");
  await expect(bars.first().locator(".sv__bucket-dot")).toHaveAttribute("style", cardHue || "missing");
  // The archive's refs carry no subject; they are this subject's own sessions.
  await expect(hand.locator('[data-part="recent"] a.hand__pill')).toHaveText(["Jun 21", "Jun 17", "Jun 13"]);
  await expect(hand.locator('[data-part="recent"] a.hand__pill').first()).toHaveAttribute("href", "/swarm/2026-06-21/robotmoney-allocation");

  await expectNoBrowserErrors(errors);
});

// A research item with no page on the site stays text: the brief is not a
// list of links, and a link that lands on "Page Not Found" is worse than none.
test("a research signal with no page on the site is not linked", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await page.route("**/api/**", (route) => {
    const u = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (u.pathname === "/api/swarm/subjects/robotmoney-allocation") {
      return json({ id: "robotmoney-allocation", name: "Robot Money Allocation", source: { type: "framework" }, wallets: [], structural_notes: [] });
    }
    if (u.pathname === "/api/swarm/sessions") return json({ sessions: [LR_ROW], nextCursor: null });
    if (u.pathname === "/api/swarm/sessions/2026-09-10/robotmoney-allocation") return json({ session: LR_ROW, takes: LR_TAKES });
    if (u.pathname === "/api/swarm/brief") {
      return json({ researchSignals: [{ signalKey: "channel-divergence" }, { signalKey: "made-up-signal" }] });
    }
    if (u.pathname === "/api/dashboards/allocation") return json({ asOf: "2026-06-02", strategy: [{ label: "Conservative DeFi Yield", targetPct: 95 }] });
    return json({}, 503);
  });
  await page.goto("/swarm/subjects/robotmoney-allocation");
  const hand = page.locator(".sr .sp-brief");
  await hand.locator(".sp-brief__sum").click();
  await expect(hand.locator('[data-part="research"] .hand__links a')).toHaveText(["Channel Divergence"]);
  await expect(hand.locator('[data-part="research"] .hand__links li > span')).toHaveText(["Made up signal"]);
  await expectNoBrowserErrors(errors);
});
