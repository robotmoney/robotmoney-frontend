// D63 (owner, 2026-10-09): the one supported baseline is production's v0.6.0
// ledger, the 116 files of tag v0.6.0, pinned by
// fixtures/releases/production-v0.6.0/baseline.json. The first describe block
// proves it; the rest of this file is the frozen pre-identity list the
// identity-first pass still matches (PRE_IDENTITY_RELEASES, issue 1097,
// smoke-production-spec.md §9.1, D55 (8)).
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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IDENTITY_MIGRATION } from "../scripts/migrate-run.ts";
import {
  PRE_IDENTITY_RELEASES,
  SUPPORTED_RELEASES,
  describeUnmatchedLedger,
  ledgerDifference,
  matchSupportedRelease,
} from "../src/db/supported-releases.ts";
import { HEAD_FILES, MIGRATIONS_DIR, RELEASES_DIR } from "./fixtures/releases/release-fixture.ts";

const BASELINE = PRE_IDENTITY_RELEASES[0]!;
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

describe("the supported baseline is production's v0.6.0 ledger (D63)", () => {
  const SUPPORTED = SUPPORTED_RELEASES[0]!;
  const fixture = JSON.parse(readFileSync(join(RELEASES_DIR, "production-v0.6.0", "baseline.json"), "utf8")) as {
    name: string;
    commit: string;
    ledger: { file: string; sha256: string }[];
  };

  test("it is the only supported release, and it has 116 names ending at 0115", () => {
    expect(SUPPORTED_RELEASES).toHaveLength(1);
    expect(SUPPORTED.migrations).toHaveLength(116);
    expect(new Set(SUPPORTED.migrations).size).toBe(116);
    expect(SUPPORTED.migrations.at(-1)).toBe("0115_token_market_samples.sql");
    expect(SUPPORTED.migrations).toContain(IDENTITY_MIGRATION);
    expect([...SUPPORTED.migrations]).toEqual([...SUPPORTED.migrations].sort());
  });

  test("the 76-name ledger no longer matches: it lacks 40 files", () => {
    expect(matchSupportedRelease([...PRE_IDENTITY_RELEASES[0]!.migrations])).toBeNull();
    expect(matchSupportedRelease([...SUPPORTED.migrations])).toBe(SUPPORTED);
    expect(matchSupportedRelease([...SUPPORTED.migrations].reverse())).toBe(SUPPORTED);
  });

  test("115 or 117 names refuse, and a renamed file refuses naming both", () => {
    const ledger = [...SUPPORTED.migrations];
    expect(matchSupportedRelease(ledger.slice(1))).toBeNull();
    expect(matchSupportedRelease([...ledger, "0116_vault_subject_position_actions.sql"])).toBeNull();
    const renamed = ledger.map((n) => (n === "0115_token_market_samples.sql" ? "0115_renamed.sql" : n));
    expect(describeUnmatchedLedger(renamed)).toContain("1 missing (0115_token_market_samples.sql)");
    expect(describeUnmatchedLedger(renamed)).toContain("1 extra (0115_renamed.sql)");
  });

  test("the fixture pins the same names, and each file on the branch is byte for byte the tag's", () => {
    expect(fixture.name).toBe(SUPPORTED.name);
    expect(fixture.ledger.map((l) => l.file)).toEqual([...SUPPORTED.migrations]);
    for (const { file, sha256 } of fixture.ledger) {
      const bytes = readFileSync(join(MIGRATIONS_DIR, file));
      expect(`${file} ${createHash("sha256").update(bytes).digest("hex")}`).toBe(`${file} ${sha256}`);
    }
  });
});

describe("the frozen pre-identity list is production's 76-name ledger of 2026-10-01", () => {
  test("it has 76 names, ends at 0080_analytics_ledger_compaction.sql and carries the four files v0.5.0 lacks", () => {
    expect(PRE_IDENTITY_RELEASES).toHaveLength(1);
    expect(LEDGER).toHaveLength(76);
    expect(new Set(LEDGER).size).toBe(76);
    expect(LAST_RECORDED).toBe("0080_analytics_ledger_compaction.sql");
    expect([...BASELINE.outOfBand]).toEqual([
      "0061_rm_worker_wallet_backfill_grant.sql",
      "0062_rm_readonly_sequence_select.sql",
      "0063_swarm_judge_model_default.sql",
      "0080_analytics_ledger_compaction.sql",
    ]);
  });

  test("a ledger of exactly those 76 names matches, in any order", () => {
    expect(matchSupportedRelease(LEDGER, PRE_IDENTITY_RELEASES)).toBe(BASELINE);
    expect(matchSupportedRelease([...LEDGER].reverse(), PRE_IDENTITY_RELEASES)).toBe(BASELINE);
  });

  test("75 names refuse, whichever one is missing", () => {
    for (const missing of [LEDGER[0]!, "0062_rm_readonly_sequence_select.sql", "0063_swarm_judge_model_default.sql", LAST_RECORDED]) {
      const ledger = LEDGER.filter((name) => name !== missing);
      expect(ledger).toHaveLength(75);
      expect(matchSupportedRelease(ledger, PRE_IDENTITY_RELEASES)).toBeNull();
      expect(ledgerDifference(ledger, BASELINE).missing).toEqual([missing]);
    }
  });

  test("77 names refuse, whichever file is added", () => {
    for (const extra of ["0056_swarm_judge_requires_model.sql", IDENTITY_MIGRATION, "0099_anything.sql"]) {
      const ledger = [...LEDGER, extra];
      expect(ledger).toHaveLength(77);
      expect(matchSupportedRelease(ledger, PRE_IDENTITY_RELEASES)).toBeNull();
      expect(ledgerDifference(ledger, BASELINE).extra).toEqual([extra]);
    }
  });

  test("a renamed file refuses, naming both names", () => {
    const ledger = LEDGER.map((name) => (name === LAST_RECORDED ? "0080_analytics_ledger_compaction_renamed.sql" : name));
    expect(matchSupportedRelease(ledger, PRE_IDENTITY_RELEASES)).toBeNull();
    expect(describeUnmatchedLedger(ledger, PRE_IDENTITY_RELEASES)).toContain("1 missing (0080_analytics_ledger_compaction.sql)");
    expect(describeUnmatchedLedger(ledger, PRE_IDENTITY_RELEASES)).toContain("1 extra (0080_analytics_ledger_compaction_renamed.sql)");
  });

  test("the 73-name ledger of 2026-09-25 no longer matches: it lacks 0061, 0063 and 0080", () => {
    const old = LEDGER.filter(
      (name) =>
        name !== "0061_rm_worker_wallet_backfill_grant.sql" &&
        name !== "0063_swarm_judge_model_default.sql" &&
        name !== "0080_analytics_ledger_compaction.sql",
    );
    expect(old).toHaveLength(73);
    expect(matchSupportedRelease(old, PRE_IDENTITY_RELEASES)).toBeNull();
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
