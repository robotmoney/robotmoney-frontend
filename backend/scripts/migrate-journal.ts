// The standalone migrate's journal — where `bun run migrate` records the phase
// it reached, on every exit (smoke-production-spec.md §2, §1.3).
//
// §2: "Connection loss. Detected at every phase boundary; the tool journals the
// phase and exits non-zero." For `bun smoke` the journal is §1.3's
// (scripts/lib/smoke-journal.ts). The spec names no place for a standalone
// `bun run migrate`'s, so it keeps its own in the directory its receipt goes
// to — the instance's state directory, or the directory of `--receipt` — one
// file per run, stamped like the receipt so the two records of one run sort
// together. A run that won the lock and succeeded has both; a run that lost,
// refused or died has the journal alone, naming the phase it stopped in.
//
// Kept apart from ./migrate-run.ts on purpose: that module reaches
// backend/src/config.ts, which validates DATABASE_URL at import, and
// backend/scripts/migrate.ts must be able to open the journal — and journal a
// refusal of its own `~/.env` — before it has any database URL to hand over.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MigrateCaller, MigrateGateOptions } from "./migrate-run.ts";

/** The journal's filename, in the directory the receipt goes to, stamped like
 *  the receipt so the two records of one run sort together. */
export function migrateJournalPath(dir: string, startedAt: Date): string {
  return join(dir, `migrate-journal-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`);
}

/** How a journaled phase ended. `started` is a phase still in progress, or one
 *  a process died inside without closing it. */
export type MigrateJournalStatus = "started" | "committed" | "refused" | "failed" | "interrupted";

export interface MigrateJournalRecord {
  readonly phase: string;
  readonly status: MigrateJournalStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** Why it refused, failed or was interrupted; `null` otherwise. */
  readonly reason: string | null;
}

/** The journal on disk. `outcome` stays `null` until the run ends. */
export interface MigrateJournalFile {
  readonly kind: "migrate-journal";
  readonly formatVersion: 1;
  readonly pid: number;
  readonly caller: MigrateCaller;
  readonly env: MigrateGateOptions["env"];
  /** host:port/dbname once known; `null` for a run refused before it read a target. */
  readonly target: string | null;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly outcome: "succeeded" | "refused" | "failed" | "interrupted" | null;
  /** The receipt a succeeded run wrote. */
  readonly receipt: string | null;
  readonly phases: readonly MigrateJournalRecord[];
}

/**
 * The standalone migrate's journal (§2: "the tool journals the phase and exits
 * non-zero"; see the header for where it lives and why).
 *
 * Written before each phase and marked after, like smoke's (§1.3), and closed
 * with an outcome on every exit. Every write replaces the whole file through a
 * rename, so a reader — an operator's `cat`, a test polling it — never meets a
 * half-written journal. Writes are synchronous so the `exit` handler, where no
 * promise runs, can still close it. It holds no credential: the owner password
 * never reaches it.
 */
export class MigrateJournal {
  private record: MigrateJournalFile;

  private constructor(
    readonly path: string,
    context: { readonly caller: MigrateCaller; readonly env: MigrateGateOptions["env"]; readonly startedAt: Date },
  ) {
    this.record = {
      kind: "migrate-journal",
      formatVersion: 1,
      pid: process.pid,
      caller: context.caller,
      env: context.env,
      target: null,
      openedAt: context.startedAt.toISOString(),
      closedAt: null,
      outcome: null,
      receipt: null,
      phases: [],
    };
  }

  /** Create the journal file. An existing file refuses: one run, one record. */
  static open(
    path: string,
    context: { readonly caller: MigrateCaller; readonly env: MigrateGateOptions["env"]; readonly startedAt: Date },
  ): MigrateJournal {
    const journal = new MigrateJournal(path, context);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, journal.text(), { encoding: "utf8", mode: 0o600, flag: "wx" });
    return journal;
  }

  get closed(): boolean {
    return this.record.closedAt !== null;
  }

  /** The phase in progress, if any. */
  get current(): string | null {
    const last = this.record.phases.at(-1);
    return last?.status === "started" ? last.phase : null;
  }

  setTarget(target: string): void {
    this.record = { ...this.record, target };
    this.persist();
  }

  /** Mark the phase in progress committed, then journal `phase` as begun. */
  begin(phase: string): void {
    if (this.closed) return;
    const now = new Date().toISOString();
    this.record = {
      ...this.record,
      phases: [
        ...this.endCurrent("committed", null, now),
        { phase, status: "started", startedAt: now, endedAt: null, reason: null },
      ],
    };
    this.persist();
  }

  /**
   * Close the run. The phase in progress takes the outcome (a success commits
   * it). A second close is ignored, so the `exit` handler can call this after a
   * path that already closed.
   */
  close(outcome: "succeeded" | "refused" | "failed" | "interrupted", reason: string | null, receipt?: string): void {
    if (this.closed) return;
    const now = new Date().toISOString();
    const status: MigrateJournalStatus = outcome === "succeeded" ? "committed" : outcome;
    const phases =
      this.current === null && outcome !== "succeeded"
        ? // Nothing in progress: the refusal happened between phases; name it anyway.
          [...this.record.phases, { phase: "(between phases)", status, startedAt: now, endedAt: now, reason }]
        : this.endCurrent(status, reason, now);
    this.record = { ...this.record, phases, closedAt: now, outcome, receipt: receipt ?? null };
    this.persist();
  }

  /** For `process.on("exit")`: a process leaving without closing its journal
   *  (a signal, a prompt's Ctrl-C, an uncaught error) records that, and where. */
  closeOnExit(code: number): void {
    this.close("interrupted", `the process exited with code ${code} before the run closed its journal`);
  }

  private endCurrent(status: MigrateJournalStatus, reason: string | null, at: string): MigrateJournalRecord[] {
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
