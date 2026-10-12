// scripts/release/ledger.ts — the ledger judgement R1.2 and R2.3 share: the
// database's `schema_migrations` reconciled by filename set against
// backend/migrations (issue 1272).
//
// The release runner holds no past-upgrade fact. It never asks whether the
// ledger equals one shipped baseline (that was backend/src/db/supported-releases.ts,
// one constant per upgrade, retyped every release); it asks whether the ledger
// is a prefix of the repository's own migrations: every recorded filename is a
// repository file, and no repository file that sorts below the newest recorded
// one is missing. The pending set is the repository minus the ledger. A count
// is never judged.
//
// Pure apart from `repoMigrations`' one readdirSync. No import outside node
// built-ins: R1.2 runs before `bun install`.
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository's migrations folder, relative to this file: the checkout a step runs in. */
export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "backend", "migrations");

/** The `.sql` files of a migrations folder, in ledger order (byte order, as the database sorts them). */
export function repoMigrations(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
}

/** PURE. The repository files the ledger does not record, in order: what the migrate applies. */
export function pendingMigrations(ledger: readonly string[], repo: readonly string[]): string[] {
  const have = new Set(ledger);
  return repo.filter((f) => !have.has(f));
}

/**
 * PURE. Every reason the ledger is not a prefix of the repository's
 * migrations: a recorded name the repository lacks (unknown), or a repository
 * file below the newest recorded name that the ledger skipped (a gap).
 * Empty means the ledger is a state this repository can upgrade.
 */
export function ledgerProblems(ledger: readonly string[], repo: readonly string[]): string[] {
  const out: string[] = [];
  const known = new Set(repo);
  const unknown = ledger.filter((n) => !known.has(n));
  if (unknown.length > 0) out.push(`the ledger records ${unknown.length} name(s) backend/migrations does not hold: ${unknown.join(", ")}`);
  const recorded = new Set(ledger);
  const newest = [...ledger].sort().at(-1);
  if (newest !== undefined) {
    const gaps = repo.filter((f) => f < newest && !recorded.has(f));
    if (gaps.length > 0) out.push(`the ledger skips ${gaps.length} repository file(s) below its newest row ${newest}: ${gaps.join(", ")}`);
  }
  return out;
}
