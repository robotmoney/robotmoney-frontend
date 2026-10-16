// `schema_manifest` — the one row that says what schema the database is
// SUPPOSED to have, so preflight can tell genuine drift from an ordinary
// version difference.
//
// Issue #1026, W2. Governed by smoke-production-spec.md §8.3, read by §7 check
// 3a (./preflight.ts), written by blank bootstrap (./schema-snapshot.ts) and by
// the migrate run of §8.3 (../../scripts/migrate-run.ts). Exercised against a
// real Postgres by backend/tests/schema-manifest.test.ts.
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
//
// Version 2 (issue #1026 W2) made the declaration a canonical JSON document of
// three parts — the snapshot SQL, the provider exclusion list and the catalog
// fingerprint check 3a compares against — where version 1 stored the SQL alone
// and 3a could only look for `CREATE TABLE` names in it. No database was ever
// published at version 1 outside tests: production's first manifest is §9.1
// step 2's, which has not run.
export const MANIFEST_FORMAT_VERSION = 2;

/** The one-row table's name, so a refusal and a grant check can agree on it. */
export const MANIFEST_TABLE = "schema_manifest";

/**
 * The serialized schema declaration, exactly as the `declaration` column stores
 * it and exactly the bytes `hashManifest` covers.
 *
 * Kept as an opaque string rather than a parsed structure because the hash is
 * over the bytes, and a parse/re-serialize round trip that is not exactly
 * stable turns a matching schema into a hash mismatch. At format version 2 the
 * string is `serializeDeclaration()`'s canonical JSON; `parseDeclaration()`
 * reads it back for check 3a.
 */
export interface SchemaDeclaration {
  /** The serialized declaration text. */
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

// ─────────────────────────────────────────────────────────────────────────────
// The catalog fingerprint — what check 3a actually compares
// ─────────────────────────────────────────────────────────────────────────────
//
// Spec §7 check 3a: "live definitions of every object class in §8.1 match the
// manifest for M stored in the database (§8.3), excluding the provider list."
// §8.1's classes are "tables, constraints, indexes, functions, triggers,
// policies, ownership, default privileges". Authored SQL cannot be compared to a
// live catalog — the catalog does not re-serialize to the text a human wrote —
// so the manifest carries the catalog's own answer for version M: every object
// of those classes, keyed by what it is, with the definition Postgres itself
// prints for it (`pg_get_indexdef`, `pg_get_constraintdef`,
// `pg_get_functiondef`, `pg_get_triggerdef`, `pg_get_expr`). Check 3a asks the
// live catalog the same questions and compares the two in BOTH directions: an
// object the manifest declares that is gone or different, and an object the
// live catalog has that the manifest does not declare.
//
// It is generated, never written by hand: `fingerprintCatalog()` against a
// database bootstrapped from the snapshot (./schema-snapshot.ts,
// `regenerateSnapshotMetadata`). Hand-writing it would make it a second
// description of the schema free to disagree with the first.
//
// WHAT IT LEAVES OUT, ON PURPOSE:
//   * Table and function GRANTS. They are §8.1's third part, reconciled on every
//     migrate run, and check 2 owns them (required from the registry, forbidden
//     from the denylist). Default privileges are a declaration class and are in.
//   * Column ORDER. A column added by `ALTER TABLE ... ADD COLUMN` lands last,
//     and pg_dump preserves whatever order history produced, so order is an
//     accident of history rather than a property the application relies on.
//   * `NOT NULL` constraint rows (Postgres 18 stores them in `pg_constraint`).
//     The column's own `notnull` attribute states the same fact once; the
//     generated constraint name is incidental.
//   * Objects belonging to a listed extension (`pg_depend` deptype `'e'`), in
//     both directions, and — only in the live-extra direction — objects owned by
//     a listed provider role. See `ProviderExclusions`.

/**
 * The provider-managed exclusion list of spec §8.1: "an explicit exclusion list
 * for provider-managed objects". Stored in the snapshot (schema/snapshot.json)
 * and in the manifest, so check 3a honours the list the INSTALLED version was
 * published with rather than whatever the booting image happens to ship.
 *
 * Two shapes, both narrow on purpose, because an entry too many is a blind spot
 * in the drift check:
 *   - `roles`: cluster roles outside the §3 taxonomy (`doadmin`, `postgres`).
 *     An object the live catalog has, the manifest does not declare, and one of
 *     these roles owns, is the provider's, not drift. A DECLARED object is
 *     compared in full whoever owns it — re-owning an application table to
 *     `doadmin` is an ownership change, and 3a says so.
 *   - `extensions`: every member of these extensions, resolved through
 *     `pg_depend` with `deptype = 'e'` — the identical test migration 0053's
 *     two ownership loops use, for the identical reason ("re-owning an
 *     extension's function fails with 'must be owner of function digest' for a
 *     non-superuser"). A member of an extension NOT on the list is an
 *     application object like any other.
 *
 * Names only, never a pattern: a pattern would silently exempt an application
 * object the day someone names one badly.
 */
export interface ProviderExclusions {
  readonly roles: readonly string[];
  readonly extensions: readonly string[];
}

/**
 * One object's normalized definition: attribute name → value. Attributes that
 * do not apply (a column with no default, an enabled trigger's absent disable
 * state) are omitted rather than stored empty, so the stored form stays small
 * and a diff names only what is actually there.
 */
export type CatalogObject = Readonly<Record<string, string>>;

/**
 * Every declared object, keyed `<class> <qualified name>`: `table public.jobs`,
 * `column public.jobs.note`, `index public.jobs_pkey`, `constraint
 * public.jobs.jobs_pkey`, `function public.rm_append_only_guard()`, `trigger
 * public.swarm_members.swarm_members_append_only`, `policy public.t.p`, `type
 * public.mood`, `schema public`, `default privileges for rm_owner in schema
 * public on tables`. The key is what a finding names.
 */
export type CatalogFingerprint = Readonly<Record<string, CatalogObject>>;

/** A version 2 declaration, parsed. */
export interface ParsedDeclaration {
  /** The snapshot's schema-declaration SQL (schema/snapshot.sql), verbatim. */
  readonly sql: string;
  readonly exclusions: ProviderExclusions;
  readonly fingerprint: CatalogFingerprint;
}

/**
 * JSON with every object's keys sorted, recursively. The declaration's bytes are
 * hashed, so its serialization must not depend on the order a query happened to
 * return rows or a caller happened to build an object in.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The declaration `hashManifest` covers and the `declaration` column stores. */
export function serializeDeclaration(parsed: ParsedDeclaration): SchemaDeclaration {
  return {
    text: canonicalJson({
      sql: parsed.sql,
      exclusions: { roles: [...parsed.exclusions.roles], extensions: [...parsed.exclusions.extensions] },
      fingerprint: parsed.fingerprint,
    }),
  };
}

/**
 * Read a declaration back. Throws, naming what is wrong, on anything that is not
 * a version 2 declaration — check 3a turns that into a refusal, because a
 * manifest whose declaration cannot be read is a manifest nothing can be
 * verified against.
 */
export function parseDeclaration(declaration: SchemaDeclaration): ParsedDeclaration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(declaration.text);
  } catch {
    throw new Error("the declaration is not a serialized version-2 declaration (it is not JSON)");
  }
  const record = parsed as Partial<Record<"sql" | "exclusions" | "fingerprint", unknown>>;
  if (typeof record?.sql !== "string") throw new Error("the declaration carries no schema SQL");
  assertExclusions(record.exclusions, "the declaration");
  assertFingerprint(record.fingerprint, "the declaration");
  return { sql: record.sql, exclusions: record.exclusions, fingerprint: record.fingerprint };
}

/** Throws unless `value` is a `ProviderExclusions`. Exported for the snapshot
 *  loader, which validates the same shape out of schema/snapshot.json. */
export function assertExclusions(value: unknown, where: string): asserts value is ProviderExclusions {
  const record = value as Partial<Record<"roles" | "extensions", unknown>> | null | undefined;
  const isNames = (list: unknown): list is string[] =>
    Array.isArray(list) && list.every((item) => typeof item === "string" && /^[a-z_][a-z0-9_]*$/.test(item));
  if (!record || !isNames(record.roles) || !isNames(record.extensions)) {
    throw new Error(
      `${where} must carry the provider exclusion list as { roles: [...], extensions: [...] } of plain names — spec §8.1`,
    );
  }
  // The dangerous direction. A taxonomy role on the list would exempt every
  // object it owns from the drift check — rm_owner owns the whole schema.
  const taxonomy = record.roles.filter((role) => /^rm_/.test(role));
  if (taxonomy.length > 0) {
    throw new Error(
      `${where} lists ${taxonomy.join(", ")} as provider-managed: a §3 taxonomy role is never provider-managed, ` +
        "and excluding one would blind check 3a to the application's own objects",
    );
  }
}

/** Throws unless `value` is a `CatalogFingerprint`. */
export function assertFingerprint(value: unknown, where: string): asserts value is CatalogFingerprint {
  const fail = (): never => {
    throw new Error(`${where} carries no catalog fingerprint (an object of object → attribute → string)`);
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  for (const object of Object.values(value as Record<string, unknown>)) {
    if (object === null || typeof object !== "object" || Array.isArray(object)) fail();
    for (const attribute of Object.values(object as Record<string, unknown>)) {
      if (typeof attribute !== "string") fail();
    }
  }
}

/** One live object: its definition, and the role that owns it (the parent
 *  relation's owner for a column, index, constraint, trigger or policy; the
 *  grantor role for a default-privilege entry). The owner is used only to
 *  apply `ProviderExclusions.roles` to undeclared objects. */
interface LiveObject {
  readonly definition: CatalogObject;
  readonly owner: string;
}

/** Schemas the catalog reserves; everything else is an application namespace.
 *  The same boundary check 2's `object_ownership` rule draws. */
const APP_NAMESPACE = `n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'`;

/** True when the object is a member of a LISTED extension. `$1` is the list. */
function notExtensionMember(catalog: string, oid: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
     WHERE d.classid = '${catalog}'::regclass AND d.objid = ${oid}
       AND d.refclassid = 'pg_extension'::regclass AND d.deptype = 'e'
       AND e.extname = ANY($1::text[]))`;
}

const RELATION_KIND: Readonly<Record<string, string>> = {
  r: "table",
  p: "table",
  v: "view",
  m: "materialized view",
  S: "sequence",
  f: "foreign table",
  c: "composite type",
};

const TRIGGER_STATE: Readonly<Record<string, string>> = {
  O: "origin",
  D: "disabled",
  R: "replica",
  A: "always",
};

const POLICY_COMMAND: Readonly<Record<string, string>> = {
  r: "select",
  a: "insert",
  w: "update",
  d: "delete",
  "*": "all",
};

const DEFAULT_ACL_OBJECTS: Readonly<Record<string, string>> = {
  r: "tables",
  S: "sequences",
  f: "functions",
  T: "types",
  n: "schemas",
  L: "large objects",
};

/** Keep only the attributes that carry a value. */
function present(attributes: Record<string, string | null | undefined>): CatalogObject {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined && value !== "") out[key] = value;
  }
  return out;
}

/**
 * Read every §8.1 object from the live catalog, members of the listed
 * extensions excluded, each with its owner.
 *
 * READ-ONLY: catalog SELECTs and a transaction-local `search_path`. The path is
 * emptied because every printer used here (`regclass`, `format_type`,
 * `pg_get_expr`, `pg_get_indexdef`, ...) schema-qualifies a name only when the
 * path does not already reach it, so the same database would print two
 * different fingerprints to two sessions with different paths. With an empty
 * path every name is qualified, whoever is asking.
 */
async function collectCatalog(db: ManifestDb, extensions: readonly string[]): Promise<Map<string, LiveObject>> {
  return await withEmptySearchPath(db, async (q) => {
    const live = new Map<string, LiveObject>();
    const put = (key: string, owner: string, definition: CatalogObject): void => {
      live.set(key, { definition, owner });
    };
    // `$1` is the extension list, bound only where a query filters on it: an
    // unreferenced parameter has no type Postgres can infer (42P18).
    const run = async <T>(text: string): Promise<T[]> =>
      (await q.unsafe(text, text.includes("$1") ? [extensions as string[]] : [])) as unknown as T[];

    for (const row of await run<{ name: string; owner: string }>(`
      SELECT quote_ident(n.nspname) AS name, pg_get_userbyid(n.nspowner) AS owner
        FROM pg_namespace n
       WHERE ${APP_NAMESPACE} AND ${notExtensionMember("pg_namespace", "n.oid")}`)) {
      put(`schema ${row.name}`, row.owner, { owner: row.owner });
    }

    const relations = await run<{
      name: string;
      kind: string;
      owner: string;
      persistence: string;
      rls: boolean;
      force_rls: boolean;
      partitioned: boolean;
      view: string | null;
      seq_type: string | null;
      seq_start: string | null;
      seq_increment: string | null;
      seq_min: string | null;
      seq_max: string | null;
      seq_cache: string | null;
      seq_cycle: boolean | null;
    }>(`
      SELECT c.oid::regclass::text AS name, c.relkind AS kind, pg_get_userbyid(c.relowner) AS owner,
             c.relpersistence AS persistence, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
             c.relkind = 'p' AS partitioned,
             CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid) END AS view,
             s.seqtypid::regtype::text AS seq_type, s.seqstart::text AS seq_start,
             s.seqincrement::text AS seq_increment, s.seqmin::text AS seq_min, s.seqmax::text AS seq_max,
             s.seqcache::text AS seq_cache, s.seqcycle AS seq_cycle
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_sequence s ON s.seqrelid = c.oid
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c') AND ${APP_NAMESPACE}
         AND ${notExtensionMember("pg_class", "c.oid")}`);
    const relationOwner = new Map<string, string>();
    for (const row of relations) {
      relationOwner.set(row.name, row.owner);
      put(
        `${RELATION_KIND[row.kind] ?? `relation(${row.kind})`} ${row.name}`,
        row.owner,
        present({
          owner: row.owner,
          partitioned: row.partitioned ? "yes" : null,
          unlogged: row.persistence === "u" ? "yes" : null,
          "row level security": row.rls ? "enabled" : null,
          "forced row level security": row.force_rls ? "enabled" : null,
          definition: row.view,
          type: row.seq_type,
          start: row.seq_start,
          increment: row.seq_increment,
          min: row.seq_min,
          max: row.seq_max,
          cache: row.seq_cache,
          cycle: row.seq_cycle === null ? null : row.seq_cycle ? "yes" : "no",
        }),
      );
    }

    // Everything below hangs off a relation and inherits its exclusion: the
    // relation filter is repeated in each query rather than joined in JS, so a
    // member of a listed extension never produces a single row.
    const ownerOf = (relation: string): string => relationOwner.get(relation) ?? "";

    for (const row of await run<{
      relation: string;
      name: string;
      type: string;
      notnull: boolean;
      default_expr: string | null;
      identity: string;
      generated: string;
      collation: string | null;
    }>(`
      SELECT c.oid::regclass::text AS relation, quote_ident(a.attname) AS name,
             format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
             pg_get_expr(ad.adbin, ad.adrelid) AS default_expr, a.attidentity AS identity,
             a.attgenerated AS generated,
             CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation
                  THEN a.attcollation::regcollation::text END AS collation
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_type t ON t.oid = a.atttypid
        LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       WHERE a.attnum > 0 AND NOT a.attisdropped
         AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'c') AND ${APP_NAMESPACE}
         AND ${notExtensionMember("pg_class", "c.oid")}`)) {
      const generated = row.generated === "s" ? "stored" : row.generated === "v" ? "virtual" : null;
      put(
        `column ${row.relation}.${row.name}`,
        ownerOf(row.relation),
        present({
          type: row.type,
          notnull: row.notnull ? "yes" : "no",
          default: generated ? null : row.default_expr,
          generated: generated ? `${generated}: ${row.default_expr ?? ""}` : null,
          identity: row.identity === "a" ? "always" : row.identity === "d" ? "by default" : null,
          collation: row.collation,
        }),
      );
    }

    for (const row of await run<{ name: string; relation: string; definition: string; valid: boolean }>(`
      SELECT i.indexrelid::regclass::text AS name, c.oid::regclass::text AS relation,
             pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${APP_NAMESPACE} AND ${notExtensionMember("pg_class", "c.oid")}`)) {
      put(
        `index ${row.name}`,
        ownerOf(row.relation),
        present({ definition: row.definition, invalid: row.valid ? null : "yes" }),
      );
    }

    for (const row of await run<{ parent: string; relation: string | null; name: string; definition: string; owner: string }>(`
      SELECT COALESCE(c.oid::regclass::text, t.oid::regtype::text) AS parent,
             c.oid::regclass::text AS relation, quote_ident(con.conname) AS name,
             pg_get_constraintdef(con.oid) AS definition,
             pg_get_userbyid(COALESCE(c.relowner, t.typowner)) AS owner
        FROM pg_constraint con
        JOIN pg_namespace n ON n.oid = con.connamespace
        LEFT JOIN pg_class c ON c.oid = con.conrelid AND con.conrelid <> 0
        LEFT JOIN pg_type t ON t.oid = con.contypid AND con.contypid <> 0
       WHERE con.contype <> 'n' AND (c.oid IS NOT NULL OR t.oid IS NOT NULL) AND ${APP_NAMESPACE}
         AND (c.oid IS NULL OR ${notExtensionMember("pg_class", "c.oid")})
         AND (t.oid IS NULL OR ${notExtensionMember("pg_type", "t.oid")})`)) {
      put(`constraint ${row.parent}.${row.name}`, row.owner, { definition: row.definition });
    }

    for (const row of await run<{ name: string; owner: string; kind: string; definition: string | null }>(`
      SELECT p.oid::regprocedure::text AS name, pg_get_userbyid(p.proowner) AS owner, p.prokind AS kind,
             CASE WHEN p.prokind <> 'a' THEN pg_get_functiondef(p.oid) END AS definition
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE ${APP_NAMESPACE} AND ${notExtensionMember("pg_proc", "p.oid")}`)) {
      put(
        `${row.kind === "p" ? "procedure" : row.kind === "a" ? "aggregate" : "function"} ${row.name}`,
        row.owner,
        present({ owner: row.owner, definition: row.definition }),
      );
    }

    for (const row of await run<{ relation: string; name: string; definition: string; state: string }>(`
      SELECT c.oid::regclass::text AS relation, quote_ident(t.tgname) AS name,
             pg_get_triggerdef(t.oid) AS definition, t.tgenabled AS state
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE NOT t.tgisinternal AND ${APP_NAMESPACE} AND ${notExtensionMember("pg_class", "c.oid")}`)) {
      put(`trigger ${row.relation}.${row.name}`, ownerOf(row.relation), {
        definition: row.definition,
        fires: TRIGGER_STATE[row.state] ?? row.state,
      });
    }

    for (const row of await run<{
      relation: string;
      name: string;
      command: string;
      permissive: boolean;
      roles: string;
      using_expr: string | null;
      check_expr: string | null;
    }>(`
      SELECT c.oid::regclass::text AS relation, quote_ident(p.polname) AS name, p.polcmd AS command,
             p.polpermissive AS permissive,
             array_to_string(ARRAY(
               SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r) END FROM unnest(p.polroles) AS r ORDER BY 1
             ), ',') AS roles,
             pg_get_expr(p.polqual, p.polrelid) AS using_expr, pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${APP_NAMESPACE} AND ${notExtensionMember("pg_class", "c.oid")}`)) {
      put(
        `policy ${row.relation}.${row.name}`,
        ownerOf(row.relation),
        present({
          command: POLICY_COMMAND[row.command] ?? row.command,
          permissive: row.permissive ? "yes" : "no",
          roles: row.roles,
          using: row.using_expr,
          "with check": row.check_expr,
        }),
      );
    }

    for (const row of await run<{
      name: string;
      kind: string;
      owner: string;
      labels: string | null;
      base: string | null;
      notnull: boolean;
      default_expr: string | null;
      subtype: string | null;
    }>(`
      SELECT t.oid::regtype::text AS name, t.typtype AS kind, pg_get_userbyid(t.typowner) AS owner,
             CASE WHEN t.typtype = 'e' THEN (
               SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder)
                 FROM pg_enum e WHERE e.enumtypid = t.oid) END AS labels,
             CASE WHEN t.typtype = 'd' THEN format_type(t.typbasetype, t.typtypmod) END AS base,
             t.typnotnull AS notnull, t.typdefault AS default_expr,
             (SELECT rngsubtype::regtype::text FROM pg_range WHERE rngtypid = t.oid) AS subtype
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE t.typtype IN ('e', 'd', 'r') AND ${APP_NAMESPACE} AND ${notExtensionMember("pg_type", "t.oid")}`)) {
      put(
        `type ${row.name}`,
        row.owner,
        present({
          kind: row.kind === "e" ? "enum" : row.kind === "d" ? "domain" : "range",
          owner: row.owner,
          labels: row.labels,
          base: row.base,
          notnull: row.kind === "d" ? (row.notnull ? "yes" : "no") : null,
          default: row.default_expr,
          subtype: row.subtype,
        }),
      );
    }

    for (const row of await run<{ role: string; schema: string | null; objects: string; acl: string }>(`
      SELECT pg_get_userbyid(d.defaclrole) AS role, quote_ident(n.nspname) AS schema, d.defaclobjtype AS objects,
             array_to_string(ARRAY(SELECT item::text FROM unnest(d.defaclacl) AS item ORDER BY 1), ',') AS acl
        FROM pg_default_acl d
        LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
       WHERE d.defaclnamespace = 0 OR (${APP_NAMESPACE})`)) {
      const scope = row.schema === null ? "in every schema" : `in schema ${row.schema}`;
      put(
        `default privileges for ${row.role} ${scope} on ${DEFAULT_ACL_OBJECTS[row.objects] ?? row.objects}`,
        row.role,
        { privileges: row.acl },
      );
    }

    return live;
  });
}

/**
 * Run `body` with `search_path` emptied, and leave the handle's path as it was.
 *
 * A pool gets a transaction and `SET LOCAL`, which ends with it. A handle that
 * already is a transaction (or a reserved connection) cannot open one, so the
 * previous value is read, replaced for the session, and written back — `SET` is
 * not a write to any table, so this is still read-only against a
 * `default_transaction_read_only` connection.
 */
async function withEmptySearchPath<T>(db: ManifestDb, body: (q: ManifestDb) => Promise<T>): Promise<T> {
  const pool = db as postgresTypes.Sql<{}>;
  if (typeof pool.begin === "function") {
    return (await pool.begin(async (tx) => {
      await tx.unsafe("SET LOCAL search_path = ''");
      return body(tx as unknown as ManifestDb);
    })) as T;
  }
  const [previous] = (await db`SELECT current_setting('search_path') AS path`) as unknown as { path: string }[];
  await db`SELECT set_config('search_path', '', false)`;
  try {
    return await body(db);
  } finally {
    await db`SELECT set_config('search_path', ${previous?.path ?? ""}, false)`;
  }
}

/**
 * The fingerprint of the live catalog as a manifest records it: every §8.1
 * object except members of the listed extensions and objects owned by a listed
 * provider role. What `regenerateSnapshotMetadata` stores in the snapshot, and
 * what a test publishes when it needs the manifest of a database it built.
 */
export async function fingerprintCatalog(db: ManifestDb, exclusions: ProviderExclusions): Promise<CatalogFingerprint> {
  const providerRoles = new Set(exclusions.roles);
  const live = await collectCatalog(db, exclusions.extensions);
  const out: Record<string, CatalogObject> = {};
  for (const key of [...live.keys()].sort()) {
    const object = live.get(key)!;
    if (providerRoles.has(object.owner)) continue;
    out[key] = object.definition;
  }
  return out;
}

/** A long value (a function body, an index definition) is shown as a short
 *  digest: the finding's job is to name the object and the attribute, and a
 *  two-page function body in a boot log hides the one line that matters. */
function shown(value: string | undefined): string {
  if (value === undefined) return "(none)";
  if (value.length <= 120) return JSON.stringify(value);
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12)} (${value.length} chars)`;
}

/**
 * Check 3a's comparison: the live catalog against a declaration's fingerprint,
 * in both directions, honouring the declaration's own exclusion list.
 *
 * Output: one operator-readable sentence per object that differs, sorted by
 * object, each naming it. Empty when the live catalog is exactly what the
 * declaration says.
 *
 *   - declared, absent live: dropped (a column, an index, a constraint, a
 *     trigger, a function, a default-privilege entry, ...);
 *   - declared, different live: changed (a column's type, a function's body, a
 *     table's owner, a trigger disabled, a policy's expression, ...);
 *   - live, undeclared: an extra object — refused unless a listed provider role
 *     owns it. Members of listed extensions never reach this comparison.
 */
export async function compareCatalog(
  db: ManifestDb,
  declared: Pick<ParsedDeclaration, "exclusions" | "fingerprint">,
): Promise<string[]> {
  const live = await collectCatalog(db, declared.exclusions.extensions);
  const providerRoles = new Set(declared.exclusions.roles);
  const problems: string[] = [];

  const keys = new Set([...Object.keys(declared.fingerprint), ...live.keys()]);
  for (const key of [...keys].sort()) {
    const expected = declared.fingerprint[key];
    const actual = live.get(key);
    if (expected === undefined) {
      if (actual && providerRoles.has(actual.owner)) continue;
      problems.push(
        `${key} is in the live catalog but not declared by the installed manifest, and the provider exclusion ` +
          `list does not cover it (owner ${actual?.owner || "unknown"})`,
      );
      continue;
    }
    if (actual === undefined) {
      problems.push(`${key} is declared by the installed manifest but absent from the live catalog`);
      continue;
    }
    const attributes = new Set([...Object.keys(expected), ...Object.keys(actual.definition)]);
    const changed = [...attributes]
      .sort()
      .filter((attribute) => expected[attribute] !== actual.definition[attribute])
      .map((attribute) => `${attribute}: ${shown(expected[attribute])} → ${shown(actual.definition[attribute])}`);
    if (changed.length > 0) {
      problems.push(`${key} differs from the installed manifest — ${changed.join("; ")}`);
    }
  }
  return problems;
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
