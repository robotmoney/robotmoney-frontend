import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DASH_LAYOUT_VIEW, routeMetaFor, viewFor } from "../../../frontend/public/assets/js/app/routes.js";
// These are the PRODUCTION archive loaders: the same functions the browser
// runs when it falls back to the shipped static archive (static-views.js is a
// plain ES module, so Bun executes the real code path — not a test double). The old
// lib/swarm-controllers.js + lib/swarm-archive.js pair this test used
// to import was a dead duplicate normalizer never loaded by main.js's import
// graph (review-maintainability-026) and has been deleted.
import {
  camelMember,
  camelSubject,
  camelTake,
  helpers,
  loadArchiveMember,
  loadArchiveSession,
  loadArchiveSnapshot,
  structuralNotesOf,
  takeHref,
  withinBucketWeightsFrom,
} from "../../../frontend/public/assets/js/app/alpine/static-views.js";

const repoRoot = join(import.meta.dir, "../../..");

// static-views.js reaches the archive through global fetch with root-relative
// URLs ("/data/swarm/..."). Serve those straight from the shipped static
// files so the loaders execute against exactly what production serves, and
// record every requested URL so we can assert URL construction too.
const requestedUrls: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (url: string | URL) => {
    const path = String(url);
    requestedUrls.push(path);
    const file = Bun.file(join(repoRoot, "frontend/public", `.${path}`));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(await file.text(), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("frontend route resolution", () => {
  test("resolves static routes to matching fragments", () => {
    expect(viewFor("/")).toBe("/views/home.html");
    expect(viewFor("/allocation")).toBe("/views/allocation.html");
    // views/vault.html is still in the tree, so without an explicit entry the
    // catch-all would resolve /vault straight back to it. The pin is the only
    // thing retiring the page.
    expect(viewFor("/vault")).toBe("/views/not-found.html");
    expect(viewFor("/research/channel-divergence")).toBe("/views/research/channel-divergence.html");
  });

  test("resolves every /admin subpath to the one buildless admin shell fragment", () => {
    // The admin shell (adminSurfaceView) reads location.pathname itself to pick
    // a section — /admin/research, /admin/research/runs/:id, and /admin/queue
    // must NOT fall through to the generic catch-all, which would request a
    // nonexistent per-path view fragment and 404 (issue #157 AC1).
    expect(viewFor("/admin")).toBe("/views/admin.html");
    expect(viewFor("/admin/research")).toBe("/views/admin.html");
    expect(viewFor("/admin/research/runs/abc-123")).toBe("/views/admin.html");
    expect(viewFor("/admin/queue")).toBe("/views/admin.html");
    // Audit (issue #155/PR #170) is an in-shell section, not a separate
    // route — /admin/audit falls through to this same catch-all. Swarm
    // (issue #159) IS its own route with dedicated fragments — see
    // "resolves admin swarm operations routes" below.
    expect(viewFor("/admin/audit")).toBe("/views/admin.html");
    expect(viewFor("/admin/")).toBe("/views/admin.html");
  });

  // Analytics dashboard router extension (issue #380, P0.3/P0.4 —
  // docs/bot-analytics-ui-port-plan.md §4.1/§5.0): every nav-wired dashboard
  // route resolves to the shared placeholder fragment today and carries
  // `layout: DASH_LAYOUT_VIEW` + `gated: true` metadata for router.js's
  // layout composition + dash-shell.js's gate, EXCEPT /submit — linked
  // directly off the gate screen itself, so it must be reachable pre-auth.
  // /list (issue #384, P2.1), /list2 + /list3 (issue #387), /market +
  // /dashboard (issue #392, P4.1), /agents (issue #385, P2.2),
  // /lobster + /vaults + /wallets (issue #386, P2.3/P2.4/P2.5),
  // /methodology + /about (issue #395, P4.2/P4.3), and /ask-mr-roboto
  // (issue #394, P5.1) have all shipped real content — each resolves to its
  // own fragment now. None of the nav-wired dashboard routes still point at
  // the shared coming-soon placeholder.
  test("resolves every static dashboard route to the shared placeholder, gated, under the dash layout", () => {
    const gatedPaths: string[] = [];
    for (const p of gatedPaths) {
      expect(viewFor(p)).toBe("/views/dash/coming-soon.html");
      expect(routeMetaFor(p)).toEqual({ layout: DASH_LAYOUT_VIEW, gated: true });
    }
  });

  // /methodology and /about (issue #395, P4.2/P4.3) ship real, static content
  // — they resolve to their own fragments now, still gated under the dash
  // layout (§4.1's noindex rule applies regardless of content status, see
  // seo.js).
  test("/methodology and /about (issue #395) resolve to their own real fragments, still gated under the dash layout", () => {
    expect(viewFor("/methodology")).toBe("/views/dash/methodology.html");
    expect(routeMetaFor("/methodology")).toEqual({ layout: DASH_LAYOUT_VIEW, gated: true });
    expect(viewFor("/about")).toBe("/views/dash/about.html");
    expect(routeMetaFor("/about")).toEqual({ layout: DASH_LAYOUT_VIEW, gated: true });
  });

  // /terms and /privacy (issue #395) are new static site-policy pages, NOT
  // part of the bot-analytics UI port (they are not among the plan's 20
  // dashboard routes) — public, ungated, no dash layout, resolved by the
  // generic catch-all exactly like /disclaimer already is.
  test("/terms and /privacy (issue #395) are public static pages, not part of the dash layout", () => {
    expect(viewFor("/terms")).toBe("/views/terms.html");
    expect(routeMetaFor("/terms")).toBeNull();
    expect(viewFor("/privacy")).toBe("/views/privacy.html");
    expect(routeMetaFor("/privacy")).toBeNull();
  });

  test("/list (issue #384) resolves to its own real fragment, still gated under the dash layout", () => {
    expect(viewFor("/list")).toBe("/views/dash/list.html");
    expect(routeMetaFor("/list")).toEqual({ layout: DASH_LAYOUT_VIEW, gated: true });
  });

  // /list2 and /list3 (issue #387, P2.6/P2.7) ship real content — they
  // resolve to their own fragments now, still gated under the dash layout.
  test("/list2 and /list3 (issue #387) resolve to their own real fragments, still gated under the dash layout", () => {
    expect(viewFor("/list2")).toBe("/views/dash/list2.html");
    expect(routeMetaFor("/list2")).toEqual({ layout: DASH_LAYOUT_VIEW, gated: true });
    expect(viewFor("/list3")).toBe("/views/dash/list3.html");
    expect(routeMetaFor("/list3")).toEqual({ layout: DASH_LAYOUT_VIEW, gated: true });
  });

  // /market + /dashboard "Agent Activity Log" TerminalFeed (issue #392, P4.1).
  test("/market and /dashboard (issue #392) resolve to the same real fragment, gated under the dash layout", () => {
    expect(viewFor("/dashboard")).toBe("/views/dash/activity.html");
    expect(routeMetaFor("/dashboard")).toEqual({ layout: DASH_LAYOUT_VIEW, gated: true });
    expect(routeMetaFor("/market")).toEqual({ layout: DASH_LAYOUT_VIEW, gated: true });
    // /market and /dashboard alias the same fragment (the original's own
    // aliasing, §4.1) — same view, same metadata.
    expect(viewFor("/market")).toBe(viewFor("/dashboard"));
  });

  test("/agents (issue #385) resolves to its own real fragment, still gated under the dash layout", () => {
    expect(viewFor("/agents")).toBe("/views/dash/agents.html");
    expect(routeMetaFor("/agents")).toEqual({ layout: DASH_LAYOUT_VIEW, gated: true });
  });

  // /agents/:id "Money-agent dossier" AgentProfile (issue #390, §5.8, P3.2) —
  // the first param-route dashboard page to ship real content; every other
  // `:id`/`:slug` route still points at the shared coming-soon placeholder
  // (see the gated-param-paths case below, which no longer includes /agents/*).
  test("/agents/:id (issue #390) resolves to its own real fragment, still gated under the dash layout", () => {
    expect(viewFor("/agents/clawd")).toBe("/views/dash/agent-profile.html");
    expect(routeMetaFor("/agents/clawd")).toEqual({ layout: DASH_LAYOUT_VIEW, gated: true });
    // Trailing slash tolerated, same as every other param regex in this file.
    expect(viewFor("/agents/clawd/")).toBe("/views/dash/agent-profile.html");
    expect(routeMetaFor("/agents/clawd/")).toEqual({ layout: DASH_LAYOUT_VIEW, gated: true });
  });

  // Issue #386 (§5.9/§5.11/§5.13, P2.3/P2.4/P2.5): the first three
  // DASH_ROUTES entries to graduate off the shared placeholder onto their
  // own real fragment, still gated + under the shared dash layout.
  test("resolves /lobster, /vaults, /wallets to their own real fragments, gated, under the dash layout", () => {
    const realPaths = {
      "/lobster": "/views/dash/lobster.html",
      "/vaults": "/views/dash/vaults.html",
      "/wallets": "/views/dash/wallets.html",
    };
    for (const [p, view] of Object.entries(realPaths)) {
      expect(viewFor(p)).toBe(view);
      expect(routeMetaFor(p)).toEqual({ layout: DASH_LAYOUT_VIEW, gated: true });
    }
  });

  test("/ask-mr-roboto (issue #394) resolves to its own real fragment, still gated under the dash layout", () => {
    expect(viewFor("/ask-mr-roboto")).toBe("/views/dash/ask-roboto.html");
    expect(routeMetaFor("/ask-mr-roboto")).toEqual({ layout: DASH_LAYOUT_VIEW, gated: true });
  });


  test("/submit is public (reachable off the gate screen itself) even though it shares the dash layout", () => {
    // /submit (issue #393, P4.4) is the second dashboard route to ship real
    // content ahead of the coming-soon placeholder — see the /list case above.
    expect(viewFor("/submit")).toBe("/views/dash/submit.html");
    expect(routeMetaFor("/submit")).toEqual({ layout: DASH_LAYOUT_VIEW, gated: false });
  });

  test("dashboard param routes (:id/:slug) resolve to the placeholder with the right gate", () => {
    // /agents/:id (issue #390) and /lobster/:id, /vaults/:id, /wallets/:id
    // (issue #391) all ship their own real fragments now — see their
    // dedicated tests above/below. That accounts for 4 of the plan's "5 param
    // regexes"; only /projects/:slug (handled separately below, ungated) is
    // left, so there are no remaining dashboard-namespaced param routes still
    // pointing at the shared coming-soon placeholder.
    const gatedParamPaths: string[] = [];
    for (const p of gatedParamPaths) {
      expect(viewFor(p)).toBe("/views/dash/coming-soon.html");
      expect(routeMetaFor(p)).toEqual({ layout: DASH_LAYOUT_VIEW, gated: true });
    }
  });

  // Issue #389 (§5.5, P3.1): the one param route the plan explicitly marks
  // public — /projects (the list) is already a live, ungated page, and
  // gating its own profile sub-route would regress that. Graduates off the
  // shared coming-soon placeholder onto its own real fragment (the first
  // param route to do so).
  test("/projects/:slug (issue #389) resolves to its own real fragment, public (ungated) under the dash layout", () => {
    expect(viewFor("/projects/robotmoney-vault")).toBe("/views/dash/project-profile.html");
    expect(routeMetaFor("/projects/robotmoney-vault")).toEqual({ layout: DASH_LAYOUT_VIEW, gated: false });
    expect(routeMetaFor("/projects/robotmoney-vault/")).toEqual({ layout: DASH_LAYOUT_VIEW, gated: false });
  });

  // /lobster/:id, /vaults/:id, /wallets/:id detail dossiers (issue #391,
  // §5.10/§5.12/§5.14, P3.3/P3.4/P3.5) — the first PARAM routes to ship real
  // content ahead of the shared placeholder (§4.1's "5 param regexes"). The
  // LIST routes (/lobster, /vaults, /wallets, issue #386) are unaffected —
  // still the shared placeholder per the test above.
  test("/lobster/:id, /vaults/:id, /wallets/:id (issue #391) resolve to their own real fragments, still gated under the dash layout", () => {
    expect(viewFor("/lobster/xyz-coin")).toBe("/views/dash/coin-profile.html");
    expect(routeMetaFor("/lobster/xyz-coin")).toEqual({ layout: DASH_LAYOUT_VIEW, gated: true });
    expect(viewFor("/vaults/1")).toBe("/views/dash/vault-profile.html");
    expect(routeMetaFor("/vaults/1")).toEqual({ layout: DASH_LAYOUT_VIEW, gated: true });
    expect(viewFor("/wallets/0xabc")).toBe("/views/dash/wallet-profile.html");
    expect(routeMetaFor("/wallets/0xabc")).toEqual({ layout: DASH_LAYOUT_VIEW, gated: true });
    // Trailing slash tolerated, same as every other param regex in this file.
    expect(viewFor("/lobster/xyz-coin/")).toBe("/views/dash/coin-profile.html");
  });

  test("routeMetaFor returns null for every non-dashboard route — a strict addition, not a behavior change", () => {
    expect(routeMetaFor("/")).toBeNull();
    expect(routeMetaFor("/allocation")).toBeNull();
    expect(routeMetaFor("/admin")).toBeNull();
    expect(routeMetaFor("/projects")).toBeNull();
    expect(routeMetaFor("/swarm/members/athena")).toBeNull();
  });

  test("every dashboard route fragment referenced by the router exists on disk", async () => {
    const paths = [
      "/list",
      "/submit",
      "/agents",
      "/agents/clawd",
      "/lobster/xyz-coin",
      "/vaults/1",
      "/wallets/0xabc",
      "/projects/robotmoney-vault",
      "/dashboard",
      "/market",
      "/lobster",
      "/vaults",
      "/wallets",
      "/methodology",
      "/about",
      "/ask-mr-roboto",
    ];
    for (const p of paths) {
      const file = Bun.file(join(repoRoot, "frontend/public", `.${viewFor(p)}`));
      expect(await file.exists()).toBe(true);
    }
    const layoutFile = Bun.file(join(repoRoot, "frontend/public", `.${DASH_LAYOUT_VIEW}`));
    expect(await layoutFile.exists()).toBe(true);
  });

  test("the /terms and /privacy fragments referenced by the catch-all exist on disk", async () => {
    for (const p of ["/terms", "/privacy"]) {
      const file = Bun.file(join(repoRoot, "frontend/public", `.${viewFor(p)}`));
      expect(await file.exists()).toBe(true);
    }
  });

  test("resolves dynamic swarm routes to reusable fragments", () => {
    expect(viewFor("/swarm/members/athena")).toBe("/views/swarm/member.html");
    expect(viewFor("/swarm/members/woon")).toBe("/views/swarm/member.html");
    expect(viewFor("/swarm/takes/4e9991de-0501-44f5-b21d-254acecd15a8")).toBe("/views/swarm/take.html");
    expect(viewFor("/swarm/2026-07-01/woon")).toBe("/views/swarm/session.html");
    expect(viewFor("/swarm/2026-06-25/woon")).toBe("/views/swarm/session.html");
  });

  // Public subject profile (/swarm/subjects/:id, issue #159's reader-facing
  // counterpart). Same dedicated-fragment pattern as /swarm/members/:id
  // above and /admin/swarm/subjects/:id below — PR #327 shipped the route
  // without a test asserting it (issue #340).
  test("resolves the public subject profile route to its own fragment", () => {
    expect(viewFor("/swarm/subjects/robotmoney-vault")).toBe("/views/swarm/subject.html");
    expect(viewFor("/swarm/subjects/woon")).toBe("/views/swarm/subject.html");
    expect(viewFor("/swarm/subjects/robotmoney-vault/")).toBe("/views/swarm/subject.html");
  });

  // Public application-status page (docs/architecture.md §11 R2) — a
  // dedicated fragment for /swarm/apply/<id>, distinct from the plain
  // /swarm/apply application form the id-less path still resolves to via
  // the generic catch-all below.
  test("resolves the application-status route to its own fragment, distinct from the apply form", () => {
    expect(viewFor("/swarm/apply/4e9991de-0501-44f5-b21d-254acecd15a8")).toBe(
      "/views/swarm/apply-status.html",
    );
    expect(viewFor("/swarm/apply/4e9991de-0501-44f5-b21d-254acecd15a8/")).toBe(
      "/views/swarm/apply-status.html",
    );
    expect(viewFor("/swarm/apply")).toBe("/views/swarm/apply.html");
  });

  // Admin swarm operations surface (issue #159) — every nested path in
  // docs/architecture.md §7.1's route list resolves to a shipped
  // fragment, including :id detail pages.
  test("resolves admin swarm operations routes", () => {
    expect(viewFor("/admin")).toBe("/views/admin.html");
    expect(viewFor("/admin/swarm")).toBe("/views/admin/swarm.html");
    expect(viewFor("/admin/swarm/subjects/woon-vault")).toBe("/views/admin/swarm-subject.html");
    expect(viewFor("/admin/swarm/members/athena")).toBe("/views/admin/swarm-member.html");
    expect(viewFor("/admin/swarm/sessions/9f2c1e0a-aaaa-bbbb-cccc-000000000001")).toBe(
      "/views/admin/swarm-session.html",
    );
  });

  test("every admin/swarm route fragment referenced by the router exists on disk", async () => {
    const paths = [
      "/admin",
      "/admin/swarm",
      "/admin/swarm/subjects/woon-vault",
      "/admin/swarm/members/athena",
      "/admin/swarm/sessions/9f2c1e0a-aaaa-bbbb-cccc-000000000001",
      "/swarm/apply",
      "/swarm/apply/4e9991de-0501-44f5-b21d-254acecd15a8",
    ];
    for (const p of paths) {
      const file = Bun.file(join(repoRoot, "frontend/public", `.${viewFor(p)}`));
      expect(await file.exists()).toBe(true);
    }
  });

  // Legacy path redirect (issue #263 pass 2): every old /committee URL
  // (including /admin/committee and /docs/investment-committee) must resolve
  // to the exact same fragment as its renamed /swarm equivalent, never 404.
  test("legacy /committee paths resolve to the same fragment as their renamed /swarm equivalent", () => {
    expect(viewFor("/committee")).toBe(viewFor("/swarm"));
    expect(viewFor("/committee/members/athena")).toBe(viewFor("/swarm/members/athena"));
    expect(viewFor("/committee/subjects/woon")).toBe(viewFor("/swarm/subjects/woon"));
    expect(viewFor("/committee/takes/4e9991de-0501-44f5-b21d-254acecd15a8")).toBe(
      viewFor("/swarm/takes/4e9991de-0501-44f5-b21d-254acecd15a8"),
    );
    expect(viewFor("/committee/apply")).toBe(viewFor("/swarm/apply"));
    expect(viewFor("/committee/apply/4e9991de-0501-44f5-b21d-254acecd15a8")).toBe(
      viewFor("/swarm/apply/4e9991de-0501-44f5-b21d-254acecd15a8"),
    );
    expect(viewFor("/committee/2026-06-25/woon")).toBe(viewFor("/swarm/2026-06-25/woon"));
    expect(viewFor("/admin/committee")).toBe(viewFor("/admin/swarm"));
    expect(viewFor("/admin/committee/subjects/woon-vault")).toBe(viewFor("/admin/swarm/subjects/woon-vault"));
    expect(viewFor("/admin/committee/members/athena")).toBe(viewFor("/admin/swarm/members/athena"));
    expect(viewFor("/admin/committee/sessions/9f2c1e0a-aaaa-bbbb-cccc-000000000001")).toBe(
      viewFor("/admin/swarm/sessions/9f2c1e0a-aaaa-bbbb-cccc-000000000001"),
    );
    expect(viewFor("/docs/investment-committee")).toBe(viewFor("/docs/investment-swarm"));
    expect(viewFor("/docs/investment-committee/how-it-works")).toBe(viewFor("/docs/investment-swarm/how-it-works"));
  });

  test("/swarm contains the hero canvas mount surface", async () => {
    const html = await Bun.file(join(repoRoot, "frontend/public/views/swarm.html")).text();
    expect(viewFor("/swarm")).toBe("/views/swarm.html");
    expect(html).toContain('class="sv__hero-field"');
    expect(html).toContain('x-data="slimeMoldHero()"');
  });

  test("production loader resolves an archived session with camelCase normalization", async () => {
    const detail = await loadArchiveSession("2026-06-25", "woon");

    expect(detail.source).toBe("archive");
    // camelSession returns null for a nullish payload; assert-and-narrow so the
    // remaining assertions typecheck against the non-null session shape.
    if (!detail.session) throw new Error("archive session normalized to null");
    // The archive JSON is snake_case throughout (subject_id, regime_summary,
    // macro_percentile, ...) — the loader must serve the camelCase shape the
    // session view binds to. subjectId (not subject_id) is the exact drift
    // that caused the earlier archive render bug.
    expect(detail.session.subjectId).toBe("woon");
    expect(detail.session.subjectName).toBe("Woon");
    expect(detail.session.regimeSummary?.macroPercentile).toBeGreaterThan(0);
    expect(detail.session.synthesis).toContain("USDC into rmUSDC");

    const takes = detail.takes as Array<{ memberId: string; stance: string; permalinkId: string | null }>;
    expect(takes.map((take) => take.memberId)).toEqual(["athena", "robotmoney", "woon"]);
    expect(takes.find((take) => take.memberId === "woon")?.stance).toBe("constructive");
    // The shipped archive carries no `id` field on its takes — only
    // `member_id` — so every one of these must resolve to no permalink at
    // all rather than /swarm/takes/<member-slug> (issue #359 AC1).
    expect(takes.every((take) => take.permalinkId == null)).toBe(true);
    expect(takes.every((take) => takeHref(take) === null)).toBe(true);

    const rec = detail.session.swarmRecommendation as {
      actions: Array<{ action: string }>;
      disagreements: Array<{ topic: string }>;
    };
    expect(rec.actions.map((action) => action.action)).toContain("rotate");
    expect(rec.disagreements.map((item) => item.topic)).toContain("WOON at 55.8% of book");

    // URL-construction invariant: the loader validated against the sessions
    // index, then fetched the per-session archive file at its canonical path.
    expect(requestedUrls).toContain("/data/swarm/sessions/index.json");
    expect(requestedUrls).toContain("/data/swarm/sessions/2026-06-25-woon.json");
  });

  test("production loader rejects sessions absent from the archive index", async () => {
    // The index gate (not a blind fetch) is what turns a bad date/subject into
    // a clean "missing" error the session view can render.
    expect(loadArchiveSession("2026-06-25", "nope")).rejects.toThrow(
      "archive session missing: 2026-06-25/nope",
    );
  });

  test("production loader resolves the archived member manifest", async () => {
    const member = await loadArchiveMember("woon");

    expect(member?.name).toBe("Woon");
    expect(member?.lens).toBe("machine economy participant");
    expect(member?.mandate).toContain("fellow agent");
    expect(requestedUrls).toContain("/data/swarm/manifests/members/woon.json");
  });

  test("production loader resolves the archived portfolio snapshot", async () => {
    const snapshot = await loadArchiveSnapshot("woon", "2026-06-25");

    // positionRows() in the session view renders these positions verbatim —
    // the token order below is the reference portfolio for the last archived
    // Woon session.
    expect((snapshot?.positions as Array<{ token: string }>).map((p) => p.token)).toEqual([
      "WOON",
      "PEAQ",
      "USDC",
      "ROBOTMONEY",
      "rmUSDC",
      "ETH",
    ]);
    expect(snapshot?.totalValueUsd).toBeCloseTo(44167.4);

    // Missing snapshots degrade to null (the view hides the portfolio panel)
    // rather than failing the whole session render.
    expect(await loadArchiveSnapshot("woon", "1999-01-01")).toBeNull();
  });

  // camelSubject backs both the live /api/swarm/subjects/:id response and
  // the archive manifest loader. The subject endpoint has always returned
  // nft_contracts, but nothing mapped it into camelCase before the public
  // subject profile (issue #340 / PR #327) — the field arrived as
  // `undefined` and every consumer silently rendered nothing.
  test("camelSubject maps nft_contracts to nftContracts", () => {
    const raw = {
      id: "woon",
      name: "Woon",
      nft_contracts: [{ address: "0xf184bdef428148ed4cbb9fab6c3b8bbd9cc3cfbd", chain: "peaq", label: "RoboFarm" }],
    };
    const subject = camelSubject(raw);
    // camelSubject(raw) only returns null for a nullish raw payload; assert-and-
    // narrow so the remaining assertions typecheck against the non-null shape
    // (same pattern as the archive session test above).
    if (!subject) throw new Error("camelSubject(raw) unexpectedly returned null");
    expect(subject.nftContracts).toEqual(raw.nft_contracts);
    expect(subject).not.toHaveProperty("nft_contracts");

    // Tolerates an already-camelCase source too (the live API projects
    // nftContracts directly — see backend/src/swarm/projections.ts).
    const alreadyCamel = camelSubject({ id: "x", nftContracts: [{ address: "0xabc" }] });
    if (!alreadyCamel) throw new Error("camelSubject unexpectedly returned null");
    expect(alreadyCamel.nftContracts).toEqual([{ address: "0xabc" }]);

    // A subject manifest with no NFT contracts declared maps to [], not undefined.
    const noNft = camelSubject({ id: "robotmoney-vault" });
    if (!noNft) throw new Error("camelSubject unexpectedly returned null");
    expect(noNft.nftContracts).toEqual([]);
  });

  // subject.html gates the "Structural notes" panel on `x-show="structuralNotes().length"`,
  // not on the raw field's truthiness. camelSubject defaults a missing
  // structural_notes field to `[]`, which is itself truthy in JS — a plain
  // `x-show="subject.structuralNotes"` would render an empty panel on every
  // subject that declares none. structuralNotesOf must gate on .length.
  test("structuralNotesOf gates on .length, not truthiness of the raw field", () => {
    expect(structuralNotesOf({ structuralNotes: [] })).toEqual([]);
    expect(structuralNotesOf({ structuralNotes: [] }).length).toBe(0);
    expect(structuralNotesOf(camelSubject({ id: "robotmoney-vault" }))).toEqual([]);

    // A real list of notes passes through, filtered of any falsy entries.
    expect(structuralNotesOf({ structuralNotes: ["a", "", "b", null] })).toEqual(["a", "b"]);

    // Older manifests carry a single paragraph instead of a list; that still
    // renders as one note rather than being dropped.
    expect(structuralNotesOf({ structuralNotes: "a single paragraph note" })).toEqual([
      "a single paragraph note",
    ]);

    // No subject at all (still loading / not found) must not throw.
    expect(structuralNotesOf(null)).toEqual([]);
  });

  // issue #359: camelTake used to derive `id` with a member-id fallback
  // (`raw.id || raw.member_id`) purely so x-for had something stable to key
  // on, and takeHref() minted a permalink straight off that same `id`. Every
  // archived take carries only `member_id`, so that produced dead links like
  // /swarm/takes/athena — 3 per session across 32 archived sessions.
  // permalinkId is the fix: a field only a real take id ever populates.
  test("camelTake never mints a permalink out of a member id", () => {
    const memberIdOnly = camelTake({ member_id: "athena", stance: "cautious", confidence: 0.72, body: "..." });
    // The keying fallback (`id`) is preserved for x-for — only the permalink
    // must refuse the member-id fallback.
    expect(memberIdOnly.id).toBe("athena");
    expect(memberIdOnly.permalinkId).toBeNull();
    expect(takeHref(memberIdOnly)).toBeNull();

    const withRealId = camelTake({ id: "take-9f2c1e0a", member_id: "athena", stance: "bullish", confidence: 0.9 });
    expect(withRealId.permalinkId).toBe("take-9f2c1e0a");
    expect(takeHref(withRealId)).toBe("/swarm/takes/take-9f2c1e0a");
  });

  // The member profile page (/swarm/members/:id) builds its rows from two
  // sources — the member-takes endpoint (loadRows) and, on failure, a scan of
  // the sessions index (scanSessions) which also serves the archive. Both
  // used to hand takeHref() the RAW api/archive take object (only
  // `member_id`, never `permalinkId`), so `takeHref(row.take)` returned null
  // for every row on that page and the "Verification receipt" link silently
  // disappeared — never a dead /swarm/takes/<slug> link there, just a
  // permalink that could never appear even for a take with a real id. Routing
  // the row's take through camelTake() (the fix) restores the working link
  // when a real id exists, while still refusing the member-id fallback.
  test("a take with no id, only member_id — the shape loadRows/scanSessions hand to the member view — never resolves to a dead permalink, and a real id still works once camelTake'd", () => {
    const rawMemberViewRow = { member_id: "athena", memberId: "athena", stance: "cautious", confidence: 0.72, body: "...", verified: true };
    // Un-normalized (the pre-fix bug): permalinkId is simply absent.
    expect(takeHref(rawMemberViewRow)).toBeNull();
    // Normalized via camelTake (the fix): still null, because there is no
    // real take id to key a permalink on — not a member-slug link either.
    expect(takeHref(camelTake(rawMemberViewRow))).toBeNull();

    const rawWithRealId = { id: "take-real-1", member_id: "athena", memberId: "athena", stance: "cautious", confidence: 0.72 };
    // Before the fix (raw, never camelTake'd) the link never appears even
    // though a real id exists — takeHref only ever reads `.permalinkId`.
    expect(takeHref(rawWithRealId)).toBeNull();
    // After the fix, camelTake'ing the row restores it.
    expect(takeHref(camelTake(rawWithRealId))).toBe("/swarm/takes/take-real-1");
  });

  // issue #359 AC2: `within_bucket_weights` has been in the session payload
  // all along — the API/archive never stopped serving it — but no surface
  // read it, so an allocation session's own bucket_weights table answered
  // "95/5/0/0" and stopped, on a page whose copy asks "within each bucket are
  // the right constituents weighted correctly?". withinBucketWeightsFrom() is
  // the pure transform behind session.html's `.sv__within` block (the
  // Alpine `withinBucketWeights()` method just delegates to it), exported the
  // same way camelTake/takeHref are so this can be asserted without a
  // browser. This drives it off the real archived fixture that shipped with
  // the fix — 2026-06-13/robotmoney-allocation, which the fix commit verified
  // in-browser rendered "Aave 32% / Morpho 32% / Sky 22% / Compound 14%".
  test("withinBucketWeightsFrom renders the archived allocation session's 4 buckets with production's constituent weights", async () => {
    const detail = await loadArchiveSession("2026-06-13", "robotmoney-allocation");
    if (!detail.session) throw new Error("archive session normalized to null");

    const rec = detail.session.swarmRecommendation as { type: string; within_bucket_weights: Record<string, Record<string, number>> };
    expect(rec.type).toBe("bucket_weights");
    expect(Object.keys(rec.within_bucket_weights)).toHaveLength(4);

    const groups = withinBucketWeightsFrom(rec);
    expect(groups).toHaveLength(4);
    expect(groups.map((g) => g.bucket)).toEqual([
      "conservative defi yield",
      "agent tokens",
      "protocol tokens",
      "real world assets",
    ]);

    // Conservative DeFi Yield: the exact production readout from the fix
    // commit's browser verification (Aave 32 / Morpho 32 / Sky 22 / Compound
    // 14), sorted by weight descending — ties (aave/morpho at 0.32) keep
    // their payload order under a stable sort.
    const conservative = groups[0];
    expect(conservative.items).toEqual([
      { name: "aave", weight: 0.32 },
      { name: "morpho", weight: 0.32 },
      { name: "sky", weight: 0.22 },
      { name: "compound", weight: 0.14 },
    ]);
    // fmtPct1's convention (one decimal place, e.g. "32.0%") is what
    // session.html's `.sv__within-list` binds each item's weight through —
    // confirm the raw numbers this test asserts are exactly what that
    // formatter would print, so a future rounding regression in either place
    // shows up here too.
    const fmtPct1 = (v: number) => `${(v * 100).toFixed(1)}%`;
    expect(conservative.items.map((it) => fmtPct1(it.weight))).toEqual(["32.0%", "32.0%", "22.0%", "14.0%"]);

    // Every group is non-empty (the transform filters out empty buckets) and
    // every weight round-trips to a finite number, not NaN/undefined.
    for (const group of groups) {
      expect(group.items.length).toBeGreaterThan(0);
      for (const item of group.items) expect(Number.isFinite(item.weight)).toBe(true);
    }

    // A recommendation with no within_bucket_weights payload at all (older
    // archived sessions, or a non-allocation subject) must render nothing —
    // the `.sv__within` block's x-show guards on this being empty.
    expect(withinBucketWeightsFrom(null)).toEqual([]);
    expect(withinBucketWeightsFrom({ type: "bucket_weights" })).toEqual([]);
  });
  // ── Archival vs. failed verification (review-data-integrity F2) ───────────
  //
  // `verified: false` used to be rendered with exactly one sentence: "This
  // take's signature did not check out against the member's public key. Treat
  // it as unattributed." That is a statement about a check that RAN AND
  // FAILED. Backporting v0's pre-launch archive put 216 takes on the public
  // surfaces that were never member-signed at all — member key registration
  // did not exist when they were published — so the wrong sentence became the
  // majority case across /swarm/<date>/<subject>, /swarm/takes/<id> and
  // /swarm/members/<id>.
  //
  // The badge state alone is not what was wrong; the WORDING was. So the
  // wording is what is asserted here, on the real shipped helpers.
  test("an archival take is never described as a failed signature check", () => {
    const archival = camelTake({ id: "t1", member_id: "athena", stance: "hold", verified: false, archival: true });
    expect(archival.archival).toBe(true);

    expect(helpers.verifyLabel(archival.verified, archival.archival)).toBe("archived");
    const tip = helpers.verifyTip(archival.verified, archival.archival);
    expect(tip).toContain("never member-signed");
    expect(tip).toContain("not a failed signature check");
    // The exact copy that must not reach these rows.
    expect(tip).not.toContain("did not check out");
    expect(tip).not.toContain("unattributed");
    // Neither the pass mark nor the failure mark: archived is a third state.
    const archMark = helpers.verifyPath(archival.verified, archival.archival);
    expect(archMark).not.toBe(helpers.verifyPath(true, false));
    expect(archMark).not.toBe(helpers.verifyPath(false, false));
  });

  test("a genuinely unverified member submission still gets the failed-check wording", () => {
    // The case the original copy was written for, which must not regress: a
    // real member submission whose signature did not verify.
    const failed = camelTake({ id: "t2", member_id: "athena", stance: "hold", verified: false });
    expect(failed.archival).toBe(false);
    expect(helpers.verifyLabel(failed.verified, failed.archival)).toBe("unverified");
    expect(helpers.verifyTip(failed.verified, failed.archival)).toContain("did not check out");

    const good = camelTake({ id: "t3", member_id: "athena", stance: "hold", verified: true });
    expect(helpers.verifyLabel(good.verified, good.archival)).toBe("verified");
    expect(helpers.verifyTip(good.verified, good.archival)).toContain("key only they hold");
  });

  // Issue #593 / review-data-integrity DI-594-001. The two normalizers every
  // session-page payload passes through dropped the member's public address:
  // camelMember() mapped no `handle` and camelTake() mapped no `memberHandle`,
  // so swarmSessionDetail's `memberById()` could only ever match on `m.id` and
  // `memberHref()` always fell through to the immutable id — while /swarm,
  // which reads the UN-camelized roster, linked the handle. One member, two
  // published addresses. The render-level assertion is in
  // frontend/test/browser/swarm-session.spec.ts; these pin the mappers.
  test("camelMember carries the public handle, and a manifest without one degrades to the legacy id", async () => {
    // A RENAMED member: handle !== id is the case that was never exercised.
    const renamed = camelMember({ id: "athena", handle: "macro-desk", status: "active", name: "Athena" });
    if (!renamed) throw new Error("camelMember normalized a real member row to null");
    expect(renamed.id).toBe("athena");
    expect(renamed.handle).toBe("macro-desk");
    // The id is what takes are signed under and must survive the rename
    // untouched — the handle is only where a reader is sent.
    expect(renamed.id).not.toBe(renamed.handle);

    // The shipped static member manifests predate the column entirely. They
    // must keep normalizing (no handle at all), so an archived page's links
    // fall back to the id exactly as they did before migration 0030.
    const archived = await loadArchiveMember("athena");
    if (!archived) throw new Error("the shipped athena manifest normalized to null");
    expect(archived.id).toBe("athena");
    expect(archived.handle).toBeUndefined();

    expect(camelMember(null)).toBeNull();
  });

  test("camelTake carries memberHandle beside the immutable signed memberId", () => {
    // The API's shape after migration 0030 (snake_case over the wire).
    const live = camelTake({ id: "t9", member_id: "athena", member_handle: "macro-desk", stance: "hold" });
    expect(live.memberId).toBe("athena");
    expect(live.memberHandle).toBe("macro-desk");
    // camelCase producers (the admin/receipt projections) read too, matching
    // the tolerant style of every other key in this mapper.
    expect(camelTake({ id: "t9", memberId: "athena", memberHandle: "macro-desk" }).memberHandle).toBe("macro-desk");

    // The shipped archive's takes carry neither field, so the session page's
    // memberHandleOf() finds a handle in neither of the two sources it reads —
    // the roster and this session's takes (issue #598) — and memberHref() lands
    // on the legacy id, which is still a resolvable public address.
    const archived = camelTake({ member_id: "athena", stance: "hold" });
    expect(archived.memberHandle).toBeUndefined();
    expect(archived.memberId).toBe("athena");
  });

  test("the shipped static archive's takes are archival, so the fallback path cannot claim a failed check either", async () => {
    const detail = await loadArchiveSession("2026-06-25", "woon");
    const takes = detail.takes as Array<{ archival: boolean; verified: unknown }>;
    expect(takes.length).toBeGreaterThan(0);
    // Everything under /data/swarm is v0 content by construction. The files
    // predate the flag and carry no nonce, so loadArchiveSession stamps it.
    expect(takes.every((t) => t.archival === true)).toBe(true);
    for (const t of takes) {
      expect(helpers.verifyTip(t.verified, t.archival)).not.toContain("did not check out");
    }
  });
});
