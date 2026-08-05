// Value pin for the `"SW"` avatar-initials fallback (issue #516).
//
// `initials()` ships as two verbatim copies —
// frontend/public/assets/js/app/alpine/views/swarm.js and
// frontend/public/assets/js/app/alpine/static-views.js — whose only link was a
// "kept in sync" comment. scripts/tests/unit/swarm-initials-lockstep.test.ts
// (PR #481) made a ONE-SIDED edit red, but it deliberately stops short of
// pinning the fallback string: it asserts only that the copies agree and that
// the value is not the retired `"IC"`. A not-equal-to check is satisfied by
// every string in the universe except one, so the replacement `"SW"` — itself a
// constant duplicated across two files — is unpinned, and the `grep '"IC"'`
// that was supposed to backstop it lives in a test PLAN, i.e. it is a human
// step, not a CI step.
//
// This file pins the value, from both sides:
//   1. RUNTIME — every `initials()` copy discovered through a stub Alpine (the
//      same Proxy capture shape as swarm-initials-lockstep.test.ts, so new
//      components are covered without being enumerated here) must return
//      exactly "SW" for a name with no usable initials.
//   2. SOURCE — every `initials()` definition under the shipped alpine tree
//      must literally end in `|| "SW"`. Runtime discovery only reaches copies
//      registered via `Alpine.data`; this half catches a copy that is exported,
//      dead, or not yet wired, which is exactly how the "IC" literal outlived
//      the Committee→Swarm rename in two places at once.
//
// Both halves are driven over planted violations below, so the red direction is
// asserted in CI rather than demonstrated by hand once.
//
// Runs in the required `unit.yml` job — `bun run test:unit`, and again in that
// same workflow's `bun run test` sweep over scripts/tests. It is NOT run by
// integration.yml: #275 moved the root sweep out of it (issue #517 tracks the
// headers that still claim otherwise).
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { registerSwarmView } from "../../../frontend/public/assets/js/app/alpine/views/swarm.js";
import { registerStaticViews } from "../../../frontend/public/assets/js/app/alpine/static-views.js";

/** The one true fallback. Changing it here without changing both JS copies is red. */
const FALLBACK = "SW";

/** Names whose every word strips to nothing under the \p{L}/\p{N} filter. */
const NO_INITIALS = ["", "   ", "!!!", "()", "— —", "  ,  .  ", "🚀"];

/** A name that must NOT reach the fallback, so a stub returning "SW" for everything is caught. */
const REAL_NAME = "Robot Money";

type Component = Record<string, unknown>;
type Initials = (name?: string) => string;

const repoRoot = join(import.meta.dir, "../../..");
const ALPINE_ROOT = "frontend/public/assets/js/app/alpine";

// ── Runtime half ───────────────────────────────────────────────────────────

/** A stub Alpine that records `Alpine.data(name, factory)` and no-ops everything else. */
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

/** Every way a set of `initials()` copies can disagree with the pinned fallback. */
function fallbackProblems(copies: Array<[string, Initials]>, expected: string): string[] {
  const problems: string[] = [];
  if (copies.length === 0) problems.push("no initials() copies discovered — the pin would assert nothing");
  for (const [name, initials] of copies) {
    for (const input of NO_INITIALS) {
      const got = initials(input);
      if (got !== expected) {
        problems.push(`${name}.initials(${JSON.stringify(input)}) === ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
      }
    }
    if (initials(REAL_NAME) === expected) {
      problems.push(`${name}.initials(${JSON.stringify(REAL_NAME)}) fell through to the ${JSON.stringify(expected)} fallback`);
    }
  }
  return problems;
}

const RUNTIME_COPIES = [
  ...initialsCopies(registerSwarmView as (a: unknown) => void),
  ...initialsCopies(registerStaticViews as (a: unknown) => void),
];

// ── Source half ────────────────────────────────────────────────────────────

function walkJs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkJs(full, out);
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

/**
 * Fallback literals of every AGENT-AVATAR `initials()` definition in a source
 * string. Two deliberate narrowings, both documented so the boundary is not
 * mistaken for full coverage:
 *
 *   * The signature must be `initials(name = "")` — that is the duplicated
 *     helper's own signature, so any copy-paste of it is scanned, while the
 *     unrelated PROJECT-name helpers in views/projects.js (`initials(name)`)
 *     and views/dash-project-profile.js (`initials()`) are not. Those read a
 *     project displayName, fall back to `"?"`, exist once each, and are not
 *     what issue #516 pins.
 *   * The literal taken is the TERMINAL `|| "…";` of the return expression, not
 *     the first `||` in the body — `String(name || "")`-style argument defaults
 *     are `||` too and are not the fallback.
 */
function sourceFallbacks(js: string): string[] {
  return [...js.matchAll(/\binitials\s*\(\s*name\s*=\s*""\s*\)\s*\{[\s\S]{0,800}?\|\|\s*"([^"]*)"\s*;/g)].map(
    (m) => m[1] as string,
  );
}

/** Every `initials()` definition in the shipped alpine tree, as `path → fallback literal`. */
function allSourceFallbacks(): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const files = walkJs(join(repoRoot, ALPINE_ROOT));
  if (files.length === 0) throw new Error(`${ALPINE_ROOT} holds no .js files — the source scan would read nothing`);
  for (const file of files) {
    for (const fallback of sourceFallbacks(readFileSync(file, "utf8"))) {
      found.push([relative(repoRoot, file), fallback]);
    }
  }
  return found;
}

const SOURCE_FALLBACKS = allSourceFallbacks();

// ── Tests ──────────────────────────────────────────────────────────────────

describe("the 'SW' initials fallback is pinned at runtime (issue #516)", () => {
  // Canary against a vacuous pass: the pin below iterates this list.
  test("both frontend modules still register initials() copies to pin", () => {
    expect(RUNTIME_COPIES.length).toBeGreaterThanOrEqual(2);
  });

  test(`every discovered copy returns exactly "${FALLBACK}" for a name with no usable initials`, () => {
    const problems = fallbackProblems(RUNTIME_COPIES, FALLBACK);
    expect(
      problems,
      `the avatar fallback is duplicated across ${ALPINE_ROOT}/views/swarm.js and ${ALPINE_ROOT}/static-views.js ` +
        `and must be edited in both:\n${problems.map((p) => `  ${p}`).join("\n")}`,
    ).toEqual([]);
  });

  test("RED CONTROL: a copy that still falls back to the retired \"IC\" is caught", () => {
    const stub: Initials = (name = "") => (name.trim().replace(/[^\p{L}\p{N}]/gu, "") ? "RM" : "IC");
    expect(fallbackProblems([["stubIC", stub]], FALLBACK).join("\n")).toContain('expected "SW"');
  });

  test("RED CONTROL: a copy that returns the fallback for every name is caught", () => {
    expect(fallbackProblems([["stubAlways", () => FALLBACK]], FALLBACK).join("\n")).toContain("fell through");
  });

  test("RED CONTROL: discovering zero copies is caught, never silently green", () => {
    expect(fallbackProblems([], FALLBACK)).not.toEqual([]);
  });
});

describe("the 'SW' initials fallback is pinned in source, including unregistered copies", () => {
  test("the alpine tree still contains the duplicated definitions this pins", () => {
    expect(SOURCE_FALLBACKS.length).toBeGreaterThanOrEqual(2);
    expect(new Set(SOURCE_FALLBACKS.map(([file]) => file)).size).toBeGreaterThanOrEqual(2);
  });

  test(`every initials() definition falls back to the literal "${FALLBACK}"`, () => {
    const problems = SOURCE_FALLBACKS.filter(([, fallback]) => fallback !== FALLBACK).map(
      ([file, fallback]) => `${file}: initials() falls back to ${JSON.stringify(fallback)}, expected ${JSON.stringify(FALLBACK)}`,
    );
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("RED CONTROL: a source copy reverted to \"IC\" is caught by the scan", () => {
    const planted = 'initials(name = "") {\n  return String(name).split(/\\s+/).join("") || "IC";\n}';
    expect(sourceFallbacks(planted)).toEqual(["IC"]);
  });

  test("GREEN CONTROL: the same source shape with the pinned literal scans clean", () => {
    const planted = 'initials(name = "") {\n  return String(name).split(/\\s+/).join("") || "SW";\n}';
    expect(sourceFallbacks(planted)).toEqual([FALLBACK]);
  });

  // The terminal-`||` rule is the part most likely to silently mis-read a
  // future rewrite, so it is pinned against an argument-default `||` too.
  test("the scan reads the terminal fallback, not an earlier argument-default ||", () => {
    const planted = 'initials(name = "") {\n  return String(name || "").slice(0, 2).toUpperCase() || "SW";\n}';
    expect(sourceFallbacks(planted)).toEqual([FALLBACK]);
  });

  test("the scan does not claim the unrelated project-name helpers", () => {
    expect(sourceFallbacks('initials(name) { return String(name || "").slice(0, 2) || "?"; }')).toEqual([]);
    expect(sourceFallbacks('initials() { return this.project.name.slice(0, 2) || "?"; }')).toEqual([]);
  });
});
