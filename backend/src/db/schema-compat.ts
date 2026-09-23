// Compatibility — how an image built for snapshot N decides whether it may
// boot against a database that has moved on to M > N.
//
// STUB. Every function throws `NOT IMPLEMENTED`; nothing imports this module
// yet. Step 1 of issue #1026's W2 workstream. Governed by
// smoke-production-spec.md §8.2 (the migration header and the ledger columns)
// and §8.4 (the rule), consumed by §7 check 3b in ./preflight.ts.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PROBLEM
// ─────────────────────────────────────────────────────────────────────────────
//
// Rollback. A release goes out, a migration lands with it, something is wrong
// with the application code and the operator wants the previous image back. The
// database cannot go back — migrations are forward-only (§8.2) and this repo's
// history tables are append-only besides. So the question is whether the old
// image can run on the new database, and the honest answers are "sometimes" and
// "the old image cannot possibly work it out by itself".
//
// It cannot work it out because it does not contain the migration. It has never
// seen the file, cannot read its SQL, and knows nothing about what changed. The
// only thing it can do is read what the newer release RECORDED at apply time.
// Spec §8.2: "On apply the runner records `compat` and `metadata_version` in
// `schema_migrations`; that is how an older image learns about migrations it
// does not contain."
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE, QUOTED
// ─────────────────────────────────────────────────────────────────────────────
//
// Spec §8.4: "Code built for snapshot N boots against a database at M > N only
// if every ledger row outside its own filename list carries `compat = additive`
// and a `metadata_version` it understands. A `NULL` compat, an unknown version,
// or `breaking` refuses. This keeps code-only rollback alive after an additive
// migration and closes it after a breaking one, explicitly."
//
// Note "outside its own filename list". The code does not evaluate migrations
// it ships with — it already supports those by construction. It evaluates only
// the surplus. And the list is FILENAMES: `backend/migrations/` currently holds
// two files numbered 0059 (`0059_analytics_output_and_report_snapshots.sql` and
// `0059_swarm_framework_subject_snapshot_cleanup.sql`), so "everything after
// 0059" is not a set this code could compute even if it wanted to.
//
// `NULL` refusing is the part that is easy to get backwards. A `NULL` compat
// means the row was written by a runner that predates these columns, or by
// something that was not the runner at all — `scripts/ops/provision-db-role-
// taxonomy.sh` applied 0053 and 0062 through psql without recording them, which
// is how production's ledger drifted in the first place. "Unknown" is not
// "probably fine".
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT `additive` MEANS — AND WHAT IT DOES NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// Spec §8.4, quoted in full because the header parser is the only thing
// standing between this word and a wrong boot:
//
//   "**`additive`** means old code's supported behavior is preserved across
//   schema, data, and grants: every query the older registry declares still
//   succeeds with the same semantics, no bootstrap row it relies on is removed
//   or reshaped, no privilege it needs is revoked. Adding SQL objects is
//   necessary, not sufficient. The declaration is a reviewed claim, backed by
//   the CI proof below."
//
// Read across the three axes, because every one of them has a counterexample
// that looks additive at the DDL level:
//
//   SCHEMA — `ALTER TABLE ... ADD COLUMN foo NOT NULL` adds an object and
//     breaks every `INSERT` the old code writes. `CREATE UNIQUE INDEX` adds an
//     object and starts rejecting rows the old code was allowed to write.
//     Changing a column's type adds nothing and breaks reads.
//   DATA — removing or reshaping a bootstrap row (§8.1) is a data change with
//     no DDL at all. Renaming a `job_schedules` key, or narrowing an enum-like
//     text column's accepted values, breaks old code without touching the
//     schema.
//   GRANTS — this is the axis W2.2 itself travels. The grant transition
//     revokes `DELETE`/`TRUNCATE` on append-only tables from `rm_app` and
//     `rm_worker`, undoing what 0053 line 129 granted
//     (`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO
//     rm_app`). If any older code path actually issues one of those
//     statements, that migration is `breaking` for it — a revocation is a
//     privilege removal no matter how much better the resulting posture is.
//
// So `additive` is a claim about the OLD REGISTRY's declared queries (§7.1),
// not a property of the diff. It is reviewed by a human and backed by the CI
// proof in §8.4 ("code at N boots against N+additive"). This module parses and
// enforces the claim; it cannot verify it.
import type postgresTypes from "postgres";

export type CompatDb = postgresTypes.Sql<{}> | postgresTypes.TransactionSql<{}>;

/**
 * The two values a migration may declare, and the two the `compat` column may
 * hold. There is no third, and there is deliberately no default: an absent
 * declaration is a parse refusal at apply time, and an absent column value is a
 * boot refusal at read time.
 */
export type MigrationCompat = "additive" | "breaking";

/**
 * The version of the compat METADATA's own semantics — what `additive` is
 * understood to promise, and what else the runner records alongside it.
 *
 * Bumped when that meaning changes, never when a migration changes. Its whole
 * purpose is the refusal in §8.4: code that meets a `metadata_version` it does
 * not recognise cannot know what the newer release meant by `additive`, so it
 * refuses instead of assuming the promise it happens to remember.
 */
export const COMPAT_METADATA_VERSION = 1;

/** The two ledger columns §8.2 adds to `schema_migrations`. Named here so the
 *  privilege check, the migrate run and a refusal message agree. Spec §8.3:
 *  "Only `rm_owner` may write it or the ledger's `compat`/`metadata_version`
 *  columns; they are trusted inputs to boot decisions." */
export const COMPAT_COLUMNS = ["compat", "metadata_version"] as const;

/** A migration's parsed header declaration. */
export interface MigrationHeader {
  /** The filename, as the ledger records it. */
  readonly filename: string;
  /** The declared value. */
  readonly compat: MigrationCompat;
  /** The metadata version the declaring release wrote under. */
  readonly metadataVersion: number;
}

/** One ledger row, as check 3b reads it. `null`s are the refusal cases, kept
 *  as data rather than thrown so the report can name every offending row at
 *  once instead of the first. */
export interface LedgerCompatRow {
  readonly filename: string;
  readonly compat: MigrationCompat | null;
  readonly metadataVersion: number | null;
}

/**
 * Parse a migration file's compat header.
 *
 * Input: the filename and the file's text. Output: a `MigrationHeader`.
 *
 * The header is the first comment block of the `.sql` file, which is where this
 * repo already puts a migration's reasoning (0053 is 60 lines of it before the
 * first statement). Parsing the FILE, not a sidecar, means the declaration
 * cannot drift from the SQL it describes and cannot be forgotten in review.
 *
 * Refusals:
 *   - No declaration found. Spec §8.2: "Every migration ... declares itself
 *     `additive` or `breaking` in a header the runner parses." Defaulting
 *     either way is wrong — defaulting to `additive` forges a promise nobody
 *     made, defaulting to `breaking` makes the safe declaration the one you get
 *     by saying nothing, which teaches everyone to say nothing.
 *   - A value other than `additive` or `breaking`.
 *   - More than one declaration in the file.
 *   - A `metadata_version` that is not a positive integer, or is greater than
 *     `COMPAT_METADATA_VERSION` — a file in this checkout cannot have been
 *     written under a metadata version this checkout does not have.
 *
 * Serves spec §10 W2 "Old release reads compat metadata written by a newer one
 * and refuses unknown `metadata_version`."
 */
export function parseMigrationHeader(filename: string, text: string): MigrationHeader {
  const declared = readHeaderBlock(text);

  const compat = singleDeclaration(filename, declared, "compat");
  if (compat !== "additive" && compat !== "breaking") {
    throw new Error(
      `${filename}: compat must be 'additive' or 'breaking', not '${compat}' — spec §8.2 allows no third value.`,
    );
  }

  const rawVersion = singleDeclaration(filename, declared, "metadata_version");
  if (!/^\d+$/.test(rawVersion) || Number(rawVersion) < 1) {
    throw new Error(
      `${filename}: metadata_version must be a positive integer, not '${rawVersion}'.`,
    );
  }
  const metadataVersion = Number(rawVersion);
  if (metadataVersion > COMPAT_METADATA_VERSION) {
    throw new Error(
      `${filename}: metadata_version ${metadataVersion} is greater than this checkout's ${COMPAT_METADATA_VERSION} — ` +
        "a file in this repository cannot have been written under a metadata version the repository does not have.",
    );
  }

  return { filename, compat, metadataVersion };
}

/** The leading comment block: every `--` line from the top, stopping at the
 *  first line that is not one. Later comments are prose, never a second
 *  declaration (§8.2's header is the FIRST block). */
function readHeaderBlock(text: string): readonly string[] {
  const block: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (block.length === 0 && trimmed === "") continue; // leading blank lines
    if (!trimmed.startsWith("--")) break;
    block.push(trimmed);
  }
  return block;
}

/** Exactly one `-- <key>: <value>` line in the header block, or a refusal.
 *  Absent and duplicated are both refusals: §8.2 forbids a default in either
 *  direction, and two declarations are not a declaration. */
function singleDeclaration(filename: string, block: readonly string[], key: string): string {
  const pattern = new RegExp(`^--\\s*${key}\\s*:\\s*(.*)$`, "i");
  const values: string[] = [];
  for (const line of block) {
    const match = pattern.exec(line);
    if (match) values.push((match[1] ?? "").trim().split(/\s+/)[0] ?? "");
  }
  if (values.length === 0) {
    throw new Error(
      `${filename}: no '${key}' declaration in the header block — spec §8.2 requires every migration to declare ` +
        "itself, and defaulting either way is wrong.",
    );
  }
  if (values.length > 1) {
    throw new Error(`${filename}: more than one '${key}' declaration in the header block (${values.join(", ")}).`);
  }
  return values[0] ?? "";
}

/**
 * Read the `compat` / `metadata_version` columns for the given ledger rows.
 *
 * Input: a handle and the filenames to read (the surplus set — everything the
 * ledger records that the booting code's own filename list does not name).
 * Output: one row each, `null`s preserved.
 *
 * Refusals:
 *   - `schema_migrations` has no `compat` column at all. That is a database
 *     older than §8.2's migration, not a compatible one, and it must not read
 *     as "every row is NULL, which happens to refuse" — the distinction is what
 *     an operator needs to see in the message.
 *   - A requested filename is not in the ledger.
 *
 * Serves spec §10 W2 "Old release reads compat metadata written by a newer one
 * and refuses unknown `metadata_version`."
 */
export function readLedgerCompat(db: CompatDb, filenames: readonly string[]): Promise<readonly LedgerCompatRow[]> {
  void db;
  void filenames;
  throw new Error("NOT IMPLEMENTED: read the ledger's compat columns — spec §8.2, issue #1026 W2.6");
}

/** The verdict of the §8.4 rule. */
export type CompatibilityVerdict =
  /** Every surplus row is `additive` with a known `metadata_version`, or there
   *  is no surplus at all (M === N). */
  | { readonly kind: "compatible"; readonly surplus: readonly string[] }
  /** At least one surplus row refuses. `reasons` carries one operator-readable
   *  sentence per offending row, naming the file and which of the three
   *  conditions (`breaking`, `NULL` compat, unknown version) it hit. */
  | { readonly kind: "refused"; readonly reasons: readonly string[] };

/**
 * Apply the §8.4 rule: may code whose own filename list is `codeFilenames` boot
 * against a database whose ledger is `ledgerFilenames`?
 *
 * Inputs: a handle, the booting code's filename list (its snapshot's list, from
 * ./schema-snapshot.ts), and the ledger's recorded filenames. Output: a
 * verdict, never a throw for a policy refusal — check 3b reports it alongside
 * checks 1-6 and the operator sees every failure in one pass.
 *
 * The surplus is `ledgerFilenames \ codeFilenames`, by FILENAME. Set
 * difference, not a numeric comparison: with two 0059s in this repo, a
 * comparison on numbers would call two different schemas equal.
 *
 * Refusals (thrown, because they are not "the code is too old", they are "the
 * question is unanswerable"):
 *   - `codeFilenames` contains a name the ledger does not record. The code is
 *     AHEAD of the database, which is a pending-migration situation, not a
 *     compatibility one, and §7's check 3a plus the migrate run own it.
 *   - `readLedgerCompat` refused.
 *
 * Serves spec §10 W2 "Old code boots after an additive change to an existing
 * table while genuine drift on the same database still fails" and "Old release
 * reads compat metadata written by a newer one and refuses unknown
 * `metadata_version`."
 */
export function checkCompatibility(
  db: CompatDb,
  codeFilenames: readonly string[],
  ledgerFilenames: readonly string[],
): Promise<CompatibilityVerdict> {
  void db;
  void codeFilenames;
  void ledgerFilenames;
  throw new Error("NOT IMPLEMENTED: apply the §8.4 compatibility rule — spec §8.4, issue #1026 W2.7");
}

/**
 * Record a migration's declaration in the ledger as part of applying it.
 *
 * Inputs: the handle — which MUST be the migration's own transaction, so the
 * row and the DDL commit together — and the parsed header. Output: nothing.
 *
 * Writing it separately would produce a ledger row with a `NULL` compat between
 * the two commits, and §8.4 says a `NULL` refuses. A crash in that window would
 * leave a database that is permanently unbootable by older code for no reason
 * other than the write order.
 *
 * Refusals:
 *   - The effective role is not `rm_owner`. Spec §8.3: "Only `rm_owner` may
 *     write it or the ledger's `compat`/`metadata_version` columns; they are
 *     trusted inputs to boot decisions."
 *   - The row already carries a non-`NULL` compat. `schema_migrations` is
 *     append-only (./append-only-guard.ts lists it), and a declaration that
 *     could be revised after the fact is not evidence of anything.
 *
 * Serves spec §10 W2 "Migrate fails between commits and during grant
 * reconciliation; rerun reaches a verified final state."
 */
export function recordMigrationCompat(db: CompatDb, header: MigrationHeader): Promise<void> {
  void db;
  void header;
  throw new Error("NOT IMPLEMENTED: record compat metadata with the migration — spec §8.2, issue #1026 W2.6");
}
