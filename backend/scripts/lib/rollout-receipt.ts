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
//      smoketes the step back to not-done.
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
// NO SECRETS IS NOT THE SAME AS PUBLISHABLE. A database endpoint is identity,
// not a credential, and this repository is public — so the FULL receipt stays on
// its own host, and the copy committed to the tree is a positive-allow-list
// projection of it (see "Committed evidence" at the foot of this file). Two
// artefacts, two audiences, one writer.
//
// Standalone for the same reason as preflight-utils.ts: node builtins and Bun
// only, nothing from src/, so a receipt can be written by a script that must
// never open the application's pool.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { allowedSignersPath, committedReceiptsDir, resolveSigner, signDetached } from "./rollout-signing.ts";

/** Default backup directory — the same one restore-container.ts resolves. */
/**
 * Where a rollout's artifacts and receipts live, when a script is not given an
 * explicit path.
 *
 * Reads RM_BACKUP_DIR first. The literal fallback is v0.2.2's directory and is
 * kept ONLY so that release's scripts behave exactly as they did when they were
 * executed — a shared lib must not silently repoint a past release's evidence.
 * Every release from v0.3.0 on exports RM_BACKUP_DIR instead; the runbook
 * (docs/runbooks/rollout-procedure.md, "Conventions") makes that the first step.
 */
export const DEFAULT_BACKUP_DIR = process.env.RM_BACKUP_DIR?.trim()
  ? process.env.RM_BACKUP_DIR.trim()
  : join(homedir(), "rm-backup-v022");

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
  /**
   * OPT-IN, per release: also write a REDACTED, SIGNED copy of this receipt
   * into the checkout, at `<repoRoot>/rollout-evidence/<committedEvidenceDir>/`.
   *
   * Absent = the host-local receipt is the only one written, which is what every
   * shipped release does and must keep doing. The signing key is named by
   * ROLLOUT_SIGNING_KEY; with no key the committed copy is SKIPPED rather than
   * written unsigned, because an unsigned committed receipt is not weaker
   * evidence, it is no evidence at all, and writing one would only mislead.
   */
  committedEvidenceDir?: string;
}

/** Where writeCommittedReceipt() looks for the environment agent's private key. */
export const SIGNING_KEY_ENV = "ROLLOUT_SIGNING_KEY";

export function emitReceipt(spec: EmitReceiptSpec): {
  path: string;
  receipt: RolloutReceipt;
  committed?: { json: string; sig: string };
} {
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

  if (!spec.committedEvidenceDir) return { path, receipt };
  const written = writeCommittedReceipt({
    repoRoot: spec.repoRoot,
    releaseDir: spec.committedEvidenceDir,
    receipt,
    keyPath: process.env[SIGNING_KEY_ENV]?.trim() || undefined,
  });
  if ("error" in written) {
    // Never fatal: the host-local receipt is already on disk, and the step's own
    // exit code is what completes it. A step must not fail because a key was
    // missing on the box that ran it.
    console.error(`[rollout-receipt] no committed copy written for ${spec.step}: ${written.error}`);
    return { path, receipt };
  }
  return { path, receipt, committed: written };
}

// ── Committed evidence: the redacted copy that lives in the tree ─────────────
//
// THE PUBLIC-REPO PROBLEM. This repository is public, and a receipt records
// DbIdentity — the server address, port, database name and user of the
// production primary — plus the hostname of the box that ran the step.
// Committing that verbatim publishes production's database endpoint, which is
// the same objection that ruled out posting receipts as issue comments.
//
// THE PROJECTION IS A POSITIVE ALLOW-LIST, not a deny-list, and that is the
// whole design. A deny-list leaks by DEFAULT: add a field to RolloutReceipt and
// it ships to a public repo unless somebody remembers to redact it. Here every
// field must be classified, `Record<keyof RolloutReceipt, Disclosure>` makes an
// unclassified field a TYPE error, projectForCommit() makes it a RUNTIME error,
// and scripts/tests/unit/rollout-receipt-redaction.test.ts makes it a TEST
// failure — so the new field fails three ways before it can leak once.
//
// IT COSTS NOTHING MECHANICALLY. rollout-where.ts's evaluate() grades on
// `r.db.in_recovery` alone; server/port/database/user appear only inside a
// human-readable `because` string. The full-fidelity receipt keeps every field
// and stays on its own host in $RM_BACKUP_DIR — the committed copy is a
// projection of it, never a replacement for it.

/** `public` = committed verbatim. `redacted` = never committed. `projected` =
 *  committed through its own nested allow-list (only `db`). */
export type Disclosure = "public" | "redacted" | "projected";

/**
 * Every field of RolloutReceipt, classified. The `Record<keyof RolloutReceipt,
 * …>` type is load-bearing: adding a field to RolloutReceipt without adding it
 * here fails `bun run typecheck` before any test runs.
 */
export const RECEIPT_DISCLOSURE: Readonly<Record<keyof RolloutReceipt, Disclosure>> = Object.freeze({
  step: "public",
  exit: "public",
  verdict: "public",
  started_at: "public",
  at: "public",
  // The one field of the receipt proper that is withheld. A hostname names a
  // real box on a real network and is not needed to grade anything: the probe
  // re-derives host ROLE from the checkout it is run in, never from a receipt.
  host: "redacted",
  host_role: "public",
  repo_sha: "public",
  repo_branch: "public",
  rc_tag: "public",
  repo_dirty: "public",
  db: "projected",
  checks: "public",
  artifacts: "public",
  attested: "public",
  note: "public",
});

/** Only `in_recovery` survives. Everything else identifies a live database. */
export const DB_IDENTITY_DISCLOSURE: Readonly<Record<keyof DbIdentity, Disclosure>> = Object.freeze({
  server: "redacted",
  port: "redacted",
  database: "redacted",
  user: "redacted",
  in_recovery: "public",
});

/** The only part of DbIdentity a committed receipt carries. */
export interface CommittedDbIdentity {
  in_recovery: boolean;
}

/** A receipt as committed: the allow-list projection of RolloutReceipt. */
export interface CommittedReceipt extends Omit<RolloutReceipt, "host" | "db"> {
  db?: CommittedDbIdentity;
}

function projectDbIdentity(db: DbIdentity): CommittedDbIdentity {
  for (const key of Object.keys(db)) {
    if (!(key in DB_IDENTITY_DISCLOSURE)) {
      throw new Error(
        `database identity field "${key}" is not classified in DB_IDENTITY_DISCLOSURE — classify it before a receipt carrying it can be committed`,
      );
    }
  }
  return { in_recovery: db.in_recovery };
}

/**
 * The committed projection of a receipt.
 *
 * Throws on an unclassified field rather than emitting it. Output key order is
 * RECEIPT_DISCLOSURE's, not the input object's, so the same receipt serialises
 * to the same bytes no matter how it was built — which matters because those
 * bytes are what gets signed.
 */
export function projectForCommit(receipt: RolloutReceipt): CommittedReceipt {
  for (const key of Object.keys(receipt)) {
    if (!(key in RECEIPT_DISCLOSURE)) {
      throw new Error(
        `rollout receipt field "${key}" is not classified in RECEIPT_DISCLOSURE — classify it public or redacted before it can be committed to a public repository`,
      );
    }
  }
  const source = receipt as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(RECEIPT_DISCLOSURE) as (keyof RolloutReceipt)[]) {
    const disclosure = RECEIPT_DISCLOSURE[key];
    if (disclosure === "redacted") continue;
    const value = source[key];
    if (value === undefined) continue;
    if (disclosure === "projected") {
      if (key !== "db") throw new Error(`"${key}" is marked projected but has no nested allow-list`);
      out[key] = projectDbIdentity(value as DbIdentity);
      continue;
    }
    out[key] = value;
  }
  return out as unknown as CommittedReceipt;
}

/** The exact bytes that are committed AND signed. One function, so the writer
 *  and the verifier can never disagree about a trailing newline. */
export function serialiseCommittedReceipt(receipt: CommittedReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

/** Writes `<step>.json` plus its detached `<step>.json.sig` into the tree. */
export function writeCommittedReceipt(spec: {
  repoRoot: string;
  releaseDir: string;
  receipt: RolloutReceipt;
  keyPath?: string;
}): { json: string; sig: string } | { error: string } {
  if (!spec.keyPath) return { error: `${SIGNING_KEY_ENV} is not set — see rollout-procedure.md §1 "Receipts"` };
  let payload: string;
  try {
    payload = serialiseCommittedReceipt(projectForCommit(spec.receipt));
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const signature = signDetached(payload, spec.keyPath);
  if (!signature) return { error: `ssh-keygen -Y sign failed with key ${spec.keyPath}` };
  const dir = committedReceiptsDir(spec.repoRoot, spec.releaseDir);
  mkdirSync(dir, { recursive: true });
  const json = join(dir, `${spec.receipt.step}.json`);
  const sig = `${json}.sig`;
  writeFileSync(json, payload);
  writeFileSync(sig, signature);
  return { json, sig };
}

export interface CommittedEvidence {
  receipt: CommittedReceipt;
  /** The allowed-signers principal whose key signed these exact bytes. */
  signer: string;
  path: string;
}

export interface CommittedEvidenceSet {
  /** Step id -> evidence, for receipts whose signature verified. */
  verified: Map<string, CommittedEvidence>;
  /**
   * Step id -> why it was thrown away. A committed receipt that does not verify
   * is NOT the same as no committed receipt: the caller reports it as "no
   * evidence", so a tampered or unsigned file reads as a deliberate blank rather
   * than as an absence nobody noticed.
   */
  rejected: Map<string, string>;
}

/**
 * Every committed receipt for a release, verified fail-closed.
 *
 * Unsigned, tampered, wrongly-namespaced, unknown-signer, malformed-.sig and a
 * missing allowed-signers file all land in `rejected`. Nothing here throws: see
 * rollout-signing.ts's header on why the probe must survive every one of them.
 */
export function readCommittedEvidence(repoRoot: string, releaseDir: string): CommittedEvidenceSet {
  const verified = new Map<string, CommittedEvidence>();
  const rejected = new Map<string, string>();
  const dir = committedReceiptsDir(repoRoot, releaseDir);
  if (!existsSync(dir)) return { verified, rejected };
  const allowed = allowedSignersPath(repoRoot);
  const haveAllowList = existsSync(allowed);

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { verified, rejected };
  }

  for (const file of entries) {
    if (!file.endsWith(".json")) continue;
    // The id comes from the FILENAME, so a receipt whose JSON will not even
    // parse still reports against the step it claims to be.
    const id = file.slice(0, -".json".length);
    if (!haveAllowList) {
      rejected.set(id, `no allowed-signers file at ${allowed}`);
      continue;
    }
    let payload: string;
    try {
      payload = readFileSync(join(dir, file), "utf8");
    } catch {
      rejected.set(id, "unreadable");
      continue;
    }
    let signature = "";
    try {
      const sigPath = join(dir, `${file}.sig`);
      signature = existsSync(sigPath) ? readFileSync(sigPath, "utf8") : "";
    } catch {
      signature = "";
    }
    if (!signature.trim()) {
      rejected.set(id, "unsigned");
      continue;
    }
    const signer = resolveSigner({ payload, signature, allowedSigners: allowed });
    if (!signer) {
      rejected.set(id, "signature does not verify against the allowed-signers file");
      continue;
    }
    let parsed: CommittedReceipt;
    try {
      parsed = JSON.parse(payload) as CommittedReceipt;
    } catch {
      rejected.set(id, "signed, but not parseable JSON");
      continue;
    }
    // A receipt is filed under its own `step`, exactly as readReceipts() does.
    // A file whose name and content disagree is filed under neither.
    if (!parsed?.step || parsed.step !== id) {
      rejected.set(id, "filename does not match the receipt's own step id");
      continue;
    }
    const prev = verified.get(parsed.step);
    if (!prev || parsed.at > prev.receipt.at) {
      verified.set(parsed.step, { receipt: parsed, signer, path: join(dir, file) });
    }
  }
  return { verified, rejected };
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
    if (hasUrl) return { role: "cutover", why: "repo-root .env carries DATABASE_URL (rollout-procedure.md §7.5)" };
    return { role: "stage", why: "repo-root .env exists but has no DATABASE_URL (rollout-procedure.md §7.5)" };
  }
  return { role: "stage", why: "no repo-root .env — the cutover and everything after it cannot run here (rollout-procedure.md §7.5)" };
}
