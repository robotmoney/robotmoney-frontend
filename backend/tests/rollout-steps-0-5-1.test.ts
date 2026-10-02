// Manifest-only consistency checks for the v0.5.0 -> v0.5.1 release record.
// Filesystem-only: no database, no docker, no network.
//
// v0.5.1 SHIPPED (tag v0.5.1). Production recorded v0.5.0's set plus
// 0062_rm_readonly_sequence_select (applied out of band on 2026-09-22) before
// it, and v0.5.1 applied exactly 0061_rm_worker_wallet_backfill_grant and
// 0063_swarm_judge_model_default. The manifest is a frozen record of that, so
// migrations arriving later are declared in LANDED_AFTER_V051 below rather than
// edited into it. The v0.5.1 steps, preflight and rehearsal tooling main once
// carried described a different release (0062 as the one migration) and was
// retired with issue 1074.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PRIOR_RELEASE_MIGRATIONS,
  RELEASE_MIGRATIONS,
  TAG_GLOB,
} from "../scripts/upgrades/0.5.0-to-0.5.1/release.ts";
import { PRIOR_RELEASE_MIGRATIONS as V050_PRIOR, RELEASE_MIGRATIONS as V050_RELEASE } from "../scripts/upgrades/0.4.0-to-0.5.0/release.ts";

describe("v0.5.1 as production recorded it", () => {
  test("the tag glob names v0.5.1", () => {
    expect(TAG_GLOB).toBe("v0.5.1*");
  });

  test("RELEASE_MIGRATIONS is 0061 and 0063: what v0.5.1 applied to production", () => {
    expect([...RELEASE_MIGRATIONS]).toEqual([
      "0061_rm_worker_wallet_backfill_grant.sql",
      "0063_swarm_judge_model_default.sql",
    ]);
  });

  test("0062 is already recorded before v0.5.1: it was applied out of band on 2026-09-22", () => {
    expect([...PRIOR_RELEASE_MIGRATIONS]).toContain("0062_rm_readonly_sequence_select.sql");
    expect([...RELEASE_MIGRATIONS]).not.toContain("0062_rm_readonly_sequence_select.sql");
  });

  test("PRIOR_RELEASE_MIGRATIONS is v0.4.0's set, v0.5.0's, and the out-of-band 0062", () => {
    expect([...PRIOR_RELEASE_MIGRATIONS]).toEqual([
      ...V050_PRIOR,
      ...V050_RELEASE,
      "0062_rm_readonly_sequence_select.sql",
    ]);
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
    // From main, a grant repair and the bare wire id for the judge model.
    "0062_rm_worker_analytics_ledger_read_grant.sql",
    "0081_swarm_judge_model_bare_id.sql",
    // From main, the analytics ledger compaction and vintage repair (#1035,
    // #1046, #1050, #1051, decision D56). It shares the number 0080 with the
    // deployment refactor's 0080_stream_events_grant_only.sql; the runner
    // orders by file name, so the two do not collide.
    "0080_analytics_ledger_compaction.sql",
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
    //   0084 — admin session and passkey `revoked_at` tombstones (D55 (6)).
    //   0085 — admin WebAuthn challenge `consumed_at` tombstone (D55 (6)).
    //   0086 — wallet samples' `superseded_at` and live-row keys (D55 (6)).
    //   0087 — `swarm_member_keys.spoof_generation_id` (smoke spec §6.4).
    //          All four `additive`: the code that writes them lands in wave 5.
    "0084_admin_revocation_tombstones.sql",
    "0085_webauthn_challenge_consumed_at.sql",
    "0086_wallet_sample_superseded_at.sql",
    "0087_member_key_spoof_generation.sql",
    //   0088 — the 32 fixed WebAuthn challenge slots (D55 (6)). `breaking`:
    //          older code INSERTs and DELETEs challenges.
    //   0089 — DELETE and TRUNCATE revoked from every runtime role on every
    //          table (D55 (6), smoke spec §9.1 step 3). `breaking`.
    //   0090 — `swarm_stream_events`' comment names the 7-day prune window
    //          (D55 (12)).
    //   0091 — rm_worker INSERT on the two wallet evidence tables, which the
    //          wallet repair pass copies a day into before rewriting it.
    "0088_webauthn_challenge_slots.sql",
    "0089_revoke_runtime_delete.sql",
    "0090_stream_events_retention_comment.sql",
    "0091_rm_worker_wallet_evidence_insert.sql",
    "0092_drop_swarm_judge_fault_injection.sql",
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
});
