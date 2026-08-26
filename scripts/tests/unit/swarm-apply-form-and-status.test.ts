// Unit coverage for the swarm apply page front-end (issue #245, AC2 /
// test-plan item 2): the roster-full waitlist-capture on the apply LANDING
// page (applyForm, frontend/.../alpine/views/apply-form.js) and the
// self-updating post-apply STATUS view's approval transition
// (swarmApplyStatus, frontend/.../alpine/static-views.js).
//
// Extended for issue #341 (PR #321 compliance: the disclaimer/recommendation
// actions restore and the application-status rebuild shipped with zero
// EXECUTING tests behind their runtime claims — only markup-substring e2e and
// manual verification had run). The additions below drive, with the same
// no-DOM/no-Alpine-runtime pattern: the Swarm Recommendation action table
// and rationale-suppression on swarmSessionDetail() (AC1), the live status
// panel's windowClosesAt-over-state trust on swarmApplyStatus() (AC2),
// stepClass()/stateChip()/liveStatus() across the five states the PR's
// verification section claims to have manually checked (AC3), and the
// copyablePrompt() roster-URL rewrite, whose existing test fixture never
// contained the URL it claimed to test (AC4). That fixture was later fixed to
// hold a URL the shipped prompt no longer used, so the same vacuity returned
// from the other side — the final describe block (issue #484) drives the real
// constant.
//
// These are buildless Alpine factories registered via Alpine.data(name, fn).
// We capture the factory functions with a stub Alpine that records only
// .data() (every other Alpine method is a no-op), then instantiate the plain
// data object and drive its PURE methods directly — no Alpine runtime, no DOM,
// no network. init()/refresh()/checkPulse() (which touch location, timers, and
// the real api) are deliberately NOT called: the observable UI state these
// tests assert on is derived synchronously from the component's own fields
// (seats, status, session, openSessions, record) by the same derived-state
// methods the templates bind to.
import { beforeAll, describe, expect, test } from "bun:test";
import {
  CANONICAL_ROSTER_URL,
  copyablePrompt,
  registerApplyForm,
} from "../../../frontend/public/assets/js/app/alpine/views/apply-form.js";
import { registerStaticViews } from "../../../frontend/public/assets/js/app/alpine/static-views.js";
import { ONBOARDING_PROMPT } from "@robotmoney/contract";

// A stub Alpine that captures Alpine.data(name, factory) registrations and
// answers any other accessed method with a no-op — registerApplyForm /
// registerStaticViews only need .data(), but the Proxy keeps this robust if
// they ever touch .store()/.magic()/etc. at registration time.
function captureFactories(...registrars: Array<(a: unknown) => void>): Record<string, () => Record<string, unknown>> {
  const registry: Record<string, () => Record<string, unknown>> = {};
  const stub = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === "data"
          ? (name: string, factory: () => Record<string, unknown>) => {
              registry[name] = factory;
            }
          : () => {},
    },
  );
  for (const register of registrars) register(stub);
  return registry;
}

let factories: Record<string, () => Record<string, unknown>>;
beforeAll(() => {
  factories = captureFactories(registerApplyForm as (a: unknown) => void, registerStaticViews as (a: unknown) => void);
});

describe("applyForm: roster-full waitlist capture (issue #245 AC2)", () => {
  test("seats unknown → not roster-full, no seats-open number, no waitlist yet", () => {
    const f = factories.applyForm() as any;
    expect(f.seats).toBeNull();
    expect(f.rosterFull()).toBe(false);
    expect(f.seatsOpen()).toBeNull();
    expect(f.waitlisted).toBe(false);
  });

  test("seats available → not roster-full, seats-open reflects the remainder", () => {
    const f = factories.applyForm() as any;
    f.seats = { filled: 6, cap: 10 };
    expect(f.rosterFull()).toBe(false);
    expect(f.seatsOpen()).toBe(4);
  });

  test("roster full → rosterFull() true and zero seats open (waitlist-capture UI renders)", () => {
    const f = factories.applyForm() as any;
    f.seats = { filled: 10, cap: 10 };
    expect(f.rosterFull()).toBe(true);
    expect(f.seatsOpen()).toBe(0);

    // Over-subscribed never reports a negative open count.
    f.seats = { filled: 12, cap: 10 };
    expect(f.rosterFull()).toBe(true);
    expect(f.seatsOpen()).toBe(0);
  });

  test("joinWaitlist(): empty email is a no-op; a real email captures interest via POST and falls back to mailto on error", async () => {
    const savedWindow = (globalThis as any).window;
    (globalThis as any).window = { location: { href: "" } };
    try {
      const f = factories.applyForm() as any;
      f.seats = { filled: 10, cap: 10 };

      f.waitEmail = "   ";
      await f.joinWaitlist();
      expect(f.waitlisted).toBe(false);
      expect((globalThis as any).window.location.href).toBe("");

      // Test offline/error fallback to mailto
      f.waitEmail = "operator@example.test";
      await f.joinWaitlist();
      expect(f.waitlisted).toBe(true);
      const href = (globalThis as any).window.location.href as string;
      expect(href.startsWith("mailto:hi@robotmoney.net")).toBe(true);
      expect(href).toContain(encodeURIComponent("operator@example.test"));
    } finally {
      (globalThis as any).window = savedWindow;
    }
  });
});

describe("copyablePrompt: the base-URL fact the canonical prompt cannot carry, and the roster-URL rehost (issue #341 AC4)", () => {
  test("canonical production origin (or none) → the prompt is returned verbatim when it carries no roster URL", () => {
    expect(copyablePrompt("PROMPT", "https://robotmoney.network")).toBe("PROMPT");
    expect(copyablePrompt("PROMPT", undefined as unknown as string)).toBe("PROMPT");
  });

  // The literal string the prompt actually ships (see apply-form.js's
  // CANONICAL_ROSTER_URL comment): a fixture that never contains it — "PROMPT"
  // alone, as this test once read — never exercises the rewrite it claims to
  // test.
  //
  // Hand-writing the URL into the fixture is not enough either, and that is how
  // this regressed: the fixture below spelled out https://swarm.robotmoney.net
  // long after the contract constant had been corrected off that host, so these
  // three tests went on passing while the real rewrite matched nothing and every
  // copied prompt kept the production roster URL. Interpolating the constant
  // keeps the fixture honest, and the `describe` block below drives the REAL
  // ONBOARDING_PROMPT so the two can never silently diverge again.
  const FIXTURE = `Read PROMPT. Verify the swarm at ${CANONICAL_ROSTER_URL} before proceeding.`;

  test("canonical production origin (or none) → the roster URL rehosts to the canonical origin's /swarm, no base-URL suffix", () => {
    expect(copyablePrompt(FIXTURE, "https://robotmoney.network")).toBe(
      "Read PROMPT. Verify the swarm at https://robotmoney.network/swarm before proceeding.",
    );
    expect(copyablePrompt(FIXTURE, undefined as unknown as string)).toBe(
      "Read PROMPT. Verify the swarm at https://robotmoney.network/swarm before proceeding.",
    );
  });

  // A deliberately ARBITRARY high port, not 48787: smoke host ports are drawn
  // free on every run, so an off-production origin is whatever this boot got.
  // (48787 as a fixture would quietly re-teach "the smoke port" — the exact
  // assumption that raced the stage tunnel.)
  test("off-production origin → the roster URL rehosts to that origin's own /swarm route, and the base URL is appended", () => {
    const origin = "http://localhost:53127";
    const out = copyablePrompt(FIXTURE, origin);
    expect(out.startsWith(`Read PROMPT. Verify the swarm at ${origin}/swarm`)).toBe(true);
    expect(out).toBe(
      `Read PROMPT. Verify the swarm at ${origin}/swarm before proceeding. Use ${origin} as the API base URL.`,
    );
  });
});

// The rewrite above is only real if the string it splits on is the string the
// SHIPPED prompt actually contains. Every test above uses a fixture this file
// wrote, so all of them pass whether or not that is still true — which is
// exactly how the rehost died unnoticed once the contract constant moved off
// https://swarm.robotmoney.net (issue #484). These drive the real constant.
describe("copyablePrompt fires on the ONBOARDING_PROMPT actually shipped, not just on a local fixture (issue #484)", () => {
  test("the shipped prompt contains CANONICAL_ROSTER_URL — the string the rewrite splits on", () => {
    expect(ONBOARDING_PROMPT).toContain(CANONICAL_ROSTER_URL);
  });

  test("off-production origin rehosts the shipped prompt's roster URL and leaves no production roster link behind", () => {
    const origin = "http://localhost:53127";
    const out = copyablePrompt(ONBOARDING_PROMPT, origin);
    expect(out).toContain(`${origin}/swarm`);
    // The whole point: an agent handed a localhost stack must not be pointed at
    // the production roster to verify that stack's provenance.
    expect(out).not.toContain(CANONICAL_ROSTER_URL);
    expect(out.endsWith(` Use ${origin} as the API base URL.`)).toBe(true);
  });

  test("production origin leaves the shipped prompt byte-identical", () => {
    expect(copyablePrompt(ONBOARDING_PROMPT, "https://robotmoney.network")).toBe(ONBOARDING_PROMPT);
  });
});

describe("swarmApplyStatus: self-updating status view advances on approval (issue #245 AC2)", () => {
  test("applied → 'applied' done, later steps pending, coarse phase pending", () => {
    const s = factories.swarmApplyStatus() as any;
    s.status = { state: "applied" };
    expect(s.stepState("applied")).toBe("done");
    expect(s.stepState("approved")).toBe("pending");
    expect(s.stepState("claimed")).toBe("pending");
    expect(s.statusPhase()).toBe("pending");
  });

  test("approval flips the view: 'approved' becomes done and the phase reads approved (applied stays done)", () => {
    const s = factories.swarmApplyStatus() as any;
    s.status = { state: "applied" };
    expect(s.statusPhase()).toBe("pending");

    // The same object the poller mutates in refresh(); the template binds to
    // these derived methods, so this is the exact update a user sees.
    s.status = { state: "approved" };
    expect(s.stepState("applied")).toBe("done");
    expect(s.stepState("approved")).toBe("done");
    expect(s.stepState("claimed")).toBe("pending");
    expect(s.statusPhase()).toBe("approved");
  });

  test("claimed → the full ladder is done and the phase still reads approved", () => {
    const s = factories.swarmApplyStatus() as any;
    s.status = { state: "claimed" };
    expect(s.stepState("applied")).toBe("done");
    expect(s.stepState("approved")).toBe("done");
    expect(s.stepState("claimed")).toBe("done");
    expect(s.statusPhase()).toBe("approved");
  });

  test("rejected → 'applied' still done (it happened), remaining steps moot, phase rejected", () => {
    const s = factories.swarmApplyStatus() as any;
    s.status = { state: "rejected" };
    expect(s.stepState("applied")).toBe("done");
    expect(s.stepState("approved")).toBe("moot");
    expect(s.stepState("claimed")).toBe("moot");
    expect(s.statusPhase()).toBe("rejected");
  });

  test("no status yet → every step reads pending (loading state, never a false 'done')", () => {
    const s = factories.swarmApplyStatus() as any;
    expect(s.status).toBeNull();
    expect(s.stepState("applied")).toBe("pending");
    expect(s.stepState("approved")).toBe("pending");
    expect(s.statusPhase()).toBe("pending");
  });
});

describe("swarmApplyStatus: pendingWindow()/liveStatus() trust windowClosesAt over the stale 'collecting' label (issue #341 AC2)", () => {
  test("pendingWindow() ignores a collecting session whose window already closed, and surfaces a later one that has not", () => {
    const s = factories.swarmApplyStatus() as any;
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    s.openSessions = [
      { date: "2026-07-28", subjectId: "mav", state: "collecting", windowClosesAt: past },
      { date: "2026-07-30", subjectId: "woon", state: "collecting", windowClosesAt: future },
    ];
    const pending = s.pendingWindow();
    expect(pending).not.toBeNull();
    expect(pending.subjectId).toBe("woon");
    expect(pending.windowClosesAt).toBe(future);
  });

  test("no open sessions at all → pendingWindow() is null", () => {
    const s = factories.swarmApplyStatus() as any;
    s.openSessions = [];
    expect(s.pendingWindow()).toBeNull();
  });

  test("only a stale collecting session (closed window) → pendingWindow() ignores it, and liveStatus() falls through to 'no takes yet' rather than claiming a live window", () => {
    const s = factories.swarmApplyStatus() as any;
    s.id = "member-abc";
    s.member = { name: "Test Agent" };
    s.status = { state: "claimed" };
    s.recordLoaded = true;
    s.record = [];
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    s.openSessions = [{ date: "2026-07-28", subjectId: "mav", state: "collecting", windowClosesAt: past }];

    expect(s.pendingWindow()).toBeNull();
    const live = s.liveStatus();
    expect(live.label).toBe("no takes yet");
  });

  test("a genuinely open window (future windowClosesAt, state='collecting') surfaces through liveStatus() as a live 'window open' panel", () => {
    const s = factories.swarmApplyStatus() as any;
    s.id = "member-abc";
    s.member = { name: "Test Agent" };
    s.status = { state: "claimed" };
    s.recordLoaded = true;
    s.record = [];
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    s.openSessions = [{ date: "2026-07-30", subjectId: "woon", state: "collecting", windowClosesAt: future }];

    const pending = s.pendingWindow();
    expect(pending).not.toBeNull();
    expect(pending.subjectId).toBe("woon");

    const live = s.liveStatus();
    expect(live.tone).toBe("pending");
    expect(live.label).toBe("window open");
    expect(live.live).toBe(true);
    expect(live.url).toBe("/swarm/2026-07-30/woon");
  });
});

describe("swarmApplyStatus: stepClass()/stateChip()/liveStatus() across the states the PR claims to have manually verified (issue #341 AC3)", () => {
  test("applied — step 'applied' done, 'approved' next, 'claimed' pending; chip 'under review'; live panel 'under review'", () => {
    const s = factories.swarmApplyStatus() as any;
    s.id = "member-abc";
    s.member = { name: "Test Agent" };
    s.status = { state: "applied" };

    expect(s.stepClass("applied")).toBe("done");
    expect(s.stepClass("approved")).toBe("next");
    expect(s.stepClass("claimed")).toBe("pending");
    expect(s.stateChip()).toEqual({ label: "under review", tone: "pending" });
    const live = s.liveStatus();
    expect(live.tone).toBe("pending");
    expect(live.label).toBe("under review");
  });

  test("approved — 'applied'/'approved' done, 'claimed' next; chip 'not voting yet'; live panel names the seat, not-voting-yet", () => {
    const s = factories.swarmApplyStatus() as any;
    s.id = "member-abc";
    s.member = { name: "Test Agent" };
    s.status = { state: "approved" };

    expect(s.stepClass("applied")).toBe("done");
    expect(s.stepClass("approved")).toBe("done");
    expect(s.stepClass("claimed")).toBe("next");
    expect(s.stateChip()).toEqual({ label: "not voting yet", tone: "pending" });
    const live = s.liveStatus();
    expect(live.tone).toBe("pending");
    expect(live.label).toBe("not voting yet");
    expect(live.lead).toContain("Test Agent");
  });

  test("claimed-no-takes — key claimed but the vote step reads 'next' (proof isn't the duty), chip 'no takes yet'", () => {
    const s = factories.swarmApplyStatus() as any;
    s.id = "member-abc";
    s.member = { name: "Test Agent" };
    s.status = { state: "claimed" };
    s.recordLoaded = true;
    s.record = [];

    expect(s.stepClass("applied")).toBe("done");
    expect(s.stepClass("approved")).toBe("done");
    // The special case (static-views.js): claimed-but-no-takes-yet reads
    // "next", not "done" — claiming the key is not the duty, voting is.
    expect(s.stepClass("claimed")).toBe("next");
    expect(s.stateChip()).toEqual({ label: "no takes yet", tone: "pending" });
    const live = s.liveStatus();
    expect(live.tone).toBe("pending");
    expect(live.label).toBe("no takes yet");
  });

  test("voting — every step done including 'claimed' once a take exists; chip 'voting'; live panel is the good/voting state", () => {
    const s = factories.swarmApplyStatus() as any;
    s.id = "member-abc";
    s.member = { name: "Test Agent" };
    s.status = { state: "claimed" };
    s.recordLoaded = true;
    s.record = [{ take: { id: "take-1" }, sessionDate: "2026-07-20", subjectId: "mav" }];

    expect(s.stepClass("applied")).toBe("done");
    expect(s.stepClass("approved")).toBe("done");
    expect(s.stepClass("claimed")).toBe("done");
    expect(s.stateChip()).toEqual({ label: "voting", tone: "good" });
    const live = s.liveStatus();
    expect(live.tone).toBe("good");
    expect(live.label).toBe("voting");
    expect(live.url).toBe("/swarm/takes/take-1");
  });

  test("rejected — 'applied' stays done, later steps are moot (not 'pending'); chip 'not accepted'; live panel is the alert/rejected state", () => {
    const s = factories.swarmApplyStatus() as any;
    s.id = "member-abc";
    s.member = { name: "Test Agent" };
    s.status = { state: "rejected" };

    expect(s.stepClass("applied")).toBe("done");
    expect(s.stepClass("approved")).toBe("moot");
    expect(s.stepClass("claimed")).toBe("moot");
    expect(s.stateChip()).toEqual({ label: "not accepted", tone: "alert" });
    const live = s.liveStatus();
    expect(live.tone).toBe("alert");
    expect(live.label).toBe("not accepted");
  });
});

describe("swarmSessionDetail: rollup recommendation renders action rows and suppresses the echoed rationale (issue #341 AC1)", () => {
  test("rollup-shaped session (quorum+stances+actions present) — isRollupRecommendation() true, actions pass through, rationale suppressed", () => {
    const d = factories.swarmSessionDetail() as any;
    d.session = {
      swarmRecommendation: {
        quorum: { submitted: 3, active: 5 },
        stances: { bullish: 2, neutral: 1 },
        actions: [
          { action: "increase", target: "BTC", detail: "Add 2% to the BTC sleeve." },
          { action: "hold", target: "ETH", detail: "No change." },
        ],
        // The aggregator currently fills this with the concatenated take
        // bodies on a rollup — byte-identical to session.synthesis (see the
        // comment above recommendationRationale() in static-views.js) — so it
        // must never reach the page even though it is present right here.
        rationale: "Member A said X. Member B said Y. Member C said Z.",
      },
    };

    expect(d.isRollupRecommendation()).toBe(true);
    expect(d.recommendationActions()).toHaveLength(2);
    expect(d.recommendationActions()[0]).toMatchObject({ action: "increase", target: "BTC" });
    expect(d.recommendationRationale()).toBe("");
    expect(d.hasRecommendationDetail()).toBe(true);
  });

  test("non-rollup recommendation with a real rationale and no actions — rationale passes through untouched, still counts as detail", () => {
    const d = factories.swarmSessionDetail() as any;
    d.session = {
      swarmRecommendation: { type: "narrative", rationale: "The swarm recommends holding." },
    };

    expect(d.isRollupRecommendation()).toBe(false);
    expect(d.recommendationActions()).toEqual([]);
    expect(d.recommendationRationale()).toBe("The swarm recommends holding.");
    expect(d.hasRecommendationDetail()).toBe(true);
  });

  test("no recommendation at all — every derived method reads empty/false, never throws on a missing session", () => {
    const d = factories.swarmSessionDetail() as any;
    d.session = {};

    expect(d.isRollupRecommendation()).toBe(false);
    expect(d.recommendationActions()).toEqual([]);
    expect(d.recommendationRationale()).toBe("");
    expect(d.hasRecommendationDetail()).toBe(false);
  });
});

// Guard against a silent-green: the factories must have actually been captured,
// or every assertion above would be running against `undefined`.
describe("harness self-check", () => {
  test("both view factories were registered and are instantiable", () => {
    expect(typeof factories.applyForm).toBe("function");
    expect(typeof factories.swarmApplyStatus).toBe("function");
  });

  test("swarmSessionDetail was registered and is instantiable (issue #341)", () => {
    expect(typeof factories.swarmSessionDetail).toBe("function");
  });
});
