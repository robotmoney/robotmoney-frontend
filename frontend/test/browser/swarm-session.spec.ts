import { expect, test, type Page } from "@playwright/test";

// Issue #498 — browser coverage for the session-page data defects the v0
// archive backport exposed. The first two were previously proven only by an
// ad-hoc headless sweep over the imported archive; a sweep is not a CI check,
// so the behaviours are pinned here as executed assertions. DEFECTS 3 and 4
// come from the review-data-integrity pass on this PR (F2 and F4) — both are
// about a true value being rendered as a claim it does not support.
//
// DEFECT 1 — the target was missing. `bucket_weights` sessions drew
// "Recommended" alone: a session proposing 97/3 against a published 95/5
// target rendered as two bars with nothing to compare them to, so a reader
// could not see it deviated at all. The framework lives in
// /api/dashboards/allocation and the session view never fetched it.
//
// DEFECT 2 — five real sessions rendered "Session not found". The view carried
// two hardcoded archive boundaries that disagreed (archivePreferred() said
// "< 2026-07-01", the static archive ends at ARCHIVE_LAST_DATE = 2026-06-25),
// and the catch block deliberately did NOT retry the API for an
// archive-preferred date. Every date now goes to the API first and the static
// archive is a fallback, so 2026-06-26..06-30 — dates the database holds and
// the archive does not — reach their session.
//
// DEFECT 3 — every archived take was described as a failed signature check.
// `verified: false` had exactly one wording behind it ("this take's signature
// did not check out … treat it as unattributed"), and the 216 backported takes
// were never member-signed at all, so nothing was ever checked. Archival is now
// its own state, and both wordings are asserted below.
//
// DEFECT 4 — historical sessions were graded against today's target.
// /api/dashboards/allocation serves the single CURRENT framework row, so a
// 2026-05-25 session was being flagged "⚠ deviates from target" against a
// target published 2026-06-02 — and an admin edit rewrote that verdict
// retroactively.
//
// WHY THE API IS MOCKED. These are assertions about the RENDER, not about what
// the smoke stack happens to have seeded: the exact bucket weights and the
// published allocation framework of a live session are not a stable thing to
// assert numbers against, and a session's takes are written by live inference.
// Each test therefore serves the session, the roster and the framework itself
// and asserts the shipped Alpine view (static-views.js's swarmSessionDetail) draws
// them. Everything else — the SPA shell, /config.js, the static-archive JSON
// under /data/swarm/** — is served by the real backend at baseURL, which is
// why this spec lives in the `e2e` workflow's `test:browser` step (the whole
// frontend/test/browser/ directory) and not in the standalone `frontend`
// workflow, exactly like swarm-index.spec.ts and swarm-subject.spec.ts.

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const notFound = { status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) };

const MEMBERS = {
  members: [
    { id: "athena", status: "active", name: "Athena", lens: "macro" },
    { id: "draco", status: "active", name: "Draco", lens: "risk" },
    { id: "vesta", status: "active", name: "Vesta", lens: "yield" },
  ],
};

// Shaped like the API's session-detail takes (snake_case, real take ids, and
// verified:false + archival:true — which is exactly what the v0 archival import
// produces: the takes were published before member key registration existed, so
// they were never member-signed and their signing key is deliberately not in
// swarm_member_keys).
const TAKES = [
  { id: "take-athena", member_id: "athena", member_name: "Athena", stance: "hold", confidence: 0.7, body: "ARCHIVE IMPORT MARKER — athena take body.", verified: false, archival: true },
  { id: "take-draco", member_id: "draco", member_name: "Draco", stance: "trim", confidence: 0.55, body: "ARCHIVE IMPORT MARKER — draco take body.", verified: false, archival: true },
  { id: "take-vesta", member_id: "vesta", member_name: "Vesta", stance: "hold", confidence: 0.6, body: "ARCHIVE IMPORT MARKER — vesta take body.", verified: false, archival: true },
];

// A LIVE member submission whose signature genuinely failed to verify. Same
// verified:false as the archive rows above, and a completely different claim
// about why — which is the distinction this spec exists to pin.
const FAILED_TAKES = [
  { id: "take-athena", member_id: "athena", member_name: "Athena", stance: "hold", confidence: 0.7, body: "LIVE SUBMISSION MARKER — athena take body.", verified: false, archival: false },
];

// Issue #593 — a RENAMED member. `handle` is the public URL segment; `id` is
// the immutable name the take was signed under and is deliberately never
// rewritten, so after a rename the two differ. Every other roster fixture in
// this file (and in swarm-index.spec.ts) has an implicit handle equal to its
// id, which is exactly why camelMember/camelTake could drop the two fields
// entirely and still ship green: only the fallback branch was ever exercised.
// Draco is kept unrenamed here so both branches render in one page.
const RENAMED_MEMBERS = {
  members: [
    { id: "athena", handle: "macro-desk", status: "active", name: "Athena", lens: "macro" },
    { id: "draco", handle: "draco", status: "active", name: "Draco", lens: "risk" },
  ],
};

// Issue #598 — the SAME renamed member, now DEACTIVATED. `GET /api/swarm/members`
// serves the ACTIVE roster and nothing else (backend/src/swarm/domain.ts:
// `SELECT * FROM swarm_members WHERE status = 'active'`), so a deactivated
// member is not served with `status: "inactive"` — it is ABSENT from the
// payload, which is what this fixture reproduces. Draco stays active and
// unrenamed so the untouched path renders in the same page. This is the fixture
// the tree did not have: every earlier roster fixture holds every member the
// session's takes were written by, so the roster-only link path always found
// its member and the divergence could not appear.
const DEACTIVATED_ROSTER = {
  members: [
    { id: "draco", handle: "draco", status: "active", name: "Draco", lens: "risk" },
  ],
};

// Shaped like the API's session-detail takes after migration 0030: the signed
// `member_id` is untouched and `member_handle` rides beside it
// (backend/src/swarm/projections.ts). Deactivating the member does NOT strip it:
// domain.ts's withTakes joins swarm_members with no status filter, so the take
// of a deactivated author keeps carrying that author's current public handle —
// which is why the page can still resolve one when the roster has dropped it.
const RENAMED_TAKES = [
  { id: "take-athena", member_id: "athena", member_handle: "macro-desk", member_name: "Athena", stance: "hold", confidence: 0.7, body: "RENAME MARKER — athena take body.", verified: true, archival: false },
  { id: "take-draco", member_id: "draco", member_handle: "draco", member_name: "Draco", stance: "trim", confidence: 0.55, body: "RENAME MARKER — draco take body.", verified: true, archival: false },
];

// The published framework /api/dashboards/allocation serves. Note the spelling:
// "Conservative DeFi Yield" has an inner capital that humanize() of the bucket
// id `conservative_defi_yield` cannot reproduce — the two sides are matched on
// letters-and-digits only, and the framework's own spelling is what renders.
const ALLOCATION = {
  // The framework is a SINGLE CURRENT row with no history, so `asOf` is the
  // only handle a reader has on when the target being drawn was set. 2026-06-02
  // is the seeded value, which postdates the earliest archived sessions.
  asOf: "2026-06-02",
  strategy: [
    { label: "Conservative DeFi Yield", targetPct: 95 },
    { label: "Directional Crypto", targetPct: 5 },
    { label: "Opportunistic", targetPct: 0 },
    { label: "Cash", targetPct: 0 },
  ],
};

function bucketSession(date: string, weights: Record<string, number> | Array<{ bucket: string; weight: number }>, subjectId = "robotmoney-allocation", subjectName = "Robot Money Allocation") {
  return {
    id: `${date}-${subjectId}`,
    date,
    subject_id: subjectId,
    subject_name: subjectName,
    state: "published",
    swarm_recommendation: {
      type: "bucket_weights",
      weights,
      quorum: { active: 3, submitted: 3, absent: 0, participation: 1 },
      stances: { hold: 2, trim: 1 },
      meanConfidence: 0.62,
      absent: [],
      consensus: [],
      disagreements: [],
    },
    generated_at: `${date}T11:00:00Z`,
  };
}

function positionSession(date: string, subjectId: string, subjectName: string) {
  return {
    id: `${date}-${subjectId}`,
    date,
    subject_id: subjectId,
    subject_name: subjectName,
    state: "published",
    swarm_recommendation: {
      type: "position_actions",
      quorum: { active: 3, submitted: 3, absent: 0, participation: 1 },
      stances: { hold: 2, trim: 1 },
      meanConfidence: 0.62,
      absent: [],
      consensus: [],
      disagreements: [],
      actions: [],
    },
    generated_at: `${date}T11:00:00Z`,
  };
}

// A session whose Disagreements panel quotes both members. Those positions
// carry ONLY the signed `member_id` — the payload has no handle in it anywhere —
// which is what makes the panel the second, independent link path that the two
// rename tests below compare against the take byline. Shared by both so they
// differ in exactly one thing: whether the renamed member is still on the
// active roster.
//
// v0-shaped (no quorum, no stance tally): a written disagreement exists only on
// v0 sessions and judged ones. A live aggregate's is a template over figures the
// record already draws, and the page does not print it.
function disagreementSession(date: string, subjectId: string, subjectName: string) {
  const base = positionSession(date, subjectId, subjectName);
  const { quorum: _q, stances: _s, ...authored } = base.swarm_recommendation;
  return {
    ...base,
    swarm_recommendation: {
      ...authored,
      disagreements: [
        {
          topic: "duration risk",
          positions: [
            { member_id: "athena", view: "The long end is where this breaks." },
            { member_id: "draco", view: "Trim the tail first." },
          ],
        },
      ],
    },
  };
}

// Serves exactly three things — the roster, the session detail, and (when
// asked) the allocation framework. Every other /api/swarm/** call 404s, which
// is the guarded-side-fetch path the view already tolerates. Non-/api requests
// (the SPA shell, /config.js, /data/swarm/** archive JSON) are left alone so
// the real static-archive fallback is reachable — the point of the
// "not found" test below.
async function mockSessionApi(
  page: Page,
  opts: { session: unknown; takes?: unknown[]; allocation?: unknown | null; snapshots?: unknown[]; members?: unknown },
): Promise<void> {
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/swarm/members") return route.fulfill(json(opts.members ?? MEMBERS));
    if (/^\/api\/swarm\/sessions\/\d{4}-\d{2}-\d{2}\/[^/]+$/.test(pathname)) {
      return route.fulfill(json({ session: opts.session, takes: opts.takes ?? TAKES }));
    }
    if (pathname === "/api/dashboards/allocation") {
      return opts.allocation ? route.fulfill(json(opts.allocation)) : route.fulfill(notFound);
    }
    // The subject's snapshots, which are what "actual" is derived from — a
    // bucket's share of NAV is summed from the positions the framework assigns
    // to it. Left 404ing unless a test supplies them, matching the guarded
    // side-fetch every other case here relies on.
    if (opts.snapshots && /\/snapshots$/.test(pathname)) {
      return route.fulfill(json({ snapshots: opts.snapshots }));
    }
    if (pathname.startsWith("/api/swarm/")) return route.fulfill(notFound);
    return route.continue();
  });
}

// The record's first section is the recommendation: the mix as a ring whose
// legend carries each sleeve's move, the decision in one line beside it, and,
// when it holds a figure the legend does not (the target beside the book, or a
// target that postdates the session), the full comparison behind a
// disclosure. A move is written the way
// /allocation writes one (lib/weight-change.js): +2 pp / −2 pp, "—" when
// flat.
const outcome = (page: Page) => page.locator("#recommendation");
// The decision in one line, only where the legend cannot state it: that no
// sleeve moved. Absent when there is no fair basis to state it on, and when
// the legend's rows already carry the moves.
const headline = (page: Page) => outcome(page).locator("p.rr-k.rr-sub");
const legendRow = (page: Page, name: string) => outcome(page).locator(".rr-legend__row").filter({ hasText: name });
// The legend rows that state a move, as a reader counts them.
const movedRows = (page: Page) => outcome(page).locator(".rr-legend__row").filter({ has: page.locator(".alp__mv.up, .alp__mv.down") });
const register = (page: Page) => outcome(page).locator(".sr__ledger table");
const registerHead = (page: Page) => register(page).locator("thead");
const registerRow = (page: Page, name: string) => register(page).locator("tbody tr").filter({ hasText: name });
// Which target the figures are measured against, and when it was published:
// the Evidence row, now that no caption under the ring restates it.
const targetRow = (page: Page) => page.locator("#evidence .rr-dl > div").filter({ has: page.locator("dt", { hasText: "Target" }) }).locator("dd");

// The full comparison is closed until asked for, as a reader finds it.
async function openRegister(page: Page): Promise<void> {
  const toggle = outcome(page).getByRole("button", { name: "Full comparison" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

test("bucket_weights session draws the target from the allocation framework and states the change", async ({ page }) => {
  // 97/3/0/0 recommended against the published 95/5/0/0 target — the exact
  // figures /swarm/2026-08-03/robotmoney-allocation carries, and the case that
  // rendered as bare "Recommended" bars before the framework was wired in.
  await mockSessionApi(page, {
    session: bucketSession("2026-08-03", {
      conservative_defi_yield: 0.97,
      directional_crypto: 0.03,
      opportunistic: 0,
      cash: 0,
    }),
    allocation: ALLOCATION,
  });

  await page.goto("/swarm/2026-08-03/robotmoney-allocation");

  await expect(page.locator(".sv__error")).toBeHidden();
  await expect(page.locator(".sv__detail-title")).toHaveText("Robot Money Allocation");

  // The legend states each sleeve's move and what it is measured against.
  await expect(legendRow(page, "Fixed Income")).toContainText("97%");
  await expect(legendRow(page, "Fixed Income").locator(".rr-legend__was")).toHaveText("Target 95%");
  await expect(legendRow(page, "Fixed Income").locator(".alp__mv")).toHaveText("+2 pp");

  // One basis: the legend is the whole comparison.
  await expect(outcome(page).getByRole("button", { name: "Full comparison" })).toHaveCount(0);
  await expect(legendRow(page, "Directional Crypto")).toContainText("3%");
  await expect(legendRow(page, "Directional Crypto").locator(".rr-legend__was")).toHaveText("Target 5%");
  // The framework's own spelling wins over humanize("conservative_defi_yield"),
  // which cannot recover DeFi's inner capital.
  await expect(outcome(page).locator(".rr-legend")).toContainText("Fixed Income");
  await expect(outcome(page).locator(".rr-legend")).not.toContainText("Conservative Defi Yield");
  await expect(legendRow(page, "Fixed Income").locator(".alp__mv")).toHaveClass(/\bup\b/);

  // The finding is the legend's two moved rows; no line beside the mix
  // counts them again.
  await expect(movedRows(page)).toHaveCount(2);
  await expect(headline(page)).toHaveCount(0);
});

test("bucket_weights session that matches its target says so once, and no sleeve restates it", async ({ page }) => {
  await mockSessionApi(page, {
    session: bucketSession("2026-06-05", {
      conservative_defi_yield: 0.95,
      directional_crypto: 0.05,
      opportunistic: 0,
      cash: 0,
    }),
    allocation: ALLOCATION,
  });

  await page.goto("/swarm/2026-06-05/robotmoney-allocation");

  await expect(page.locator(".sv__error")).toBeHidden();
  // Same target, same recommendation: the one thing the legend cannot show
  // is that nothing moved, so the headline says it.
  await expect(headline(page)).toHaveText("Target weights retained");
  // …and the legend agrees without restating it: a sleeve that did not move
  // prints its weight alone, not "— vs target 95%" beside "95%".
  await expect(legendRow(page, "Fixed Income").locator("b")).toHaveText("95%");
  await expect(outcome(page).locator(".rr-legend .alp__mv")).toHaveCount(0);
  await expect(outcome(page).locator(".rr-legend__d .alp__mv")).toHaveCount(0);
  await expect(outcome(page).getByRole("button", { name: "Full comparison" })).toHaveCount(0);
});

// "Actual" is the only figure on this panel that is DERIVED rather than
// published: the framework manifest says which tokens constitute each bucket,
// and the day's snapshot says what the book holds, so a bucket's actual weight
// is its tokens' share of NAV. Before this, `actual` was hardcoded null on the
// weights path and the column never rendered on any session — the panel showed
// four proposed numbers with nothing to measure them against.
test("bucket_weights session derives Actual from the snapshot and measures the gap against it", async ({ page }) => {
  // The vault holds a book, so its session measures the recommendation against
  // where that book sits. (A framework subject has none: see the next test.)
  await mockSessionApi(page, {
    // Recommended 97/3 against a book sitting entirely in Conservative DeFi.
    session: bucketSession("2026-08-03", {
      conservative_defi_yield: 0.97,
      agent_tokens: 0.03,
      protocol_tokens: 0,
      real_world_assets: 0,
    }, "robotmoney-vault", "Robot Money Vault"),
    allocation: ALLOCATION,
    // AAVE/COMPOUND/MORPHO are all conservative_defi_yield tokens in the
    // committed manifest, so actual must come out 100/0/0/0 — and the gap must
    // flip to being measured against actual, not target.
    snapshots: [{
      date: "2026-08-03",
      total_value_usd: 150,
      positions: [
        { token: "AAVE", chain: "base", value_usd: 50 },
        { token: "COMPOUND", chain: "base", value_usd: 50 },
        { token: "MORPHO", chain: "base", value_usd: 50 },
      ],
    }],
  });

  await page.goto("/swarm/2026-08-03/robotmoney-vault");

  await expect(page.locator(".sv__error")).toBeHidden();
  // Basis flips to actual the moment we know it: recommended-minus-actual is
  // the MOVE being asked for, which is the question a reader has. The legend
  // states both moves against the book; no headline counts them again.
  await expect(movedRows(page)).toHaveCount(2);
  await expect(headline(page)).toHaveCount(0);
  await expect(legendRow(page, "Fixed Income").locator(".rr-legend__was")).toHaveText("Actual 100%");
  // The book is the session's own day's, so the aside states its total alone.
  await expect(page.locator("#holdings .rr-sec__aside")).toHaveText("$150");
  await openRegister(page);
  await expect(registerHead(page)).toContainText(/actual/i, { useInnerText: true });
  const conservative = registerRow(page, "Fixed Income");
  await expect(conservative).toContainText("100%");
  // 97 recommended − 100 actual = trim 3 points.
  await expect(conservative.locator(".alp__mv")).toHaveText("−3 pp");
  const agent = registerRow(page, "Small Cap Tokens");
  // 3 recommended − 0 actual = add 3. A bucket whose tokens are simply absent
  // from the book reads 0%, which is true — not "—", which would claim we do
  // not know.
  await expect(agent).toContainText("0%");
  await expect(agent.locator(".alp__mv")).toHaveText("+3 pp");
  // The book is on the page too, in the subject page's positions table.
  await expect(page.locator("#holdings .rr-sec__h")).toHaveText("Holdings");
  await expect(page.locator("#holdings .rr-positions tbody tr")).toHaveCount(3);
});

// A book from another day is the one case the date says something the header
// does not: pickSnapshotFor falls back to the latest snapshot before the session.
test("a book read on an earlier day than its session is dated in the Holdings aside", async ({ page }) => {
  await mockSessionApi(page, {
    session: bucketSession("2026-08-03", {
      conservative_defi_yield: 0.97,
      agent_tokens: 0.03,
      protocol_tokens: 0,
      real_world_assets: 0,
    }, "robotmoney-vault", "Robot Money Vault"),
    allocation: ALLOCATION,
    snapshots: [{
      date: "2026-08-02",
      total_value_usd: 150,
      positions: [
        { token: "AAVE", chain: "base", value_usd: 50 },
        { token: "COMPOUND", chain: "base", value_usd: 50 },
        { token: "MORPHO", chain: "base", value_usd: 50 },
      ],
    }],
  });

  await page.goto("/swarm/2026-08-03/robotmoney-vault");

  await expect(page.locator(".sv__error")).toBeHidden();
  await expect(page.locator("#holdings .rr-sec__aside")).toHaveText("$150 · Aug 2, 2026");
});

// The book is what the session acted on, so only a book read on or before its
// date is measured against, and a move from the book never reads the target:
// a published target that postdates the session withholds a move from target,
// not one from the book. The subject page's latest recommendation reads the
// book through the same helper (bookSleeveShares).
test("a move from the book is measured on a book read by the session's date, whatever the target's date", async ({ page }) => {
  const book = (date: string) => ({
    date,
    total_value_usd: 150,
    positions: [
      { token: "AAVE", chain: "base", value_usd: 50 },
      { token: "COMPOUND", chain: "base", value_usd: 50 },
      { token: "MORPHO", chain: "base", value_usd: 50 },
    ],
  });
  const weights = { conservative_defi_yield: 0.97, agent_tokens: 0.03, protocol_tokens: 0, real_world_assets: 0 };

  // 2026-05-30 predates ALLOCATION.asOf (2026-06-02): no move from target,
  // but the book it read that day still gives one.
  await mockSessionApi(page, {
    session: bucketSession("2026-05-30", weights, "robotmoney-vault", "Robot Money Vault"),
    allocation: ALLOCATION,
    snapshots: [book("2026-05-30")],
  });
  await page.goto("/swarm/2026-05-30/robotmoney-vault");
  await expect(page.locator(".sv__error")).toBeHidden();
  await expect(movedRows(page)).toHaveCount(2);
  await expect(headline(page)).toHaveCount(0);
  await expect(legendRow(page, "Fixed Income").locator(".rr-legend__was")).toHaveText("Actual 100%");
  await expect(legendRow(page, "Fixed Income").locator(".alp__mv")).toHaveText("−3 pp");

  // The only book is read two days after the session: it is not what the
  // session acted on, so the move reads from the target instead.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mockSessionApi(page, {
    session: bucketSession("2026-08-03", weights, "robotmoney-vault", "Robot Money Vault"),
    allocation: ALLOCATION,
    snapshots: [book("2026-08-05")],
  });
  await page.goto("/swarm/2026-08-03/robotmoney-vault");
  await expect(page.locator(".sv__error")).toBeHidden();
  await expect(movedRows(page)).toHaveCount(2);
  await expect(headline(page)).toHaveCount(0);
  await expect(legendRow(page, "Fixed Income").locator(".rr-legend__was")).toHaveText("Target 95%");
  await expect(outcome(page).locator(".rr-legend__head")).not.toContainText("Book");
});

// The allocation subject IS the framework: it holds nothing. The release smoke
// writes a fake basket into swarm_subject_snapshots for every subject that is
// not woon or mav, and this page drew it as the subject's "Portfolio read" and
// measured the swarm's recommendation against it.
test("a framework session renders no book, even when the API serves one, and measures against the target", async ({ page }) => {
  await mockSessionApi(page, {
    session: bucketSession("2026-08-03", { conservative_defi_yield: 0.97, agent_tokens: 0.03, protocol_tokens: 0, real_world_assets: 0 }),
    allocation: ALLOCATION,
    snapshots: [{
      date: "2026-08-03",
      total_value_usd: 42687.7,
      positions: [
        { token: "ROBOT", chain: "base", value_usd: 21343.85 },
        { token: "ETH", chain: "base", value_usd: 11953 },
      ],
    }],
  });

  await page.goto("/swarm/2026-08-03/robotmoney-allocation");

  await expect(page.locator(".sv__error")).toBeHidden();
  await expect(legendRow(page, "Small Cap Tokens").locator(".rr-legend__was")).toHaveText("Target 5%");
  await expect(page.locator("#holdings")).toHaveCount(0);
  await expect(page.locator(".rr-positions")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("$42,688");
  await expect(legendRow(page, "Small Cap Tokens").locator(".alp__mv")).toHaveText("−2 pp");
  // A leaked book would add an Actual column beside the target and open the
  // full comparison; with the target alone there is none.
  await expect(outcome(page).getByRole("button", { name: "Full comparison" })).toHaveCount(0);
  await expect(outcome(page).locator(".rr-legend__head")).not.toContainText("Book");
});

// The live aggregator publishes `weights` as [{bucket, weight}] (the contract's
// SwarmBucketWeight[]); the v0 archive published a map. Read as a map, the
// array's indexes came out as four sleeves named "0" to "3", every one at 0%.
test("a live bucket_weights session published as an array reads the same as the map", async ({ page }) => {
  await mockSessionApi(page, {
    session: bucketSession("2026-09-12", [
      { bucket: "conservative_defi_yield", weight: 0.93 },
      { bucket: "agent_tokens", weight: 0.07 },
      { bucket: "protocol_tokens", weight: 0 },
      { bucket: "real_world_assets", weight: 0 },
    ]),
    allocation: {
      asOf: "2026-06-02",
      strategy: [
        { label: "Conservative DeFi Yield", targetPct: 95 },
        { label: "Agent Tokens", targetPct: 5 },
        { label: "Protocol Tokens", targetPct: 0 },
        { label: "Real World Assets", targetPct: 0 },
      ],
    },
  });

  await page.goto("/swarm/2026-09-12/robotmoney-allocation");

  await expect(page.locator(".sv__error")).toBeHidden();
  // Auto-waiting: the rows land after init resolves.
  await expect(outcome(page).locator(".rr-legend__row .rr-legend__l")).toHaveText(["Fixed Income", "Small Cap Tokens", "Protocol Tokens", "Real World Assets"]);
  await expect(legendRow(page, "Small Cap Tokens").locator("b")).toHaveText("7%");
  await expect(legendRow(page, "Small Cap Tokens").locator(".rr-legend__was")).toHaveText("Target 5%");
  await expect(legendRow(page, "Small Cap Tokens").locator(".alp__mv")).toHaveText("+2 pp");
  await expect(outcome(page).getByRole("button", { name: "Full comparison" })).toHaveCount(0);
  // The ring the session cards draw, from the same weights.
  await expect(outcome(page).locator(".sv__wdonut-host")).toHaveAttribute("aria-label", /Small Cap Tokens 7%/);
});

test("bucket_weights session degrades to Recommended-only when the framework is unavailable", async ({ page }) => {
  await mockSessionApi(page, {
    session: bucketSession("2026-08-03", { conservative_defi_yield: 0.97, directional_crypto: 0.03 }),
    allocation: null, // /api/dashboards/allocation 404s
  });
  // There are now TWO sources for a target: the dashboard endpoint above and
  // the committed framework manifest, which is what lets a backendless checkout
  // still draw one. 404ing only the endpoint no longer produces the
  // no-framework state this test exists to cover, so block both — otherwise the
  // test silently stops testing degradation and passes on the fallback.
  await page.route("**/data/swarm/manifests/allocation.json", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));

  await page.goto("/swarm/2026-08-03/robotmoney-allocation");

  // A missing framework degrades the outcome, never the page.
  await expect(page.locator(".sv__error")).toBeHidden();
  await expect(legendRow(page, "Fixed Income").locator("b")).toHaveText("97%");
  await expect(legendRow(page, "Directional Crypto").locator("b")).toHaveText("3%");
  // Recommended alone: the ring names its whole as the recommendation and the
  // legend compares it with nothing, which is the whole claim of this test.
  await expect(outcome(page).locator(".rr-ring figcaption")).toContainText("Recommended");
  // A mix is the whole allocation by definition: the centre names the ring
  // and prints no "100%".
  await expect(outcome(page).locator(".rr-ring figcaption")).not.toContainText("100%");
  await expect(outcome(page).locator(".rr-legend")).not.toContainText(/target|book|actual/i, { useInnerText: true });
  await expect(targetRow(page)).toHaveText("Not recorded");
  // With no basis to measure against, there is no move to state and no
  // comparison to open, rather than a row of em-dashes under a verdict.
  await expect(headline(page)).toHaveCount(0);
  await expect(outcome(page).locator(".alp__mv")).toHaveCount(0);
  await expect(outcome(page).locator(".sr__ledger")).toHaveCount(0);
  await expect(outcome(page).getByRole("button", { name: "Full comparison" })).toHaveCount(0);
});

// 2026-06-26 … 06-30: after ARCHIVE_LAST_DATE (2026-06-25) and before the old
// hardcoded 2026-07-01 archive-preference boundary. The static archive under
// /data/swarm/sessions/ genuinely carries no file for these dates — those
// requests are NOT mocked here, so they 404 against the real backend exactly
// as they do in production. Before the fix the view routed the date to the
// archive, missed, and rethrew instead of retrying the API: "Session not
// found" for a session the API answered 200 for.
for (const [date, subjectId, subjectName] of [
  ["2026-06-26", "robotmoney-vault", "Robot Money Vault"],
  ["2026-06-30", "robotmoney-vault", "Robot Money Vault"],
] as const) {
  test(`session on ${date} — past the static archive's last date — renders its takes, not "Session not found"`, async ({ page }) => {
    await mockSessionApi(page, { session: positionSession(date, subjectId, subjectName), allocation: ALLOCATION });

    await page.goto(`/swarm/${date}/${subjectId}`);

    await expect(page.locator(".sv__detail-title")).toHaveText(subjectName);
    await expect(page.locator(".sv__error")).toBeHidden();
    await expect(page.locator(".rr-take")).toHaveCount(3);
    await expect(page.locator(".rr-take .sv__take-body").first()).toContainText("ARCHIVE IMPORT MARKER");
    // Takes imported from the v0 archive are ARCHIVED, not unverified: the
    // page must not claim a verification it cannot make, and must not claim a
    // signature check that never happened either.
    await expect(page.locator("[data-verified-badge]").first()).toHaveAttribute("data-verified-state", /archived/i);
  });
}

// review-data-integrity F2. verified:false carried one sentence — "This take's
// signature did not check out against the member's public key. Treat it as
// unattributed." — and the archive backport routed 216 takes that were never
// member-signed straight into it. The badge STATE was already asserted above;
// the state was never the wrong part. The copy was. Both cases are asserted
// here, in the same render, because the bug is that one wording served two
// incompatible meanings.
test("an archival take is labelled archived and never described as a failed signature check", async ({ page }) => {
  await mockSessionApi(page, { session: positionSession("2026-06-26", "robotmoney-vault", "Robot Money Vault"), allocation: ALLOCATION });

  await page.goto("/swarm/2026-06-26/robotmoney-vault");

  const badge = page.locator("[data-verified-badge]").first();
  await expect(badge).toHaveAttribute("data-verified-state", "archived");
  // aria-label carries the full sentence, so this is the text a screen-reader
  // user is actually given — not a hover-only tooltip.
  const label = await badge.getAttribute("aria-label");
  expect(label).toContain("filed before members signed");
  expect(label).toContain("pre-launch record");
  expect(label).not.toContain("did not check out");
  expect(label).not.toContain("unattributed");
  // The visible tooltip says the same thing as the aria-label.
  await expect(page.locator(".sv__vfy-tip").first()).toContainText("filed before members signed");
  // And it is not styled as a failure.
  await expect(badge).toHaveClass(/sv__vfy--arch/);
  await expect(badge).not.toHaveClass(/sv__vfy--bad/);
});

test("a live submission whose signature failed still gets the failed-check wording", async ({ page }) => {
  await mockSessionApi(page, {
    session: positionSession("2026-06-26", "robotmoney-vault", "Robot Money Vault"),
    takes: FAILED_TAKES,
    allocation: ALLOCATION,
  });

  await page.goto("/swarm/2026-06-26/robotmoney-vault");

  const badge = page.locator("[data-verified-badge]").first();
  await expect(badge).toHaveAttribute("data-verified-state", "unverified");
  const label = await badge.getAttribute("aria-label");
  expect(label).toContain("did not check out");
  expect(label).not.toContain("unattributed");
  await expect(badge).toHaveClass(/sv__vfy--bad/);
  await expect(badge).not.toHaveClass(/sv__vfy--arch/);
});

// The session page never probes for a consensus receipt. No route says
// whether a receipt exists without answering 404, and a published weights
// session has none until it is published; the probe logged a failed request on
// every such page, and the full-stack smoke fails on any. The status belongs on
// the session payload, and the page shows none until the API carries it.
test("a session page asks for no consensus receipt, whatever the session", async ({ page }) => {
  const receiptAsks: string[] = [];
  page.on("request", (req) => { if (new URL(req.url()).pathname.includes("/consensus-receipt")) receiptAsks.push(req.url()); });

  await mockSessionApi(page, { session: positionSession("2026-06-26", "woon", "Woon Treasury"), allocation: ALLOCATION });
  await page.goto("/swarm/2026-06-26/woon");
  await expect(page.locator(".rr-take").first()).toBeVisible();

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mockSessionApi(page, { session: bucketSession("2026-06-26", { conservative_defi_yield: 0.95, agent_tokens: 0.05, protocol_tokens: 0, real_world_assets: 0 }), allocation: ALLOCATION });
  await page.goto("/swarm/2026-06-26/robotmoney-allocation");
  await expect(page.locator("#evidence")).toBeVisible();

  expect(receiptAsks).toEqual([]);
  await expect(page.locator("#evidence .rr-dl dt").filter({ hasText: "Consensus receipt" })).toHaveCount(0);
});

// A member can attach a memo to its take. The shared take card (RM-121)
// dropped the link, and no archived take has a memo, so the static preview
// never showed the loss. Member supplied, so only a web address is linked.
test("a take's memo is linked from its card, and only when it is a web address", async ({ page }) => {
  await mockSessionApi(page, {
    session: positionSession("2026-06-26", "robotmoney-vault", "Robot Money Vault"),
    takes: [
      { ...FAILED_TAKES[0], memo_url: "https://example.org/athena-memo" },
      { id: "take-draco", member_id: "draco", member_name: "Draco", stance: "hold", confidence: 0.6, body: "Draco take body.", verified: false, archival: false, memo_url: "javascript:alert(1)" },
    ],
    allocation: ALLOCATION,
  });

  await page.goto("/swarm/2026-06-26/robotmoney-vault");

  const memos = page.locator("#takes .rr-take a.sv__memo-link");
  await expect(memos).toHaveCount(1);
  await expect(memos).toHaveText("Read memo");
  await expect(memos).toHaveAttribute("href", "https://example.org/athena-memo");
  await expect(memos).toHaveAttribute("rel", /noopener/);
  await expect(page.locator('#takes a[href^="javascript:"]')).toHaveCount(0);
});

// An open session, reached from /swarm's live strip ("See full session"),
// states what the strip states: the takes filed out of the roster, and when
// the window closes. The takes so far are not the vote, so no consensus is
// drawn until the session publishes.
test("an open session states its takes filed out of the roster and when its window closes, and no consensus yet", async ({ page }) => {
  const closes = new Date(Date.now() + 200 * 60_000 + 30_000).toISOString();
  const open = { ...positionSession("2026-06-26", "robotmoney-vault", "Robot Money Vault"), state: "collecting", window_closes_at: closes, swarm_recommendation: null };
  const onScale = TAKES.map((t, i) => ({ ...t, stance: ["cautious", "neutral", "cautious"][i], archival: false }));
  await mockSessionApi(page, { session: open, takes: onScale.slice(0, 2), allocation: ALLOCATION });
  await page.goto("/swarm/2026-06-26/robotmoney-vault");

  const meta = page.locator(".rr-meta").first();
  await expect(meta).toContainText("Takes 2 of 3");
  await expect(meta).toContainText("Window closes in 3h 20m");
  await expect(page.locator(".rr-vote")).toBeVisible();
  await expect(page.locator(".rr-vote__sum")).not.toContainText("Consensus");

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mockSessionApi(page, { session: positionSession("2026-06-26", "robotmoney-vault", "Robot Money Vault"), takes: onScale, allocation: ALLOCATION });
  await page.goto("/swarm/2026-06-26/robotmoney-vault");
  await expect(page.locator(".rr-vote__sum")).toContainText("Consensus");
  await expect(page.locator(".rr-meta").first()).toContainText("Takes 3");
  await expect(page.locator(".rr-meta").first()).not.toContainText("of 3");
  await expect(page.locator(".rr-meta").first()).not.toContainText("Window");
});

// review-data-integrity F4. /api/dashboards/allocation serves the single
// CURRENT allocation_framework row, and it is admin-editable. Joining a
// historical session against it measures the swarm against a target that did
// not exist yet, and lets an edit today silently rewrite yesterday's verdict.
// The target still draws in the full comparison — it is informative — but
// the decision is withheld and the Evidence row dates the target after the session.
test("a session that predates the published framework draws the target for reference and withholds the verdict", async ({ page }) => {
  // 2026-05-25 is the archive's first session; ALLOCATION.asOf is 2026-06-02.
  await mockSessionApi(page, {
    session: bucketSession("2026-05-25", { conservative_defi_yield: 0.97, directional_crypto: 0.03 }),
    allocation: ALLOCATION,
  });

  await page.goto("/swarm/2026-05-25/robotmoney-allocation");

  await expect(page.locator(".sv__error")).toBeHidden();
  await openRegister(page);
  await expect(register(page)).toContainText("95%");
  await expect(register(page)).toContainText("97%");
  await expect(registerHead(page)).toContainText(/target/i, { useInnerText: true });
  // 97 vs 95 is a two-point gap — well past the 0.005 tolerance — so the
  // decision is withheld BECAUSE of the date, not because the numbers agree,
  // and the legend states no move against a target that did not exist yet.
  await expect(headline(page)).toHaveCount(0);
  await expect(legendRow(page, "Fixed Income").locator("b")).toHaveText("97%");
  await expect(outcome(page).locator(".rr-legend .alp__mv")).toHaveCount(0);
  await expect(outcome(page).locator(".rr-legend__d .alp__mv")).toHaveCount(0);
  await expect(targetRow(page)).toHaveText("Published Jun 2, 2026, after this session");
});

test("a session dated after the published framework states the change, with the target's date in the Evidence row", async ({ page }) => {
  await mockSessionApi(page, {
    session: bucketSession("2026-08-03", { conservative_defi_yield: 0.97, directional_crypto: 0.03 }),
    allocation: ALLOCATION,
  });

  await page.goto("/swarm/2026-08-03/robotmoney-allocation");

  // The change is the legend's: both sleeves carry their move from target.
  await expect(movedRows(page)).toHaveCount(2);
  await expect(legendRow(page, "Fixed Income").locator(".rr-legend__was")).toHaveText("Target 95%");
  await expect(headline(page)).toHaveCount(0);
  await expect(targetRow(page)).toHaveText("Published Jun 2, 2026");
});

test("a date the static archive DOES cover is read from the API, not from the checked-in archive", async ({ page }) => {
  // 2026-06-25/woon is the archive's last session and a file that really
  // exists under /data/swarm/sessions/. The view used to prefer that file over
  // the database for any covered date, so the feed showed one copy of the
  // session and the page showed another. The take body below exists only in
  // the API response; seeing it proves the API won.
  await mockSessionApi(page, { session: positionSession("2026-06-25", "woon", "Woon"), allocation: ALLOCATION });

  await page.goto("/swarm/2026-06-25/woon");

  await expect(page.locator(".sv__error")).toBeHidden();
  await expect(page.locator(".rr-take .sv__take-body").first()).toContainText("ARCHIVE IMPORT MARKER");
  await expect(page.locator(".rr-take")).toHaveCount(3);
  // Only the API path renders a seal that links to the take's receipt, which
  // needs a real take id the archive's rows do not carry: a direct assertion
  // that the page did not fall back to the archive.
  await expect(page.locator("[data-verified-badge]").first()).toBeVisible();
  await expect(page.locator("[data-verified-badge]").first()).toHaveAttribute("href", "/swarm/takes/take-athena");
});

// Issue #593 / review-data-integrity DI-594-001. The roster page (/swarm) links
// members at their public `handle`; this page linked them at the immutable id,
// because camelTake() dropped `member_handle` and camelMember() dropped
// `handle` — so `t.memberHandle` was always undefined and memberById()'s
// `m.handle === ref` branch was unreachable. Two public surfaces derived from
// the same API then published two different addresses for one member.
//
// The fixture has handle !== id, which is what makes this an assertion about
// the handle rather than about the fallback. Both link sources are covered in
// one render:
//   - the take byline/avatar, fed by camelTake's `memberHandle`;
//   - the disagreement panel, whose positions carry ONLY the signed
//     `member_id`, so it reaches a handle through camelMember's `handle` on the
//     roster. Since #598 that panel falls back to this session's takes when the
//     roster does not hold the member — the case the next test covers — so the
//     mapper-level guarantee that camelMember carries `handle` at all is pinned
//     directly in scripts/tests/unit/frontend-routes.test.ts.
test("a renamed member's session links address the public handle, never the id the take was signed under", async ({ page }) => {
  await mockSessionApi(page, {
    session: disagreementSession("2026-06-26", "robotmoney-vault", "Robot Money Vault"),
    takes: RENAMED_TAKES,
    members: RENAMED_MEMBERS,
    allocation: ALLOCATION,
  });

  await page.goto("/swarm/2026-06-26/robotmoney-vault");

  await expect(page.locator(".sv__error")).toBeHidden();
  await expect(page.locator(".rr-take")).toHaveCount(2);

  // Take byline + avatar: the handle, not `athena`.
  const athenaTake = page.locator(".rr-take").filter({ hasText: "RENAME MARKER — athena take body." });
  await expect(athenaTake.locator(".sv__member-link")).toHaveAttribute("href", "/swarm/members/macro-desk");
  await expect(athenaTake.locator(".sv__avatar--mark")).toHaveAttribute("href", "/swarm/members/macro-desk");

  // The disagreement panel names the member through the ROSTER (it holds only
  // the signed member_id) and links no member page: its one link per row is
  // the member's take card on this page. The byline is the member link.
  const athenaPosition = page.locator("#views-differ .rr-views-t tbody tr").filter({ hasText: "Athena" });
  await expect(athenaPosition.locator("a.rr-lnk")).toHaveAttribute("href", /^#take-/);
  await expect(athenaPosition.locator('a[href^="/swarm/members/"]')).toHaveCount(0);

  // An unrenamed member (handle === id) is unaffected: the same address as
  // before migration 0030, which is what keeps every published link alive.
  const dracoTake = page.locator(".rr-take").filter({ hasText: "RENAME MARKER — draco take body." });
  await expect(dracoTake.locator(".sv__member-link")).toHaveAttribute("href", "/swarm/members/draco");

  // Nothing on the page still points at the legacy id for the renamed member.
  await expect(page.locator('a[href="/swarm/members/athena"]')).toHaveCount(0);
});

// Issue #598 / review-data-integrity DI-594-R2-001. The test above proves both
// link sites agree WHILE the renamed member is on the active roster. Deactivate
// that member and they stopped agreeing:
//
//   - the take byline carries `member_handle` in the take's own payload, so it
//     kept linking /swarm/members/macro-desk;
//   - a disagreement position carries only the signed `member_id`, so it could
//     reach a handle only through the roster — and `GET /api/swarm/members`
//     serves active members only, so `memberById()` returned null and the link
//     fell back to /swarm/members/athena.
//
// One page, two public addresses for one member. Neither 404s (the server
// resolves handle OR legacy id), which is exactly why nothing caught it: the
// only way to see it is a fixture where the renamed member is ABSENT from the
// roster, and none existed. memberHandleOf() now reads the roster first and this
// session's takes second, so both sites resolve through one lookup.
test("a renamed member that is later DEACTIVATED still gets one address from both link sites", async ({ page }) => {
  await mockSessionApi(page, {
    // Same session and same takes as the test above — only the roster differs.
    session: disagreementSession("2026-06-27", "robotmoney-vault", "Robot Money Vault"),
    takes: RENAMED_TAKES,
    members: DEACTIVATED_ROSTER,
    allocation: ALLOCATION,
  });

  await page.goto("/swarm/2026-06-27/robotmoney-vault");

  await expect(page.locator(".sv__error")).toBeHidden();
  await expect(page.locator(".rr-take")).toHaveCount(2);

  const athenaTake = page.locator(".rr-take").filter({ hasText: "RENAME MARKER — athena take body." });
  // THE FIXTURE IS IN THE DEFECT STATE. The lens line is roster-only data
  // (memberLens -> memberById), so its fallback wording is a direct assertion
  // that this page really is rendering a member the roster does not hold — the
  // condition the assertions below would silently stop testing if a future
  // fixture edit put Athena back on the roster.
  await expect(athenaTake.locator(".sv__take-lens")).toHaveText("swarm member");

  // Byline + avatar: the take's own handle.
  await expect(athenaTake.locator(".sv__member-link")).toHaveAttribute("href", "/swarm/members/macro-desk");
  await expect(athenaTake.locator(".sv__avatar--mark")).toHaveAttribute("href", "/swarm/members/macro-desk");

  // The disagreement position, found by its view text rather than by a member
  // name: the panel's label is roster-derived and falls back to the signed id
  // for a member the roster dropped. Its one link is the take card on this
  // page, never a member address that could disagree with the byline's.
  const athenaPosition = page.locator("#views-differ .rr-views-t tbody tr").filter({ hasText: "The long end is where this breaks." });
  await expect(athenaPosition.locator("a.rr-lnk")).toHaveAttribute("href", /^#take-/);

  // The unrenamed, still-active member is unaffected.
  const dracoTake = page.locator(".rr-take").filter({ hasText: "RENAME MARKER — draco take body." });
  await expect(dracoTake.locator(".sv__member-link")).toHaveAttribute("href", "/swarm/members/draco");
  const dracoPosition = page.locator("#views-differ .rr-views-t tbody tr").filter({ hasText: "Trim the tail first." });
  await expect(dracoPosition.locator("a.rr-lnk")).toHaveAttribute("href", /^#take-/);

  // ONE ADDRESS PER MEMBER, stated as a set rather than as two separate
  // equalities: this fails if EITHER link site regresses to the legacy id,
  // including a regression that moved both sites onto the id together.
  const addresses = await page
    .locator(".sv__takes-section, #views-differ")
    .locator('a[href^="/swarm/members/"]')
    .evaluateAll((links) => [...new Set(links.map((a) => a.getAttribute("href")))].sort());
  expect(addresses).toEqual(["/swarm/members/draco", "/swarm/members/macro-desk"]);
});

// ── The research record (RM-121) ────────────────────────────────────────────
// The session page reads as its subject page does: the recommendation when
// the session recommended weights or wrote actions, the reasoning beside the
// market reading it was given, the vote and each take, and the evidence,
// including the brief it was handed.

const LIVE_ID = "4cf025d6-8b53-4e7b-85a8-3843f2aa1609";
// Shaped like prod's 2026-09-10 allocation session: a live aggregate, whose
// consensus, disagreement, rationale and synthesis are templates over the
// quorum, the stance tally, the mean confidence and the regime percentile.
const LIVE_SESSION = {
  id: LIVE_ID, date: "2026-09-10", subjectId: "robotmoney-allocation", subjectName: "Robot Money Allocation", state: "published",
  regimeSummary: {
    regime: "risk_on", composite: 0.5978, composite_percentile: 0.8324,
    macro_regime: "risk_on", macro_percentile: 0.9, onchain_regime: "neutral", onchain_percentile: 0.56,
    factor_regime: "neutral", factor_percentile: 0.68,
  },
  synthesis: "5 of 7 members (71% participation) reviewed Robot Money Allocation. Stance split: 3 constructive, 1 neutral, 1 bullish.",
  swarmRecommendation: {
    type: "position_actions",
    quorum: { active: 7, submitted: 5, absent: 2, participation: 0.714 },
    stances: { constructive: 3, neutral: 1, bullish: 1 },
    meanConfidence: 0.638,
    absent: ["m-max", "m-dual"],
    consensus: ["5 of 7 members submitted (71% participation).", "Stance split: 3 constructive, 1 neutral, 1 bullish."],
    rationale: "Majority stance is constructive (3 of 5 submitted takes), mean confidence 0.64.",
    disagreements: [{
      topic: "bullish vs neutral stance on Robot Money Allocation",
      positions: [{ member_id: "m-woon", view: "WOON BODY" }, { member_id: "m-shodai", view: "SHODAI BODY" }],
      what_settles: "Whether the next regime snapshot's composite percentile moves toward the bullish or the neutral read.",
    }],
    // The hardcoded pair rollups carried from 2026-08-06 to 09-04, derived
    // from no member input. Never drawn as the swarm's outcome.
    actions: [{ token: "USDC", action: "rotate", rationale: "hardcoded" }, { token: "rmUSDC", action: "add", rationale: "hardcoded" }],
  },
};
const LIVE_TAKES = [
  ["m-noop", "noop-analyst", "Noop Analyst", "constructive", 0.6],
  ["m-rm", "robot-money", "Robot Money", "constructive", 0.62],
  ["m-athena", "athena", "Athena", "constructive", 0.62],
  ["m-woon", "woon", "Woon", "bullish", 0.67],
  ["m-shodai", "shodai", "ShodAI", "neutral", 0.68],
].map(([memberId, memberHandle, memberName, stance, confidence]) => ({
  id: `take-${memberHandle}`, memberId, memberHandle, memberName, stance, confidence,
  body: `${String(memberHandle).toUpperCase().replace(/-/g, "")} BODY`, verified: true, archival: false,
}));
const LIVE_ROSTER = {
  members: [
    ...LIVE_TAKES.map((t) => ({ id: t.memberId, handle: t.memberHandle, status: "active", name: t.memberName, lens: "swarm" })),
    { id: "m-max", handle: "maximus", status: "active", name: "Maximus", lens: "swarm" },
    { id: "m-dual", handle: "dualmint", status: "active", name: "DualMint", lens: "swarm" },
  ],
};

// Three constructive members at 60 to 62% share a column: a name that has no
// room beside its dot moves off it, and no name covers another or runs across
// another member's dot.
test("the vote chart keeps every member's name clear of the others' names and dots", async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === `/api/swarm/sessions/${LIVE_ID}`) return route.fulfill(json({ session: LIVE_SESSION, takes: LIVE_TAKES }));
    if (u.pathname === "/api/swarm/members") return route.fulfill(json(LIVE_ROSTER));
    if (u.pathname.startsWith("/api/")) return route.fulfill(notFound);
    return route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/swarm/sessions/${LIVE_ID}`);
  await expect(page.locator("#takes .rr-vote__dot")).toHaveCount(5);

  const boxes = await page.locator("#takes .rr-vote__dot").evaluateAll((els) => els.map((el) => {
    const dot = el.querySelector("i")!.getBoundingClientRect();
    const lbl = el.querySelector(".rr-vote__lbl")!.getBoundingClientRect();
    return { name: el.getAttribute("aria-label")!.split(",")[0], dot: { x: dot.x + dot.width / 2, y: dot.y + dot.height / 2 }, lbl: { l: lbl.left, r: lbl.right, t: lbl.top, b: lbl.bottom } };
  }));
  for (const a of boxes) {
    for (const b of boxes) {
      if (a === b) continue;
      const overlap = a.lbl.l < b.lbl.r && b.lbl.l < a.lbl.r && a.lbl.t < b.lbl.b && b.lbl.t < a.lbl.b;
      expect(overlap, `${a.name}'s name overlaps ${b.name}'s`).toBe(false);
      const onDot = b.dot.x > a.lbl.l && b.dot.x < a.lbl.r && b.dot.y > a.lbl.t && b.dot.y < a.lbl.b;
      expect(onDot, `${a.name}'s name covers ${b.name}'s dot`).toBe(false);
    }
  }
});

test("a live aggregate reached by id draws the record from its own brief and prints no templated discussion", async ({ page }) => {
  const briefQueries: string[] = [];
  await page.route("**/api/**", (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === `/api/swarm/sessions/${LIVE_ID}`) return route.fulfill(json({ session: LIVE_SESSION, takes: LIVE_TAKES }));
    if (u.pathname === "/api/swarm/members") return route.fulfill(json(LIVE_ROSTER));
    if (u.pathname === "/api/swarm/brief") {
      briefQueries.push(u.search);
      return route.fulfill(json({
        id: "b1", sessionId: LIVE_ID, body: {
          prompt: { user: "Review the supplied swarm context for Robot Money Allocation on 2026-09-10." },
          regime: { regime: "risk_on", composite: "0.6044609980607236", macro_regime: "risk_on", onchain_regime: "neutral" },
          recentSessions: [{ date: "2026-09-09T00:00:00.000Z", state: "published", subject_id: "robotmoney-vault" }],
          researchSignals: [{ signalKey: "channel-divergence" }],
          takeSchema: { stance: {}, confidence: {}, body: {} },
        },
      }));
    }
    if (u.pathname === "/api/swarm/sessions") {
      return route.fulfill(json({ sessions: [{ id: "v1", date: "2026-09-09", subjectId: "robotmoney-vault", subjectName: "Robot Money Vault", state: "published" }] }));
    }
    if (u.pathname.startsWith("/api/")) return route.fulfill(notFound);
    return route.continue();
  });

  await page.goto(`/swarm/sessions/${LIVE_ID}`);

  await expect(page.locator(".sv__error")).toBeHidden();
  // Up to the subject this session reviewed.
  const up = page.locator(".rr-crumbs a").nth(1);
  await expect(up).toHaveAttribute("href", "/swarm/subjects/robotmoney-allocation");
  await expect(up).toHaveText("Robot Money Allocation");

  // The brief THIS session opened with, by its id: by date the API answers with
  // the day's latest brief, which is another session's on a two-session day.
  expect(briefQueries.some((q) => q.includes(`session=${LIVE_ID}`))).toBe(true);
  expect(briefQueries.some((q) => q.includes("date="))).toBe(false);

  // The market reading it was given.
  const context = page.locator("#reasoning .rr-context");
  await expect(context.locator(".sig__row.is-lead .sig__l")).toHaveText("Composite");
  await expect(context.locator(".sig__row.is-lead .sig__v")).toHaveText("83rd");
  // Live method: factor is context, drawn apart.
  await expect(context.locator(".sig__row").nth(3)).toHaveClass(/is-context/);
  // Its row's tip says so, and each label opens its panel on the regime page.
  await expect(context.locator(".sig__row").nth(3).locator(".sig__tip")).toContainText("Not in the composite");
  await expect(context.locator(".sig__row").nth(3).locator("a.sig__l")).toHaveAttribute("href", "/regime#panel-factor");
  await expect(context.locator(".sig__row.is-lead a.sig__l")).toHaveAttribute("href", "/regime#composite");

  // The vote: constructive leads, three of the five who took part.
  const vote = page.locator("#takes .rr-vote");
  const tally = vote.locator(".rr-vote__sum");
  await expect(tally.locator(".sv__stance-badge")).toHaveText("constructive");
  await expect(tally.locator(".rr-vote__share")).toHaveText("3 of 5");
  await expect(vote.locator('.rr-vote__dot[aria-label*=", constructive,"]')).toHaveCount(3);
  // Turnout and the mean are stated once each: the takes in the facts row, the mean on the chart's rule.
  await expect(page.locator(".rr-meta > .rr-meta__i").filter({ hasText: /^\s*Takes/ }).locator("b")).toHaveText("5");
  await expect(vote.locator(".rr-vote__mean span")).toHaveText("Mean 64%");
  await expect(vote.locator(".rr-vote__plot")).toHaveAttribute("aria-label", /Mean confidence 64%\./);
  await expect(tally).not.toContainText(/Took part|Mean confidence/);
  // Who could have voted and did not, by name.
  const absent = tally.locator(".rr-meta__i").filter({ hasText: "Absent" }).locator("a.rr-lnk");
  await expect(absent).toHaveText(["Maximus", "DualMint"]);
  await expect(absent.first()).toHaveAttribute("href", "/swarm/members/maximus");

  // No outcome: a live aggregate that recommended no weights recommended
  // nothing, and the hardcoded USDC/rmUSDC pair is not the swarm's. The
  // allocation's recommendation is weights, so its empty ring says so.
  await expect(outcome(page).locator(".rr-x")).toHaveCount(0);
  await expect(outcome(page).locator(".sr__act, .rr-act")).toHaveCount(0);
  await expect(outcome(page).locator(".rr-ring--empty figcaption")).toHaveText("No weights published");
  await expect(page.locator("body")).not.toContainText("hardcoded");
  // No discussion: every line of it restates a figure the record draws.
  await expect(page.locator(".rr-sec__h")).toHaveText(["The recommendation", "Reasoning & disagreement", "Member takes", "Evidence & provenance"]);
  // The Synthesis title stays over its empty state.
  await expect(page.locator("#reasoning .rr-subhead__h").first()).toHaveText("Synthesis");
  await expect(page.locator("#reasoning")).toContainText("No synthesis written");
  await expect(page.locator("body")).not.toContainText("Stance split");
  await expect(page.locator("#members-agree")).toHaveCount(0);
  await expect(page.locator("#views-differ")).toHaveCount(0);
  await expect(page.locator(".rr-meta")).not.toContainText("Disagreements");
  // A framework holds no book.
  await expect(page.locator("#holdings")).toHaveCount(0);

  // What it was handed, with the recent session named and linked.
  await page.locator("#evidence").getByRole("button", { name: /What the swarm was handed/ }).click();
  const hand = page.locator("#session-handover");
  // The regime is the page's facts row and market context, not a second copy here.
  await expect(hand.locator('[data-part="regime"]')).toHaveCount(0);
  const recent = hand.locator('[data-part="recent"] a.rr-lnk');
  await expect(recent).toHaveText(["Sep 9 · Robot Money Vault"]);
  await expect(recent).toHaveAttribute("href", "/swarm/2026-09-09/robotmoney-vault");

  // The vote as a way into the takes: one dot per member, each a jump to that
  // member's card.
  const dots = vote.locator(".rr-vote__dot");
  await expect(dots).toHaveCount(5);
  await expect(dots.filter({ hasText: "Noop Analyst" })).toHaveAttribute("href", "#take-m-noop");
  await expect(page.locator("#take-m-noop")).toContainText("NOOPANALYST BODY");
});

test("an archived allocation session measures its outcome against the targets it was handed", async ({ page }) => {
  // Every API read fails, so the page reads the checked-in v0 archive: the
  // 2026-06-24 session and the brief it opened with.
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));

  await page.goto("/swarm/2026-06-24/robotmoney-allocation");

  await expect(page.locator(".sv__error")).toBeHidden();
  const context = page.locator("#reasoning .rr-context");
  // A v0 reading averaged factor into the composite, so it is drawn as an input.
  await expect(context.locator(".sig__row").nth(3)).not.toHaveClass(/is-context/);
  await expect(context.locator(".sig")).toBeVisible();

  const out = outcome(page);
  // The two moves are the legend's rows (asserted below); no headline
  // counts them again.
  await expect(movedRows(page)).toHaveCount(2);
  await expect(headline(page)).toHaveCount(0);
  // Under the rationale, the stance tally and mean confidence the subject
  // page prints under the same recommendation (David, 2026-09-19): the two
  // pages read one recommendation the same way; only the link differs.
  await expect(out.locator(".rr-counts")).toHaveCount(1);
  await expect(out.locator(".rr-counts")).toContainText("cautious");
  await expect(out.locator(".rr-counts em")).toHaveText("70% mean confidence");
  await expect(page.locator("#takes .rr-vote__dot")).toHaveCount(3);
  await expect(out.locator(".sv__wdonut-host")).toHaveAttribute("aria-label",
    "Fixed Income 95%, Small Cap Tokens 3%, Real World Assets 2%");
  await expect(legendRow(page, "Small Cap Tokens").locator(".rr-legend__was")).toHaveText("Target 5%");
  await expect(legendRow(page, "Small Cap Tokens").locator(".alp__mv")).toHaveText("−2 pp");
  await expect(legendRow(page, "Real World Assets").locator(".alp__mv")).toHaveText("+2 pp");
  await expect(out.getByRole("button", { name: "Full comparison" })).toHaveCount(0);
  // The target is the one in the session's own brief, so it cannot postdate it.
  await expect(targetRow(page)).toHaveText("Handed to this session, dated Jun 2, 2026");
  await expect(out.locator(".rr-prose")).toContainText("Composite 0.541");

  // Inside each sleeve, as /allocation's sleeve cards: published names, the
  // recommended sleeve weight, and the items in POLICY order (Aave, Morpho,
  // Compound, Sky), each in the colour its position gives it there.
  await expect(out.locator(".rr-legend__row .rr-legend__l")).toHaveText(["Fixed Income", "Small Cap Tokens", "Protocol Tokens", "Real World Assets"]);
  await expect(legendRow(page, "Fixed Income").locator("b")).toHaveText("95%");
  const defiBtn = out.locator('[data-sleeve-btn="conservative_defi_yield"]');
  await defiBtn.click();
  await expect(defiBtn).toHaveAttribute("aria-expanded", "true");
  const panel = out.locator(".rr-x__panel");
  await expect(panel).toHaveAttribute("id", "sleeve-conservative_defi_yield");
  await expect(panel.locator(".rr-x__head b")).toHaveText("Fixed Income");
  // The pinned sleeve's weight is the ring's and its legend row's; the panel names the sleeve alone.
  await expect(out.locator(".rr-ring figcaption b")).toHaveText("95%");
  await expect(defiBtn.locator("b")).toHaveText("95%");
  await expect(panel.locator(".rr-x__head")).not.toContainText("%");
  const assets = panel.locator(".rr-x__assets tbody tr");
  await expect(assets.locator("th span")).toHaveText(["Aave", "Morpho", "Compound", "Sky"]);
  await expect(assets.filter({ hasText: "Morpho" }).locator("td").first()).toHaveText("35%");
  await expect(assets.first().locator("i")).toHaveAttribute("style", /background:\s*#10b981/i);

  // The discussion v0 wrote, with each position matched to its take.
  await expect(page.locator(".rr-sec__h")).toHaveText(["The recommendation", "Reasoning & disagreement", "Member takes", "Evidence & provenance"]);
  await expect(page.locator("#members-agree li")).toHaveCount(4);
  await expect(page.locator("#views-differ .rr-q")).toHaveCount(3);
  // A view's row carries the stance and confidence the member's take filed,
  // the member's words under the name, and the way to the take.
  const cut = page.locator("#views-differ .rr-views-t tbody tr").filter({ hasText: "Cut to 2%" });
  await expect(cut.locator(".sv__stance-badge")).toHaveCount(1);
  await expect(cut.locator("td.q").first()).toHaveText(/^\d+%$/);
  await expect(cut.locator("a.rr-lnk")).toHaveAttribute("href", /^#take-/);
  await expect(page.locator("#take-athena .sv__stance-badge")).toHaveText("cautious");
  await expect(page.locator("#take-athena .rr-conf")).toHaveText("Confidence 68%");
  await expect(page.locator(".rr-take")).toHaveCount(3);
});

// The session's own headline: the date this page is about, set under the
// subject's name, and its phase leading the facts row. Then the
// recommendation, before the reasoning and the vote behind it.
test("a session page opens on its date and phase, then leads with the recommendation", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));

  await page.goto("/swarm/2026-06-25/woon");

  await expect(page.locator(".sv__error")).toBeHidden();
  await expect(page.locator(".rr-crumbs a").nth(1)).toHaveAttribute("href", "/swarm/subjects/woon");
  await expect(page.locator(".rr-when time")).toHaveText("June 25, 2026");
  // The phase leads the facts row (David, 2026-09-22).
  await expect(page.locator(".rr-meta > .rm-sphase:first-child")).toHaveText("published");
  await expect(page.locator(".rr-when .rm-sphase")).toHaveCount(0);

  // The recommendation first, in document order. It draws the book itself, so
  // there is no separate holdings section.
  const order = await page.locator(".rr-sec").evaluateAll((secs) => secs.map((s) => s.id));
  expect(order).toEqual(["recommendation", "reasoning", "takes", "evidence"]);

  // The actions Woon's members wrote, on the book they were written against
  // (the book holds six positions; the session set an action on five). Each
  // row carries its own, so no headline counts "2 change, 3 held" again.
  await expect(headline(page)).toHaveCount(0);
  const rows = outcome(page).locator(".rr-legend__row");
  await expect(rows).toHaveCount(6);
  await expect(rows.locator(".rr-act:not(.is-none)")).toHaveCount(5);
  await expect(rows.locator(".rr-act.is-hold")).toHaveCount(3);
  await expect(rows.first().locator(":scope > span")).toHaveText("WOON");
  await expect(rows.first().locator(".rr-act")).toHaveText("hold");

  // One key colour per holding, resolved over this legend as the subject page
  // resolves the same book: WOON does not borrow ROBOTMONEY's cyan.
  const keys = await rows.locator('i[data-mark="series"]').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
  expect(keys.length).toBeGreaterThan(3);
  expect(new Set(keys).size).toBe(keys.length);
  // Notable leaves out the lines the handover already prints as operator notes.
  await page.locator("#evidence").getByRole("button", { name: /What the swarm was handed/ }).click();
  const notes = await page.locator('#session-handover .hand__row[data-part="notes"] li').allTextContents();
  const notable = await page.locator("#book-notable li").allTextContents();
  expect(notes.length).toBeGreaterThan(0);
  expect(notable.length).toBeGreaterThan(0);
  expect(notable.filter((n) => notes.includes(n))).toEqual([]);

  // The take head: the stance as a word, the confidence beside it.
  const first = page.locator(".rr-take").first();
  await expect(first.locator(".sv__stance-badge")).toHaveText("cautious");
  await expect(first.locator(".rr-conf")).toHaveText("Confidence 72%");

  // The record's generation time, without the date the header already gives.
  await expect(page.locator("#evidence .rr-dl > div").filter({ hasText: "Record generated" }).locator("dd")).toHaveText("23:58 UTC");
});

// The targets the session's OWN brief handed it are what its outcome is
// measured against, not today's framework, which is one admin-editable row.
test("the targets the session's own brief handed it win over today's framework", async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/api/swarm/members") return route.fulfill(json(MEMBERS));
    if (u.pathname === "/api/swarm/sessions/2026-08-03/robotmoney-allocation") {
      return route.fulfill(json({ session: bucketSession("2026-08-03", { conservative_defi_yield: 0.95, agent_tokens: 0.05, protocol_tokens: 0, real_world_assets: 0 }), takes: TAKES }));
    }
    if (u.pathname === "/api/swarm/brief") {
      return route.fulfill(json({ body: { allocation: { buckets: [
        { id: "conservative_defi_yield", name: "Conservative DeFi Yield", target_weight: 0.9 },
        { id: "agent_tokens", name: "Agent Tokens", target_weight: 0.1 },
        { id: "protocol_tokens", name: "Protocol Tokens", target_weight: 0 },
        { id: "real_world_assets", name: "Real World Assets", target_weight: 0 },
      ] } } }));
    }
    if (u.pathname === "/api/dashboards/allocation") return route.fulfill(json(ALLOCATION));
    if (u.pathname.startsWith("/api/")) return route.fulfill(notFound);
    return route.continue();
  });

  await page.goto("/swarm/2026-08-03/robotmoney-allocation");

  await expect(legendRow(page, "Fixed Income").locator(".rr-legend__was")).toHaveText("Target 90%");
  await expect(legendRow(page, "Fixed Income").locator(".alp__mv")).toHaveText("+5 pp");
  await expect(legendRow(page, "Small Cap Tokens").locator(".alp__mv")).toHaveText("−5 pp");
  await expect(outcome(page).getByRole("button", { name: "Full comparison" })).toHaveCount(0);
  await expect(targetRow(page)).toHaveText("Handed to this session");
});

// v0 sessions imported into the database run past the static archive's last
// date, with no quorum. Their composite averaged factor in, so factor is an
// input there; a test on the date alone would call them live.
test("a v0 session imported past the archive date draws factor as the input it was", async ({ page }) => {
  const base = positionSession("2026-07-15", "robotmoney-vault", "Robot Money Vault");
  const { quorum: _q, stances: _s, ...v0 } = base.swarm_recommendation;
  await mockSessionApi(page, {
    session: {
      ...base,
      swarm_recommendation: v0,
      regime_summary: {
        regime: "risk_on", composite: 0.568, composite_percentile: 0.67, macro_percentile: 0.79, onchain_percentile: 0.06,
        factor_percentile: 0.98, macro_regime: "risk_on", onchain_regime: "risk_off", factor_regime: "risk_on",
      },
    },
    allocation: ALLOCATION,
  });

  await page.goto("/swarm/2026-07-15/robotmoney-vault");

  const signal = page.locator("#reasoning .rr-context");
  await expect(signal.locator(".sig__row")).toHaveCount(4);
  await expect(signal.locator(".sig__row").nth(3)).not.toHaveClass(/is-context/);
  await expect(signal.locator(".rr-note")).toHaveText("Each reading is a percentile of its own last three years, so the 50th is its median.");
  await expect(signal.locator(".sig__row").nth(3).locator(".sig__tip")).toContainText("in the composite of this older reading");
});

// A sleeve published with no weight has none: it is not a move to zero.
test("a sleeve published with no weight is not drawn as a move to zero", async ({ page }) => {
  await mockSessionApi(page, {
    session: bucketSession("2026-08-03", { conservative_defi_yield: 0.95, agent_tokens: null as unknown as number, protocol_tokens: 0, real_world_assets: 0 }),
    allocation: { asOf: "2026-06-02", strategy: [
      { label: "Conservative DeFi Yield", targetPct: 95 }, { label: "Agent Tokens", targetPct: 5 },
      { label: "Protocol Tokens", targetPct: 0 }, { label: "Real World Assets", targetPct: 0 },
    ] },
  });

  await page.goto("/swarm/2026-08-03/robotmoney-allocation");

  // The legend prints no weight for it, and no move: neither a drop to zero
  // nor a "—" mark restating the dash its weight already reads.
  await expect(legendRow(page, "Small Cap Tokens").locator("b")).toHaveText("—");
  await expect(legendRow(page, "Small Cap Tokens").locator(".alp__mv")).toHaveCount(0);
  await expect(legendRow(page, "Small Cap Tokens")).not.toContainText("−5 pp");
  await expect(outcome(page).getByRole("button", { name: "Full comparison" })).toHaveCount(0);
});
