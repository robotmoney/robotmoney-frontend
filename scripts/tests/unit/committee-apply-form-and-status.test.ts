// Unit coverage for the committee apply page front-end (issue #245, AC2 /
// test-plan item 2): the roster-full waitlist-capture on the apply LANDING
// page (applyForm, frontend/.../alpine/views/apply-form.js) and the
// self-updating post-apply STATUS view's approval transition
// (committeeApplyStatus, frontend/.../alpine/static-views.js).
//
// These are buildless Alpine factories registered via Alpine.data(name, fn).
// We capture the factory functions with a stub Alpine that records only
// .data() (every other Alpine method is a no-op), then instantiate the plain
// data object and drive its PURE methods directly — no Alpine runtime, no DOM,
// no network. init()/refresh()/checkPulse() (which touch location, timers, and
// the real api) are deliberately NOT called: the observable UI state these
// tests assert on is derived synchronously from the component's own fields
// (seats, status) by rosterFull()/seatsOpen()/joinWaitlist() and
// statusPhase()/stepState(), which is exactly what the templates bind to.
import { beforeAll, describe, expect, test } from "bun:test";
import {
  copyablePrompt,
  registerApplyForm,
} from "../../../frontend/public/assets/js/app/alpine/views/apply-form.js";
import { registerStaticViews } from "../../../frontend/public/assets/js/app/alpine/static-views.js";

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

  test("joinWaitlist(): empty email is a no-op; a real email captures interest and marks waitlisted", () => {
    const savedWindow = (globalThis as any).window;
    (globalThis as any).window = { location: { href: "" } };
    try {
      const f = factories.applyForm() as any;
      f.seats = { filled: 10, cap: 10 };

      f.waitEmail = "   ";
      f.joinWaitlist();
      expect(f.waitlisted).toBe(false);
      expect((globalThis as any).window.location.href).toBe("");

      f.waitEmail = "operator@example.test";
      f.joinWaitlist();
      expect(f.waitlisted).toBe(true);
      const href = (globalThis as any).window.location.href as string;
      expect(href.startsWith("mailto:hi@robotmoney.net")).toBe(true);
      expect(href).toContain(encodeURIComponent("operator@example.test"));
    } finally {
      (globalThis as any).window = savedWindow;
    }
  });
});

describe("copyablePrompt: the base-URL fact the canonical prompt cannot carry (issue #245 AC2)", () => {
  test("canonical production origin (or none) → the prompt is returned verbatim", () => {
    expect(copyablePrompt("PROMPT", "https://robotmoney.net")).toBe("PROMPT");
    expect(copyablePrompt("PROMPT", undefined as unknown as string)).toBe("PROMPT");
  });

  // A deliberately ARBITRARY high port, not 48787: demo host ports are drawn
  // free on every run, so an off-production origin is whatever this boot got.
  // (48787 as a fixture would quietly re-teach "the demo port" — the exact
  // assumption that raced the stage tunnel.)
  test("off-production origin → the host's base URL is appended, prompt kept as the prefix", () => {
    const out = copyablePrompt("PROMPT", "http://localhost:53127");
    expect(out.startsWith("PROMPT")).toBe(true);
    expect(out).toBe("PROMPT Use http://localhost:53127 as the API base URL.");
  });
});

describe("committeeApplyStatus: self-updating status view advances on approval (issue #245 AC2)", () => {
  test("applied → 'applied' done, later steps pending, coarse phase pending", () => {
    const s = factories.committeeApplyStatus() as any;
    s.status = { state: "applied" };
    expect(s.stepState("applied")).toBe("done");
    expect(s.stepState("approved")).toBe("pending");
    expect(s.stepState("claimed")).toBe("pending");
    expect(s.statusPhase()).toBe("pending");
  });

  test("approval flips the view: 'approved' becomes done and the phase reads approved (applied stays done)", () => {
    const s = factories.committeeApplyStatus() as any;
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
    const s = factories.committeeApplyStatus() as any;
    s.status = { state: "claimed" };
    expect(s.stepState("applied")).toBe("done");
    expect(s.stepState("approved")).toBe("done");
    expect(s.stepState("claimed")).toBe("done");
    expect(s.statusPhase()).toBe("approved");
  });

  test("rejected → 'applied' still done (it happened), remaining steps moot, phase rejected", () => {
    const s = factories.committeeApplyStatus() as any;
    s.status = { state: "rejected" };
    expect(s.stepState("applied")).toBe("done");
    expect(s.stepState("approved")).toBe("moot");
    expect(s.stepState("claimed")).toBe("moot");
    expect(s.statusPhase()).toBe("rejected");
  });

  test("no status yet → every step reads pending (loading state, never a false 'done')", () => {
    const s = factories.committeeApplyStatus() as any;
    expect(s.status).toBeNull();
    expect(s.stepState("applied")).toBe("pending");
    expect(s.stepState("approved")).toBe("pending");
    expect(s.statusPhase()).toBe("pending");
  });
});

// Guard against a silent-green: the factories must have actually been captured,
// or every assertion above would be running against `undefined`.
describe("harness self-check", () => {
  test("both view factories were registered and are instantiable", () => {
    expect(typeof factories.applyForm).toBe("function");
    expect(typeof factories.committeeApplyStatus).toBe("function");
  });
});
