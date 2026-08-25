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
} from "../../lib/rollout-manifest.ts";
import type { RolloutStep as SharedRolloutStep } from "../../lib/rollout-manifest.ts";

export type { Actor, HostRole } from "../../lib/rollout-manifest.ts";

/**
 * This release's gate letters. Names, not an order — execution order is
 * manifest order. Declared here rather than in the shared type so a release
 * cannot inherit the previous one's set by accident.
 */
export type Gate = "A" | "B" | "C" | "F";

/** This release's step type: the shared shape, narrowed to this release's gates. */
export type RolloutStep = SharedRolloutStep<Gate>;

/** This release's upgrade directory — the one parameter the glob factories take. */
const DIR = "0.2.2-to-0.3.0";

// Built rather than transcribed. The arrays are IDENTICAL to the ones this file
// declared by hand, element for element and in order, and
// backend/tests/rollout-shared-manifest.test.ts asserts exactly that against the
// live manifests — order included, because rollout-steps*.test.ts compares each
// `dependsOn` to the runbook's `depends-on:` block with an ordered toEqual.
const PREFLIGHT_CODE = preflightCode(DIR);
const POSTFLIGHT_CODE = postflightCode(DIR, [
  // seed() decides whether ops.repair_gaps exists and what catchup_policy the
  // wallet samplers carry, so postflight's checks 3 and 5 certify its output.
  "backend/src/db/seed.ts",
]);
// Copied out of the frozen shared arrays: `dependsOn` is a mutable string[], and
// a step must never hold a reference that could edit what every other release reads.
const RESTORE_CODE = [...SHARED_RESTORE_CODE];
const APP_CODE = [...SHARED_APP_CODE];

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
    title: "runtime controls and AUM_PRODUCER_REVISION are DECIDED and recorded",
    gate: "F",
    hostRole: "any",
    actor: "operator",
    requires: [],
    dependsOn: [],
    verify: "record all three decisions on the tracking issue, then: where.ts --record P1.config-decided",
    note: "Unset WEBAUTHN_ORIGIN leaves the passkey fix broken; unset BASE_RPC_MAX_CALLS_PER_SEC runs repair on the built-in rate; blank AUM_PRODUCER_REVISION makes future snapshots unavailable rather than fabricating producer identity.",
  },
  {
    id: "P2.rc-tag",
    phase: "P2 release identity",
    section: "§1",
    title: "an rc tag exists at HEAD",
    hostRole: "any",
    actor: "operator",
    requires: ["P1.phases-closed"],
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
    actor: "script",
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
    actor: "script",
    requires: ["P3.gate-c"],
    dependsOn: [...PREFLIGHT_CODE],
    // 2h, not 12h. This step carries Gate E (§3.4) as its `blocking-xacts`
    // check, and a long-running transaction is a condition that goes stale by
    // the minute — a preflight that was Gate-E-clean at breakfast says nothing
    // about dinner. With P7.cutover now requiring this step, the short TTL is
    // what forces a fresh preflight immediately before the irreversible step,
    // which is what Gate E has always actually meant.
    ttlHours: 2,
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
    // 2h, matching P4.preflight-live. Both are point-in-time reads of the live
    // replica taken in the pre-cutover window, and this one is chained to that
    // one — evidence may not outlive its own premise. Cheap to re-run: it is a
    // handful of SELECTs, no container and no build.
    ttlHours: 2,
    verify: "run §9's checks as rm_readonly against the replica, then: where.ts --record P4.postflight-dryrun",
    note: "Against the still-v0.2.2 database every post-migration check MUST fail. A check that passes before the migration is not testing anything.",
  },
  {
    id: "P5.rehearsal-boot",
    phase: "P5 rehearsal",
    section: "§7",
    title: "the twin migrates and boots on the rc being shipped",
    hostRole: "stage",
    actor: "script",
    // Gate F as well as Gate C: a rehearsal has to rehearse the world §5.2
    // chose. With BASE_RPC_MAX_CALLS_PER_SEC unset the twin dispatches repair
    // work; with it set to 0 the twin does nothing. Those are different
    // rehearsals, and neither is evidence for the other.
    requires: ["P3.gate-c", "P1.config-decided"],
    dependsOn: [...APP_CODE, "backend/scripts/upgrades/0.2.2-to-0.3.0/stage-rehearsal.ts"],
    // 48h, matching P3.gate-c. A rehearsal cannot be better evidence than the
    // dump proof it consumed: at 72h there was a 24h window in which Gate C
    // read `expired` while the rehearsal built on it still read `ok`.
    ttlHours: 48,
    verify: "bun scripts/upgrades/0.2.2-to-0.3.0/stage-rehearsal.ts $RM_BACKUP_DIR --emit-receipt",
    note: "Record the migration set's WALL-CLOCK here. §2.2's 'well under a second' is read off the DDL, not measured; this step is where it becomes a number.",
  },
  {
    id: "P5.postflight-twin",
    phase: "P5 rehearsal",
    section: "§7",
    title: "postflight is clean against the MIGRATED twin",
    hostRole: "stage",
    actor: "script",
    requires: ["P5.rehearsal-boot"],
    // stage-rehearsal.ts is in here because it is what DECIDES whether these
    // checks run against the twin at all: it hands postflight to the shared
    // driver's onReady window. A commit that drops that hook leaves a green
    // rehearsal that graded nothing, so this step's evidence must die with it.
    dependsOn: [...POSTFLIGHT_CODE, "backend/scripts/upgrades/0.2.2-to-0.3.0/stage-rehearsal.ts"],
    ttlHours: 48,
    verify: "bun scripts/upgrades/0.2.2-to-0.3.0/stage-rehearsal.ts $RM_BACKUP_DIR --emit-receipt   # runs this step",
    note: "A twin that boots but fails postflight is a failed rehearsal, not a partial success.",
  },
  {
    id: "P5.rollback-twin",
    phase: "P5 rehearsal",
    section: "§7.2",
    title: "the §10 rollback is executed once against a migrated twin",
    hostRole: "stage",
    // OPERATOR, not script: there is no rollback driver in this repo, for any
    // release. §7.2 is a written procedure and this step tracks whether anyone
    // has run it — which is strictly better than the previous arrangement,
    // where §7 required the rollback in prose and nothing could report on it at
    // all. Automating it is open work; when it lands, this becomes script.
    actor: "operator",
    requires: ["P5.postflight-twin"],
    dependsOn: [],
    ttlHours: 48,
    verify: "execute §10 against a migrated twin per the procedure below, then: where.ts --record P5.rollback-twin",
    note: "Never done, for any release: no rollback driver exists, no down migrations exist, and 'rollback' appears in none of the v0.2.2 rehearsal reports. §10's survivability claim is a reading of the schema until this runs.",
  },
  {
    id: "P5.passkey-twin",
    phase: "P5 rehearsal",
    section: "§7.3",
    title: "a passkey ceremony completes against a tunnel-published twin",
    hostRole: "stage",
    actor: "operator",
    requires: ["P5.postflight-twin", "P1.config-decided"],
    dependsOn: [],
    ttlHours: 48,
    verify: "complete a passkey ceremony against the tunnel-published twin, then: where.ts --record P5.passkey-twin",
    note: "De-risks §9 Check 7, which is otherwise first tested in PRODUCTION after the irreversible cutover. Does NOT substitute for P8.acceptance — a twin ceremony runs at the stage origin, not robotmoney.network.",
  },
  {
    id: "P6.report",
    phase: "P6 sign-off",
    section: "§7.4",
    title: "stage rehearsal report written and signed off",
    hostRole: "any",
    actor: "operator",
    // P4.postflight-dryrun is here, not on the rehearsal, because this is the
    // step where the twin's green gets INTERPRETED. Postflight passing on a
    // migrated twin means nothing on its own unless those same checks are known
    // to FAIL before the migration — otherwise a check that passes
    // unconditionally is indistinguishable from one that verified something.
    requires: ["P5.postflight-twin", "P4.postflight-dryrun", "P5.rollback-twin", "P5.passkey-twin"],
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
    // Gate B and Gate F stated directly. evaluate() computes no transitivity and
    // where.ts's "held by" line reads only DIRECT requires, so an edge that is
    // transitively implied still has to be named to be shown — and these two are
    // exactly the gates §3 calls blocking that nothing used to enforce.
    requires: ["P6.report", "P4.preflight-live", "P1.config-decided"],
    dependsOn: [...APP_CODE],
    verify: "DEMO_PROJECT=rm_prod bun smoke -- --db external --no-tui   # then: where.ts --record P7.cutover",
    note: "The .env from §5 must be in place BEFORE this runs. Seven `migrated:` lines expected, then `migrations up to date`.",
  },
  {
    id: "P8.postflight-prod",
    phase: "P8 verify",
    section: "§9",
    title: "postflight is clean against PRODUCTION",
    hostRole: "cutover",
    actor: "script",
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
