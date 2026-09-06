// Lockstep guard for the two duplicate `initials()` avatar helpers (issue
// #496, AC7 / test-plan item 4).
//
// `initials()` exists twice, verbatim:
//   * frontend/public/assets/js/app/alpine/views/swarm.js  (swarmView)
//   * frontend/public/assets/js/app/alpine/static-views.js (the shared
//     `helpers` object spread into every static Alpine component)
//
// Nothing enforced that they stay in sync. swarm.js's own comment ("Kept in
// sync with the same helper in static-views.js") was the ONLY link, and no
// test went red on divergence — which is exactly how the `"IC"` (Investment
// Committee) fallback survived the Committee→Swarm rename in two places at
// once, and why fixing it needed a two-file lockstep commit that nothing
// would have caught if only one side had moved.
//
// This drives BOTH copies over the same input table and asserts identical
// output, so a one-sided edit is red. It is a no-DOM/no-Alpine-runtime test:
// same stub-Alpine capture pattern as swarm-synthesis-preview.test.ts and
// swarm-apply-form-and-status.test.ts — `initials()` is pure, so the factory
// is instantiated and the method driven directly, with no init()/network.
//
// Runs in the required unit.yml root job via `bun run test:unit`.
import { describe, expect, test } from "bun:test";
import { registerSwarmView } from "../../../frontend/public/assets/js/app/alpine/views/swarm.js";
import { registerStaticViews } from "../../../frontend/public/assets/js/app/alpine/static-views.js";

type Component = Record<string, unknown>;
type Initials = (name?: string) => string;

// A stub Alpine that records Alpine.data(name, factory) and no-ops every
// other member access.
function captureFactories(register: (a: unknown) => void): Record<string, () => Component> {
  const registry: Record<string, () => Component> = {};
  const stub = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === "data"
          ? (name: string, factory: () => Component) => {
              registry[name] = factory;
            }
          : () => {},
    },
  );
  register(stub);
  return registry;
}

/** Every registered component exposing an `initials()` method, as `name → fn`. */
function initialsCopies(register: (a: unknown) => void): Array<[string, Initials]> {
  return Object.entries(captureFactories(register))
    .map(([name, factory]) => [name, factory()] as const)
    .filter(([, component]) => typeof component.initials === "function")
    .map(([name, component]) => [name, (component.initials as Initials).bind(component)] as [string, Initials]);
}

const swarmCopies = initialsCopies(registerSwarmView as (a: unknown) => void);
const staticCopies = initialsCopies(registerStaticViews as (a: unknown) => void);
const allCopies = [...swarmCopies, ...staticCopies];

// Inputs chosen to exercise every branch of the helper: the fallback (empty /
// whitespace-only / punctuation-only), the single-word and multi-word paths,
// the two-word cap, the punctuation strip that motivated the helper in the
// first place ("woon (test)" → "WT", not "W("), and the \p{L}/\p{N} unicode
// classes the strip is written against.
const NAMES = [
  "",
  "   ",
  "!!!",
  "()",
  "— —",
  "Athena",
  "athena",
  "Robot Money",
  "woon (test)",
  "Robot Money Research Desk",
  "  Robot   Money  ",
  "7Seas Capital",
  "Ödön Éva",
  "Ærö Björk",
  "李 明",
  "Ωμέγα Δέλτα",
  "🚀 rocket",
  "a",
];

describe("initials() exists in two copies that must move in lockstep (issue #496)", () => {
  // Canary against a vacuous pass: if either registration stops exposing an
  // `initials()` copy, the comparison below would compare nothing and pass.
  test("both frontend modules still register an initials() copy", () => {
    expect(swarmCopies.map(([n]) => n)).toContain("swarmView");
    expect(staticCopies.length).toBeGreaterThan(0);
    expect(allCopies.length).toBeGreaterThanOrEqual(2);
  });

  const [referenceName, reference] = swarmCopies.find(([n]) => n === "swarmView") ?? [];

  test("swarmView is the reference copy", () => {
    expect(referenceName).toBe("swarmView");
    expect(typeof reference).toBe("function");
  });

  for (const [name, initials] of allCopies) {
    test(`${name}.initials() agrees with swarmView.initials() on every input`, () => {
      const ref = reference as Initials;
      const mismatches = NAMES.map((n) => ({ name: n, got: initials(n), want: ref(n) })).filter(
        ({ got, want }) => got !== want,
      );
      expect(
        mismatches,
        `${name}.initials() diverged from swarmView.initials() — the two copies must be edited together:\n` +
          mismatches.map((m) => `  ${JSON.stringify(m.name)}: got ${JSON.stringify(m.got)}, want ${JSON.stringify(m.want)}`).join("\n"),
      ).toEqual([]);
    });
  }

  // The behaviour the reference copy is pinned to, so "identical" cannot be
  // satisfied by both copies drifting together into nonsense. The fallback
  // assertion is the #496 regression itself: "IC" was Investment Committee.
  test("the reference copy still produces the documented initials, and its no-initials fallback is not the retired committee string", () => {
    const ref = reference as Initials;
    expect(ref("Robot Money")).toBe("RM");
    expect(ref("woon (test)")).toBe("WT");
    expect(ref("Athena")).toBe("A");
    expect(ref("Robot Money Research Desk")).toBe("RM");
    expect(ref("")).not.toBe("IC");
    expect(ref("!!!")).toBe(ref(""));
  });
});

describe("the retired 'IC' (Investment Committee) literal is gone from the shipped frontend JS", () => {
  test("no initials() copy falls back to \"IC\" for a name with no usable initials", () => {
    for (const [name, initials] of allCopies) {
      expect(initials(""), `${name}.initials("")`).not.toBe("IC");
      expect(initials("!!!"), `${name}.initials("!!!")`).not.toBe("IC");
    }
  });
});
