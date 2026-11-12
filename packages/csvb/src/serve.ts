// `csvb serve` and `csvb stale`: the scheduled backup (issue 1608, D80).
//
// One wake of the loop (`serveOnce`): fast-forward the clone of the data repo to its remote, find out whether a UTC
// day boundary is sealed (an hour in the past) beyond the clone's newest backup, run `runBackup` against the read
// replica, verify what it added, commit ONLY `csv/**`, and push without force. Any failure leaves the remote ref
// unchanged and the clone as it was (a commit the push could not deliver is rolled back).
//
// The data repo holds data only (D80 item 1). Nothing in the clone is ever run: the image holds this tool, and the
// clone is read and written as files. Stray tooling files in a clone are neither run nor staged.
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { backupIdOfDay, DAY_MS, lastSealedDayMs } from "@robotmoney/analyst-sdk/src/archive/format1.ts";
import { defaultOptions, requestAbort, runBackup, type BackupOptions } from "./backup.ts";
import { BACKUP_ID_RE, CSV_DIR } from "./model.ts";
import { verifyRepo } from "./verify.ts";

type Sql = postgres.Sql<{}>;

/** The newest backup id in a clone (by directory: cheap, and it needs no database), or null. */
export function newestBackupId(repo: string): string | null {
  const d = join(repo, CSV_DIR);
  if (!existsSync(d)) return null;
  const ids = readdirSync(d).filter((n) => BACKUP_ID_RE.test(n) && existsSync(join(d, n, "backup.json"))).sort();
  return ids.length ? ids[ids.length - 1]! : null;
}

const idMs = (id: string): number => Date.parse(`${id.slice(0, 4)}-${id.slice(5, 7)}-${id.slice(8, 10)}T${id.slice(11, 13)}:${id.slice(13, 15)}:${id.slice(15, 17)}Z`);

export interface Staleness {
  id: string | null;
  ageDays: number;
  stale: boolean;
  message: string;
}

/** Is the newest backup older than `maxDays` at `nowMs`? An empty clone is stale. */
export function staleness(repo: string, maxDays: number, nowMs: number): Staleness {
  const id = newestBackupId(repo);
  if (id === null) return { id, ageDays: Infinity, stale: true, message: `stale: ${repo} holds no backup` };
  const ageDays = (nowMs - idMs(id)) / DAY_MS;
  const stale = ageDays > maxDays;
  const age = ageDays.toFixed(1);
  return { id, ageDays, stale, message: stale ? `stale: newest backup ${id} is ${age} days old (limit ${maxDays})` : `ok: newest backup ${id} is ${age} days old (limit ${maxDays})` };
}

// ── git, as a client of the data repo ───────────────────────────────────────────────────────────

const git = (repo: string, args: string[], env?: Record<string, string>): string =>
  execFileSync("git", ["-C", repo, "-c", "user.name=csvb-backup", "-c", "user.email=csvb-backup@robotmoney.invalid", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    timeout: 600_000, // a hung network never wedges a wake
  }).trim();

const tryGit = (repo: string, args: string[]): string | null => {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
};

// ── what keeps the scheduled backup gentle (D82: optional, non-gating) ──────────────────────────
/** Pause between pages: a real, non-zero default (a hand run's is 50). */
export const SERVE_PAUSE_MS = 250;
/** Time budget of one wake: under the wake interval, so wakes cannot pile up. */
export const SERVE_MAX_SECONDS = 1800;
/** No tight loop, whatever the setting: wakes are at least this far apart. */
export const MIN_INTERVAL_S = 60;
/** After repeated failures the wait doubles, up to this. */
export const MAX_BACKOFF_S = 6 * 3600;

/** Seconds to sleep after a wake: the interval (never under the minimum), doubled per consecutive failure, bounded. */
export function nextDelayS(intervalS: number, failures: number): number {
  const base = Math.max(MIN_INTERVAL_S, intervalS);
  if (failures <= 0) return base;
  return Math.min(base * 2 ** Math.min(failures, 20), Math.max(base, MAX_BACKOFF_S));
}

export interface ServeOptions {
  /** The clone of the data repo. Cloned from `remote` when it does not exist. */
  repo: string;
  /** The remote's URL (only needed when the clone does not exist yet). */
  remoteUrl?: string;
  remote?: string;
  branch?: string;
  sql: Sql;
  nowMs: () => number;
  maxRssMb: number;
  /** Pause between pages (default {@link SERVE_PAUSE_MS}) and the time budget of one wake (default {@link SERVE_MAX_SECONDS}). */
  pauseMs?: number;
  maxSeconds?: number;
  /** Tests only: replaces fields of the backup options (the tables, the replica requirement, the junction). */
  backup?: Partial<BackupOptions>;
  /**
   * Extra environment for git (the ssh command carrying the push key). A function is called inside each wake, after
   * the credentials are known to be in place, so a missing or rotated key never breaks startup.
   */
  gitEnv?: Record<string, string> | (() => Record<string, string>);
  log: (line: string) => void;
}

/**
 * The backup options one wake runs with: the replica only (the command line cannot turn that off), ONE connection (the
 * caller's `sql`, opened with max 1), a statement timeout, a real pause between pages and a time budget.
 */
export function serveBackupOptions(o: Pick<ServeOptions, "sql" | "repo" | "maxRssMb" | "pauseMs" | "maxSeconds" | "log" | "backup">, nowMs: number): BackupOptions {
  return { ...defaultOptions(o.sql, o.repo), maxRssMb: o.maxRssMb, pauseMs: o.pauseMs ?? SERVE_PAUSE_MS, maxSeconds: o.maxSeconds ?? SERVE_MAX_SECONDS, nowMs, log: o.log, ...o.backup };
}

/** Wakes never overlap: an exclusive lock file beside the clone. A lock whose process is gone is taken over. */
async function withLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${repo}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(lock, "utf8").trim());
      let alive = pid > 0;
      if (alive) {
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
      }
      if (alive || attempt > 0) throw new Error(`another wake holds the lock ${lock} (pid ${pid}); this wake does nothing`);
      rmSync(lock, { force: true });
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

export interface ServeResult {
  /** The backup ids this wake cut (or found uncommitted from an earlier wake and committed). */
  ids: string[];
  pushed: boolean;
}

/** One wake. Throws on any failure; the remote is then unchanged and the clone holds nothing new. */
export function serveOnce(o: ServeOptions): Promise<ServeResult> {
  return withLock(o.repo, () => wake(o));
}

async function wake(o: ServeOptions): Promise<ServeResult> {
  const remote = o.remote ?? "origin";
  const branch = o.branch ?? "main";
  const genv = typeof o.gitEnv === "function" ? o.gitEnv() : o.gitEnv;
  if (!existsSync(join(o.repo, ".git"))) {
    if (!o.remoteUrl) throw new Error(`${o.repo} is not a clone and no remote URL was given`);
    mkdirSync(dirname(o.repo), { recursive: true });
    execFileSync("git", ["clone", "--quiet", o.remoteUrl, o.repo], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...genv } });
    o.log(`cloned ${remote} into ${o.repo}`);
  }
  // Bring the clone level with the remote by fast-forward only; a clone ahead of or diverged from it is refused.
  git(o.repo, ["fetch", "--quiet", remote], genv);
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const hasRemoteBranch = tryGit(o.repo, ["rev-parse", "--verify", "--quiet", remoteRef]) !== null;
  if (hasRemoteBranch) {
    const ahead = git(o.repo, ["rev-list", `${remoteRef}..HEAD`]);
    if (ahead !== "") throw new Error(`the clone has commits that ${remote}/${branch} lacks; refusing to push them (no force push, ever)`);
    git(o.repo, ["merge", "--ff-only", "--quiet", remoteRef]);
  }
  const before = git(o.repo, ["rev-parse", "HEAD"]);
  const now = o.nowMs();

  // Is a boundary sealed beyond the newest backup? Backups already moved into the clone by an interrupted wake
  // (files present, no commit) are committed below without cutting again.
  const newest = newestBackupId(o.repo);
  const sealed = backupIdOfDay(lastSealedDayMs(now));
  const cutsDue = newest === null || sealed > newest;
  const uncommitted = git(o.repo, ["status", "--porcelain", "--", CSV_DIR]) !== "";
  if (!cutsDue && !uncommitted) {
    o.log(`nothing to do: the newest backup ${newest} is the newest sealed boundary`);
    return { ids: [], pushed: false };
  }

  try {
    const ids: string[] = [];
    if (cutsDue) {
      const opts = serveBackupOptions(o, now);
      const recs = await runBackup(opts);
      ids.push(...recs.map((r) => r.backup));
    }
    const problems = await verifyRepo({ root: o.repo });
    if (problems.length) throw new Error(`csvb verify failed on the clone:\n  ${problems.join("\n  ")}`);
    // Stage and commit csv/** only: whatever else a clone holds is not ours.
    git(o.repo, ["add", "--all", "--", CSV_DIR]);
    const staged = git(o.repo, ["diff", "--cached", "--name-only", "--", CSV_DIR]);
    if (staged === "") return { ids: [], pushed: false };
    const label = ids.length ? ids.join(", ") : "an interrupted earlier run";
    git(o.repo, ["commit", "--quiet", "-m", `backup: ${label}`, "--", CSV_DIR]);
    git(o.repo, ["push", "--quiet", remote, `HEAD:refs/heads/${branch}`], genv); // never --force: a non-fast-forward is refused
    o.log(`pushed ${label} to ${remote}/${branch}`);
    return { ids, pushed: true };
  } catch (e) {
    // The remote did not move. Put the clone back where this wake found it, csv/ only.
    tryGit(o.repo, ["reset", "--quiet", "--hard", before]);
    tryGit(o.repo, ["clean", "-fdq", "--", CSV_DIR]);
    throw e;
  }
}

// ── the loop and its health ─────────────────────────────────────────────────────────────────────

export interface LoopOptions extends Omit<ServeOptions, "sql"> {
  connect: () => Sql;
  /** Are the replica connection file and the push key in place? Asked on every wake, so placing them needs no restart. */
  provisioned: () => string | null;
  staleDays: number;
  intervalS: number;
  healthPort: number;
}

/**
 * The health answer: 503 exactly when the newest backup is older than the stale window. Two states are never judged:
 * an instance whose credential files are not in place (a stage or local boot runs this container but must not back
 * anything up), and the first wake after a start (a catch-up takes minutes, and a start must not be refused for it).
 */
export function health(repo: string, staleDays: number, nowMs: number, lastError: string | null, hold: string | null = null): { status: number; body: string } {
  if (hold) return { status: 200, body: hold };
  const s = staleness(repo, staleDays, nowMs);
  return { status: s.stale ? 503 : 200, body: s.message + (lastError ? `; last run failed: ${lastError}` : "") };
}

/** A key file given to ssh: a private copy with the mode ssh requires (the mount is read-only). */
export function sshEnvForKey(keyPath: string): Record<string, string> {
  const copy = join(tmpdir(), `csvb-push-key-${process.pid}`);
  copyFileSync(keyPath, copy);
  chmodSync(copy, 0o600);
  const known = join(tmpdir(), "csvb-known-hosts");
  return { GIT_SSH_COMMAND: `ssh -i ${copy} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${known}` };
}

export interface LoopState {
  lastError: string | null;
  hold: string | null;
  failures: number;
}

/**
 * The wake loop. NOTHING a wake does can end it: a failed connect, backup, verify or push is caught, logged, left to
 * the stale alarm and retried at the next wake after a bounded, doubling wait. `ctl` is the clock and the stop flag.
 */
export async function serveLoop(o: LoopOptions, state: LoopState, ctl: { sleep: (ms: number) => Promise<void>; stopped: () => boolean }): Promise<void> {
  while (!ctl.stopped()) {
    const missing = o.provisioned();
    if (missing) {
      state.hold = `not provisioned: ${missing}; nothing is backed up by this instance`;
      state.failures = 0;
      o.log(state.hold);
    } else {
      let sql: Sql | null = null;
      try {
        sql = o.connect();
        const r = await serveOnce({ ...o, sql });
        state.lastError = null;
        state.failures = 0;
        if (r.ids.length === 0) o.log("woke; nothing sealed");
      } catch (e) {
        state.lastError = (e as Error).message.split("\n")[0]!;
        state.failures += 1;
        o.log(`run failed, nothing added, will retry: ${(e as Error).message}`);
      } finally {
        await sql?.end({ timeout: 5 }).catch(() => {});
      }
      state.hold = null; // the first wake is over: from here the stale window decides
    }
    if (ctl.stopped()) break;
    await ctl.sleep(nextDelayS(o.intervalS, state.failures) * 1000);
  }
}

export async function serveForever(o: LoopOptions): Promise<void> {
  const state: LoopState = { lastError: null, hold: "starting: the first wake has not finished", failures: 0 };
  const server = Bun.serve({
    port: o.healthPort,
    fetch: (req) => {
      if (new URL(req.url).pathname !== "/health") return new Response("not found", { status: 404 });
      const h = health(o.repo, o.staleDays, o.nowMs(), state.lastError, state.hold);
      return new Response(h.body + "\n", { status: h.status });
    },
  });
  let stop = false;
  let wakeNow: (() => void) | null = null;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stop = true;
      requestAbort(sig);
      wakeNow?.();
    });
  }
  await serveLoop(o, state, {
    stopped: () => stop,
    sleep: (ms) =>
      new Promise<void>((r) => {
        wakeNow = r;
        setTimeout(r, ms);
      }),
  });
  server.stop(true);
}
