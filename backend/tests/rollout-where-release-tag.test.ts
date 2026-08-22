// The one fact the where.ts lift turned from a literal into a derivation.
//
// Each release's probe used to spell its own version out: `ctx.tags.includes("v0.3.0")`,
// `"v0.3.0 exists"`, `"v0.3.0 not cut"`. Collapsing the copies replaced all three
// with releaseTag(TAG_GLOB) — `v0.3.0*` minus its trailing `*`.
//
// That is a good trade only while the derivation is right, and the probe golden
// does NOT cover it: the golden pins the receipt-backed rows, while P9.tag is
// derived from git tags the fixture cannot control, so its `because` is left
// unpinned there on purpose. This file is the missing half.
//
// It checks the derivation against a SECOND, independent statement of the same
// fact — the tag the step's own `verify` command tells an operator to cut. Two
// sources that must agree, neither transcribed into this file: a wrong glob, a
// wrong slice, or a renamed tag breaks the agreement rather than passing
// quietly.
import { describe, expect, test } from "bun:test";
import { releaseTag } from "../scripts/lib/rollout-where.ts";
import { stepById } from "../scripts/lib/rollout-manifest.ts";
import type { RolloutStep } from "../scripts/lib/rollout-manifest.ts";
import { STEPS as STEPS_022, TAG_GLOB as GLOB_022 } from "../scripts/upgrades/0.2.1-to-0.2.2/steps.ts";
import { STEPS as STEPS_030, TAG_GLOB as GLOB_030 } from "../scripts/upgrades/0.2.2-to-0.3.0/steps.ts";

interface Release {
  name: string;
  steps: RolloutStep[];
  tagGlob: string;
}

const RELEASES: Release[] = [
  { name: "v0.2.2", steps: STEPS_022, tagGlob: GLOB_022 },
  { name: "v0.3.0", steps: STEPS_030, tagGlob: GLOB_030 },
];

describe("releaseTag() — the version literal the probe no longer repeats", () => {
  test("strips the trailing glob star", () => {
    expect(releaseTag("v0.2.2*")).toBe("v0.2.2");
    expect(releaseTag("v0.3.0*")).toBe("v0.3.0");
  });

  test("a glob with no star is returned whole, not silently truncated", () => {
    // Degrades to "look for this tag literally" rather than to a wrong tag.
    expect(releaseTag("v1.0.0")).toBe("v1.0.0");
  });

  test.each(RELEASES)("$name: the derived tag is the one P9.tag tells the operator to cut", (rel) => {
    const step = stepById(rel.steps, "P9.tag");
    expect({ found: step !== undefined }).toEqual({ found: true });

    // The independent source: `git tag [-a] <tag> ...` out of the verify command.
    const cut = step!.verify.match(/git tag (?:-a )?(\S+)/)?.[1];
    expect({ release: rel.name, cut: cut ?? null }).toEqual({
      release: rel.name,
      cut: releaseTag(rel.tagGlob),
    });
  });

  test.each(RELEASES)("$name: P9.tag cites a runbook section, which the probe quotes back", (rel) => {
    // `${tag} not cut — correct until ${step.section} is clean` is assembled
    // from the manifest, so an empty or unprefixed section would print a
    // half-finished sentence at the one moment an operator is reading closely.
    const step = stepById(rel.steps, "P9.tag")!;
    expect({ release: rel.name, section: step.section }).toEqual({
      release: rel.name,
      section: expect.stringMatching(/^§[\d.]+$/) as unknown as string,
    });
  });
});
