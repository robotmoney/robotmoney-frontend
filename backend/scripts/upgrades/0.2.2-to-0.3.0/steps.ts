// The v0.3.0 rollout step manifest — the single declaration of what this
// release's runbook is made of, consumed by where.ts (position), by
// preflight.ts/postflight.ts (the migration list), and by
// backend/tests/rollout-steps-0-3-0.test.ts (which holds it and the runbook prose in
// agreement mechanically).
//
// WHY A MANIFEST. docs/runbooks/v0-3-0-rollout.md plus docs/runbooks/rollout-procedure.md are prose that
// an agent has to reverse-engineer its position from. Worse, facts stated in
// two places drift: v0.2.2's §5.6 asked for "all Gate A–D results" after §2 had
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

export type HostRole = "stage" | "cutover" | "any";
export type Actor = "script" | "operator" | "agent";

export interface RolloutStep {
  /** Stable id, also the receipt filename. Phase-prefixed so manifest order
   *  and display order are the same thing. */
  id: string;
  phase: string;
  /** Runbook section this step is written in. The test asserts the prose at
   *  that section carries a matching `yaml step` block. */
  section: string;
  title: string;
  /** Gate letter, for the runbook's §3 gates. The letters are stable NAMES, not
   *  an order — §3's execution order is C, B, D, E, which is manifest order. */
  gate?: "A" | "B" | "C" | "F";
  hostRole: HostRole;
  actor: Actor;
  /** Step ids that must be `ok` before this one can run. */
  requires: string[];
  /**
   * Code paths whose change invalidates a completed receipt. This is the axis
   * that makes "we cut a new rc" answerable without redoing everything: a
   * docs-only commit invalidates nothing, while a commit touching a step's own
   * inputs invalidates exactly that step. Repo-relative globs, matched against
   * `git diff --name-only <receipt sha>..HEAD`.
   *
   * Empty = the step is not code-bound (an operator observation, a git tag).
   */
  dependsOn: string[];
  /**
   * Artifacts, relative to the backup dir. `<STAMP>` expands to .last-stamp.
   * Their absence demotes the step to `missing` no matter what a receipt says.
   *
   * Patterns are ANDed: every one listed must match something. Two spellings of
   * the same file are therefore ONE pattern, not two entries.
   */
  artifacts?: string[];
  /** Wall-clock validity. Expiry is amber (re-run advised), not red — unlike
   *  code drift, which is red. */
  ttlHours?: number;
  /** The command that performs (and, for scripts, records) this step. */
  verify: string;
  /** Derived from git/filesystem at probe time; carries no receipt. */
  derived?: boolean;
  /**
   * What `pg_is_in_recovery()` MUST have said on the connection this step ran
   * against: true = a read replica, false = the primary. A receipt that
   * disagrees graded the wrong server and is rejected outright — §2.0's
   * failure mode ("connects successfully, to the wrong database") made durable.
   */
  expectInRecovery?: boolean;
  /** One line on why this step can be blocked or stale, shown by the probe. */
  note?: string;
}

// Glob groups, named once. `backend/scripts/**` is deliberately NOT one of
// these: a change to stage-rehearsal.ts must not invalidate a preflight run,
// and a change to preflight.ts must not invalidate a boot rehearsal. Steps
// declare the files they actually execute, plus what those files read.
const PREFLIGHT_CODE = [
  "backend/scripts/upgrades/0.2.2-to-0.3.0/preflight.ts",
  "backend/scripts/upgrades/0.2.2-to-0.3.0/release.ts",
  "backend/scripts/lib/preflight-utils.ts",
  "backend/scripts/lib/checks.ts",
  "backend/migrations/**",
];
const POSTFLIGHT_CODE = [
  "backend/scripts/upgrades/0.2.2-to-0.3.0/postflight.ts",
  "backend/scripts/upgrades/0.2.2-to-0.3.0/release.ts",
  "backend/scripts/lib/postflight-utils.ts",
  "backend/scripts/lib/checks.ts",
  // seed() decides whether ops.repair_gaps exists and what catchup_policy the
  // wallet samplers carry, so postflight's checks 3 and 5 certify its output.
  "backend/src/db/seed.ts",
  "backend/migrations/**",
];
const RESTORE_CODE = [
  "scripts/lib/restore-container.ts",
  "scripts/lib/postgres-image.ts",
];
/** What a real boot actually executes. This is why the rc.6 rehearsal survived
 *  the commits that invalidated its gates: none of them landed here. */
const APP_CODE = [
  "backend/src/**",
  "backend/migrations/**",
  "backend/Dockerfile",
  "frontend/**",
  "scripts/**",
  "docker-compose.yml",
  "docker-compose.demo.yml",
  "package.json",
  "bun.lock",
];


export const STEPS: RolloutStep[] = [
  {
    id: "P1.phases-closed",
    phase: "P1 authorize",
    section: "§3.0",
    title: `every Phase issue linked from #${TRACKING_ISSUE} is CLOSED, or the freeze exception is recorded`,
    gate: "A",
    hostRole: "any",
    actor: "agent",
    requires: [],
    dependsOn: [],
    ttlHours: 24,
    verify: `gh issue view ${TRACKING_ISSUE} --json body -q .body   # then: where.ts --record P1.phases-closed`,
    note: "v0.3.0 was feature-frozen with Phases open. release-runbooks.md §1 allows that ONLY with the exception, its reason and sign-off recorded on the issue — this step is where that is checked, not assumed.",
  },
  {
    id: "P1.config-decided",
    phase: "P1 authorize",
    section: "§3.5",
    title: "WEBAUTHN_ORIGIN and BASE_RPC_MAX_CALLS_PER_SEC are both DECIDED and recorded",
    gate: "F",
    hostRole: "any",
    actor: "operator",
    requires: [],
    dependsOn: [],
    verify: "record both decisions on the tracking issue, then: where.ts --record P1.config-decided",
    note: "Not deploying a value is itself a decision here: unset means the passkey fix stays broken and the gap repair never runs. Deciding by omission is what this gate exists to stop.",
  },
  {
    id: "P2.rc-tag",
    phase: "P2 release identity",
    section: "§1",
    title: "an rc tag exists at HEAD",
    hostRole: "any",
    actor: "operator",
    requires: [],
    dependsOn: [],
    derived: true,
    verify: "git tag -a v0.3.0-rc.<N> <sha> -m 'v0.3.0 release candidate <N>' && git push origin v0.3.0-rc.<N>",
    note: "Derived from `git tag --points-at HEAD`; never recorded.",
  },
  {
    id: "P3.baseline",
    phase: "P3 backup",
    section: "§3.1",
    title: "pre-upgrade baseline captured from the replica",
    hostRole: "stage",
    actor: "agent",
    requires: [],
    dependsOn: [],
    artifacts: ["pre-upgrade-baseline-*.txt"],
    ttlHours: 48,
    verify: "rollout-procedure.md §5's baseline capture, then: where.ts --record P3.baseline",
    note: "Must include job_schedules.catchup_policy per kind: 0034 OVERWRITES those rows, and §9 check 3 grades against this capture.",
  },
  {
    id: "P3.backup",
    phase: "P3 backup",
    section: "§3.1",
    title: "dump + globals taken as rm_readonly and encrypted",
    hostRole: "stage",
    actor: "agent",
    requires: [],
    dependsOn: [],
    artifacts: ["rm-preupgrade-<STAMP>.dump.gpg", "rm-globals-<STAMP>.sql.gpg"],
    ttlHours: 48,
    verify: "rollout-procedure.md §5.1 + §5.2, then: where.ts --record P3.backup",
    note: "§5.1 and §5.2 are one step: §5.2 shreds §5.1's plaintext, so only the .gpg pair survives to be checked.",
  },
  {
    id: "P3.schedules",
    phase: "P3 backup",
    section: "§3.1",
    title: "swarm.* schedule rows captured (IRREVERSIBLE — no restore returns them)",
    hostRole: "stage",
    actor: "agent",
    requires: [],
    dependsOn: [],
    artifacts: ["rm-swarm-schedules-*.txt"],
    verify: "rollout-procedure.md §5.4's psql block, then: where.ts --record P3.schedules",
    note: "Every boot's seed() clobbers these rows; this file is the only record of the prior values.",
  },
  {
    id: "P3.gate-c",
    phase: "P3 backup",
    section: "§3.1",
    title: "Gate C — the dump restores, and preflight is clean against it",
    gate: "C",
    hostRole: "stage",
    actor: "agent",
    requires: ["P3.backup"],
    dependsOn: [
      ...PREFLIGHT_CODE,
      ...RESTORE_CODE,
      "backend/scripts/upgrades/0.2.2-to-0.3.0/restore-check.ts",
    ],
    ttlHours: 48,
    verify: "bun scripts/upgrades/0.2.2-to-0.3.0/restore-check.ts $RM_BACKUP_DIR --emit-receipt",
    note: "Runs FIRST, before anything reads the live database: rollback depends on this dump, so it is proven before the upgrade may touch anything.",
  },
  {
    id: "P4.preflight-live",
    phase: "P4 preflight",
    section: "§6",
    title: "Gate B — preflight is clean against the live replica",
    gate: "B",
    hostRole: "stage",
    actor: "agent",
    requires: ["P3.gate-c"],
    dependsOn: [...PREFLIGHT_CODE],
    ttlHours: 12,
    verify: "bun scripts/upgrades/0.2.2-to-0.3.0/preflight.ts --emit-receipt",
    note: "Expect ONE warning: schema-migrations reports 0032_wallet_* as out-of-order. That is correct for this release — see §2.2.1. append-only-safety is what proves it is harmless, so read that check's result, not just the verdict.",
  },
  {
    id: "P4.postflight-dryrun",
    phase: "P4 preflight",
    section: "§9",
    title: "postflight's checks are proven to DISCRIMINATE before cutover",
    hostRole: "stage",
    actor: "agent",
    requires: ["P4.preflight-live"],
    dependsOn: [...POSTFLIGHT_CODE],
    ttlHours: 12,
    verify: "run §9's checks as rm_readonly against the replica, then: where.ts --record P4.postflight-dryrun",
    note: "Against the still-v0.2.2 database every post-migration check MUST fail. A check that passes before the migration is not testing anything.",
  },
  {
    id: "P5.rehearsal-boot",
    phase: "P5 rehearsal",
    section: "§7",
    title: "the twin migrates and boots on the rc being shipped",
    hostRole: "stage",
    actor: "agent",
    requires: ["P3.gate-c"],
    dependsOn: [...APP_CODE, "backend/scripts/upgrades/0.2.2-to-0.3.0/stage-rehearsal.ts"],
    ttlHours: 72,
    verify: "bun scripts/upgrades/0.2.2-to-0.3.0/stage-rehearsal.ts $RM_BACKUP_DIR --emit-receipt",
    note: "Record the migration set's WALL-CLOCK here. §2.2's 'well under a second' is read off the DDL, not measured; this step is where it becomes a number.",
  },
  {
    id: "P5.postflight-twin",
    phase: "P5 rehearsal",
    section: "§7",
    title: "postflight is clean against the MIGRATED twin",
    hostRole: "stage",
    actor: "agent",
    requires: ["P5.rehearsal-boot"],
    // stage-rehearsal.ts is in here because it is what DECIDES whether these
    // checks run against the twin at all: it hands postflight to the shared
    // driver's onReady window. A commit that drops that hook leaves a green
    // rehearsal that graded nothing, so this step's evidence must die with it.
    dependsOn: [...POSTFLIGHT_CODE, "backend/scripts/upgrades/0.2.2-to-0.3.0/stage-rehearsal.ts"],
    ttlHours: 72,
    verify: "bun scripts/upgrades/0.2.2-to-0.3.0/stage-rehearsal.ts $RM_BACKUP_DIR --emit-receipt   # runs this step",
    note: "A twin that boots but fails postflight is a failed rehearsal, not a partial success.",
  },
  {
    id: "P6.report",
    phase: "P6 sign-off",
    section: "§7.1",
    title: "stage rehearsal report written and signed off",
    hostRole: "any",
    actor: "operator",
    requires: ["P5.postflight-twin"],
    dependsOn: [],
    artifacts: ["stage-rehearsal-report-*.md"],
    verify: "write the report per rollout-procedure.md §6.5, then: where.ts --record P6.report",
  },
  {
    id: "P7.cutover",
    phase: "P7 cutover",
    section: "§8",
    title: "IRREVERSIBLE — production migrated and booted on the rc",
    hostRole: "cutover",
    actor: "agent",
    requires: ["P6.report"],
    dependsOn: [...APP_CODE],
    verify: "DEMO_PROJECT=rm_prod bun smoke -- --db external --no-tui   # then: where.ts --record P7.cutover",
    note: "The .env from §5 must be in place BEFORE this runs. Four `migrated:` lines expected, then `migrations up to date`.",
  },
  {
    id: "P8.postflight-prod",
    phase: "P8 verify",
    section: "§9",
    title: "postflight is clean against PRODUCTION",
    hostRole: "cutover",
    actor: "agent",
    requires: ["P7.cutover"],
    dependsOn: [...POSTFLIGHT_CODE],
    verify: "bun scripts/upgrades/0.2.2-to-0.3.0/postflight.ts --emit-receipt=P8.postflight-prod",
  },
  {
    id: "P8.acceptance",
    phase: "P8 verify",
    section: "§9",
    title: "a REAL passkey ceremony completes against the public HTTPS origin",
    hostRole: "any",
    actor: "operator",
    requires: ["P8.postflight-prod"],
    dependsOn: [],
    verify: "complete a passkey sign-in at the public origin, then: where.ts --record P8.acceptance",
    note: "This release's headline acceptance criterion. Reading WEBAUTHN_ORIGIN back out of the container proves configuration, not function — no script can do this step.",
  },
  {
    id: "P9.tag",
    phase: "P9 close",
    section: "§9",
    title: "v0.3.0 tagged at the deployed rc's commit",
    hostRole: "any",
    actor: "operator",
    requires: ["P8.acceptance"],
    dependsOn: [],
    derived: true,
    verify: "git tag v0.3.0 <deployed-rc-commit> && git push origin v0.3.0",
    note: "Derived from `git tag --points-at`; never recorded. The version tag records what is PROVEN in production, so it cannot precede P8.",
  },
  {
    id: "P9.report",
    phase: "P9 close",
    section: "§12",
    title: "production rollout report written and signed off",
    hostRole: "any",
    actor: "operator",
    requires: ["P9.tag"],
    dependsOn: [],
    artifacts: ["rollout-report-*.md"],
    verify: "fill in §12, then: where.ts --record P9.report",
  },
];

export function stepById(id: string): RolloutStep | undefined {
  return STEPS.find((s) => s.id === id);
}
