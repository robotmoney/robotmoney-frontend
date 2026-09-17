// The glob-group factories must reproduce, byte for byte and IN ORDER, the
// arrays the two release manifests declare by hand today.
//
// This lands BEFORE either steps.ts is rewired, and every expectation is read
// off the LIVE manifests rather than transcribed from them. That ordering is
// the point: if a factory is wrong, it is wrong here, against the code as it
// shipped — not against a fixture written by someone already looking at the
// replacement.
//
// WHY ORDER. rollout-steps*.test.ts compares each step's `dependsOn` to the
// `depends-on:` block in the runbook markdown with toEqual, which is ordered.
// A factory that produced the right SET in the wrong ORDER would pass a casual
// eye, fail those suites, and — if someone "fixed" it by reordering the
// runbook instead — silently rewrite committed rollout documents.
import { describe, expect, test } from "bun:test";
import {
  APP_CODE,
  RESTORE_CODE,
  postflightCode,
  preflightCode,
  stepById,
} from "../scripts/lib/rollout-manifest.ts";
import type { RolloutStep } from "../scripts/lib/rollout-manifest.ts";
import { EVIDENCE_DIR } from "../scripts/lib/rollout-signing.ts";
import { STEPS as STEPS_022 } from "../scripts/upgrades/0.2.1-to-0.2.2/steps.ts";
import { STEPS as STEPS_030 } from "../scripts/upgrades/0.2.2-to-0.3.0/steps.ts";
import { COMMITTED_EVIDENCE_DIR, STEPS as STEPS_040 } from "../scripts/upgrades/0.3.0-to-0.4.0/steps.ts";

interface ReleaseUnderTest {
  name: string;
  dir: string;
  steps: RolloutStep[];
  /** The release-specific source postflight certifies the behaviour of. */
  certifies: string[];
}

/** Each live release, with the two facts the factories take as parameters. */
const RELEASES: ReleaseUnderTest[] = [
  {
    name: "v0.2.2",
    dir: "0.2.1-to-0.2.2",
    steps: STEPS_022,
    // AC2 calls the real handle derivation rather than a paraphrase, so a
    // change to it changes what postflight certifies.
    certifies: ["backend/src/swarm/handle.ts"],
  },
  {
    name: "v0.3.0",
    dir: "0.2.2-to-0.3.0",
    steps: STEPS_030,
    // seed() decides whether ops.repair_gaps exists and what catchup_policy the
    // wallet samplers carry, so checks 3 and 5 certify its output.
    certifies: ["backend/src/db/seed.ts"],
  },
];

describe.each(RELEASES)("$name glob groups round-trip through the factories", (rel) => {
  const dep = (id: string) => {
    const s = stepById(rel.steps, id);
    expect({ id, found: s !== undefined }).toEqual({ id, found: true });
    return s!.dependsOn;
  };

  test("preflightCode() reproduces P4.preflight-live's dependsOn", () => {
    expect(dep("P4.preflight-live")).toEqual(preflightCode(rel.dir));
  });

  test("postflightCode() reproduces P8.postflight-prod's dependsOn", () => {
    expect(dep("P8.postflight-prod")).toEqual(postflightCode(rel.dir, rel.certifies));
  });

  test("APP_CODE reproduces P7.cutover's dependsOn", () => {
    expect(dep("P7.cutover")).toEqual([...APP_CODE]);
  });

  test("P3.gate-c is preflight + restore + this release's restore-check, in that order", () => {
    expect(dep("P3.gate-c")).toEqual([
      ...preflightCode(rel.dir),
      ...RESTORE_CODE,
      `backend/scripts/upgrades/${rel.dir}/restore-check.ts`,
    ]);
  });

  test("the release-specific `certifies` entry sits before backend/migrations/**", () => {
    // The one ordering a caller could plausibly get wrong by appending.
    const built = postflightCode(rel.dir, rel.certifies);
    expect(built.indexOf(rel.certifies[0]!)).toBe(built.indexOf("backend/migrations/**") - 1);
  });
});

describe("the shared groups are genuinely shared", () => {
  test("both releases' P7.cutover declare the identical APP_CODE array", () => {
    const a = stepById(RELEASES[0].steps, "P7.cutover")!.dependsOn;
    const b = stepById(RELEASES[1].steps, "P7.cutover")!.dependsOn;
    expect(a).toEqual(b);
  });

  test("RESTORE_CODE and APP_CODE are frozen — a caller cannot mutate the shared array", () => {
    expect(Object.isFrozen(RESTORE_CODE)).toBe(true);
    expect(Object.isFrozen(APP_CODE)).toBe(true);
  });

  test("no glob group names backend/scripts/** — that would cross-invalidate the gates", () => {
    // A change to stage-rehearsal.ts must not invalidate a preflight run.
    for (const g of [...APP_CODE, ...RESTORE_CODE, ...preflightCode("X"), ...postflightCode("X", ["Y"])]) {
      expect({ g, crossCutting: g === "backend/scripts/**" }).toEqual({ g, crossCutting: false });
    }
  });
});

// ── committed rollout evidence must not invalidate the step after it ────────
//
// Receipts now get a redacted, signed copy committed INTO the tree. That makes
// writing evidence a code change, and a code change is exactly what
// rollout-where.ts's drift axis treats as invalidating: if a committed receipt
// path matched any step's `dependsOn`, recording P4's receipt would appear in
// `git diff <P5's sha>..HEAD` and smoke P5 back to `invalid`. Evidence would
// destroy evidence, and the more of the rollout you recorded the less of it
// would count.
//
// The property is asserted against EVERY step of EVERY live release, including
// the two that do not commit evidence at all — they share the glob-group
// factories, so a group that started matching would break them too. Mirrors the
// existing "no glob group names backend/scripts/**" case: same failure mode,
// same shape.
describe("committed evidence paths match no step's dependsOn glob", () => {
  const LIVE: { name: string; steps: RolloutStep[] }[] = [
    { name: "v0.2.2", steps: STEPS_022 },
    { name: "v0.3.0", steps: STEPS_030 },
    { name: "v0.4.0", steps: STEPS_040 },
  ];

  /** Every shape a file in the committed evidence tree can take. */
  const EVIDENCE_PATHS = [
    `${EVIDENCE_DIR}/allowed-signers`,
    `${EVIDENCE_DIR}/${COMMITTED_EVIDENCE_DIR}/P4.preflight-live.json`,
    `${EVIDENCE_DIR}/${COMMITTED_EVIDENCE_DIR}/P4.preflight-live.json.sig`,
    `${EVIDENCE_DIR}/${COMMITTED_EVIDENCE_DIR}/P8.postflight-prod.json`,
    `${EVIDENCE_DIR}/${COMMITTED_EVIDENCE_DIR}/P8.postflight-prod.json.sig`,
  ];

  for (const rel of LIVE) {
    test(`${rel.name}: no step's dependsOn matches a committed-evidence path`, () => {
      const hits: string[] = [];
      for (const step of rel.steps) {
        for (const path of EVIDENCE_PATHS) {
          for (const glob of step.dependsOn) {
            // Bun.Glob is the SAME matcher rollout-where.ts's evaluate() uses,
            // so this asserts the real behaviour rather than an approximation.
            if (new Bun.Glob(glob).match(path)) hits.push(`${step.id}: ${glob} matches ${path}`);
          }
        }
      }
      expect(hits).toEqual([]);
    });
  }

  test("every live release is represented, and each carries steps that declare globs", () => {
    // Guards the cases above against going vacuous: a release whose steps all
    // had empty dependsOn would pass while proving nothing.
    expect(LIVE.map((r) => r.name)).toEqual(["v0.2.2", "v0.3.0", "v0.4.0"]);
    for (const rel of LIVE) {
      expect({ release: rel.name, hasGlobs: rel.steps.some((s) => s.dependsOn.length > 0) }).toEqual({
        release: rel.name,
        hasGlobs: true,
      });
    }
  });

  test("RED CONTROL: the matcher does match a path a glob group really covers", () => {
    // `scripts/**` is in APP_CODE. If the evidence tree had been put under
    // scripts/, every assertion above would be red — which is the proof that
    // they are not passing because Bun.Glob silently matches nothing.
    expect(new Bun.Glob("scripts/**").match("scripts/lib/restore-container.ts")).toBe(true);
    expect(new Bun.Glob("scripts/**").match(`scripts/${EVIDENCE_DIR}/allowed-signers`)).toBe(true);
  });
});
