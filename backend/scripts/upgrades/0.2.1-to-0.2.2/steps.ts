// The v0.2.2 rollout step manifest — the single declaration of what this
// release's runbook is made of, consumed by where.ts (position), by
// preflight.ts/postflight.ts (the migration list), and by
// backend/tests/rollout-steps.test.ts (which holds it and the runbook prose in
// agreement mechanically).
//
// WHY A MANIFEST. docs/archive/v0-2-2-rollout.md is 2500 lines of prose that
// an agent has to reverse-engineer its position from. Worse, facts stated in
// two places drift: §5.6 asked for "all Gate A–D results" after §2 had
// abolished Gate A and renamed the rest, and THIS_RELEASE_MIGRATIONS said four
// migrations in preflight.ts while postflight.ts said six. Both are the same
// bug — a fact with two homes. Everything here has exactly one home, and the
// runbook's `yaml step` blocks are checked against it by the test.
//
// WHAT IS NOT HERE. Nothing that git or the filesystem already answers. Whether
// an rc tag exists at HEAD, which files changed since a receipt, whether the
// dump is on disk — those are DERIVED by where.ts, because a derived fact
// cannot go stale. Steps marked `derived` have no receipt at all.

// Re-exported so existing importers (where.ts, the test) have one name to
// reach for. The gate scripts import them from release.ts DIRECTLY — see that
// file's header for why the manifest must not be in their `depends-on`.
export { TAG_GLOB, THIS_RELEASE_MIGRATIONS, TRACKING_ISSUE } from "./release.ts";
import { TRACKING_ISSUE } from "./release.ts";

// The step TYPE and the four glob groups used to be declared here, in full, in
// every release directory — 68% identical across the two live copies. They now
// come from the shared half; what stays below is what is actually about this
// release. See backend/scripts/lib/rollout-manifest.ts for why the gate letters
// did NOT move with them.
import {
  APP_CODE as SHARED_APP_CODE,
  RESTORE_CODE as SHARED_RESTORE_CODE,
  postflightCode,
  preflightCode,
  stepById as stepByIdIn,
} from "../../lib/rollout-manifest.ts";
import type { RolloutStep as SharedRolloutStep } from "../../lib/rollout-manifest.ts";

export type { Actor, HostRole } from "../../lib/rollout-manifest.ts";

/**
 * This release's gate letters. Names, not an order — §3 executes C, B, D, E,
 * which is manifest order. Declared here rather than in the shared type so a
 * release cannot inherit the previous one's set by accident.
 */
export type Gate = "B" | "C" | "D" | "E";

/** This release's step type: the shared shape, narrowed to this release's gates. */
export type RolloutStep = SharedRolloutStep<Gate>;

/** This release's upgrade directory — the one parameter the glob factories take. */
const DIR = "0.2.1-to-0.2.2";

// Built rather than transcribed. The arrays are IDENTICAL to the ones this file
// declared by hand, element for element and in order, and
// backend/tests/rollout-shared-manifest.test.ts asserts exactly that against the
// live manifests — order included, because rollout-steps*.test.ts compares each
// `dependsOn` to the runbook's `depends-on:` block with an ordered toEqual.
const PREFLIGHT_CODE = preflightCode(DIR);
const POSTFLIGHT_CODE = postflightCode(DIR, [
  // AC2 calls the real derivation rather than a paraphrase, so a change to it
  // changes what postflight certifies.
  "backend/src/swarm/handle.ts",
]);
// Copied out of the frozen shared arrays: `dependsOn` is a mutable string[], and
// a step must never hold a reference that could edit what every other release reads.
const RESTORE_CODE = [...SHARED_RESTORE_CODE];
const APP_CODE = [...SHARED_APP_CODE];

export const STEPS: RolloutStep[] = [
  {
    id: "P1.phases-closed",
    phase: "P1 authorize",
    section: "§2",
    title: `every Phase issue linked from #${TRACKING_ISSUE} is CLOSED`,
    hostRole: "any",
    actor: "agent",
    requires: [],
    dependsOn: [],
    ttlHours: 24,
    verify: `gh issue view ${TRACKING_ISSUE} --json body -q .body   # then: where.ts --record P1.phases-closed`,
    note: "§2's own note on this decayed in a day, twice. Short TTL on purpose.",
  },
  {
    id: "P2.rc-tag",
    phase: "P2 release identity",
    section: "§7.2",
    title: "an rc tag exists at HEAD",
    hostRole: "any",
    actor: "operator",
    requires: [],
    dependsOn: [],
    derived: true,
    verify: "git tag -a v0.2.2-rc.<N> <sha> -m 'v0.2.2 release candidate <N>' && git push origin v0.2.2-rc.<N>",
    note: "Derived from `git tag --points-at HEAD`; never recorded.",
  },
  {
    id: "P3.baseline",
    phase: "P3 backup",
    section: "§5.0",
    title: "pre-upgrade baseline captured from the replica",
    hostRole: "stage",
    actor: "agent",
    requires: [],
    dependsOn: [],
    artifacts: ["pre-upgrade-baseline-*.txt", "member-baseline-*.json"],
    ttlHours: 48,
    verify: "§5.0's psql block, then: where.ts --record P3.baseline",
    note: "§8, §9 and AC6 all grade against these; they cannot be recovered from an upgraded or rolled-back database.",
  },
  {
    id: "P3.backup",
    phase: "P3 backup",
    section: "§5.1",
    title: "dump + globals taken as rm_readonly and encrypted (§5.2)",
    hostRole: "stage",
    actor: "agent",
    requires: [],
    dependsOn: [],
    artifacts: ["rm-preupgrade-<STAMP>.dump.gpg", "rm-globals-<STAMP>.sql.gpg"],
    ttlHours: 48,
    verify: "§5.1's pg_dump/pg_dumpall + §5.2's gpg, then: where.ts --record P3.backup",
    note: "§5.1 and §5.2 are one step: §5.2 shreds §5.1's plaintext, so only the .gpg pair survives to be checked.",
  },
  {
    id: "P3.schedules",
    phase: "P3 backup",
    section: "§5.4",
    title: "swarm.* schedule rows captured (IRREVERSIBLE — no restore returns them)",
    hostRole: "stage",
    actor: "agent",
    requires: [],
    dependsOn: [],
    artifacts: ["rm-swarm-schedules-*.txt"],
    verify: "§5.4's psql block, then: where.ts --record P3.schedules",
    note: "Every boot's seed() clobbers these rows; this file is the only record of the prior values.",
  },
  {
    id: "P3.gate-c",
    phase: "P3 backup",
    section: "§5.3",
    title: "Gate C — the dump restores, and preflight is clean against it",
    gate: "C",
    hostRole: "stage",
    actor: "agent",
    requires: ["P3.backup"],
    dependsOn: [
      ...PREFLIGHT_CODE,
      ...RESTORE_CODE,
      "backend/scripts/upgrades/0.2.1-to-0.2.2/restore-check.ts",
    ],
    verify: "bun scripts/upgrades/0.2.1-to-0.2.2/restore-check.ts ~/rm-backup-v022 --emit-receipt",
    note: "Bound to preflight.ts through restore-check.ts:33's `import { runChecks }`.",
  },
  {
    id: "P4.preflight-live",
    phase: "P4 live preflight",
    section: "§4",
    title: "Gates B, D, E — preflight against the live read replica",
    gate: "B",
    hostRole: "stage",
    actor: "agent",
    requires: ["P3.gate-c"],
    dependsOn: PREFLIGHT_CODE,
    ttlHours: 4,
    expectInRecovery: true,
    verify: "bun scripts/upgrades/0.2.1-to-0.2.2/preflight.ts --emit-receipt",
    note: "Gate E (blocking-xacts) goes stale by the minute — §2 requires a re-run immediately before §7.3 regardless of this TTL.",
  },
  {
    id: "P4.postflight-dryrun",
    phase: "P4 live preflight",
    section: "§8.0",
    title: "prove §8's checks discriminate against still-v0.2.1 production",
    hostRole: "stage",
    actor: "agent",
    requires: ["P4.preflight-live"],
    dependsOn: [],
    artifacts: ["postflight-dryrun-*.txt"],
    ttlHours: 48,
    verify: "§8.0's table as rm_readonly against the replica, then: where.ts --record P4.postflight-dryrun",
    note: "Checks 4/6/7/9 MUST error 42703 pre-upgrade. A check that returns 0 rows instead means you are on an already-migrated database.",
  },
  {
    id: "P5.rehearsal-boot",
    phase: "P5 twin rehearsal",
    section: "§5.3b",
    title: "real migrate + boot + frontend checks against the restored twin",
    hostRole: "stage",
    actor: "agent",
    requires: ["P3.gate-c"],
    dependsOn: [
      ...APP_CODE,
      ...RESTORE_CODE,
      "backend/scripts/upgrades/0.2.1-to-0.2.2/stage-rehearsal.ts",
    ],
    verify: "bun scripts/upgrades/0.2.1-to-0.2.2/stage-rehearsal.ts ~/rm-backup-v022 --emit-receipt",
    note: "Spends real credit on the production model, by design (§5.3b). Depends on app code, NOT on the gate scripts.",
  },
  {
    id: "P5.postflight-twin",
    phase: "P5 twin rehearsal",
    section: "§5.5",
    title: "§8 checks + §8.1 ACs against the migrated twin",
    hostRole: "stage",
    actor: "agent",
    requires: ["P5.rehearsal-boot"],
    dependsOn: [...POSTFLIGHT_CODE, "backend/scripts/upgrades/0.2.1-to-0.2.2/stage-rehearsal.ts"],
    verify: "bun scripts/upgrades/0.2.1-to-0.2.2/stage-rehearsal.ts ~/rm-backup-v022 --emit-receipt   # G8 runs this step",
    note: "Has no standalone command: the twin exists only between readiness and teardown, so §5.3b.1's G8 runs it inside the rehearsal.",
  },
  {
    id: "P6.report",
    phase: "P6 go/no-go",
    section: "§5.6",
    title: "stage rehearsal report written, verdict GO",
    hostRole: "stage",
    actor: "operator",
    requires: ["P4.preflight-live", "P5.rehearsal-boot", "P5.postflight-twin"],
    dependsOn: [],
    // ONE pattern covering both names §5.6 has used. Multiple patterns are
    // ANDed — correct for P3.backup, where the dump and the globals must both
    // exist — so listing the two spellings as if they were alternatives made
    // this step permanently unrecordable. Found by trying to record it.
    artifacts: ["*rehearsal-report-*.md"],
    verify: "write the §5.6 report, then: where.ts --record P6.report --note GO",
    note: "⛔ Blocking gate for §7 — an AC failure on the twin is an AC failure in production; it is the same data.",
  },
  {
    id: "P7.cutover",
    phase: "P7 cutover",
    section: "§7.3",
    title: "the production boot — IRREVERSIBLE",
    hostRole: "cutover",
    actor: "agent",
    requires: ["P6.report"],
    dependsOn: APP_CODE,
    verify: "DEMO_PROJECT=rm_prod bun smoke -- --external-pg --no-tui   # then: where.ts --record P7.cutover",
    note: "Needs the writer DATABASE_URL in repo-root .env; a stage host cannot run this and must not try (§2).",
  },
  {
    id: "P8.postflight-prod",
    phase: "P8 postflight",
    section: "§8",
    title: "§8 checks against production",
    hostRole: "cutover",
    actor: "agent",
    requires: ["P7.cutover"],
    dependsOn: POSTFLIGHT_CODE,
    expectInRecovery: false,
    verify: "bun scripts/upgrades/0.2.1-to-0.2.2/postflight.ts --base-url=<prod> --emit-receipt=P8.postflight-prod",
  },
  {
    id: "P8.acceptance",
    phase: "P8 postflight",
    section: "§8.1",
    title: "release acceptance criteria AC1–AC6",
    hostRole: "cutover",
    actor: "operator",
    requires: ["P8.postflight-prod"],
    dependsOn: [],
    verify: "AC1-AC6 run inside postflight; confirm each PASSed, then: where.ts --record P8.acceptance",
    note: "All six are automated. AC6 needs POSTFLIGHT_MEMBER_BASELINE=§5.0's member-baseline-<STAMP>.json, or its count half WARNs instead of passing.",
  },
  {
    id: "P9.tag",
    phase: "P9 close out",
    section: "§8",
    title: "bare v0.2.2 tag cut at the deployed rc's commit",
    hostRole: "cutover",
    actor: "operator",
    requires: ["P8.acceptance"],
    dependsOn: [],
    derived: true,
    verify: "git tag -a v0.2.2 <deployed sha> -m 'v0.2.2' && git push origin v0.2.2",
    note: "Derived: the tag either exists on the deployed commit or it does not.",
  },
  {
    id: "P9.report",
    phase: "P9 close out",
    section: "§13",
    title: "production rollout report + operator sign-off",
    hostRole: "cutover",
    actor: "operator",
    requires: ["P9.tag"],
    dependsOn: [],
    artifacts: ["rollout-report-*.md"],
    verify: "fill in §13, then: where.ts --record P9.report",
  },
];

export function stepById(id: string): RolloutStep | undefined {
  return stepByIdIn(STEPS, id);
}
