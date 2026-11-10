// `bun run prune` — the manual, receipted rm_owner prune (issue #1026, decision
// D55 (12); smoke-production-spec.md §3, system-scheduler-spec.md §6.3
// Retention).
//
// D55 (12): "Pruning is an operator command: a planned root `prune` script, run
// through `bun run`. It takes a typed `rm_owner` password, runs fenced under the
// target lock (smoke spec §2), and writes a receipt. It runs at each upgrade or
// on a runbook cadence. Nothing schedules it. Its retention window is a minimum
// of 7 days ... The window is a floor, not a schedule: the command never
// removes a row younger than it. The command lists exactly the tables it may
// prune ... It never prunes a security tombstone or audit history."
//
// WHY IT EXISTS. D55 (6) took DELETE and TRUNCATE from every runtime role on
// every table (migration 0107), so the only way a row leaves the database is an
// rm_owner run. D61 moved the "typed" password above into `~/.env`'s
// `rm_owner` line and the `y` into `--confirm-target`. This is that run: the one pruning path, for the tables whose rows stop
// mattering after a while.
//
// WHAT IT PRUNES, AND NOTHING ELSE (PRUNE_TARGETS below, a closed constant):
//   * `swarm_stream_events` rows committed before the cutoff. The log keeps a
//     time window of at least 7 days; a scheduler whose cursor falls below the
//     retained floor is told `log_truncated`, resyncs and rebuilds (scheduler
//     spec §6.3), so a prune loses nothing a subscriber still needs. The
//     counter row (`swarm_stream_head`) is never touched: numbering continues
//     from it, never from the rows left.
//   * `admin_session` rows that EXPIRED before the cutoff and were never
//     revoked. An expired session is refused by every read (auth.ts filters
//     `expires_at > now()`), and the sign-in it came from is audit_log's
//     `login_passkey` row, so the row has no audit value. A REVOKED session is
//     a security tombstone (D55 (6)) and is kept, whatever its age.
// WHAT IT NEVER PRUNES, BY CONSTRUCTION: every other table. In particular the
// revocation tombstones (`admin_session` / `admin_passkey` rows with
// `revoked_at`), `swarm_member_keys`, `automation_tokens`, `audit_log`, every
// append-only history table and every analytics ledger. The WebAuthn challenge
// slots need no prune: there are always exactly 32, overwritten in place
// (migration 0106).
//
// THE WINDOW. `--retention-days <n>`, default 7. A value below 7 refuses before
// anything connects: the window is a floor the owner confirmed, configurable
// upward only. The cutoff is `now() - n days` by the DATABASE's clock, taken
// inside the fenced transaction, so a skewed operator clock cannot move it.
//
// THE SEQUENCE, like `bun run migrate` (backend/scripts/migrate.ts):
//   plan (read the target) → lock (the §2 session lock, revalidated) → gates
//   (the §4.3 matrix) → owner (`~/.env`'s rm_owner line, proven by a login;
//   a missing line refuses naming the key and the file) → confirm
//   (`--confirm-target` equal to the target `~/.env` resolves, D61) → prune (ONE transaction, fenced
//   with `pg_advisory_xact_lock` on the target key, as rm_owner) → receipt.
// Beside the receipt a journal records the phase every run reached, refused
// and interrupted runs included (§2: a losing tool "journals the phase and
// exits non-zero").
//
// usage: bun run prune --confirm-target <host:port/database> [--retention-days <n>] [--instance <name>] [--receipt <path>] [--lock-timeout <seconds>]
//
// Nothing prompts and no terminal is needed (D61 rule 1).
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import postgres from "postgres";
import type postgresTypes from "postgres";
import { homeEnvFilePath, loadEnvFile, urlForRole } from "../../scripts/lib/env-role.ts";
import {
  confirmTargetFlag,
  homeEnvTarget,
  requireConfirmTarget,
  requirePrivilegedPassword,
  type RemoteAuthority,
} from "../../scripts/lib/privileged-env.ts";
import { PRODUCTION_INSTANCE, instancePaths, stateRoot } from "../../scripts/lib/smoke-state.ts";
import { resolveDeploymentPolicy, resolveRmEnv } from "../src/deploy-policy.ts";
import { on, registerQuery } from "../src/db/registry.ts";
import {
  acquireTargetLock,
  assertStillHeld,
  describeHolderText,
  readTargetState,
  releaseTargetLockOnExit,
  withFenceOn,
  type HeldTargetLock,
  type LockHolder,
} from "../src/db/target-lock.ts";

/** The retention floor, in days (D55 (12): "a minimum of 7 days, which the owner confirmed"). */
export const MIN_RETENTION_DAYS = 7;
/** The window when none is given: the floor itself. */
export const DEFAULT_RETENTION_DAYS = MIN_RETENTION_DAYS;

const CALLERS = ["scripts/prune"];

// ── The two statements, each a registered rm_owner site (spec §7.1) ─────────
//
// Each is one statement: the cutoff, the DELETE and the count. The cutoff is
// the database's `now()` minus the window, and it is returned even when no row
// matched, so the receipt can always name it.

const pruneStreamEvents = registerQuery({
  role: "rm_owner",
  object: "swarm_stream_events",
  // SELECT because the WHERE reads committed_at and RETURNING reads seq.
  privileges: ["DELETE", "SELECT"],
  site: "scripts/prune:pruneStreamEvents",
  purpose:
    "Remove scheduler event-log rows committed before the retention cutoff (at least 7 days), on an operator's " +
    "typed-owner `bun run prune` (D55 (12)).",
  callers: CALLERS,
  probe: {
    statement: `WITH cut AS (SELECT now() - make_interval(days => $1) AS at),
      gone AS (DELETE FROM swarm_stream_events e USING cut WHERE e.committed_at < cut.at RETURNING e.seq)
      SELECT (SELECT at FROM cut) AS cutoff, (SELECT count(*) FROM gone)::int AS rows`,
    params: [MIN_RETENTION_DAYS],
  },
});

const pruneExpiredSessions = registerQuery({
  role: "rm_owner",
  object: "admin_session",
  // SELECT because the WHERE reads revoked_at and expires_at, and RETURNING token.
  privileges: ["DELETE", "SELECT"],
  site: "scripts/prune:pruneExpiredSessions",
  purpose:
    "Remove admin sessions that expired before the retention cutoff and were never revoked; a revoked session is a " +
    "security tombstone and is kept (D55 (6), (12)).",
  callers: CALLERS,
  probe: {
    statement: `WITH cut AS (SELECT now() - make_interval(days => $1) AS at),
      gone AS (DELETE FROM admin_session s USING cut WHERE s.revoked_at IS NULL AND s.expires_at < cut.at RETURNING s.token)
      SELECT (SELECT at FROM cut) AS cutoff, (SELECT count(*) FROM gone)::int AS rows`,
    params: [MIN_RETENTION_DAYS],
  },
});

/** One table the command may prune: what it removes, and why that is safe. */
export interface PruneTarget {
  readonly table: string;
  /** The predicate, as the receipt records it. `<cutoff>` is `now() - window`. */
  readonly predicate: string;
  readonly why: string;
  readonly run: (db: postgresTypes.TransactionSql<{}>, days: number) => Promise<{ cutoff: Date; rows: number }>;
}

/**
 * THE CLOSED LIST. A table is pruned only if it is here, and a new entry is a
 * decision with its reason written down. Never a security tombstone, never
 * audit history (D55 (12)); tests/prune-command.test.ts plants both and proves
 * each survives.
 */
export const PRUNE_TARGETS: readonly PruneTarget[] = Object.freeze([
  {
    table: "swarm_stream_events",
    predicate: "committed_at < <cutoff>",
    why: "the event log keeps a window; a cursor below the retained floor gets resync-and-close (log_truncated)",
    run: async (db, days) => {
      const [row] = await on(db, pruneStreamEvents)<{ cutoff: Date; rows: number }>`
        WITH cut AS (SELECT now() - make_interval(days => ${days}) AS at),
          gone AS (DELETE FROM swarm_stream_events e USING cut WHERE e.committed_at < cut.at RETURNING e.seq)
          SELECT (SELECT at FROM cut) AS cutoff, (SELECT count(*) FROM gone)::int AS rows`;
      return { cutoff: row!.cutoff, rows: Number(row!.rows) };
    },
  },
  {
    table: "admin_session",
    predicate: "revoked_at IS NULL AND expires_at < <cutoff>",
    why: "an expired, never-revoked session is refused by every read and its sign-in is audit_log's; revoked ones are tombstones and stay",
    run: async (db, days) => {
      const [row] = await on(db, pruneExpiredSessions)<{ cutoff: Date; rows: number }>`
        WITH cut AS (SELECT now() - make_interval(days => ${days}) AS at),
          gone AS (DELETE FROM admin_session s USING cut WHERE s.revoked_at IS NULL AND s.expires_at < cut.at RETURNING s.token)
          SELECT (SELECT at FROM cut) AS cutoff, (SELECT count(*) FROM gone)::int AS rows`;
      return { cutoff: row!.cutoff, rows: Number(row!.rows) };
    },
  },
]);

/** A refusal the command reports and exits non-zero on, as distinct from a crash. */
export class PruneRefused extends Error {}

/**
 * The window from `--retention-days`. Refuses anything but a whole number of
 * days at or above the floor: the window is configurable upward only.
 */
export function parseRetentionDays(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_RETENTION_DAYS;
  if (!/^\d+$/.test(raw)) {
    throw new PruneRefused(`Refusing: --retention-days must be a whole number of days, got ${JSON.stringify(raw)}.`);
  }
  const days = Number(raw);
  if (days < MIN_RETENTION_DAYS) {
    throw new PruneRefused(
      `Refusing: --retention-days ${days} is below the ${MIN_RETENTION_DAYS}-day minimum (D55 (12)). The window is ` +
        "a floor the owner confirmed and may only be raised.",
    );
  }
  return days;
}

/** What one table's prune removed, as the receipt records it. */
export interface PrunedTable {
  readonly table: string;
  readonly predicate: string;
  readonly windowDays: number;
  readonly cutoff: string;
  readonly rows: number;
}

/**
 * The prune itself: every PRUNE_TARGETS entry, in ONE transaction fenced with
 * the target key's `pg_advisory_xact_lock` (§2), on the rm_owner pool the
 * caller opened. A competitor that wins the session lock after this process
 * lost it still blocks on the fence until this commits or aborts.
 */
export async function runPrune(
  owner: postgresTypes.Sql<{}>,
  options: { readonly windowDays: number; readonly lock: HeldTargetLock },
): Promise<readonly PrunedTable[]> {
  if (options.windowDays < MIN_RETENTION_DAYS) {
    throw new PruneRefused(`Refusing: a ${options.windowDays}-day window is below the ${MIN_RETENTION_DAYS}-day minimum.`);
  }
  await assertStillHeld(options.lock, "prune");
  return withFenceOn(owner, "prune", async (tx) => {
    const pruned: PrunedTable[] = [];
    for (const target of PRUNE_TARGETS) {
      const { cutoff, rows } = await target.run(tx as postgresTypes.TransactionSql<{}>, options.windowDays);
      pruned.push({
        table: target.table,
        predicate: target.predicate,
        windowDays: options.windowDays,
        cutoff: new Date(cutoff).toISOString(),
        rows,
      });
    }
    return pruned;
  });
}

// ── The journal (§2) ────────────────────────────────────────────────────────

type JournalStatus = "started" | "committed" | "refused" | "failed" | "interrupted";

export interface PruneJournalFile {
  readonly kind: "prune-journal";
  readonly formatVersion: 1;
  readonly pid: number;
  readonly env: "prod" | "stage" | null;
  readonly target: string | null;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly outcome: "succeeded" | "refused" | "failed" | "interrupted" | null;
  readonly receipt: string | null;
  readonly phases: readonly {
    readonly phase: string;
    readonly status: JournalStatus;
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly reason: string | null;
  }[];
}

/**
 * The prune's journal, beside its receipt: written before each phase, marked
 * after, closed with an outcome on every exit (the shape of
 * ./migrate-journal.ts's). Every write replaces the file through a rename, so
 * a reader never meets a half-written one. It holds no credential.
 */
export class PruneJournal {
  private record: PruneJournalFile;

  private constructor(readonly path: string, env: PruneJournalFile["env"], startedAt: Date) {
    this.record = {
      kind: "prune-journal",
      formatVersion: 1,
      pid: process.pid,
      env,
      target: null,
      openedAt: startedAt.toISOString(),
      closedAt: null,
      outcome: null,
      receipt: null,
      phases: [],
    };
  }

  /** Create the journal file. An existing file refuses: one run, one record. */
  static open(path: string, env: PruneJournalFile["env"], startedAt: Date): PruneJournal {
    const journal = new PruneJournal(path, env, startedAt);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, journal.text(), { encoding: "utf8", mode: 0o600, flag: "wx" });
    return journal;
  }

  get closed(): boolean {
    return this.record.closedAt !== null;
  }

  setTarget(target: string): void {
    this.record = { ...this.record, target };
    this.persist();
  }

  begin(phase: string): void {
    if (this.closed) return;
    const now = new Date().toISOString();
    this.record = {
      ...this.record,
      phases: [...this.endCurrent("committed", null, now), { phase, status: "started", startedAt: now, endedAt: null, reason: null }],
    };
    this.persist();
  }

  close(outcome: "succeeded" | "refused" | "failed" | "interrupted", reason: string | null, receipt?: string): void {
    if (this.closed) return;
    const now = new Date().toISOString();
    const status: JournalStatus = outcome === "succeeded" ? "committed" : outcome;
    const last = this.record.phases.at(-1);
    const phases =
      last?.status !== "started" && outcome !== "succeeded"
        ? [...this.record.phases, { phase: "(between phases)", status, startedAt: now, endedAt: now, reason }]
        : this.endCurrent(status, reason, now);
    this.record = { ...this.record, phases, closedAt: now, outcome, receipt: receipt ?? null };
    this.persist();
  }

  closeOnExit(code: number): void {
    this.close("interrupted", `the process exited with code ${code} before the run closed its journal`);
  }

  private endCurrent(status: JournalStatus, reason: string | null, at: string): PruneJournalFile["phases"][number][] {
    const phases = [...this.record.phases];
    const last = phases.at(-1);
    if (last?.status === "started") phases[phases.length - 1] = { ...last, status, endedAt: at, reason };
    return phases;
  }

  private text(): string {
    return `${JSON.stringify(this.record, null, 2)}\n`;
  }

  private persist(): void {
    const staging = `${this.path}.${process.pid}.tmp`;
    writeFileSync(staging, this.text(), { encoding: "utf8", mode: 0o600 });
    renameSync(staging, this.path);
  }
}

const stamp = (at: Date): string => at.toISOString().replace(/[:.]/g, "-");

/** The receipt's filename in the directory it goes to, stamped like the journal's. */
export function pruneReceiptPath(dir: string, startedAt: Date): string {
  return join(dir, `prune-receipt-${stamp(startedAt)}.json`);
}

export function pruneJournalPath(dir: string, startedAt: Date): string {
  return join(dir, `prune-journal-${stamp(startedAt)}.json`);
}

// ── The command ─────────────────────────────────────────────────────────────

/** Password-free `host:port/dbname`, the only form of a target this command prints. */
function redacted(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
}

function asOwner(url: string, password: string): string {
  const u = new URL(url);
  u.username = "rm_owner";
  u.password = encodeURIComponent(password);
  return u.toString();
}

export interface PruneReceipt {
  readonly kind: "prune-receipt";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly env: "prod" | "stage" | null;
  readonly target: string;
  readonly targetLock: string;
  readonly windowDays: number;
  readonly tables: readonly PrunedTable[];
}

/**
 * THE sequence: plan, lock, gates, owner, confirm, prune, receipt — each phase
 * journaled. Refusals throw {@link PruneRefused}; the caller exits non-zero.
 */
export async function pruneCommand(input: {
  readonly env: "prod" | "stage" | null;
  /** The target under a credential that cannot delete (`rm_readonly` from `~/.env`). */
  readonly readerUrl: string;
  readonly windowDays: number;
  readonly holder: Omit<LockHolder, "acquiredAt">;
  readonly lockTimeoutMs: number;
  readonly receiptPath: string;
  readonly journal: PruneJournal;
  /** `~/.env`'s rm_owner line, the file, `--confirm-target` and the target the
   *  file resolves to (D61). Never logged, never written. */
  readonly authority: RemoteAuthority;
  readonly log: (message: string) => void;
}): Promise<{ readonly receipt: string; readonly tables: readonly PrunedTable[] }> {
  const startedAt = new Date();
  const target = redacted(input.readerUrl);
  const journal = input.journal;
  journal.setTarget(target);
  const reader = postgres(input.readerUrl, { max: 1, onnotice: () => {} });
  let owner: postgresTypes.Sql<{}> | null = null;
  let release: (() => Promise<void>) | null = null;
  let lock: HeldTargetLock | null = null;
  const phase = async (name: string): Promise<void> => {
    journal.begin(name);
    if (lock !== null) await assertStillHeld(lock, name);
  };
  try {
    // The window is judged again here, so no caller reaches the prune with a
    // window below the floor, whatever parsed it.
    parseRetentionDays(String(input.windowDays));

    await phase("plan");
    const expected = await readTargetState(reader);
    await phase("lock");
    const acquired = await acquireTargetLock({
      databaseUrl: input.readerUrl,
      holder: input.holder,
      timeoutMs: input.lockTimeoutMs,
      expected,
    });
    if (!acquired.acquired) throw new PruneRefused(`Refusing: ${acquired.reason}`);
    const held = acquired.lock;
    const dispose = releaseTargetLockOnExit(held);
    release = async () => {
      dispose();
      await held.release();
    };
    lock = held;

    // §4.3: the policy and the target's enrollment must agree, as for every
    // tool that writes a database. A target that is enrolled as nothing is
    // not pruned.
    await phase("gates");
    const verdict = resolveDeploymentPolicy({
      rmEnv: input.env ?? undefined,
      connection: "remote",
      identity: expected.identity === "missing" ? null : expected.identity,
    });
    if (!verdict.allow) throw new PruneRefused(`Refusing: ${verdict.reason}`);
    if (expected.identity === "missing") {
      throw new PruneRefused(
        "Refusing: this database has no deployment_identity row, so it is not enrolled as anything (spec §4.2).",
      );
    }
    input.log(`target ${target} (${expected.identity}) under ${describeHolderText(held.holder)}`);

    await phase("owner");
    let password: string;
    try {
      password = requirePrivilegedPassword({ rm_owner: input.authority.ownerPassword }, "rm_owner", input.authority.envFile);
    } catch (error) {
      throw new PruneRefused((error as Error).message);
    }
    // Prove the login before the confirmation: a connection is opened and
    // authenticated, and no statement is issued on it until the fenced prune.
    owner = postgres(asOwner(input.readerUrl, password), { max: 1, onnotice: () => {} });
    try {
      (await owner.reserve()).release();
    } catch (error) {
      const message = (error as Error).message.split(password).join("***");
      throw new PruneRefused(`Refusing: the rm_owner credential was not accepted by this database (${message}).`);
    }

    await phase("confirm");
    const plan = PRUNE_TARGETS.map((t) => `  ${t.table}: ${t.predicate}`).join("\n");
    input.log(
      `WARNING: this deletes rows from ${target} as rm_owner, with a ${input.windowDays}-day window ` +
        "(<cutoff> = the database's now() minus the window):\n" +
        `${plan}\n` +
        "Nothing else is touched: no security tombstone, no audit history.",
    );
    try {
      requireConfirmTarget(input.authority.confirmTarget, input.authority.resolvedTarget, "this prune");
    } catch (error) {
      throw new PruneRefused((error as Error).message);
    }

    await phase("prune");
    const tables = await runPrune(owner, { windowDays: input.windowDays, lock: held });
    for (const t of tables) input.log(`${t.table}: ${t.rows} row(s) where ${t.predicate}, cutoff ${t.cutoff}`);

    await phase("receipt");
    const receipt: PruneReceipt = {
      kind: "prune-receipt",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      env: input.env,
      target,
      targetLock: describeHolderText(held.holder),
      windowDays: input.windowDays,
      tables,
    };
    mkdirSync(dirname(input.receiptPath), { recursive: true, mode: 0o700 });
    writeFileSync(input.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    journal.close("succeeded", null, input.receiptPath);
    return { receipt: input.receiptPath, tables };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    journal.close(error instanceof PruneRefused || message.startsWith("Refusing") ? "refused" : "failed", message);
    throw error;
  } finally {
    await owner?.end({ timeout: 5 }).catch(() => undefined);
    await release?.().catch(() => undefined);
    await reader.end({ timeout: 5 }).catch(() => undefined);
  }
}

// ── The CLI ─────────────────────────────────────────────────────────────────

async function main(): Promise<never> {
  const NAME = "prune";
  const err = (m: string) => console.error(`[${NAME}] ${m}`);
  const log = (m: string) => console.log(`[${NAME}] ${m}`);
  let journal: PruneJournal | undefined;
  const refuse = (message: string): never => {
    journal?.close("refused", message);
    err(message);
    process.exit(1);
  };
  const flag = (name: string): string | undefined => {
    const at = process.argv.indexOf(name);
    if (at < 0) return undefined;
    const value = process.argv[at + 1];
    if (!value || value.startsWith("--")) refuse(`${name} needs a value`);
    return value;
  };

  // The window first: a refused window never connects to anything.
  let windowDays = DEFAULT_RETENTION_DAYS;
  try {
    windowDays = parseRetentionDays(flag("--retention-days"));
  } catch (error) {
    refuse((error as Error).message);
  }
  const receiptFlag = flag("--receipt");
  const instanceFlag = flag("--instance");
  const confirmTarget = confirmTargetFlag(process.argv.slice(2));
  const lockTimeoutSeconds = Number(flag("--lock-timeout") ?? 60);
  if (!Number.isFinite(lockTimeoutSeconds) || lockTimeoutSeconds < 0) refuse("--lock-timeout needs a number of seconds");

  const envPath = homeEnvFilePath();
  const env = loadEnvFile(envPath);
  const policy = resolveRmEnv({ RM_ENV: process.env.RM_ENV ?? env?.RM_ENV });
  if (!policy.ok) refuse(policy.reason);
  const rmEnv = policy.ok && policy.source !== "unset" ? policy.env : null;

  // The receipt's home, before anything connects.
  const startedAt = new Date();
  let receiptDir: string;
  if (receiptFlag === undefined) {
    const instance = instanceFlag ?? (rmEnv === "prod" ? PRODUCTION_INSTANCE : undefined);
    if (instance === undefined) {
      refuse("name the instance whose state directory receives the receipt (--instance <name>), or pass --receipt <path>.");
    }
    receiptDir = instancePaths(stateRoot(process.env), instance!).dir;
  } else {
    receiptDir = dirname(resolve(receiptFlag));
  }
  journal = PruneJournal.open(pruneJournalPath(receiptDir, startedAt), rmEnv, startedAt);
  process.on("exit", (code) => journal?.closeOnExit(code));
  journal.begin("config");

  if (!env) refuse(`no readable $HOME/.env (${envPath}).`);
  const readerUrl = urlForRole(env!, "rm_readonly");
  if (!readerUrl) {
    refuse("$HOME/.env cannot assemble an rm_readonly connection (host, port, database, sslmode and an rm_readonly line).");
  }

  const receiptPath = receiptFlag === undefined ? pruneReceiptPath(receiptDir, startedAt) : resolve(receiptFlag);
  try {
    const { receipt, tables } = await pruneCommand({
      env: rmEnv,
      readerUrl: readerUrl!,
      windowDays,
      holder: { tool: NAME, planId: null, instance: instanceFlag ?? null, host: hostname(), pid: process.pid },
      lockTimeoutMs: lockTimeoutSeconds * 1000,
      receiptPath,
      journal,
      authority: { ownerPassword: env!.rm_owner, envFile: envPath, confirmTarget, resolvedTarget: homeEnvTarget(env!)! },
      log,
    });
    log(`pruned ${tables.reduce((n, t) => n + t.rows, 0)} row(s) across ${tables.length} table(s)`);
    log(`receipt ${receipt}`);
    process.exit(0);
  } catch (error) {
    err(error instanceof PruneRefused ? error.message : `failed: ${error instanceof Error ? error.message : String(error)}`);
    log(`journal ${journal.path}`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
