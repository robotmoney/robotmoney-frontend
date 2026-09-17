// Who wrote this receipt? — the one question the probe could not answer.
//
// WHY THIS EXISTS. rollout-where.ts re-derives everything a receipt claims: it
// re-hashes the artifacts, re-runs the drift diff, re-derives the host role. All
// of that is about WHAT happened. None of it is about WHO said so, and
// deriveHostRole() (rollout-receipt.ts) infers stage-vs-cutover purely from
// whether a repo-root .env carries DATABASE_URL — so any box can hand-write JSON
// claiming a stage rehearsal passed and readReceipts() will accept it. This
// module answers authorship, and nothing else.
//
// SSH, NOT GPG, AND NOTHING HAND-ROLLED. `ssh-keygen -Y sign|verify|
// find-principals` is a signature scheme every environment agent already has a
// key for, ships with OpenSSH >= 8.0, and — unlike GPG — needs no keyring, no
// agent and no trust database to VERIFY: one committed allowed-signers file is
// the whole trust root. `git verify-tag` reads that same file under
// `gpg.format=ssh`, so "who cut this rc tag" and "who wrote this receipt" are
// answered against one list.
//
// NAMESPACE BINDING IS THE POINT. A signature is made under
// RECEIPT_SIGNATURE_NAMESPACE and is only accepted under it. Without a fixed
// namespace, a signature the agent made over some other blob — a git commit, an
// email, a challenge someone handed it — would verify as a rollout receipt the
// moment its bytes happened to match. ssh-keygen refuses a namespace mismatch
// outright ("namespace does not match"), which is exactly the check we want and
// exactly the check nobody should be writing themselves.
//
// FAIL CLOSED, NEVER FAIL LOUD. Every function here returns `null` rather than
// throwing. The probe is the mandatory FIRST step of a rollout (rollout-
// procedure.md §1) and is documented as side-effect free and always exit-0: a
// missing allowed-signers file, a truncated .sig, an ssh-keygen that is not
// installed must all degrade to "no signer", which the caller grades as NO
// EVIDENCE. A probe that crashes because a signature was malformed would deny
// an operator the state table at the exact moment they most need it, and the
// unsigned-receipt case is not an error — it is the normal state of every
// release that predates this module.
//
// Standalone for the same reason as rollout-receipt.ts: node builtins and Bun
// only, nothing from src/.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The signature namespace every rollout receipt is signed under.
 *
 * Versioned: a future change to what the committed bytes contain gets `.v2` and
 * every `.v1` signature stops verifying, rather than a new reader silently
 * accepting an old signature over a different projection.
 */
export const RECEIPT_SIGNATURE_NAMESPACE = "rollout-receipt.v1";

/**
 * The committed evidence tree, repo-relative.
 *
 * A TOP-LEVEL directory, deliberately. It must match no step's `dependsOn`
 * glob — otherwise recording P4's receipt would count as code drift and
 * invalidate P5, and the act of writing evidence down would destroy it. Every
 * live release's glob groups are enumerated in rollout-manifest.ts; `scripts/**`
 * and `backend/src/**` are among them, `docs/**` is inside no group but is
 * covered by the docs-only CI bypass, and this name is inside neither.
 * backend/tests/rollout-shared-manifest.test.ts asserts the no-match property
 * against every step of every live release rather than trusting this comment.
 */
export const EVIDENCE_DIR = "rollout-evidence";

/** One public key per environment principal. Never a private key. */
export function allowedSignersPath(repoRoot: string): string {
  return join(repoRoot, EVIDENCE_DIR, "allowed-signers");
}

/**
 * Where a release's committed receipts live.
 *
 * Per-release, and OPT-IN: `receiptsDir()` in rollout-receipt.ts is untouched,
 * so v0.2.2 and v0.3.0 keep resolving their evidence exactly where they always
 * did. A shared lib must not silently repoint a shipped release's evidence.
 */
export function committedReceiptsDir(repoRoot: string, releaseDir: string): string {
  return join(repoRoot, EVIDENCE_DIR, releaseDir);
}

interface Ran {
  code: number;
  out: string;
  err: string;
}

function run(cmd: string[], stdin?: string, cwd?: string): Ran {
  const r = Bun.spawnSync(cmd, {
    cwd,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const dec = new TextDecoder();
  return { code: r.exitCode ?? -1, out: dec.decode(r.stdout), err: dec.decode(r.stderr) };
}

/**
 * Detached armoured signature over `payload`, or null if signing failed.
 *
 * `-` makes ssh-keygen read the payload from stdin and write the signature to
 * stdout, so the bytes that are signed are the bytes the caller holds — never a
 * file it wrote and hopes still says the same thing.
 */
export function signDetached(
  payload: string,
  keyPath: string,
  namespace: string = RECEIPT_SIGNATURE_NAMESPACE,
): string | null {
  try {
    if (!existsSync(keyPath)) return null;
    const r = run(["ssh-keygen", "-Y", "sign", "-f", keyPath, "-n", namespace, "-"], payload);
    return r.code === 0 && r.out.includes("BEGIN SSH SIGNATURE") ? r.out : null;
  } catch {
    return null;
  }
}

export interface ResolveSignerSpec {
  /** The exact bytes that were signed. */
  payload: string;
  /** Armoured detached signature, as committed beside the payload. */
  signature: string;
  /** Path to the allowed-signers file. Absent = no trust root = no signer. */
  allowedSigners: string;
  namespace?: string;
}

/**
 * The principal that signed `payload`, or null.
 *
 * TWO steps, both required. `find-principals` answers "which listed key made
 * this signature" and says nothing about the payload — a signature lifted from
 * another receipt passes it. `verify` then binds signature, payload, principal
 * AND namespace together. Skipping the first would mean guessing a principal;
 * skipping the second would accept any signature the listed key ever made.
 */
export function resolveSigner(spec: ResolveSignerSpec): string | null {
  let scratch: string | null = null;
  try {
    if (!spec.signature.trim()) return null;
    if (!existsSync(spec.allowedSigners)) return null;
    const namespace = spec.namespace ?? RECEIPT_SIGNATURE_NAMESPACE;
    scratch = mkdtempSync(join(tmpdir(), "rollout-sig-"));
    const sigFile = join(scratch, "receipt.sig");
    writeFileSync(sigFile, spec.signature);

    const found = run(["ssh-keygen", "-Y", "find-principals", "-s", sigFile, "-f", spec.allowedSigners]);
    if (found.code !== 0) return null;
    for (const principal of found.out.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const verified = run(
        ["ssh-keygen", "-Y", "verify", "-f", spec.allowedSigners, "-I", principal, "-n", namespace, "-s", sigFile],
        spec.payload,
      );
      if (verified.code === 0) return principal;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* a leaked temp dir must not fail a probe */
      }
    }
  }
}

/**
 * The principal that signed an annotated git tag, or null.
 *
 * `-c` rather than repo config, so the probe reads the COMMITTED allowed-signers
 * file and not whatever the host happens to have configured — the whole point is
 * that the answer does not depend on the machine asking. An unsigned tag, a tag
 * signed by an unlisted key, and a tag that does not exist are all null: git
 * exits non-zero for each, and prints "No principal matched." for the middle one
 * without naming anybody.
 */
export function verifyTagSigner(repoRoot: string, tag: string, allowedSigners: string): string | null {
  try {
    if (!tag || !existsSync(allowedSigners)) return null;
    const r = run(
      ["git", "-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${allowedSigners}`, "verify-tag", tag],
      undefined,
      repoRoot,
    );
    if (r.code !== 0) return null;
    return `${r.err}${r.out}`.match(/Good "git" signature for (\S+) with/)?.[1] ?? null;
  } catch {
    return null;
  }
}
