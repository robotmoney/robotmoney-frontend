// `schema_manifest` — the one row that says what schema the database is
// SUPPOSED to have, so preflight can tell genuine drift from an ordinary
// version difference.
//
// STUB. Every function throws `NOT IMPLEMENTED`; nothing imports this module
// yet. Step 1 of issue #1026's W2 workstream. Governed by
// smoke-production-spec.md §8.3, read by §7 check 3a, written by the migrate
// run of §8.3 (see ../../scripts/migrate-run.ts).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A MANIFEST AND NOT JUST THE LEDGER
// ─────────────────────────────────────────────────────────────────────────────
//
// `schema_migrations` records which FILES ran. It says nothing about what the
// database looks like now. Those come apart constantly and always have:
//
//   * `scripts/ops/provision-db-role-taxonomy.sh` applied 0053 and 0062 through
//     psql and never recorded them, which is how production's ledger drifted
//     (stated in backend/scripts/migrate.ts's own header).
//   * A partial `pg_restore` loads rows and skips the post-data section, so the
//     triggers are absent while the ledger claims the migration that installs
//     them ran — the exact shape of issue #602 and of append-only-guard.ts's
//     whole reason for existing.
//   * Anything with `rm_owner` can `ALTER TABLE` at any moment; the ledger does
//     not notice.
//
// Preflight check 3a (spec §7) has to answer "do the live definitions match
// what version M is supposed to be?", and it must answer it "whatever code is
// booting" — an old image must fail on real drift and pass on a newer-but-
// compatible database. Comparing live definitions against the SHIPPED
// snapshot cannot do that: the shipped snapshot is the booting code's idea of
// the schema, so every ordinary version difference reads as drift. The
// comparison target therefore has to live in the DATABASE and describe the
// version the database is actually at. That is this table.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT IS A TRUSTED INPUT, AND WHAT PROTECTS IT
// ─────────────────────────────────────────────────────────────────────────────
//
// Spec §8.3, quoted: "Only `rm_owner` may write it or the ledger's
// `compat`/`metadata_version` columns; they are trusted inputs to boot
// decisions. A manifest whose hash does not match the ledger's filename list,
// or whose format version is unknown, refuses."
//
// Both halves matter. The write restriction means a compromised or merely buggy
// `rm_app` cannot talk a boot into accepting a schema it should refuse. The
// hash/filename cross-check means an `rm_owner` that wrote the manifest and the
// ledger inconsistently — a half-finished migrate run, a hand-edited row — is
// caught rather than believed. A trusted input with no integrity check is just
// an unchecked input with a nicer name.
//
// Note what this does NOT give: the manifest is a declaration, not a
// measurement. It states what M should look like. Check 3a is what measures the
// live catalog against it.
//
// ─────────────────────────────────────────────────────────────────────────────
// IN PROGRESS: LEDGER AHEAD OF MANIFEST
// ─────────────────────────────────────────────────────────────────────────────
//
// The migrate run applies migrations one transaction each and publishes the
// manifest in the LAST transaction (the grant reconciliation). Between the
// first commit and that publication the two disagree on purpose, and spec §8.3
// names the state: "Between the first commit and publication the database is
// *in progress*, ledger ahead of manifest: application boot refuses it (check
// 3a), and the migrate tool recognizes it, validates committed work against
// each migration's expected post-state, and resumes from the first unapplied
// step without replaying or accepting drift."
//
// So the same condition has two readers with opposite responses. An application
// boot must refuse: the schema is mid-change and nothing has verified where it
// got to. The migrate tool must NOT refuse: refusing would make a crash between
// two migrations unrecoverable except by hand, which is precisely the situation
// the operator reaches for the tool in. `detectManifestState()` below reports
// the condition; `resumePlan()` is the migrate tool's half.
import { createHash } from "node:crypto";
import type postgresTypes from "postgres";
import {
  APPEND_ONLY_MIGRATIONS,
  APPEND_ONLY_TABLES,
  APPEND_ONLY_TABLE_MIGRATION,
  LEDGER_IMMUTABLE_FAMILIES,
  ledgerTriggerNames,
  triggerNames,
} from "./append-only-guard.ts";

export type ManifestDb = postgresTypes.Sql<{}> | postgresTypes.TransactionSql<{}>;

/**
 * The format version of the serialized declaration. Bumped when the
 * declaration's SHAPE changes, never when the schema changes.
 *
 * Its whole job is the refusal in spec §8.3 — "a manifest ... whose format
 * version is unknown refuses". Old code meeting a manifest written by a newer
 * release cannot parse it and must say so rather than guess, which is the same
 * argument as `metadata_version` on the ledger (§8.4, ./schema-compat.ts).
 */
export const MANIFEST_FORMAT_VERSION = 1;

/** The one-row table's name, so a refusal and a grant check can agree on it. */
export const MANIFEST_TABLE = "schema_manifest";

/**
 * The serialized schema declaration: every object class spec §8.1 lists
 * (tables, constraints, indexes, functions, triggers, policies, ownership,
 * default privileges), normalised so two databases at the same version produce
 * byte-identical output.
 *
 * Kept as an opaque string rather than a parsed structure because the hash is
 * over the bytes, and a parse/re-serialize round trip that is not exactly
 * stable turns a matching schema into a hash mismatch.
 */
export interface SchemaDeclaration {
  /** The normalised declaration text. */
  readonly text: string;
}

/** The one row of `schema_manifest`. */
export interface SchemaManifest {
  readonly formatVersion: number;
  readonly declaration: SchemaDeclaration;
  /**
   * The exact migration filenames this declaration embodies.
   *
   * A FILENAME LIST, NEVER A NUMBER — and this repo is the proof. There are two
   * migrations numbered 0059:
   *   backend/migrations/0059_analytics_output_and_report_snapshots.sql
   *   backend/migrations/0059_swarm_framework_subject_snapshot_cleanup.sql
   * "the database is at 0059" therefore names two different schemas, and a
   * database that applied one of them is neither ahead of nor behind a database
   * that applied the other. Spec §8.1 states the rule ("carrying the exact
   * filename list of the migrations it embodies (a number alone is not an
   * identity)"); the two 0059s are why it is not theoretical.
   */
  readonly filenames: readonly string[];
  /** Content hash over the declaration and the filename list together — see
   *  `hashManifest`. */
  readonly contentHash: string;
}

/** What `detectManifestState` found. */
export type ManifestState =
  /** No `schema_manifest` table, or no row: a database that predates the
   *  manifest, or a blank one that bootstrap has not finished. Not the same as
   *  `in_progress` and must not be reported as it. */
  | { readonly kind: "absent" }
  /** Manifest present, its filename list equals the ledger's, its hash
   *  verifies, its format version is known. The only state an application boot
   *  may proceed from. */
  | { readonly kind: "published"; readonly manifest: SchemaManifest }
  /** Ledger ahead of manifest: migrations are recorded that the manifest does
   *  not embody. Spec §8.3's *in progress*. Application boot refuses (check
   *  3a); the migrate tool resumes. */
  | {
      readonly kind: "in_progress";
      readonly manifest: SchemaManifest;
      /** Ledger rows not covered by `manifest.filenames`, in apply order. */
      readonly ahead: readonly string[];
    }
  /** The manifest and the ledger disagree in a way no ordinary sequence
   *  produces — the manifest embodies a file the ledger does not record, or the
   *  stored hash does not match the stored content. Never resumable: refuse and
   *  make a human look. */
  | { readonly kind: "inconsistent"; readonly reasons: readonly string[] }
  /** `formatVersion` is not one this code understands. Refuse, per §8.3. */
  | { readonly kind: "unknown_format"; readonly formatVersion: number };

/**
 * Read the one manifest row.
 *
 * Input: any handle (pool or transaction — the migrate run reads it inside the
 * fenced reconciliation transaction, per spec §2). Output: the manifest, or
 * `null` when the table or the row is absent.
 *
 * Refusals: more than one row (the table is one-row by constraint; two rows
 * means someone bypassed it and no choice between them is defensible).
 * Does NOT refuse on an unknown format version — reading is how you find that
 * out; `detectManifestState` classifies it.
 *
 * Serves spec §10 W2 "Old release reads compat metadata written by a newer one
 * and refuses unknown `metadata_version`" and the integrity half of "old code
 * boots after an additive change ... while genuine drift still fails".
 */
export async function readManifest(db: ManifestDb): Promise<SchemaManifest | null> {
  if (!(await manifestTableExists(db))) return null;

  const rows = (await db`
    SELECT format_version, declaration, filenames, content_hash
    FROM schema_manifest`) as unknown as ManifestRow[];

  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new Error(
      `${MANIFEST_TABLE} holds ${rows.length} rows; it is a one-row table and no choice between two manifests is defensible`,
    );
  }
  return rowToManifest(rows[0] as ManifestRow);
}

/** The one row's columns, exactly as the table spells them. */
interface ManifestRow {
  readonly format_version: number;
  readonly declaration: string;
  readonly filenames: string[];
  readonly content_hash: string;
}

function rowToManifest(row: ManifestRow): SchemaManifest {
  return {
    formatVersion: Number(row.format_version),
    declaration: { text: row.declaration },
    filenames: row.filenames,
    contentHash: row.content_hash,
  };
}

/** `to_regclass` rather than a catalog join: a database that predates the
 *  manifest has no table at all, and that is `absent`, not an error. */
async function manifestTableExists(db: ManifestDb): Promise<boolean> {
  const [row] = (await db`SELECT to_regclass(${`public.${MANIFEST_TABLE}`}) IS NOT NULL AS present`) as unknown as {
    present: boolean;
  }[];
  return row?.present === true;
}

/** The ledger's recorded filenames, in apply order. */
async function ledgerFilenames(db: ManifestDb): Promise<string[]> {
  const rows = (await db`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[];
  return rows.map((r) => r.name);
}

/** Effective role, for the §8.3 write restriction. */
async function effectiveRole(db: ManifestDb): Promise<string> {
  const [row] = (await db`SELECT current_user AS role`) as unknown as { role: string }[];
  return row?.role ?? "";
}

function sameNameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((name, index) => name === right[index]);
}

/**
 * Write the manifest for the final state of a migrate run.
 *
 * Input: the handle — which MUST be the grant-reconciliation transaction, not
 * the pool — and the manifest to publish. Output: nothing; it either commits
 * with the reconciliation or it does not exist.
 *
 * Spec §8.3: the run is "fence (§2) → apply pending migrations, one transaction
 * each → roles-and-grants reconciliation (always, even with nothing pending) →
 * publish the manifest for the final state in the reconciliation's
 * transaction." Publishing in that transaction is what makes "manifest
 * published" mean "grants reconciled" — a manifest that could commit separately
 * would let a boot pass check 3a on a database whose grants are still the
 * previous version's, and check 2 would then fail for reasons check 3a said
 * were fine.
 *
 * Refusals:
 *   - The effective role is not `rm_owner`. Spec §8.3: "Only `rm_owner` may
 *     write it or the ledger's `compat`/`metadata_version` columns; they are
 *     trusted inputs to boot decisions." Enforced by the table's grants AND
 *     checked here, because a grant mistake should fail loudly at the write
 *     rather than quietly widen who can forge a boot decision.
 *   - `filenames` does not equal the ledger's recorded set inside this same
 *     transaction.
 *   - `contentHash` does not equal `hashManifest(...)` of what is being
 *     written.
 *   - `formatVersion !== MANIFEST_FORMAT_VERSION`.
 *
 * Serves spec §10 W2 "Migrate fails between commits and during grant
 * reconciliation; rerun reaches a verified final state."
 */
export async function writeManifest(db: ManifestDb, manifest: SchemaManifest): Promise<void> {
  // Validate everything BEFORE writing anything: a refused write must leave no
  // row, and the cheapest way to guarantee that is never to have written one.
  const role = await effectiveRole(db);
  if (role !== "rm_owner") {
    throw new Error(
      `${MANIFEST_TABLE} may only be written by rm_owner (§8.3); the effective role is ${role}. ` +
        "It is a trusted input to boot decisions.",
    );
  }

  if (manifest.formatVersion !== MANIFEST_FORMAT_VERSION) {
    throw new Error(
      `${MANIFEST_TABLE} format version ${manifest.formatVersion} is not this code's ${MANIFEST_FORMAT_VERSION}`,
    );
  }

  const ledger = await ledgerFilenames(db);
  if (!sameNameSet(manifest.filenames, ledger)) {
    throw new Error(
      `${MANIFEST_TABLE} filename list does not equal the ledger recorded in this transaction ` +
        `(manifest ${manifest.filenames.length} files, ledger ${ledger.length} files)`,
    );
  }

  const expected = hashManifest(manifest.declaration, manifest.filenames);
  if (manifest.contentHash !== expected) {
    throw new Error(
      `${MANIFEST_TABLE} content hash ${manifest.contentHash} does not match the declaration and filename list ` +
        `(expected ${expected})`,
    );
  }

  // One row by construction. DELETE + INSERT rather than an upsert, because the
  // table is one-row by constraint in some shapes and merely by convention in
  // others, and both must publish the same single manifest.
  await db`DELETE FROM schema_manifest`;
  await db`
    INSERT INTO schema_manifest (format_version, declaration, filenames, content_hash)
    VALUES (${manifest.formatVersion}, ${manifest.declaration.text}, ${manifest.filenames as string[]},
            ${manifest.contentHash})`;
}

/**
 * The content hash stored in `contentHash` and re-checked on every read.
 *
 * Input: the declaration and the filename list. Output: a hex digest over BOTH,
 * with the filename list in its recorded order. Both, because the manifest's
 * claim is "this declaration is what these files produce" — hashing only the
 * declaration would let the filename list be edited without detection, and that
 * list is the identity check 3b reasons about (§8.4).
 *
 * Pure and synchronous so a test can pin exact digests, the same way this repo
 * pins `promptHash` / `inputsDigest` in src/swarm/judge.ts.
 *
 * Serves spec §10 W2 "Old code boots after an additive change to an existing
 * table while genuine drift on the same database still fails."
 */
export function hashManifest(declaration: SchemaDeclaration, filenames: readonly string[]): string {
  // JSON, so the two inputs cannot be confused for one another: a declaration
  // ending in a filename and a filename list starting with the same text must
  // not collide, and a length-free concatenation would let them.
  const payload = JSON.stringify({
    formatVersion: MANIFEST_FORMAT_VERSION,
    declaration: declaration.text,
    // In RECORDED order, never sorted — the order is part of the identity.
    filenames: [...filenames],
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Classify the database's manifest/ledger relationship — the single function
 * both readers call, so "in progress" means the same thing to a booting api and
 * to the migrate tool.
 *
 * Input: a handle. Output: a `ManifestState`. It reads the manifest and the
 * ledger and compares them; it does NOT inspect the live catalog (that is check
 * 3a's measurement, ./preflight.ts) and it does not read migration files off
 * disk (that is the resume plan's job below).
 *
 * Refusals: none of its own — every bad condition is a returned state, because
 * its two callers want opposite behaviour from the same finding and the choice
 * belongs to them, not here.
 *
 * Serves spec §10 W2 "Migrate fails between commits and during grant
 * reconciliation; rerun reaches a verified final state."
 */
export async function detectManifestState(db: ManifestDb): Promise<ManifestState> {
  const manifest = await readManifest(db);
  if (manifest === null) return { kind: "absent" };

  // Unknown format first: a declaration this code cannot parse is a declaration
  // whose other fields it cannot reason about either.
  if (manifest.formatVersion !== MANIFEST_FORMAT_VERSION) {
    return { kind: "unknown_format", formatVersion: manifest.formatVersion };
  }

  const ledger = await ledgerFilenames(db);
  const recorded = new Set(ledger);
  const reasons: string[] = [];

  const expected = hashManifest(manifest.declaration, manifest.filenames);
  if (manifest.contentHash !== expected) {
    reasons.push(
      `${MANIFEST_TABLE}: stored content hash ${manifest.contentHash} does not match the stored declaration and ` +
        `filename list (expected ${expected})`,
    );
  }

  for (const name of manifest.filenames) {
    if (!recorded.has(name)) {
      reasons.push(`${MANIFEST_TABLE}: embodies ${name}, which the ledger does not record`);
    }
  }

  if (reasons.length > 0) return { kind: "inconsistent", reasons };

  const embodied = new Set(manifest.filenames);
  const ahead = ledger.filter((name) => !embodied.has(name));
  if (ahead.length > 0) return { kind: "in_progress", manifest, ahead };

  return { kind: "published", manifest };
}

/** What the migrate tool must do to finish an interrupted run. */
export interface ResumePlan {
  /** Migrations already committed but not embodied by the manifest. Each is
   *  re-validated against its expected post-state; none is re-applied. Spec
   *  §8.3: "validates committed work against each migration's expected
   *  post-state, and resumes from the first unapplied step without replaying or
   *  accepting drift." */
  readonly committedToVerify: readonly string[];
  /** Migrations on disk that the ledger does not record, in apply order. These
   *  are applied, one transaction each. */
  readonly pending: readonly string[];
  /** Always true. Grant reconciliation runs "always, even with nothing
   *  pending" (§8.3), and it is the transaction the manifest publishes in, so a
   *  resume that skipped it would leave the database in progress forever. Kept
   *  as a field rather than left implicit so the plan a test reads states it. */
  readonly reconcileGrants: true;
}

/**
 * Build the resume contract from an in-progress (or merely pending) database.
 *
 * Inputs: a handle and the migration filenames available on disk, in apply
 * order. Output: the `ResumePlan` above.
 *
 * Refusals:
 *   - A ledger row names a file that is not on disk. The database has run a
 *     migration this code does not contain; resuming would publish a manifest
 *     describing a schema this code cannot describe. This is a compatibility
 *     question, not a resume one — §8.4 and ./schema-compat.ts own it.
 *   - `detectManifestState` returned `inconsistent` or `unknown_format`.
 *   - A committed-but-unmanifested migration fails its expected post-state
 *     check. Spec §8.3 forbids "accepting drift", and a resume is exactly when
 *     accepting it would be most tempting.
 *
 * Serves spec §10 W2 "Migrate fails between commits and during grant
 * reconciliation; rerun reaches a verified final state."
 */
export async function resumePlan(db: ManifestDb, filesOnDisk: readonly string[]): Promise<ResumePlan> {
  const state = await detectManifestState(db);
  if (state.kind === "inconsistent") {
    throw new Error(
      `refusing to resume: the manifest and the ledger are inconsistent — ${state.reasons.join("; ")}. ` +
        "No ordinary sequence produces this; make a human look.",
    );
  }
  if (state.kind === "unknown_format") {
    throw new Error(
      `refusing to resume: ${MANIFEST_TABLE} format version ${state.formatVersion} is not one this code understands`,
    );
  }

  const ledger = await ledgerFilenames(db);
  const onDisk = new Set(filesOnDisk);
  const absent = ledger.filter((name) => !onDisk.has(name));
  if (absent.length > 0) {
    throw new Error(
      `the ledger records ${absent.join(", ")}, which this checkout does not contain. ` +
        "That is §8.4's compatibility question, not a resume.",
    );
  }

  const embodied = new Set(state.kind === "absent" ? [] : state.manifest.filenames);
  const committedToVerify = ledger.filter((name) => !embodied.has(name));

  const recorded = new Set(ledger);
  // Apply order, not discovery order: the filename IS the order (§8.1), which
  // is also why two files numbered 0059 are two distinct steps rather than one.
  const pending = [...filesOnDisk].filter((name) => !recorded.has(name)).sort();

  await verifyCommittedPostState(db, committedToVerify);

  return { committedToVerify, pending, reconcileGrants: true };
}

/**
 * The "validates committed work against each migration's expected post-state"
 * half of §8.3's resume.
 *
 * What a migration's post-state IS, generically, is not something this module
 * can know for every file. What it can check is the part this repo already
 * declares in a machine-readable form: the append-only and ledger-immutable
 * triggers each guard migration installs (./append-only-guard.ts). Those are
 * exactly the objects a partial `pg_restore` drops while the ledger keeps
 * claiming the migration ran — the failure mode the manifest exists for — so a
 * resume that accepted them would be accepting drift at the one moment it is
 * most tempting to.
 *
 * Tables the migration has not created yet, or that a later migration dropped,
 * are skipped: their absence is a version difference, not drift.
 */
async function verifyCommittedPostState(db: ManifestDb, migrations: readonly string[]): Promise<void> {
  const committed = new Set(migrations);
  const guards = APPEND_ONLY_MIGRATIONS.filter((migration) => committed.has(migration));
  const families = LEDGER_IMMUTABLE_FAMILIES.filter((family) => committed.has(family.migration));
  if (guards.length === 0 && families.length === 0) return;

  const tableRows = (await db`
    SELECT c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'`) as unknown as { name: string }[];
  const tables = new Set(tableRows.map((row) => row.name));

  const triggerRows = (await db`
    SELECT c.relname AS table_name, t.tgname AS trigger_name
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal`) as unknown as {
    table_name: string;
    trigger_name: string;
  }[];
  const installed = new Set(triggerRows.map((row) => `${row.table_name}.${row.trigger_name}`));

  const problems: string[] = [];
  const require = (migration: string, table: string, trigger: string): void => {
    if (!installed.has(`${table}.${trigger}`)) {
      problems.push(`${migration}: ${table} is missing trigger ${trigger}`);
    }
  };

  for (const migration of guards) {
    for (const table of APPEND_ONLY_TABLES) {
      if (APPEND_ONLY_TABLE_MIGRATION[table] !== migration) continue;
      if (!tables.has(table)) continue;
      const names = triggerNames(table);
      require(migration, table, names.statement);
      require(migration, table, names.row);
    }
  }

  for (const family of families) {
    for (const table of family.tables) {
      if (!tables.has(table)) continue;
      const names = ledgerTriggerNames(family, table);
      require(family.migration, table, names.statement);
      require(family.migration, table, names.row);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `refusing to resume: committed migrations do not match their expected post-state — ${problems.join("; ")}. ` +
        "§8.3 forbids accepting drift.",
    );
  }
}
