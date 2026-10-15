// scripts/release/ledger.ts — the ledger judgement P02-identity and P07-baseline share: the
// database's `schema_migrations` reconciled with backend/migrations and the
// bytes at the tag the running stack reports (D67; issues 1272, 1273).
//
// The release runner holds no past-upgrade fact. It never asks whether the
// ledger equals one shipped baseline (that was backend/src/db/supported-releases.ts,
// one constant per upgrade, retyped every release). It runs the three checks
// of backend/src/db/ledger-reconcile.ts: every recorded name is a repository
// file (check 1), the pending set is the repository minus the ledger (check
// 2), and every applied file's bytes equal the bytes at the pin ref (check 3).
// No check reads a 4-digit prefix or the applied order: production applied
// seven files out of number order, and that passes. The earlier "no
// repository file below the newest recorded one may be missing" rule (issue
// 1272) is gone for that reason; a hand-edited ledger is caught by check 1 and
// by `bun run migrate`'s own resume rules, never by a number.
//
// THE PIN REF is the version the running stack reports at
// `<publicOrigin>/api/version`: its tag, or its commit when it carries no tag
// (`runningPinRef`). A stack that reports no version leaves nothing to pin
// the applied bytes to, and the caller refuses; nothing is assumed in its
// place. The ref is resolved with `git rev-parse --verify` in the release
// checkout (P01-checkout fetched the tags), and an unresolvable ref is
// `pin-ref-unresolved`.
//
// Only node built-ins and Bun globals at runtime: P02-identity runs before
// `bun install` (the backend module imports the registry, which imports
// `postgres` as a type only).
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeReconcile,
  hashMigrationsAtCommit,
  hashMigrationsDir,
  ledgerNotInRepo,
  reconcile,
  resolvePinRef,
  type ReconcileReceipt,
} from "../../backend/src/db/ledger-reconcile.ts";

export { describeReconcile, ledgerNotInRepo, type ReconcileReceipt };

/** The repository's migrations folder, relative to this file: the checkout a step runs in. */
export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "backend", "migrations");

/** The `.sql` files of a migrations folder, in ledger order (byte order, as the database sorts them). */
export function repoMigrations(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
}

/**
 * The three checks over a ledger already read, against `migrationsDir` and,
 * with `pinRef`, the bytes at that ref. Synchronous: the directory, the
 * hashes and git. The one SELECT is the caller's (P02-identity and P07-baseline read the
 * ledger on their proven read-only session).
 */
export function reconcileLedger(
  ledger: readonly string[],
  options: { readonly migrationsDir?: string; readonly pinRef?: string; readonly intended?: readonly string[]; readonly now?: () => Date } = {},
): ReconcileReceipt {
  const migrationsDir = resolve(options.migrationsDir ?? MIGRATIONS_DIR);
  const checkout = hashMigrationsDir(migrationsDir);
  const pin =
    options.pinRef === undefined
      ? null
      : (() => {
          const commit = resolvePinRef(migrationsDir, options.pinRef);
          return { ref: options.pinRef, commit, files: commit === null ? new Map<string, string>() : hashMigrationsAtCommit(migrationsDir, commit) };
        })();
  return reconcile({
    readAt: (options.now ?? (() => new Date()))(),
    migrationsDir,
    ledger,
    checkout,
    ...(options.intended ? { intended: options.intended } : {}),
    pin,
  });
}

/** PURE. The refusal a receipt carries: one line naming the verdict and the files, or none on `ok`. */
export function ledgerProblems(receipt: ReconcileReceipt): string[] {
  return receipt.verdict === "ok" ? [] : [`the ledger does not reconcile with backend/migrations (${receipt.verdict}): ${describeReconcile(receipt)}`];
}

/** What the running stack reports about itself, read from `/api/version`. */
export interface RunningVersion {
  readonly commit: string;
  /** The release tag the boot carried (RM_BUILD_TAG), or null for an untagged boot. */
  readonly tag: string | null;
}

/** PURE. Every reason a `/api/version` body does not name a running commit. */
export function parseRunningVersion(text: string | null): RunningVersion | { error: string } {
  if (text === null) return { error: "/api/version did not answer 200" };
  let body: { commit?: unknown; tag?: unknown };
  try { body = JSON.parse(text) as { commit?: unknown; tag?: unknown }; } catch { return { error: "/api/version is not JSON" }; }
  if (typeof body.commit !== "string" || !/^[0-9a-f]{40}$/.test(body.commit)) return { error: `/api/version commit is ${String(body.commit)}, not a 40-hex sha` };
  if (/\+(dirty|unknown)/.test(text)) return { error: "/api/version carries +dirty or +unknown: production does not run a pushed commit" };
  const tag = typeof body.tag === "string" && /^v\d+\.\d+\.\d+(-rc\.\d+)?$/.test(body.tag) ? body.tag : null;
  return { commit: body.commit, tag };
}

/** PURE. The pin ref a running version gives: its tag, else its commit. */
export function runningPinRef(version: RunningVersion): string {
  return version.tag ?? version.commit;
}

/** `GET <origin>/api/version`, parsed; `{ error }` when it does not answer or does not name a commit. */
export async function readRunningVersion(origin: string): Promise<RunningVersion | { error: string }> {
  let text: string | null = null;
  try {
    const res = await fetch(`${origin.replace(/\/+$/, "")}/api/version`, { signal: AbortSignal.timeout(10_000) });
    text = res.ok ? await res.text() : null;
  } catch {
    text = null;
  }
  return parseRunningVersion(text);
}
