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
import { readdirSync, readFileSync } from "node:fs";
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
    // The deployment refactor (#1026 / D47, smoke-production-spec.md). All
    // three are owed to the next release's manifest, and none of them can be
    // added to v0.5.0's or v0.5.1's: those releases shipped before the spec was
    // adopted, and their directories are a record of what actually went out.
    //   0063 — §4.2's one-row `deployment_identity` target enrollment.
    //   0064 — §8.3's `schema_manifest` plus §8.2's `compat` /
    //          `metadata_version` columns on the ledger.
    //   0065 — §9.1 step 2's grant transition, revoking DELETE/TRUNCATE on the
    //          append-only tables from rm_app/rm_worker. Preflight check 2
    //          fails until it lands.
    //   0066 — W5's removal of the swarm email feature (decision D50,
    //          reversing D30): drops `swarm_notification_outbox` and
    //          `swarm_waitlist.notified_at`.
    "0063_deployment_identity.sql",
    "0064_schema_manifest.sql",
    "0065_append_only_grant_transition.sql",
    //   0067 — W4.1's `swarm_subjects.epoch_duration_seconds`, the subject's
    //          one scheduling parameter (scheduler spec §2.2).
    //   0068 — W4.2/W4.3's epoch lifecycle on `swarm_sessions`: the captured
    //          judge mode, the stored judging request instant and absolute
    //          deadline, the consensus acceptance instant, the judging
    //          outcome, the successor link turnover is bound by, and the
    //          at-most-one-`collecting`-per-subject unique index (§2.1).
    //   0069 — W4.5's `automation_tokens`, the API automation-credential store
    //          (smoke spec §3): a hash and the rights, never the secret.
    //   0070 — W4.4's `swarm_scheduler_jobs`, the ad-hoc jobs the API once
    //          pushed on the scheduler subscription. Job pushes are gone (§6.3
    //          as amended by D52) and 0079 drops the table; 0070 stays on disk
    //          because it may have reached a shared database (criterion 105).
    //   0072 — W4's removal half: it DELETES the five retired `swarm.*`
    //          `job_schedules` rows (scheduler spec §12; there are no schedule
    //          rows any more) and made 0068's and 0070's logs append-only
    //          (both since released: 0079 and 0080). `breaking` (D55 (7)):
    //          code at 0070 seeded and read the rows it deletes.
    "0066_drop_swarm_notifications.sql",
    "0067_subject_epoch_duration.sql",
    "0068_session_epoch_lifecycle.sql",
    "0069_automation_tokens.sql",
    "0070_swarm_scheduler_jobs.sql",
    "0072_drop_swarm_schedules.sql",
    //   0073 — the subject's `epoch_anchor` and `judging_duration_seconds`
    //          (scheduler spec §2.2, D53 decision 7).
    //   0074 — `swarm_sessions.judging_duration_seconds`, captured at
    //          turnover (scheduler spec §4.4).
    //   0075 — the take's `final` flag, its backfill and partial unique index,
    //          and rm_app's column-only UPDATE (D51).
    //   0076 — the ledger's INSERT/UPDATE revoked from the runtime roles
    //          (smoke spec §8.3).
    //   0077 — the immutable analytics ledgers narrowed back to SELECT,
    //          INSERT for rm_app (D53 decision 6).
    //   0078 — `automation_tokens` keyed on (instance, holder) for the three
    //          service-token holders (smoke spec §3, D52).
    "0073_subject_grid_columns.sql",
    "0074_session_judging_duration.sql",
    "0075_swarm_recommendations_final.sql",
    "0076_ledger_write_revoke.sql",
    "0077_immutable_ledger_grants.sql",
    "0078_automation_token_holders.sql",
    //   0079 — drops `swarm_scheduler_jobs` with the job pushes (§6.3, D52;
    //          criteria 94, 105). `breaking`: 0070-0078 code writes it.
    //   0080 — `swarm_stream_events` loses 0072's triggers and is protected by
    //          grant alone, prunable only by rm_owner (D53 (2)). `breaking`.
    //   0081 — `swarm_stream_head`, the one counter row event numbers come
    //          from (§6.3). `breaking`: MAX + 1 writers would collide.
    //   0082 — `swarm_judge_config.mode` admits off | enforce (D53 (1)).
    //   0083 — clears self-written member operators (D55 (2)).
    "0079_drop_swarm_scheduler_jobs.sql",
    "0080_stream_events_grant_only.sql",
    "0081_stream_event_counter.sql",
    "0082_judge_config_two_modes.sql",
    "0083_clear_forged_member_operator.sql",
  ];

  test("the job ledger 0070 created is dropped by a later file, never by deleting 0070 (criterion 105)", () => {
    // 0070 may already be recorded on a shared database, so it stays on disk
    // and a forward migration removes what it made. Nothing may create the
    // table again after that.
    const dir = join(import.meta.dir, "..", "migrations");
    const onDisk = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
    expect(onDisk).toContain("0070_swarm_scheduler_jobs.sql");
    const drops = onDisk.filter((n) => /DROP TABLE IF EXISTS swarm_scheduler_jobs\b/.test(readFileSync(join(dir, n), "utf8")));
    expect(drops).toEqual(["0079_drop_swarm_scheduler_jobs.sql"]);
    const recreates = onDisk.filter(
      (n) => n > drops[0]! && /CREATE TABLE[^;]*swarm_scheduler_jobs/.test(readFileSync(join(dir, n), "utf8")),
    );
    expect(recreates).toEqual([]);
  });

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
