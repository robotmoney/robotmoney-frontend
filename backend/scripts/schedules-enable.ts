#!/usr/bin/env bun
// `bun run schedules:enable` — the production-initialization command that turns
// the five `swarm.*` schedule rows on. Spec §6.3, step 4 of §9.1.
//
// STUB (issue #1026, W1 step 1 / plan row W1.9). Signatures and types are real;
// every body throws, and this file is not yet wired into `backend/package.json`
// or the root `package.json`, so it is unreachable today. It is additive and
// behaviour-neutral by construction.
//
// ── Why enabling schedules is a COMMAND and not a boot side-effect ──────────
//
// Spec §6.3: "Schedule enablement is a production-initialization command
// (`bun run schedules:enable`, §9.1), NOT A RESTART SIDE-EFFECT. It sets the
// five `swarm.*` rows enabled and never touches `next_run_at`. A plain restart
// never rewrites operator state."
//
// Today it is a side-effect. `backend/src/db/seed.ts`'s `seedSwarmSchedules()`
// UPDATEs `cron`, `enabled`, `payload` and `timezone` by kind on every seed run,
// on the theory — written into the comment there — that these fields are
// "environment-configuration, not operator-toggled state". That theory is what
// this command exists to reverse. The concrete consequences on a live
// deployment:
//
//  - An operator disables a schedule during an incident. The next deploy, or
//    the next restart that runs the seed, silently re-enables it. The operator
//    has no way to make a decision that survives a restart, which means the
//    only reliable way to stop a schedule is to stop the worker — i.e. to take
//    an outage in order to avoid one.
//  - The reverse: a deployment that was intentionally quiet gets its cadence
//    re-applied from whatever `SWARM_*_CRON` values happened to be in the
//    host's environment, which on the production host today are the values that
//    have never been exercised under `RM_ENV=prod` at all (§9.3).
//
// Separating enablement into an explicit, receipted command means operator
// state is written exactly when an operator writes it, and a restart is a
// restart.
//
// ── Why `next_run_at` is untouched ──────────────────────────────────────────
//
// §6.3 states it twice, and §6.3's "Preflight vs readiness" paragraph explains
// why: "Preflight verifies the rows are enabled and their cron strings parse.
// It does not require a future `next_run_at`: `NULL` and overdue rows are the
// scheduler's to initialize or drain per `catchup_policy`, and refusing to
// start the worker that advances them would block recovery after downtime."
//
// Writing `next_run_at` from this command would be actively harmful. An overdue
// row is a BACKLOG — evidence of missed work that `catchup_policy` (migration
// 0034) exists to replay or collapse. Setting it forward from here silently
// discards that backlog, and does so at the exact moment an operator is
// recovering from the outage that created it. The scheduler owns this column.
// This command owns `enabled`, and nothing else.
//
// It also must not write `cron`, `payload` or `timezone`. Those are the fields
// `seedSwarmSchedules()` rewrites, and the point of this command is that an
// enablement is not a cadence change.
//
// ── The gates ───────────────────────────────────────────────────────────────
//
// §4.3: "Production initialization (§9.1) is a set of separate commands allowed
// on `production`, each gated by `RM_ENV=prod`, typed `rm_owner`, `y/n`, and a
// receipt. None is reachable through `bun smoke`."
//
// All four, every time, in that order. The first three are cheap and refuse
// before anything is read; the receipt is the record that survives. And the
// target lock (§2) is held across the whole thing — §2's caller list names
// `bun run schedules:enable` explicitly, because a schedule write is a mutation
// and a mutation that lands between smoke's preflight and its containers
// starting is exactly what the session lock exists to prevent.
//
// ── The five rows ───────────────────────────────────────────────────────────
//
// `swarm.open_session`, `swarm.publish_brief`, `swarm.close_window`,
// `swarm.aggregate`, `swarm.publish` — the lifecycle sequence in
// `backend/src/config.ts`'s `resolveSwarmSchedules()`. Five, exactly: a
// deployment with four of them enabled runs sessions that never publish, and a
// partial enablement must therefore be reported as the failure it is rather
// than as four successes.
//
// ── Governing spec sections ─────────────────────────────────────────────────
//
//   §6.3  the command, its one field, and the preflight-vs-readiness split.
//   §9.1  step 4 of the one-time production initialization.
//   §4.3  the four gates on every production-initialization command.
//   §2    the target-lock protocol, which names this command as a caller.
//   §7    preflight check 6: "On `prod`: the five `swarm.*` schedule rows are
//         enabled and their cron strings parse" — the check this command makes
//         satisfiable.
//
// Acceptance gates served (spec §10, W1): "Restart after schedules become
// overdue" — a restart must leave an overdue row overdue and let the scheduler
// drain it per `catchup_policy`, which is only observable once enablement has
// stopped being a restart side-effect.

import type { TargetLock } from "../src/db/target-lock.ts";

/**
 * The five `swarm.*` rows, in lifecycle order. A frozen list rather than a
 * query, because "the five" is a fact this command asserts: a database with a
 * sixth `swarm.*` row, or with one of these missing, is a database this command
 * does not understand and must refuse rather than partially enable.
 */
export const SWARM_SCHEDULE_KINDS = [
  "swarm.open_session",
  "swarm.publish_brief",
  "swarm.close_window",
  "swarm.aggregate",
  "swarm.publish",
] as const;

export type SwarmScheduleKind = (typeof SWARM_SCHEDULE_KINDS)[number];

/**
 * One row as observed before the write. `nextRunAt` is read and REPORTED so the
 * operator can see the backlog they are about to let the scheduler drain — and
 * so the receipt records that this command saw it and left it alone.
 */
export interface ScheduleRow {
  readonly kind: SwarmScheduleKind;
  readonly cron: string;
  readonly enabled: boolean;
  readonly nextRunAt: string | null;
  readonly catchupPolicy: string;
}

/**
 * The plan this command prints before asking `y/n`: which rows will change,
 * which are already enabled, and what the untouched `next_run_at` values are.
 *
 * Printed before the prompt, not after — an operator cannot consent to a change
 * they have not seen, and `y/n` on an unshown diff is a rubber stamp.
 */
export interface EnablementPlan {
  readonly rows: readonly ScheduleRow[];
  /** Kinds whose `enabled` will move false → true. May be empty. */
  readonly toEnable: readonly SwarmScheduleKind[];
  /** Kinds already enabled; reported as no-ops, never rewritten. */
  readonly alreadyEnabled: readonly SwarmScheduleKind[];
  /** Enabled rows whose `next_run_at` is NULL or in the past; informational only. */
  readonly overdue: readonly SwarmScheduleKind[];
}

/**
 * Read the five rows and build the plan.
 *
 * Runs under the held target lock, after {@link TargetLock} revalidation, so the
 * rows it reads cannot move before the write.
 *
 * Refusal cases:
 *  - any of {@link SWARM_SCHEDULE_KINDS} is missing from `job_schedules`: the
 *    database has not been seeded with the lifecycle rows, and INSERTing them
 *    here would be this command silently doing a seed's job with a cadence it
 *    has no business choosing.
 *  - a duplicate row for one kind: `seedSwarmSchedules()` historically upserted
 *    on `(kind, cron)` and could leave a stale duplicate under an old cron. Two
 *    rows for one kind means the scheduler's behaviour depends on which one is
 *    enabled, so this refuses and names both.
 *  - a `cron` string that does not parse (`cron-parser`): preflight check 6
 *    requires parseable crons on `prod`, and enabling a row whose cron is
 *    garbage produces a schedule that never fires and a preflight that fails on
 *    the next boot.
 */
export function readEnablementPlan(lock: TargetLock): Promise<EnablementPlan> {
  void lock;
  throw new Error("NOT IMPLEMENTED: read the five swarm.* rows — spec §6.3, issue #1026 W1.9");
}

/**
 * Render the plan for the terminal, above the `y/n` prompt.
 *
 * Must state, in the operator's own words, the thing that is easiest to get
 * wrong: that `next_run_at` is not being touched, and that overdue rows will be
 * initialized or drained by the scheduler per each row's `catchup_policy`
 * (§6.3). An operator who does not know that will look at an overdue row after
 * this command and conclude it failed.
 */
export function renderEnablementPlan(plan: EnablementPlan): string {
  void plan;
  throw new Error("NOT IMPLEMENTED: enablement plan rendering — spec §6.3, issue #1026 W1.9");
}

/**
 * The §4.3 gates, checked before anything is read from the database.
 *
 * Inputs: the process environment (for `RM_ENV`), the `deployment_identity`
 * kind read from the target, whether a TTY is attached, and whether this
 * process was invoked from `bun smoke`.
 *
 * Refusal cases, each with its own message:
 *  - `RM_ENV` is not exactly `prod`. This is a production-initialization
 *    command; on stage the schedules are environment-configured and the row
 *    state is not operator state worth protecting.
 *  - `deployment_identity` is not `production` (§4.2, §4.3). Enabling
 *    production schedules on a rehearsal target would start real cadences
 *    against rehearsal data.
 *  - no TTY: the typed `rm_owner` password and the `y/n` both require a
 *    terminal, and there is no `--yes` flag, no `--force`, and no environment
 *    variable that supplies either. §4.3 says "typed"; an unattended path would
 *    make the gate decorative.
 *  - invoked from `bun smoke`: "None is reachable through `bun smoke`" (§4.3).
 *    The check exists because the tempting convenience — have the boot enable
 *    schedules when it finds them off — is precisely the restart side-effect
 *    §6.3 forbids.
 */
export function assertProductionInitializationGates(options: {
  readonly env: Record<string, string | undefined>;
  readonly identity: "production" | "rehearsal" | null;
  readonly interactive: boolean;
  readonly invokedFromSmoke: boolean;
}): void {
  void options;
  throw new Error("NOT IMPLEMENTED: production-initialization gates — spec §4.3/§9.1, issue #1026 W1.9");
}

/**
 * Prompt for the `rm_owner` password at the terminal.
 *
 * §3: "`rm_owner` is `LOGIN`. Its password is typed at the terminal for the one
 * run that needs it and NEVER STORED." So: no echo, never written to the
 * receipt, never placed in an environment variable for a child process, and
 * never cached in the instance state directory — `scripts/lib/smoke-state.ts`
 * persists generated LOCAL passwords only, and a remote `rm_owner` is not one
 * of those.
 *
 * Refusal cases: no TTY; an empty password; a password that fails a verification
 * login (refuse before doing anything else, so a typo costs nothing); a
 * connection that authenticates as a role other than `rm_owner`.
 */
export function promptOwnerPassword(): Promise<string> {
  throw new Error("NOT IMPLEMENTED: typed rm_owner credential prompt — spec §3, issue #1026 W1.9");
}

/**
 * Ask `y/n` on the rendered plan.
 *
 * Only a literal `y` proceeds. Not `yes`, not empty-means-yes, not any
 * `--assume-yes`. The whole value of the gate is that a person read a specific
 * plan and typed a specific character; a default answer removes both halves.
 *
 * Refusal cases: anything other than `y`; a closed or non-interactive stdin.
 */
export function confirm(rendered: string): Promise<boolean> {
  void rendered;
  throw new Error("NOT IMPLEMENTED: y/n confirmation — spec §4.3, issue #1026 W1.9");
}

/**
 * The write: set `enabled = true` on the rows in `plan.toEnable`, and nothing
 * else.
 *
 * Runs inside the §2 xact fence (`withMutationFence`), as one transaction, as
 * `rm_owner`. One transaction because a partial enablement is a broken
 * lifecycle (sessions that open and never publish); fenced because §2 requires
 * every mutation — "schedule write" is in its list by name — to hold
 * `pg_advisory_xact_lock` on the connection performing it.
 *
 * The statement must name `enabled` as its only assignment and must filter to
 * `kind = ANY(...)` over {@link SWARM_SCHEDULE_KINDS}. It must NOT touch
 * `next_run_at`, `cron`, `payload`, `timezone` or `catchup_policy`, and a
 * reviewer should be able to confirm that by reading the one statement.
 *
 * Refusal cases:
 *  - the row count affected does not equal `plan.toEnable.length`: the rows
 *    moved between the plan and the write. Under a held target lock that should
 *    be impossible, so it is evidence the lock is not doing its job — abort the
 *    transaction and refuse loudly rather than accepting the discrepancy.
 *  - the connecting role is not `rm_owner`.
 *
 * Serves spec §10 W1: "Restart after schedules become overdue."
 */
export function applyEnablement(lock: TargetLock, plan: EnablementPlan): Promise<readonly ScheduleRow[]> {
  void lock;
  void plan;
  throw new Error("NOT IMPLEMENTED: enable the five swarm.* rows — spec §6.3, issue #1026 W1.9");
}

/**
 * The receipt this command leaves behind — the fourth gate of §4.3.
 *
 * Its job is to answer, months later and without the operator present: what did
 * this database look like before, what changed, who did it, and against which
 * target. It is the same kind of artifact as the deployment receipt of §1.4,
 * and incident work reads both.
 *
 * Must contain no credential: `rm_owner`'s password is typed and never stored
 * (§3), and a receipt is exactly the kind of file that gets pasted into a
 * thread.
 */
export interface SchedulesEnableReceipt {
  readonly command: "schedules:enable";
  readonly writtenAt: string;
  /** Database identity, redacted: `host/dbname`, never a connection string. */
  readonly database: string;
  readonly identity: "production";
  readonly rmEnv: "prod";
  readonly before: readonly ScheduleRow[];
  readonly after: readonly ScheduleRow[];
  /** Explicitly recorded as untouched, so a later reader knows it was a choice. */
  readonly nextRunAtTouched: false;
  readonly operator: string;
}

/**
 * Write the receipt durably before the command reports success.
 *
 * Before, not after: a success reported without a durable receipt is a change
 * that happened with no record, and the gate in §4.3 is the receipt, not the
 * intention to write one.
 *
 * Refusal cases: the receipt cannot be written or made durable — the command
 * exits non-zero and says the enablement DID land, because it did, and an
 * operator who is told the command failed will run it again.
 */
export function writeSchedulesEnableReceipt(path: string, receipt: SchedulesEnableReceipt): Promise<void> {
  void path;
  void receipt;
  throw new Error("NOT IMPLEMENTED: schedules:enable receipt — spec §4.3/§9.1, issue #1026 W1.9");
}

/**
 * Entry point: gates → target lock (§2) → revalidate → read plan → render →
 * typed `rm_owner` → `y/n` → fenced write → receipt → release the lock.
 *
 * The order is the spec's and is not rearrangeable. In particular the lock is
 * taken before the plan is read — §2's acquisition point is "before the first
 * read used for a decision", and the plan is nothing but reads used for a
 * decision — and released explicitly at the end, including on every refusal
 * path.
 *
 * Exit codes: 0 only when the write and the receipt both landed. A refusal at
 * any gate exits non-zero WITHOUT having read the database. An operator
 * answering `n` exits non-zero too: they declined, and a script that treats a
 * declined initialization as success will move on to step 5.
 */
export function main(argv: readonly string[]): Promise<number> {
  void argv;
  throw new Error("NOT IMPLEMENTED: schedules:enable entry point — spec §6.3/§9.1, issue #1026 W1.9");
}
