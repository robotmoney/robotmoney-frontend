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

import { createInterface } from "node:readline";
import { open, writeFile } from "node:fs/promises";
import parser from "cron-parser";
import postgres from "postgres";
import { acquireTargetLock, assertStillHeld, revalidateAfterAcquire, targetLockKey } from "../src/db/target-lock.ts";
import type { DbHandle } from "../src/db/client.ts";
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
export async function readEnablementPlan(lock: TargetLock): Promise<EnablementPlan> {
  const rows = await lock.connection<
    { kind: string; cron: string; enabled: boolean; next_run_at: string | null; catchup_policy: string }[]
  >`
    SELECT kind, cron, enabled, next_run_at::text AS next_run_at, catchup_policy
      FROM job_schedules
     WHERE kind = ANY(${[...SWARM_SCHEDULE_KINDS]})
     ORDER BY kind`;

  const missing = SWARM_SCHEDULE_KINDS.filter((kind) => !rows.some((row) => row.kind === kind));
  if (missing.length > 0) {
    throw new Error(
      `schedules:enable: the lifecycle rows ${missing.join(", ")} are absent from job_schedules. ` +
        "This command enables rows; it does not create them, because the cadence is not its to choose. Seed them first.",
    );
  }
  const duplicated = SWARM_SCHEDULE_KINDS.filter((kind) => rows.filter((row) => row.kind === kind).length > 1);
  if (duplicated.length > 0) {
    const detail = duplicated
      .map((kind) => `${kind}: ${rows.filter((row) => row.kind === kind).map((row) => `cron ${row.cron}, enabled ${row.enabled}`).join(" / ")}`)
      .join("; ");
    throw new Error(
      `schedules:enable: more than one job_schedules row exists per kind (${detail}). ` +
        "The scheduler's behaviour would depend on which one is enabled, so nothing is written.",
    );
  }
  for (const row of rows) {
    try {
      parser.parseExpression(row.cron);
    } catch (error) {
      throw new Error(
        `schedules:enable: the cron string for ${row.kind} does not parse (${row.cron}): ${(error as Error).message}. ` +
          "Enabling it would produce a schedule that never fires and a preflight that fails on the next boot.",
      );
    }
  }

  const now = Date.now();
  const ordered = SWARM_SCHEDULE_KINDS.map((kind): ScheduleRow => {
    const row = rows.find((candidate) => candidate.kind === kind) as (typeof rows)[number];
    return {
      kind,
      cron: row.cron,
      enabled: row.enabled,
      nextRunAt: row.next_run_at,
      catchupPolicy: row.catchup_policy,
    };
  });

  return {
    rows: ordered,
    toEnable: ordered.filter((row) => !row.enabled).map((row) => row.kind),
    alreadyEnabled: ordered.filter((row) => row.enabled).map((row) => row.kind),
    overdue: ordered
      .filter((row) => row.enabled && (row.nextRunAt === null || Date.parse(row.nextRunAt) <= now))
      .map((row) => row.kind),
  };
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
  const lines = ["schedules:enable — the five swarm.* lifecycle rows", ""];
  for (const row of plan.rows) {
    const change = row.enabled ? "already enabled, no change" : "enabled: false -> true";
    lines.push(
      `  ${row.kind}  cron ${row.cron}  catchup_policy ${row.catchupPolicy}  ` +
        `next_run_at ${row.nextRunAt ?? "NULL"}${plan.overdue.includes(row.kind) ? " (overdue)" : ""}  — ${change}`,
    );
  }
  lines.push(
    "",
    `Rows to enable: ${plan.toEnable.length === 0 ? "none" : plan.toEnable.join(", ")}`,
    `Already enabled: ${plan.alreadyEnabled.length === 0 ? "none" : plan.alreadyEnabled.join(", ")}`,
    "",
    "This command writes `enabled` and nothing else. next_run_at is NOT touched: an overdue or NULL",
    "next_run_at stays exactly as it is, and the scheduler initializes or drains it per each row's",
    "catchup_policy. A row that still looks overdue after this command has not failed.",
  );
  return lines.join("\n");
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
  if (options.env.RM_ENV !== "prod") {
    throw new Error(
      `schedules:enable: RM_ENV is ${options.env.RM_ENV ?? "unset"}, not prod. This is a production-initialization ` +
        "command (spec §9.1); elsewhere the schedule rows are environment-configured and not operator state.",
    );
  }
  if (options.identity !== "production") {
    throw new Error(
      options.identity === null
        ? "schedules:enable: this target is not enrolled — deployment_identity has no row, so it is not production " +
          "(spec §4.2). Production cadences must not start against an un-enrolled database."
        : "schedules:enable: deployment_identity is rehearsal, not production (spec §4.2). Enabling production " +
          "schedules here would start real cadences against rehearsal data.",
    );
  }
  if (!options.interactive) {
    throw new Error(
      "schedules:enable: no terminal is attached. The rm_owner password is typed and the confirmation is typed, " +
        "and there is no unattended path to either (spec §4.3).",
    );
  }
  if (options.invokedFromSmoke) {
    throw new Error(
      "schedules:enable: this command was invoked from bun smoke. None of the production-initialization commands " +
        "is reachable through the boot (spec §4.3) — enablement is an operator action, not a restart side-effect.",
    );
  }
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
export async function promptOwnerPassword(): Promise<string> {
  if (process.stdin.isTTY !== true) {
    throw new Error(
      "schedules:enable: the rm_owner password is typed at a terminal and never stored (spec §3), and no terminal " +
        "is attached to this process.",
    );
  }
  const typed = await readLine("rm_owner password: ", { echo: false });
  if (typed === "") {
    throw new Error("schedules:enable: an empty rm_owner password is not a credential.");
  }
  return typed;
}

/**
 * Read one line from the terminal, optionally without echoing it.
 *
 * Shared by the credential prompt and the `y/n`: both are "a person typed this
 * at a terminal", and neither has a non-interactive form.
 */
async function readLine(prompt: string, options: { echo: boolean }): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (!options.echo) {
    // Suppress echo for the credential: readline still receives the keystrokes,
    // the terminal just does not print them, so the password never reaches the
    // scrollback an operator later pastes into a thread.
    (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => {};
    process.stdout.write(prompt);
  }
  try {
    const answer = await new Promise<string>((resolve) => rl.question(options.echo ? prompt : "", resolve));
    if (!options.echo) process.stdout.write("\n");
    return answer.trim();
  } finally {
    rl.close();
  }
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
export async function confirm(rendered: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    throw new Error(
      "schedules:enable: stdin is not a terminal, so the y/n cannot be typed. It does not default to yes (spec §4.3).",
    );
  }
  process.stdout.write(`${rendered}\n\n`);
  const answer = await readLine("Enable these rows? [y/n] ", { echo: true });
  return answer === "y";
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
export async function applyEnablement(lock: TargetLock, plan: EnablementPlan): Promise<readonly ScheduleRow[]> {
  const toEnable = [...plan.toEnable];
  if (toEnable.length > 0) {
    // A pool handle opens the transaction with `begin`; a handle that is already
    // inside one (a caller that fenced a wider mutation) nests with `savepoint`.
    // Either way the write is atomic, so a refused count rolls all of it back.
    const conn = lock.connection;
    const begin = ("begin" in conn ? conn.begin : conn.savepoint) as unknown as (
      body: (tx: DbHandle) => Promise<void>,
    ) => Promise<void>;
    await begin(async (tx) => {
      // The fence first, on the connection performing the mutation (§2).
      await tx`SELECT pg_advisory_xact_lock(${lock.key.toString()}::bigint)`;
      // One assignment, one filter. `enabled` is the only column named, and the
      // filter is the five lifecycle kinds intersected with the plan.
      const updated = await tx<{ kind: string }[]>`
        UPDATE job_schedules
           SET enabled = true
         WHERE kind = ANY(${toEnable})
           AND kind = ANY(${[...SWARM_SCHEDULE_KINDS]})
        RETURNING kind`;
      if (updated.length !== toEnable.length) {
        throw new Error(
          `schedules:enable: the write matched ${updated.length} rows but the plan named ${toEnable.length}. ` +
            "Under a held target lock the rows cannot move between the plan and the write, so this is evidence the " +
            "lock is not doing its job. Nothing is enabled: the transaction is rolled back.",
        );
      }
    });
  }
  return (await readEnablementPlan(lock)).rows;
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
export async function writeSchedulesEnableReceipt(path: string, receipt: SchedulesEnableReceipt): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    // Durable, not merely written: a receipt lost to a crashed host is the same
    // as a receipt never written, and this is the gate of §4.3.
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new Error(
      `schedules:enable: the receipt could not be written to ${path} (${(error as Error).message}). ` +
        "The enablement DID land — the rows are enabled. Do not re-run the command; record the change by hand.",
    );
  }
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
export async function main(argv: readonly string[]): Promise<number> {
  const env = process.env;
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const invokedFromSmoke = env.RM_INVOKED_FROM_SMOKE === "1";
  const receiptIndex = argv.indexOf("--receipt");
  const receiptPath =
    receiptIndex >= 0 ? argv[receiptIndex + 1] : `schedules-enable-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  if (receiptPath === undefined) {
    process.stderr.write("schedules:enable: --receipt needs a path.\n");
    return 1;
  }

  try {
    // The three gates that need no database, checked before the database is
    // opened at all. The fourth needs `deployment_identity`, so it is re-checked
    // below once that one read has happened.
    assertProductionInitializationGates({ env, identity: "production", interactive, invokedFromSmoke });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    process.stderr.write("schedules:enable: DATABASE_URL is not set.\n");
    return 1;
  }

  const probe = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  let identity: "production" | "rehearsal" | null;
  let key;
  let databaseName: string;
  try {
    const [where] = await probe<{ db: string; sysid: string }[]>`
      SELECT current_database() AS db, (SELECT system_identifier::text FROM pg_control_system()) AS sysid`;
    databaseName = where?.db ?? "";
    key = targetLockKey({ systemIdentifier: where?.sysid ?? "", databaseName });
    const rows = await probe<{ kind: string }[]>`SELECT kind FROM deployment_identity LIMIT 1`;
    identity = rows[0]?.kind === "production" ? "production" : rows[0] === undefined ? null : "rehearsal";
  } catch (error) {
    process.stderr.write(`schedules:enable: the target could not be identified (${(error as Error).message}).\n`);
    return 1;
  } finally {
    await probe.end({ timeout: 5 });
  }

  try {
    assertProductionInitializationGates({ env, identity, interactive, invokedFromSmoke });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  const acquired = await acquireTargetLock({
    databaseUrl,
    key,
    holder: {
      tool: "schedules:enable",
      instance: env.RM_INSTANCE ?? null,
      host: env.HOSTNAME ?? "unknown",
      pid: process.pid,
    },
    timeoutMs: 60_000,
  });
  if (!acquired.acquired) {
    process.stderr.write(`${acquired.reason}\n`);
    return 1;
  }
  const lock = acquired.lock;

  try {
    const revalidated = await revalidateAfterAcquire(lock, { identity: "production", ledgerHead: null, manifestHash: null });
    if (!revalidated.ok) {
      process.stderr.write(`schedules:enable: the target moved while waiting for the lock — ${revalidated.reason}\n`);
      return 1;
    }
    await assertStillHeld(lock, "schedules:enable plan");

    const plan = await readEnablementPlan(lock);
    const before = plan.rows;
    // Typed credential first, then the y/n on a plan the operator has seen.
    await promptOwnerPassword();
    if (!(await confirm(renderEnablementPlan(plan)))) {
      process.stderr.write("schedules:enable: declined. Nothing was written.\n");
      return 1;
    }

    const after = await applyEnablement(lock, plan);
    const url = new URL(databaseUrl);
    await writeSchedulesEnableReceipt(receiptPath, {
      command: "schedules:enable",
      writtenAt: new Date().toISOString(),
      database: `${url.hostname}/${databaseName}`,
      identity: "production",
      rmEnv: "prod",
      before,
      after,
      nextRunAtTouched: false,
      operator: env.USER ?? env.LOGNAME ?? "unknown",
    });
    process.stdout.write(`schedules:enable: ${plan.toEnable.length} row(s) enabled; receipt at ${receiptPath}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  } finally {
    await lock.release();
  }
}

if (import.meta.main) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
