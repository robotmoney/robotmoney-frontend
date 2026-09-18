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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  test("P8.verify-prod is the LAST cutover step and requires postflight", () => {
    // Schema shape and product behaviour are different questions, asked in
    // that order: postflight proves the migration landed, verify-prod proves
    // the live product satisfies its invariants. Ordering matters because
    // `requires` must point BACKWARDS in manifest order for
    // propagateBlocked() to resolve in one pass.
    const ids = STEPS.map((s) => s.id);
    expect(ids.indexOf("P8.postflight-prod")).toBeLessThan(ids.indexOf("P8.verify-prod"));
    const verify = STEPS.find((s) => s.id === "P8.verify-prod")!;
    expect(verify.requires).toContain("P8.postflight-prod");
    expect(verify.hostRole).toBe("cutover");
    // readonly, not full: a `full` leg drives the pipeline (publishes sessions,
    // spends inference) and would manufacture the very history the readonly
    // legs exist to audit.
    expect(verify.verify).toContain("--tier readonly");
  });

  test("every step's section pointer names a real section of the runbook", () => {
    // The probe prints `section` next to NEXT, so a wrong pointer sends an
    // operator to the wrong page. P3.backup/P3.gate-c pointed at §3
    // ("Preconditions") when the backup and restore proof live at §4.2.
    const runbook = readFileSync(join(import.meta.dir, "..", "..", "docs", "runbooks", "v0-5-0-rollout.md"), "utf8");
    for (const step of STEPS) {
      // The runbook spells sections three ways, and all three are legitimate:
      //   `## 4. Baseline…`      chapter heading, number then a dot
      //   `### 5.1 Cut the RC…`  sub-heading, number then a SPACE (no dot)
      //   `**4.2 — Backup…`      bolded subsection, number then an em dash
      // The section number itself contains dots, so escape it rather than
      // letting `.` match any character.
      const n = step.section.replace("§", "").replace(/\./g, "\\.");
      const found = new RegExp(`^#{2,3} ${n}[.\\s]|^\\*\\*${n} —`, "m").test(runbook);
      expect({ step: step.id, section: step.section, found }).toEqual({ step: step.id, section: step.section, found: true });
    }
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
