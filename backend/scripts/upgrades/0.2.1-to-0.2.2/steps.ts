// The v0.2.2 rollout step manifest — the single declaration of what this
// release's runbook is made of, consumed by where.ts (position), by
// preflight.ts/postflight.ts (the migration list), and by
// backend/tests/rollout-steps.test.ts (which holds it and the runbook prose in
// agreement mechanically).
//
// WHY A MANIFEST. docs/runbooks/v0-2-2-rollout.md is 2500 lines of prose that
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

/**
 * Every migration this release applies, in runner order (readdir + JS sort,
 * src/db/migrate.ts:39-41). THE single source: preflight.ts and postflight.ts
 * both import this. They used to each declare their own copy and the copies
 * disagreed — postflight was corrected to six in 27ec374, preflight was not.
 *
 * §5.6 and §8's check 2 both cite this list; the test asserts each file exists
 * under backend/migrations/.
 */
export const THIS_RELEASE_MIGRATIONS = [
  "0029_admin_auth_recovery.sql",
  "0029_admin_passkey.sql",
  "0030_swarm_member_handle.sql",
  "0031_swarm_member_handle_namespace.sql",
  "0032_append_only_history.sql",
  "0033_swarm_member_uuid_ids.sql",
] as const;

/** Selects this release's tags and no others (§7.2 cuts `v0.2.2-rc.N`). */
export const TAG_GLOB = "v0.2.2*";

/** The release tracking issue whose Phase tasklist gates preflight (§2). */
export const TRACKING_ISSUE = 660;

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
  /** Gate letter, for the four §2 gates. The letters are stable NAMES, not an
   *  order — §2's execution order is C, B, D, E, which is manifest order here. */
  gate?: "B" | "C" | "D" | "E";
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
  /** Artifacts, relative to the backup dir. `<STAMP>` expands to .last-stamp.
   *  Their absence demotes the step to `missing` no matter what a receipt says. */
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
  "backend/scripts/upgrades/0.2.1-to-0.2.2/preflight.ts",
  "backend/scripts/upgrades/0.2.1-to-0.2.2/steps.ts",
  "backend/scripts/lib/preflight-utils.ts",
  "backend/scripts/lib/checks.ts",
  "backend/migrations/**",
];
const POSTFLIGHT_CODE = [
  "backend/scripts/upgrades/0.2.1-to-0.2.2/postflight.ts",
  "backend/scripts/upgrades/0.2.1-to-0.2.2/steps.ts",
  "backend/scripts/lib/postflight-utils.ts",
  "backend/scripts/lib/checks.ts",
  // AC2 calls the real derivation rather than a paraphrase, so a change to it
  // changes what postflight certifies.
  "backend/src/swarm/handle.ts",
  "backend/migrations/**",
];
const RESTORE_CODE = [
  "backend/scripts/lib/restore-container.ts",
  "backend/scripts/lib/postgres-image.ts",
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
    artifacts: ["pre-upgrade-baseline-*.txt"],
    ttlHours: 48,
    verify: "§5.0's psql block, then: where.ts --record P3.baseline",
    note: "§8 and §9 both grade against this file; an empty one verifies nothing.",
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
    artifacts: ["rehearsal-report-*.md", "stage-rehearsal-report-*.md"],
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
    verify: "AC1-AC5 run inside postflight; verify AC6 by hand, then: where.ts --record P8.acceptance",
    note: "AC1-AC5 are automated (postflight §8.1 checks). AC6 is not: it needs §5.0's per-member baseline, and its failure mode is silent.",
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
  return STEPS.find((s) => s.id === id);
}
