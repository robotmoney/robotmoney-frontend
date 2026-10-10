// The one supported baseline is production's 76-name ledger, and the pending
// 0.5.x -> 0.6.0 migrations are numbered so the gap rule never refuses them
// (issue 1097; smoke-production-spec.md §9.1, D55 (8)).
//
// Two things must hold together, and each alone is not enough:
//
//   1. The ledger match is EXACT: 76 names match, 75 or 77 do not, and neither
//      does a renamed file. (The first production migrate refuses any other
//      ledger; first-production-migrate.test.ts drives that through the real
//      command.)
//   2. Every file production has not run sorts either below the identity
//      migration (the five files the identity-first pass is allowed to apply
//      under a recorded higher name, §9.1 "The normal path accepts the state
//      the pass leaves") or above the LAST name production records. A pending
//      file between the two is a gap: `assertBaselineGap` in
//      backend/scripts/migrate-run.ts refuses it, and it must stay strict.
//      Production records 0080_analytics_ledger_compaction.sql, so a pending
//      0063_deployment_identity ... 0079_* refused the first production migrate.
import { describe, expect, test } from "bun:test";
import { IDENTITY_MIGRATION } from "../scripts/migrate-run.ts";
import {
  SUPPORTED_RELEASES,
  describeUnmatchedLedger,
  ledgerDifference,
  matchSupportedRelease,
} from "../src/db/supported-releases.ts";
import { HEAD_FILES } from "./fixtures/releases/release-fixture.ts";

const BASELINE = SUPPORTED_RELEASES[0]!;
const LEDGER = [...BASELINE.migrations];
const LAST_RECORDED = LEDGER.at(-1)!;

/** The five files the baseline lacks that sort below the identity migration. */
const BELOW_IDENTITY = [
  "0056_swarm_judge_requires_model.sql",
  "0057_swarm_judge_policy_stamp.sql",
  "0058_swarm_judge_fault_injection.sql",
  "0059_swarm_judgement_completion_usage.sql",
  "0062_rm_worker_analytics_ledger_read_grant.sql",
];

describe("the supported baseline is production's 76-name ledger", () => {

  test("a ledger of exactly those 76 names matches, in any order", () => {
    expect(matchSupportedRelease(LEDGER)).toBe(BASELINE);
    expect(matchSupportedRelease([...LEDGER].reverse())).toBe(BASELINE);
  });

  test("75 names refuse, whichever one is missing", () => {
    for (const missing of [LEDGER[0]!, "0062_rm_readonly_sequence_select.sql", "0063_swarm_judge_model_default.sql", LAST_RECORDED]) {
      const ledger = LEDGER.filter((name) => name !== missing);
      expect(ledger).toHaveLength(75);
      expect(matchSupportedRelease(ledger)).toBeNull();
      expect(ledgerDifference(ledger, BASELINE).missing).toEqual([missing]);
    }
  });

  test("77 names refuse, whichever file is added", () => {
    for (const extra of ["0056_swarm_judge_requires_model.sql", IDENTITY_MIGRATION, "0099_anything.sql"]) {
      const ledger = [...LEDGER, extra];
      expect(ledger).toHaveLength(77);
      expect(matchSupportedRelease(ledger)).toBeNull();
      expect(ledgerDifference(ledger, BASELINE).extra).toEqual([extra]);
    }
  });

  test("a renamed file refuses, naming both names", () => {
    const ledger = LEDGER.map((name) => (name === LAST_RECORDED ? "0080_analytics_ledger_compaction_renamed.sql" : name));
    expect(matchSupportedRelease(ledger)).toBeNull();
    expect(describeUnmatchedLedger(ledger)).toContain("1 missing (0080_analytics_ledger_compaction.sql)");
    expect(describeUnmatchedLedger(ledger)).toContain("1 extra (0080_analytics_ledger_compaction_renamed.sql)");
  });

  test("the 73-name ledger of 2026-09-25 no longer matches: it lacks 0061, 0063 and 0080", () => {
    const old = LEDGER.filter(
      (name) =>
        name !== "0061_rm_worker_wallet_backfill_grant.sql" &&
        name !== "0063_swarm_judge_model_default.sql" &&
        name !== "0080_analytics_ledger_compaction.sql",
    );
    expect(old).toHaveLength(73);
    expect(matchSupportedRelease(old)).toBeNull();
  });
});

describe("no pending migration sorts inside the recorded range (the gap rule stays strict)", () => {
  const pending = HEAD_FILES.filter((file) => !LEDGER.includes(file));

  test("every file production has not run is below the identity migration or above 0080_analytics_ledger_compaction.sql", () => {
    const inside = pending.filter((file) => !BELOW_IDENTITY.includes(file) && file <= LAST_RECORDED);
    expect(inside).toEqual([]);
  });

  test("exactly five pending files sort below the identity migration, and they are the ones the pass accepts", () => {
    expect(pending.filter((file) => file < IDENTITY_MIGRATION)).toEqual(BELOW_IDENTITY);
  });

  test("the identity migration is the first pending file above the last recorded name", () => {
    expect(pending.filter((file) => file > LAST_RECORDED)[0]).toBe(IDENTITY_MIGRATION);
    expect(IDENTITY_MIGRATION > LAST_RECORDED).toBe(true);
  });

  test("the baseline is a subset of the branch: an upgrade never meets a recorded file the branch lacks", () => {
    expect(LEDGER.filter((file) => !HEAD_FILES.includes(file))).toEqual([]);
  });

  test("the renumbered files use one contiguous range, one number each", () => {
    const renumbered = pending.filter((file) => file >= IDENTITY_MIGRATION);
    const numbers = renumbered.map((file) => Number(file.slice(0, 4)));
    expect(numbers).toEqual(numbers.map((_, i) => numbers[0]! + i));
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});
