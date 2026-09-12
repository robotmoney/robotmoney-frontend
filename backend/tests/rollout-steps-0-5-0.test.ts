// Manifest-only consistency checks for the v0.4.0 -> v0.5.0 rollout steps.
// Filesystem-only — no database, no docker, no network — so it runs in any CI
// job and cannot be skipped for being slow, matching
// rollout-steps-0-3-0.test.ts's own stated reason for the same property.
//
// Deliberately NOT the full runbook<->manifest ```yaml step block matcher
// 0.2.2-to-0.3.0/0.3.0-to-0.4.0's sibling tests use: v0.4.0 dropped that
// heavyweight format in favor of prose cross-referencing release-runbooks.md's
// generic §4 gates (docs/runbooks/v0-4-0-rollout.md has no yaml step blocks
// at all), and v0-5-0-rollout.md follows that same, more recent convention.
// What this file DOES pin — `requires` pointing backwards and resolving to
// real steps — is exactly the invariant rollout-where.ts's propagateBlocked()
// depends on (its own header: "ONE FORWARD PASS SUFFICES because `requires`
// always point BACKWARDS in manifest order"), and the one this release
// actually exercises for the first time: P6.rc-tag is the first step in any
// release's manifest whose `requires` isn't merely decorative — the RC tag is
// cut only after P4.preflight-live and P5.rehearsal both pass
// (release-runbooks.md §3, revised 2026-09-11), reversing every prior
// release's tag-first order.
import { describe, expect, test } from "bun:test";
import { STEPS } from "../scripts/upgrades/0.4.0-to-0.5.0/steps.ts";

describe("0.4.0-to-0.5.0 rollout manifest", () => {
  test("step ids are unique", () => {
    expect(new Set(STEPS.map((s) => s.id)).size).toBe(STEPS.length);
  });

  test("requires references resolve to real steps, and point backwards", () => {
    const index = new Map(STEPS.map((s, i) => [s.id, i]));
    for (const [i, step] of STEPS.entries()) {
      for (const req of step.requires) {
        expect({ step: step.id, req, known: index.has(req) }).toEqual({ step: step.id, req, known: true });
        // A prerequisite that comes LATER in manifest order would make the
        // probe's "first not-ok step is next" rule pick an unreachable step —
        // rollout-where.ts's propagateBlocked() assumes this holds and does
        // not check it itself.
        expect({ step: step.id, req, before: index.get(req)! < i }).toEqual({ step: step.id, req, before: true });
      }
    }
  });

  test("P6.rc-tag requires stage preflight and rehearsal, and files after both in manifest order", () => {
    // The one step in this release whose position in the array is not merely
    // cosmetic: rollout-where.ts's NEXT is "the first not-ok step in manifest
    // order", so P6.rc-tag being physically AFTER P4/P5 is what actually makes
    // NEXT skip past it to P3.backup while a fresh release has nothing else
    // done yet — the exact behavior a probe run against this manifest must show.
    const rcTag = STEPS.find((s) => s.id === "P6.rc-tag")!;
    expect(rcTag.requires).toEqual(["P4.preflight-live", "P5.rehearsal"]);
    const ids = STEPS.map((s) => s.id);
    expect(ids.indexOf("P4.preflight-live")).toBeLessThan(ids.indexOf("P6.rc-tag"));
    expect(ids.indexOf("P5.rehearsal")).toBeLessThan(ids.indexOf("P6.rc-tag"));
  });

  test("P8.postflight-prod requires the RC tag in addition to preflight and rehearsal", () => {
    // Production postflight runs against a deployed RC — it should not be
    // gradeable as unblocked while no RC has even been cut yet.
    const postflight = STEPS.find((s) => s.id === "P8.postflight-prod")!;
    expect(postflight.requires).toContain("P6.rc-tag");
  });

  test("P6.rc-tag is derived (a git fact, not a receipt-backed script step)", () => {
    const rcTag = STEPS.find((s) => s.id === "P6.rc-tag")!;
    expect(rcTag.derived).toBe(true);
    // rollout-where.ts's evaluate() special-cases any id ENDING IN ".rc-tag" —
    // not the historical exact literal "P2.rc-tag" — precisely so a release
    // can renumber this step's phase without silently falling through to the
    // generic "no receipt" evaluation path.
    expect(rcTag.id.endsWith(".rc-tag")).toBe(true);
  });
});
