// Rollout receipts — the evidence layer under `where.ts`.
//
// WHY THIS EXISTS. A release runbook is a linear document, but a rollout is a
// resumable process: an agent or operator drops into a half-finished session
// and has to answer "where am I, and does what I already did still count?"
// Every previous answer to that in this repo was prose — a note in the runbook,
// a line in a rehearsal report — and prose decays. docs/runbooks/
// v0-2-2-rollout.md §2 (archived) carries two dead status paragraphs for this
// reason, kept only as a record of what stale looked like.
//
// So position is never written down. It is DERIVED, every time, from three
// things this module supplies:
//   1. a receipt per completed step, written by the step's own script;
//   2. the git SHA that receipt was produced at, so code drift can invalidate it;
//   3. the artifacts it produced, hashed, so a deleted or rewritten file
//      demotes the step back to not-done.
//
// A receipt is evidence, NOT authority. where.ts re-verifies all three before
// it believes one. If the filesystem and a receipt disagree, the filesystem
// wins — see where.ts's `evaluate()`.
//
// NO SECRETS. Receipts sit next to the backup artifacts, in a directory that
// also holds an encrypted credential dump (§5.2). They record database
// IDENTITY (host, port, role, in-recovery) and never a password or URL with
// one, so the receipts directory itself needs no encryption. `collectDbIdentity`
// is the only thing that touches a connection, and it selects nothing else.
//
// Standalone for the same reason as preflight-utils.ts: node builtins and Bun
// only, nothing from src/, so a receipt can be written by a script that must
// never open the application's pool.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default backup directory — the same one restore-container.ts resolves. */
export const DEFAULT_BACKUP_DIR = join(homedir(), "rm-backup-v022");

/** Receipts live beside the backup artifacts, not in the checkout: §5.1 makes
 *  you `cd` out of the tree and §5.2 forbids rollout artifacts inside it. */
export function receiptsDir(backupDir?: string): string {
  return process.env.ROLLOUT_RECEIPTS_DIR ?? join(backupDir ?? DEFAULT_BACKUP_DIR, "receipts");
}

export interface DbIdentity {
  /** inet_server_addr(), or "(unix socket)" — an EMPTY address is the single
   *  most likely wrong answer under §2.0, so it is recorded explicitly rather
   *  than as an empty string that reads like "not captured". */
  server: string;
  port: number | null;
  database: string;
  user: string;
  /** true = a read replica. A receipt claiming a live-replica step against
   *  in_recovery=false was pointed at the primary and is not what it says. */
  in_recovery: boolean;
}

export interface ReceiptArtifact {
  path: string;
  sha256: string;
  bytes: number;
}

export interface CheckSummary {
  pass: number;
  warn: number;
  fail: number;
  /** Names of non-PASS checks, so a receipt is readable without the log. */
  warned: string[];
  failed: string[];
}

export interface RolloutReceipt {
  /** Step id from the release's steps.ts manifest, e.g. "P4.preflight-live". */
  step: string;
  /** Process exit code. 0 is the only value that makes a step complete. */
  exit: number;
  /** Short verdict string, e.g. "SAFE TO UPGRADE". */
  verdict: string;
  started_at: string;
  at: string;
  host: string;
  /** "stage" | "cutover" — as derived at the time the step ran. */
  host_role: string;
  repo_sha: string;
  repo_branch: string;
  /** Tag pointing at repo_sha, if any — e.g. "v0.2.2-rc.7". */
  rc_tag: string | null;
  /** A dirty tree means the receipt does not describe any committed state. */
  repo_dirty: boolean;
  db?: DbIdentity;
  checks?: CheckSummary;
  artifacts: ReceiptArtifact[];
  /** true = an operator/agent attested this step by hand (`where.ts --record`)
   *  rather than a script exiting 0. Displayed differently on purpose: it is
   *  somebody's word, not a program's exit code. */
  attested: boolean;
  note?: string;
}

export interface GitFacts {
  sha: string;
  branch: string;
  dirty: boolean;
  /** Tag at HEAD matching the release's tag glob, if any. */
  tag: string | null;
}

function git(repoRoot: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: repoRoot, stderr: "pipe" });
  return new TextDecoder().decode(r.stdout).trim();
}

/** HEAD facts. `tagGlob` selects the release's own tags so an unrelated tag
 *  sitting on the same commit is not mistaken for the rc. */
export function gitFacts(repoRoot: string, tagGlob: string): GitFacts {
  return {
    sha: git(repoRoot, ["rev-parse", "HEAD"]),
    branch: git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: git(repoRoot, ["status", "--porcelain"]).length > 0,
    tag: git(repoRoot, ["tag", "--points-at", "HEAD", "-l", tagGlob]).split("\n").filter(Boolean)[0] ?? null,
  };
}

/** Files changed between a receipt's SHA and HEAD. Empty when the SHA is
 *  unknown to this checkout (a receipt copied in from another host), which the
 *  caller must treat as "cannot verify", never as "nothing changed". */
export function changedSince(repoRoot: string, sha: string): { known: boolean; files: string[] } {
  const known = Bun.spawnSync(["git", "cat-file", "-e", `${sha}^{commit}`], { cwd: repoRoot }).exitCode === 0;
  if (!known) return { known: false, files: [] };
  const out = git(repoRoot, ["diff", "--name-only", `${sha}..HEAD`]);
  return { known: true, files: out ? out.split("\n").filter(Boolean) : [] };
}

export function sha256File(path: string): ReceiptArtifact | null {
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  return { path, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.byteLength };
}

/**
 * The receipt form of §2.0's identity assertion. §2.0 makes the operator run
 * that query and READ it; nothing has ever made the answer outlive the
 * terminal. Recording it means a step that graded the wrong database can be
 * caught later, by where.ts, instead of never.
 */
export async function collectDbIdentity(
  db: { unsafe(query: string): Promise<unknown> },
): Promise<DbIdentity | undefined> {
  try {
    const rows = (await db.unsafe(
      `SELECT coalesce(host(inet_server_addr()), '(unix socket)') AS server,
              inet_server_port()                                 AS port,
              current_database()                                 AS database,
              current_user                                       AS "user",
              pg_is_in_recovery()                                AS in_recovery`,
    )) as unknown as DbIdentity[];
    return rows[0];
  } catch {
    // Identity is evidence, not a gate: a receipt without it is weaker but
    // still worth writing, and this must never fail a step that passed.
    return undefined;
  }
}

export interface EmitReceiptSpec {
  step: string;
  exit: number;
  verdict: string;
  startedAt: string;
  repoRoot: string;
  tagGlob: string;
  hostRole: string;
  backupDir?: string;
  db?: DbIdentity;
  checks?: CheckSummary;
  /**
   * Git facts captured when the step STARTED. Pass this for any step that runs
   * long enough for HEAD to move under it — a rehearsal takes minutes, and a
   * receipt stamped with a SHA that was committed halfway through describes a
   * run that never happened. Omitted = captured now, which is only safe for a
   * step that completes in one moment.
   */
  git?: GitFacts;
  /** Paths to hash. Missing ones are skipped — a step that produced nothing
   *  is a step where.ts will not be able to confirm, which is correct. */
  artifactPaths?: string[];
  attested?: boolean;
  note?: string;
}

export function emitReceipt(spec: EmitReceiptSpec): { path: string; receipt: RolloutReceipt } {
  const g = spec.git ?? gitFacts(spec.repoRoot, spec.tagGlob);
  const receipt: RolloutReceipt = {
    step: spec.step,
    exit: spec.exit,
    verdict: spec.verdict,
    started_at: spec.startedAt,
    at: new Date().toISOString(),
    host: Bun.spawnSync(["hostname"]).stdout.toString().trim() || "(unknown)",
    host_role: spec.hostRole,
    repo_sha: g.sha,
    repo_branch: g.branch,
    rc_tag: g.tag,
    repo_dirty: g.dirty,
    db: spec.db,
    checks: spec.checks,
    artifacts: (spec.artifactPaths ?? []).map(sha256File).filter((a): a is ReceiptArtifact => a !== null),
    attested: spec.attested ?? false,
    note: spec.note,
  };
  const dir = receiptsDir(spec.backupDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${spec.step}.json`);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return { path, receipt };
}

/** Reads every receipt in the directory, newest-wins per step id. Unparseable
 *  files are ignored rather than fatal: a corrupt receipt must degrade to
 *  "no evidence", never to a crash that blocks the probe. */
export function readReceipts(backupDir?: string): Map<string, RolloutReceipt> {
  const dir = receiptsDir(backupDir);
  const out = new Map<string, RolloutReceipt>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as RolloutReceipt;
      if (!r?.step) continue;
      const prev = out.get(r.step);
      if (!prev || r.at > prev.at) out.set(r.step, r);
    } catch {
      /* not a receipt */
    }
  }
  return out;
}

/** Summarises a checker's results for the receipt. Shape-compatible with
 *  checks.ts's CheckResult without importing it, so this stays usable from a
 *  script that never builds a Checker. */
export function summarise(results: { name: string; status: string }[]): CheckSummary {
  return {
    pass: results.filter((r) => r.status === "PASS").length,
    warn: results.filter((r) => r.status === "WARN").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    warned: results.filter((r) => r.status === "WARN").map((r) => r.name),
    failed: results.filter((r) => r.status === "FAIL").map((r) => r.name),
  };
}

/**
 * Host role, derived — never configured.
 *
 * The distinction that matters for v0.2.2 is capability, not name: §7.3's boot
 * and every §8/§11/§12 `psql "$DATABASE_URL"` need the writer credential, and
 * that credential lives in the repo-root .env file (§6.5), read by
 * readFileSync — not in the environment. A box without that file cannot run
 * them at all, which is precisely the staging host's design
 * (docs/archive/v0-2-2-rollout.md §2).
 */
export function deriveHostRole(repoRoot: string): { role: "stage" | "cutover"; why: string } {
  const envFile = join(repoRoot, ".env");
  if (existsSync(envFile)) {
    const hasUrl = /^DATABASE_URL=\S/m.test(readFileSync(envFile, "utf8"));
    if (hasUrl) return { role: "cutover", why: "repo-root .env carries DATABASE_URL (§6.5)" };
    return { role: "stage", why: "repo-root .env exists but has no DATABASE_URL (§6.5)" };
  }
  return { role: "stage", why: "no repo-root .env — §7/§8/§11/§12 cannot run here (§2, §6.5)" };
}
