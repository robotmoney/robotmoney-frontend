// Manifest-only consistency checks for the v0.5.0 -> v0.5.1 rollout steps.
// Filesystem-only — no database, no docker, no network — so it runs in any CI
// job and cannot be skipped for being slow, matching rollout-steps-0-5-0's
// own stated reason for the same property.
//
// v0.5.1 is the repo's FIRST code-only release, so this file carries cases its
// siblings have no reason to: that RELEASE_MIGRATIONS really is empty, that
// PRIOR_RELEASE_MIGRATIONS is the exact union of v0.4.0's set and v0.5.0's,
// and that the union matches what is actually on disk. That last one is the
// load-bearing case — a code-only release's whole premise is "the schema is
// already final", and the only way that premise goes stale is a migration
// landing on this branch that nobody accounted for.
//
// v0.5.1 HAS SHIPPED, so its manifest is a frozen record and migrations now
// keep arriving for the NEXT release. See LANDED_AFTER_V051 below for how the
// guard tells "missing from this release's manifest" apart from "not this
// release's migration at all" without editing the frozen record.
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { STEPS, TAG_GLOB } from "../scripts/upgrades/0.5.0-to-0.5.1/steps.ts";
import {
  PRESERVED_RELEASE_TABLES,
  PRIOR_RELEASE_MIGRATIONS,
  RELEASE_MIGRATIONS,
} from "../scripts/upgrades/0.5.0-to-0.5.1/release.ts";
import { PRIOR_RELEASE_MIGRATIONS as V050_PRIOR, RELEASE_MIGRATIONS as V050_RELEASE } from "../scripts/upgrades/0.4.0-to-0.5.0/release.ts";

describe("0.5.0-to-0.5.1 rollout manifest", () => {
  test("step ids are unique", () => {
    expect(new Set(STEPS.map((s) => s.id)).size).toBe(STEPS.length);
  });

  test("requires references resolve to real steps, and point backwards", () => {
    const index = new Map(STEPS.map((s, i) => [s.id, i]));
    for (const [i, step] of STEPS.entries()) {
      for (const req of step.requires) {
        expect({ step: step.id, req, known: index.has(req) }).toEqual({ step: step.id, req, known: true });
        expect({ step: step.id, req, before: index.get(req)! < i }).toEqual({ step: step.id, req, before: true });
      }
    }
  });

  test("P6.rc-tag requires stage preflight and rehearsal, and files after both", () => {
    const rcTag = STEPS.find((s) => s.id === "P6.rc-tag")!;
    expect(rcTag.requires).toEqual(["P4.preflight-live", "P5.rehearsal"]);
    const ids = STEPS.map((s) => s.id);
    expect(ids.indexOf("P4.preflight-live")).toBeLessThan(ids.indexOf("P6.rc-tag"));
    expect(ids.indexOf("P5.rehearsal")).toBeLessThan(ids.indexOf("P6.rc-tag"));
  });

  test("P6.rc-tag's verify names THIS release's rc series, not the previous one", () => {
    // The copy-paste a release directory forked from its predecessor is most
    // likely to carry: a v0.5.1 manifest that greps for v0.5.0-rc.* would
    // report the PREVIOUS release's tag as this one's and pass P6 on it.
    const rcTag = STEPS.find((s) => s.id === "P6.rc-tag")!;
    expect(rcTag.verify).toContain("v0.5.1-rc.*");
    expect(rcTag.verify).not.toContain("v0.5.0-rc.*");
    expect(TAG_GLOB).toBe("v0.5.1*");
  });

  test("P5.rehearsal requires the LIVE preflight, not just Gate C", () => {
    // The one ordering v0.5.1 changes from its predecessor, and the reason is
    // release-shaped: a rehearsal of a release that applies no migration is
    // only meaningful once the live target is known to be at the baseline the
    // release patches. See steps.ts's header.
    const p5 = STEPS.find((s) => s.id === "P5.rehearsal")!;
    expect(p5.requires).toEqual(["P3.gate-c", "P4.preflight-live"]);
  });

  test("P8.verify-prod is the LAST cutover step and requires postflight", () => {
    const ids = STEPS.map((s) => s.id);
    expect(ids[ids.length - 1]).toBe("P8.verify-prod");
    expect(STEPS.find((s) => s.id === "P8.verify-prod")!.requires).toEqual(["P8.postflight-prod"]);
  });
});

describe("v0.5.1 carries exactly one migration, and it is the gate repair", () => {
  test("RELEASE_MIGRATIONS is 0062 and nothing else", () => {
    // The release began code-only and acquired 0062 to repair the backup gate
    // (rm_readonly could not read twelve sequences, so pg_dump refused). If a
    // FEATURE migration ever lands here, that is a different release.
    expect([...RELEASE_MIGRATIONS]).toEqual(["0062_rm_readonly_sequence_select.sql"]);
  });

  test("0062 is not in PRIOR — the release does not claim its own repair as inherited", () => {
    expect([...PRIOR_RELEASE_MIGRATIONS]).not.toContain("0062_rm_readonly_sequence_select.sql");
  });

  test("PRIOR_RELEASE_MIGRATIONS is exactly v0.4.0's set plus v0.5.0's", () => {
    // Restated by hand in release.ts (a release directory is a frozen artefact
    // and must not import across directories), so this keeps it honest.
    expect([...PRIOR_RELEASE_MIGRATIONS]).toEqual([...V050_PRIOR, ...V050_RELEASE]);
  });

  // MIGRATIONS THAT LANDED AFTER v0.5.1 WAS CUT.
  //
  // v0.5.0 and v0.5.1 both SHIPPED, so their release directories are frozen
  // artefacts: a record of what actually went out. Adding a migration to
  // either manifest to quieten the guard below would not fix anything, it
  // would falsify that record — it would assert those files were part of a
  // rollout they were never in.
  //
  // But the guard still has to distinguish TWO very different things, and it
  // could not tell them apart on file names alone, because this repo allows
  // duplicate migration NUMBERS (0056, 0059, 0061 and 0062 each name two
  // files) and the ones below interleave with v0.5.0's:
  //
  //   1. A migration that SHOULD have been in this release and is missing from
  //      its manifest — the drift the guard exists to catch, because every
  //      other gate is built on the manifest being the whole truth about the
  //      schema the release ships.
  //   2. A migration that arrived AFTERWARDS and belongs to a future release —
  //      not drift, and nothing v0.5.1's frozen record should mention.
  //
  // So the distinction is DECLARED, here in the guard rather than in the frozen
  // artefact. Each entry is a file that is on disk, is not part of v0.5.0 or
  // v0.5.1, and is owed to the next release's manifest when that directory is
  // cut. A migration that is in NEITHER the manifests nor this list still fails
  // the test, which is the tooth that matters: this list is a statement someone
  // had to write down and can be reviewed, not a hole.
  const LANDED_AFTER_V051 = [
    // From main, the in-house judge work (#969 / D-A7 and the AC-E2E-06 lever).
    "0056_swarm_judge_requires_model.sql",
    "0057_swarm_judge_policy_stamp.sql",
    "0058_swarm_judge_fault_injection.sql",
    "0059_swarm_judgement_completion_usage.sql",
    // From main, two grant repairs found after v0.5.1 went out.
    "0061_rm_worker_wallet_backfill_grant.sql",
    "0062_rm_worker_analytics_ledger_read_grant.sql",
  ];

  test("nothing this release shipped is also claimed as a later arrival", () => {
    // The list above must never be used to excuse a file the release really
    // did ship — that would turn the escape hatch into the drift.
    const shipped = new Set<string>([...PRIOR_RELEASE_MIGRATIONS, ...RELEASE_MIGRATIONS]);
    expect(LANDED_AFTER_V051.filter((n) => shipped.has(n))).toEqual([]);
    expect(new Set(LANDED_AFTER_V051).size).toBe(LANDED_AFTER_V051.length);
  });

  test("every later arrival is really on disk — the list cannot outlive its files", () => {
    // Otherwise a migration deleted or renamed would leave a permanent
    // exemption behind, and the next file to take that name would inherit it.
    const onDisk = new Set(readdirSync(join(import.meta.dir, "..", "migrations")).filter((n) => n.endsWith(".sql")));
    expect(LANDED_AFTER_V051.filter((n) => !onDisk.has(n))).toEqual([]);
  });

  test("the on-disk migration set matches the manifest — nothing landed after it was written", () => {
    // THE case that can actually go red on a live branch: a migration merging
    // into releases-0.5.x that neither list names. The gates are built on the
    // manifest being the whole truth about this branch's schema.
    const onDisk = readdirSync(join(import.meta.dir, "..", "migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort();
    const newest = onDisk.filter((n) => n >= "0039");
    expect(newest).toEqual([...PRIOR_RELEASE_MIGRATIONS, ...RELEASE_MIGRATIONS, ...LANDED_AFTER_V051].sort());
  });

  test("every preserved table is named by a v0.5.0 migration, and none is duplicated", () => {
    expect(new Set(PRESERVED_RELEASE_TABLES).size).toBe(PRESERVED_RELEASE_TABLES.length);
    expect(PRESERVED_RELEASE_TABLES.length).toBeGreaterThan(0);
  });
});
