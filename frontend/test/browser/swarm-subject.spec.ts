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
//
// The page is a research record (RM-121): a facts row (.rr-meta), the latest
// recommendation as an explorable ring (#latest), the book (#holdings) and the
// recommendation history as a table (#history). The review band and the brief
// the session was handed moved to the session page, one click away; the tests
// that guarded them here follow that link.

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

test("public subject profile renders holdings, wallets, NFT contracts and its sessions from fetched (archive) data", async ({ page }) => {
  const errors = failOnBrowserErrors(page);

  // Force every swarm API call to fail so subjectProfile.init() and its
  // loadSnapshots()/loadSessionIndex() side-fetches take their real archive
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

  // Positions table: the archived 2026-06-25 snapshot's positions (verified
  // directly against loadArchiveSnapshot in frontend-routes.test.ts).
  await expect(page.locator("#hold-h")).toHaveText("Holdings");
  const positions = page.locator(".rr-positions tbody tr");
  await expect(positions).toHaveCount(6);
  await expect(positions.first()).toContainText("WOON");
  await expect(page.locator(".rr-positions .rr-k")).toHaveText("Positions on Jun 25, 2026");

  // Concentration chart draws once there are >= 2 snapshots in the window.
  const svg = page.locator(".rr-area__svg svg");
  await expect(svg).toBeVisible();
  // Stacked bands, not lines: positions at equal weight drew exactly on top of
  // each other as strokes (the vault's three 33.3% holdings rendered as ONE
  // line), and share-of-NAV is an area question. Each band carries a crisp
  // top edge, and that is the only line drawn: one per band, unfilled, keyed
  // to its band, never a series of its own.
  await expect(svg.locator("polygon").first()).toBeVisible();
  const bandTokens = await svg.locator("polygon").evaluateAll((els) => els.map((e) => e.getAttribute("data-token")));
  const edgeTokens = await svg.locator("polyline").evaluateAll((els) => els.map((e) => e.getAttribute("data-token")));
  expect(bandTokens.length).toBeGreaterThan(1);
  expect(edgeTokens).toEqual(bandTokens);
  await expect(svg.locator('polyline:not([fill="none"])')).toHaveCount(0);

  // The legend is the whole point of the rebuild — the panel previously drew
  // unlabelled lines whose only key was a rule in the table further down.
  const legend = page.locator(".rr-area__legend li");
  await expect(legend).toHaveCount(bandTokens.length);
  await expect(legend.first()).toBeVisible();
  await expect(page.locator(".rr-area__legend")).toContainText("WOON");
  // Every row carries its CURRENT share, not just a name.
  await expect(legend.first()).toContainText("%");

  // A token's colour comes from assetDot(), so it is the same colour here, in
  // the positions table, and on /allocation — it used to be indexed by the
  // position's RANK, which meant the colour said "second-biggest today" and
  // moved whenever two holdings swapped places.
  // By exact name: rmUSDC is a different token in the same book.
  const usdcBand = await legend.filter({ has: page.locator("span", { hasText: /^USDC$/ }) })
    .locator("i").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(usdcBand).toBe("rgb(16, 185, 129)"); // #10b981, USDC's entry in ASSET_DOT
  const usdcRow = await positions.filter({ has: page.locator("th span", { hasText: /^USDC$/ }) })
    .locator("th i").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(usdcRow).toBe(usdcBand);

  // What the book is read from, in one table. Tracked wallets: woon.json
  // declares 3. NFT contracts: it declares 3 (RoboFarm, RecycleMachine,
  // ClawMachine) — nft_contracts -> nftContracts is exactly the camelSubject
  // mapping gap issue #340 covers at the unit level.
  const sources = page.locator(".rr-sources tbody tr");
  await expect(sources.locator("th")).toHaveText(["main", "holdings", "holdings-peaq", "RoboFarm", "RecycleMachine", "ClawMachine"]);
  await expect(sources.locator("td:nth-child(2)")).toHaveText(["Wallet", "Wallet", "Wallet", "NFT contract", "NFT contract", "NFT contract"]);

  // Sessions: all 9 archived, published woon sessions, one history row each.
  const rows = page.locator("#history .sv__session-card");
  await expect(rows).toHaveCount(9);

  // And their takes are read from the archive too. The detail fallback is a
  // fetch against the API, which has no row for an archived session — so
  // without the bodies carried onto the row this reported "could not be
  // loaded" over takes already in memory.
  const first = rows.first();
  await expect(first.locator("th small")).toHaveText("3 takes");
  await expect(page.locator("#history")).not.toContainText("could not be loaded");

  // The consensus is DERIVED from the takes here. The static archive stores no
  // aggregate stances, quorum or mean confidence, so every archived row had no
  // consensus at all — over stances sitting on the takes in the same object.
  await expect(first.locator(".sv__stance-badge")).toHaveText("cautious");
  const counts = page.locator("#latest .rr-counts");
  await expect(counts.locator(":scope > span").filter({ hasText: "cautious" }).locator("b")).toHaveText("2");
  await expect(counts.locator(":scope > span").filter({ hasText: "constructive" }).locator("b")).toHaveText("1");
  // An archived session knows how many filed, not how many could have.
  await expect(counts.locator("em")).toHaveText(/^3 took part · \d+% mean confidence$/);
  // No stance spread bar on this page: it competed with the ring, which IS the
  // decision, while saying what the badge says in a word.
  await expect(page.locator(".sv__spread")).toHaveCount(0);

  await expectNoBrowserErrors(errors);
});

// The optional parts gate on .length rather than rendering an empty section.
// This used to be asserted against robotmoney-allocation, whose archive
// manifest is the only one carrying `wallets: []` with no `nft_contracts` key.
// The two gates are covered separately now: the NFT one off
// the archive, which is the fixture that has it, and the wallets one off a
// stubbed API subject, which is the path production actually takes.
test("public subject profile lists no NFT contract for an archived subject with none declared", async ({ page }) => {
  const errors = failOnBrowserErrors(page);

  await page.route("**/api/swarm/**", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );

  // robotmoney-vault's manifest declares one wallet and no nft_contracts key
  // at all, so the wallet row below is the positive control: the NFT
  // absence is a gate firing, not a page that never drew its sources.
  await page.goto("/swarm/subjects/robotmoney-vault");

  await expect(page.locator(".sv__detail-title")).toHaveText("Robot Money Vault");
  const sources = page.locator(".rr-sources tbody tr");
  await expect(sources).toHaveCount(1);
  await expect(sources.locator("td").first()).toHaveText("Wallet");
  await expect(page.locator(".rr-sources")).not.toContainText("NFT contract");
  // The note about unvalued NFT contracts goes with them.
  await expect(page.locator("#holdings")).not.toContainText("NFT contracts");

  await expectNoBrowserErrors(errors);
});

test("public subject profile lists no wallets for a subject serving an empty wallet list", async ({ page }) => {
  const errors = failOnBrowserErrors(page);

  await page.route("**/api/swarm/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (/\/api\/swarm\/subjects\/mav$/.test(pathname)) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "mav", name: "Mav Treasury", thesis_blurb: "",
          wallets: [], nft_contracts: [], structural_notes: ["One note."],
        }),
      });
    }
    // A book with no wallets on it, so the Holdings section draws and the
    // absence below is the wallets gate itself, not the section's.
    if (/\/api\/swarm\/subjects\/mav\/snapshots$/.test(pathname)) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          snapshots: [{
            date: "2026-09-01", total_value_usd: 1000,
            positions: [{ token: "USDC", chain: "base", value_usd: 1000 }],
          }],
        }),
      });
    }
    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });

  // `mav` has no archive manifest, so nothing can merge wallets back in behind
  // the served payload.
  await page.goto("/swarm/subjects/mav");

  await expect(page.locator(".sv__detail-title")).toHaveText("Mav Treasury");
  // The book is drawn...
  await expect(page.locator("#holdings .rr-stat__v")).toHaveText("$1,000");
  // ...with no "Read from" table: no wallet and no NFT contract to list.
  await expect(page.locator(".rr-sources")).toHaveCount(0);
  await expect(page.locator("#holdings")).not.toContainText("Read from");
  // And the body rendered the whole way down: the history's empty state sits
  // past every gated part.
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
// a different way: /swarm showed the consensus lean, the quorum and what the
// session decided, while the profile showed a take count and five lines of
// synthesis. Same session, two stories, depending on which page you arrived
// from.
//
// Both surfaces now derive those from lib/session-summary.js. The data was
// never the obstacle: loadSessionRow() fetches each session's FULL detail, and
// the latest recommendation and its history row are built from it.
//
// Stubbed rather than archive-driven on purpose: the checked-in archive
// sessions carry a recommendation but no `stances`, `quorum` or
// `meanConfidence`, so the archive path cannot exercise the aggregate half of
// the consensus at all.
test("a subject's latest session carries the consensus and the decision, as /swarm does", async ({ page }) => {
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
  // Counted so the page can be shown NOT to buy the same response twice: the
  // latest recommendation and its history row are one session, read once.
  let detailFetches = 0;
  await page.route(`**/api/swarm/sessions/${session.id}`, (route) => {
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
  const latest = page.locator("#latest");
  await expect(latest).toBeVisible();

  // The consensus, in the same parts /swarm prints: the stances counted, who
  // took part, and how sure they were.
  const counts = latest.locator(".rr-counts");
  await expect(counts.locator(":scope > span").filter({ hasText: "constructive" }).locator("b")).toHaveText("4");
  await expect(counts.locator(":scope > span").filter({ hasText: "cautious" }).locator("b")).toHaveText("1");
  await expect(counts.locator("em")).toHaveText("5 of 7 took part · 62% mean confidence");

  // What it DECIDED, in the subject's own units.
  // Drawn, not spelled: one arc per sleeve, in /allocation's own colours, with
  // the figures beside their names. "95 / 5 / 0 / 0" made a reader map four
  // numbers back onto four names they were holding in their head.
  const keys = latest.locator(".rr-legend__row");
  await expect(keys).toHaveCount(4);
  await expect(keys.nth(0)).toContainText("Conservative DeFi Yield");
  await expect(keys.nth(0)).toContainText("95%");
  await expect(keys.nth(1)).toContainText("Agent Tokens");
  await expect(keys.nth(1)).toContainText("5%");
  // A sleeve at zero keeps its row, marked as held there on purpose...
  await expect(keys.nth(2)).toContainText("Protocol Tokens");
  await expect(keys.nth(2)).toContainText("0%");
  await expect(keys.nth(2)).toHaveClass(/is-zero/);
  // ...and draws no arc, so the ring never shows a sliver for nothing. Two
  // sleeves are funded here, so two arcs sit on the track.
  const arcs = latest.locator(".sv__wdonut circle[pathLength]");
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
  await expect(latest.locator(".sv__wdonut-host")).toHaveAttribute("aria-label", /Conservative DeFi Yield 95%/);
  // The way through to the session itself.
  await expect(latest.locator(".rr-cta")).toHaveAttribute("href", `/swarm/sessions/${session.id}`);
  await expect(latest.locator(".rr-cta")).toContainText("Read the Sep 1, 2026 session");

  // The history row: the date is the identity here, not the subject's name —
  // on this page every row would carry the same name.
  const row = page.locator("#history .sv__session-card").first();
  await expect(row.locator(".sv__session-title")).toHaveText(/Sep 1, 2026/);
  await expect(row.locator(".sv__session-title")).toHaveAttribute("href", `/swarm/sessions/${session.id}`);
  await expect(row.locator("th small")).toHaveText("5 takes");
  // The same decision, one figure per sleeve column, a held zero marked so.
  await expect(row.locator("td.q")).toHaveText(["95%", "5%", "0%", "0%"]);
  await expect(row.locator("td.q").nth(2)).toHaveClass(/is-zero/);

  // One fetch built both.
  expect(detailFetches).toBe(1);
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
// quorum and no mean confidence, and the facts under the old "Consensus"
// kicker were each gated separately — so the word printed over empty space on
// every archived row of every subject. The consensus line under the latest
// recommendation is gated as a whole for the same reason.
test("a session with no consensus to report prints no consensus line", async ({ page }) => {
  const errors = failOnBrowserErrors(page);

  // A row whose detail resolves with the decision, and with NO takes and none
  // of the aggregates: no stances, no quorum, no confidence and no takes to
  // derive any of them from. This is the case the gate is for. An ARCHIVED
  // session is no longer one — its takes carry stances, and the page derives
  // the consensus from them.
  const row = {
    id: "8e1f0c22-4a55-4f30-b7c1-2d9e6a4b1f88",
    date: "2026-09-02",
    subject_id: "robotmoney-allocation",
    state: "published",
    swarm_recommendation: { type: "bucket_weights", weights: { conservative_defi_yield: 0.95, agent_tokens: 0.05 } },
  };
  await page.route("**/api/swarm/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/swarm/sessions") {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ sessions: [row], nextCursor: null }),
      });
    }
    if (pathname === `/api/swarm/sessions/${row.id}`) {
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
    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });

  await page.goto("/swarm/subjects/robotmoney-allocation");
  const latest = page.locator("#latest");
  await expect(latest).toBeVisible();

  // The session is here, and it does carry the decision...
  await expect(latest.locator(".rr-legend__row").first()).toContainText("Conservative DeFi Yield");
  await expect(latest.locator(".rr-legend__row").first()).toContainText("95%");
  await expect(page.locator("#history .sv__session-card").first().locator("td.q").first()).toHaveText("95%");
  // ...but nothing to say about the consensus, so the line is absent rather
  // than standing over empty space.
  await expect(latest.locator(".rr-counts")).toHaveCount(0);
  await expect(page.locator(".rr")).not.toContainText("took part");
  await expect(page.locator(".rr")).not.toContainText("mean confidence");

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

  // No Holdings section: no positions table, no notable list, no
  // concentration chart, and no holdings figure among the facts.
  await expect(page.locator("#holdings")).toHaveCount(0);
  await expect(page.locator(".rr-positions")).toHaveCount(0);
  await expect(page.locator(".rr-area__notes")).toHaveCount(0);
  await expect(page.locator(".rr-area__svg svg")).toHaveCount(0);
  await expect(page.locator(".rr-meta")).not.toContainText(/holdings/i);
  // Two snapshots would otherwise be enough to draw the chart, so this is a
  // gate firing rather than a fixture too thin to render.
  await expect(page.locator(".rr-meta")).toContainText("Sessions");

  // And the request is never made: a subject with no book has none to fetch.
  expect(snapshotsRequested).toBe(false);

  await expectNoBrowserErrors(errors);
});

// The subject IS the published allocation, so its page carries the weights in
// force, beside its latest recommendation and behind a disclosure: that
// recommendation already compares against the target its own session was
// handed. No other subject carries them.
test("the allocation subject carries the weights in force, and no other subject does", async ({ page }) => {
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
  const btn = page.locator('#latest button[aria-controls="targets-in-force"]');
  await expect(btn).toBeVisible();
  await expect(btn).toContainText("Since Jun 2, 2026");
  await expect(btn).toHaveAttribute("aria-expanded", "false");
  await btn.click();
  await expect(btn).toHaveAttribute("aria-expanded", "true");
  const card = page.locator("#targets-in-force");

  const rows = card.locator(".sv__sleeve");
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

  // Another weights subject reads the framework as the target its sessions
  // are measured against, and still carries no weights-in-force of its own:
  // the framework does not describe it.
  await page.goto("/swarm/subjects/robotmoney-vault");
  await expect(page.locator(".sv__detail-title")).toHaveText("Robot Money Vault");
  await expect(page.locator("#latest")).toBeVisible();
  await expect(page.locator("#targets-in-force")).toHaveCount(0);

  // A book subject is a book the framework does not describe at all: no
  // weights in force, and it never asks for them.
  frameworkFetches = 0;
  await page.goto("/swarm/subjects/woon");
  await expect(page.locator(".sv__detail-title")).toHaveText("Woon Treasury");
  await expect(page.locator("#latest")).toBeVisible();
  await expect(page.locator("#targets-in-force")).toHaveCount(0);
  expect(frameworkFetches).toBe(0);

  await expectNoBrowserErrors(errors);
});

// The heading has to stay true in both states. "Latest swarm recommendation"
// is right for weights a session published and wrong for the seeded row in
// force today — and the note under the weights says that no session has
// changed them. So the heading follows provenance, and it follows
// provenance.sessionId rather than the DTO's top-level `managed`, which is
// true today and is about the VAULT being managed.
test("the weights in force name who set them, and never overclaim", async ({ page }) => {
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
  const heading = page.locator('button[aria-controls="targets-in-force"] > span');
  await expect(heading).toHaveText("Target weights in force");
  await expect(page.locator("#targets-in-force")).toHaveAttribute("aria-label", "Target weights in force");
  await expect(page.locator("#targets-in-force")).toContainText("No session has changed these weights yet");

  // A session wrote them: now it IS the latest swarm recommendation.
  framework = { ...framework, provenance: { sessionId: "3f2b9c10-77aa-4d1e-9a3c-0b5e6f8d2c41" } };
  await page.goto("/swarm");
  await page.goto("/swarm/subjects/robotmoney-allocation");
  await expect(heading).toHaveText("Latest swarm recommendation");

  await expectNoBrowserErrors(errors);
});

// ── The latest session, and the brief it opened with (RM-121) ────────────
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

// The subject page leads with its latest session's reading and vote and one
// way into that session; the signal band and what the swarm was handed are
// the session's own evidence, and live on its page. Followed from here, so
// the handover this page used to carry is still checked end to end.
test("the latest recommendation carries its session's reading and vote, and its session carries what the swarm was handed", async ({ page }) => {
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
    if (u.pathname === `/api/swarm/sessions/${LR_ID}`) return json({ session: LR_ROW, takes: LR_TAKES });
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

  // The reading the latest session was given, in the facts row: the
  // session's own regime summary, not the brief's copy of it.
  const meta = page.locator(".rr-meta");
  await expect(meta.locator(".rr-meta__i", { hasText: "Composite" }).locator("b")).toHaveText("0.598");
  await expect(meta.locator(".rr-meta__i", { hasText: "Regime" }).locator("b")).toHaveText("risk-on");
  await expect(meta.locator('a[href="/allocation"]')).toBeVisible();

  // The vote: each stance counted, bearish to bullish, then who took part.
  const latest = page.locator("#latest");
  await expect(latest.locator(".rr-sec__aside")).toHaveText("Sep 10, 2026");
  const counts = latest.locator(".rr-counts");
  await expect(counts.locator(":scope > span > span")).toHaveText(["neutral", "constructive", "bullish"]);
  await expect(counts.locator(":scope > span > b")).toHaveText(["1", "3", "1"]);
  await expect(counts.locator("em")).toHaveText("5 of 7 took part · 64% mean confidence");

  // One way into the session, by its id.
  const cta = latest.locator(".rr-cta");
  await expect(cta).toHaveAttribute("href", `/swarm/sessions/${LR_ID}`);
  await cta.click();
  await expect(page).toHaveURL(new RegExp(`/swarm/sessions/${LR_ID}$`));

  // SIGNAL, on the session page: dots on one percentile axis.
  const signal = page.locator(".rr-context");
  await expect(signal.locator(".sig__l")).toHaveText(["Composite", "Macro", "On-chain", "Factor"]);
  await expect(signal.locator(".sig__v")).toHaveText(["83rd", "90th", "56th", "68th"]);
  await expect(signal.locator(".sig__row").first().locator(".sig__dot")).toHaveAttribute("style", /left:\s*83\.2%/);
  // On the published method factor is context, not an input, and is drawn so.
  await expect(signal.locator(".sig__row").nth(3)).toHaveClass(/is-context/);
  await expect(signal.locator(".rr-note")).toContainText("Factor is context");
  // This reading carries no cuts, and none are hard-coded in their place.
  await expect(signal.locator(".sig__zone")).toHaveCount(0);

  // WHAT THE SWARM WAS HANDED: closed, then a record of that brief's parts.
  const handBtn = page.locator('button[aria-controls="session-handover"]');
  await expect(handBtn).toHaveAttribute("aria-expanded", "false");
  await handBtn.click();
  const hand = page.locator("#session-handover");
  const keys = await hand.locator(".hand__row").evaluateAll((els) => els.map((e) => e.getAttribute("data-part")));
  expect(keys).toEqual(["instruction", "regime", "research", "recent", "notes", "returns"]);
  // The regime in the session page's own chips: every reading wears its dot,
  // the composite (a number) does not.
  const regime = hand.locator('[data-part="regime"] .sv__fact');
  await expect(regime.locator("em")).toHaveText(["composite", "regime", "macro", "on-chain"]);
  await expect(regime.locator("b")).toHaveText(["0.604", "risk-on", "risk-on", "neutral"]);
  await expect(regime.first().locator(".sv__fact-dot")).toHaveCount(0);
  await expect(regime.locator(".sv__fact-dot")).toHaveCount(3);
  // A recent session links to its session, by the dated address.
  const recent = hand.locator('[data-part="recent"] a.rr-lnk');
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

  // The hue the first sleeve wears in the weights in force on this page.
  const cardHue = await page.locator("#targets-in-force .sv__bucket-dot").first().getAttribute("style");
  expect(cardHue).toMatch(/background:/);

  // The latest archived session is 2026-06-24.
  const cta = page.locator("#latest .rr-cta");
  await expect(cta).toHaveAttribute("href", "/swarm/2026-06-24/robotmoney-allocation");
  await cta.click();
  await expect(page).toHaveURL(/\/swarm\/2026-06-24\/robotmoney-allocation$/);

  // Its composite averaged macro, on-chain AND factor, so saying "factor is
  // context" here would be wrong.
  const signal = page.locator(".rr-context");
  await expect(signal.locator(".sig__l")).toHaveText(["Composite", "Macro", "On-chain", "Factor"]);
  await expect(signal.locator(".sig__row").nth(3)).not.toHaveClass(/is-context/);
  await expect(signal.locator(".rr-note")).not.toContainText("Factor is context");

  // That brief carried the targets in force when it opened: drawn as the
  // subject page's register, each sleeve in the hue it wears there.
  await page.locator('button[aria-controls="session-handover"]').click();
  const hand = page.locator("#session-handover");
  const bars = hand.locator('[data-part="targets"] .sv__sleeve');
  await expect(bars.locator(".sv__sleeve-n")).toHaveText(["Conservative DeFi Yield", "Agent Tokens", "Protocol Tokens", "Real World Assets"]);
  await expect(bars.locator(".sv__sleeve-v")).toHaveText(["95%", "5%", "0%", "0%"]);
  await expect(bars.first().locator(".sv__sleeve-track i")).toHaveAttribute("style", /width:\s*95%/);
  await expect(bars.first().locator(".sv__bucket-dot")).toHaveAttribute("style", cardHue || "missing");
  // The archive's refs carry no subject; they are this subject's own sessions.
  await expect(hand.locator('[data-part="recent"] a.rr-lnk')).toHaveText(["Jun 21", "Jun 17", "Jun 13"]);
  await expect(hand.locator('[data-part="recent"] a.rr-lnk').first()).toHaveAttribute("href", "/swarm/2026-06-21/robotmoney-allocation");
  // A research item links when the site has a page for it, and the archive's
  // articles all do.
  await expect(hand.locator('[data-part="research"] .hand__links a').first()).toHaveAttribute("href", /^\//);

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
    if (u.pathname === `/api/swarm/sessions/${LR_ID}`) return json({ session: LR_ROW, takes: LR_TAKES });
    if (u.pathname === "/api/swarm/brief") {
      return json({ researchSignals: [{ signalKey: "channel-divergence" }, { signalKey: "made-up-signal" }] });
    }
    if (u.pathname === "/api/dashboards/allocation") return json({ asOf: "2026-06-02", strategy: [{ label: "Conservative DeFi Yield", targetPct: 95 }] });
    return json({}, 503);
  });
  await page.goto("/swarm/subjects/robotmoney-allocation");
  // Through the latest recommendation to the session the brief belongs to.
  await page.locator("#latest .rr-cta").click();
  await expect(page).toHaveURL(new RegExp(`/swarm/sessions/${LR_ID}$`));
  await page.locator('button[aria-controls="session-handover"]').click();
  const hand = page.locator("#session-handover");
  await expect(hand.locator('[data-part="research"] .hand__links a')).toHaveText(["Channel Divergence"]);
  await expect(hand.locator('[data-part="research"] .hand__links li > span')).toHaveText(["Made up signal"]);
  await expectNoBrowserErrors(errors);
});
