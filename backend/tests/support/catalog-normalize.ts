// A normalized dump of a database's catalog, for comparing two databases by
// what they DECLARE rather than by how they were built (issue #1026, spec
// smoke-production-spec.md §8.4).
//
// TEST SUPPORT ONLY. The runtime drift check (preflight check 3a) has its own
// fingerprint in src/db/; this file does not import it and must not be imported
// by it. Two independent readings of the catalog are the point: a class one of
// them forgets is caught by the other, not by a shared blind spot.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT "NORMALIZED" MEANS HERE
// ─────────────────────────────────────────────────────────────────────────────
//
// Every entry is a `(key, definition)` pair. The key names the object in words
// a reader can act on — `column public.jobs.status`, `trigger public.jobs.x` —
// and the definition is what Postgres itself reprints for it
// (`pg_get_constraintdef`, `pg_get_indexdef`, `pg_get_functiondef`,
// `pg_get_triggerdef`, `pg_get_expr`, `format_type`). Nothing carries an OID:
// every reference is resolved to a name before it leaves the catalog, so two
// databases that were built in a different order, or by a different login,
// compare equal exactly when they declare the same objects.
//
// The classes are the ones spec §8.1 lists for the schema declaration — tables,
// constraints, indexes, functions, triggers, policies, ownership, default
// privileges — plus the ones those imply (columns and their defaults, sequences,
// views, types, comments, ACLs on relations, columns, functions and the schema
// itself), and the database-level classes a migration could add that none of
// those reach: operators, casts, publications and event triggers. Row DATA is not in it, with one exception: a sequence's parameters
// are declaration, its current value is not.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT LEAVES OUT, AND WHY EACH IS SAFE TO LEAVE OUT
// ─────────────────────────────────────────────────────────────────────────────
//
//   * System schemas (`pg_catalog`, `information_schema`, `pg_toast`, temp).
//   * Objects an extension owns (`pg_depend.deptype = 'e'`), and the extensions
//     themselves. Spec §8.1 gives the snapshot "an explicit exclusion list for
//     provider-managed objects" (PROVIDER_MANAGED_EXCLUSIONS in
//     src/db/schema-snapshot.ts); the extension's own functions are the
//     provider's, not ours, and its version is the cluster's.
//   * Roles and role attributes. They are CLUSTER objects, shared by every
//     database a comparison could be made between, so two databases on one
//     cluster cannot differ in them.
//   * Physical detail: OIDs, relfilenodes, tablespaces left at the default,
//     statistics, sequence `last_value`.
//
// Column ORDER is kept (as the column's rank among live columns, not its raw
// attnum, which counts dropped columns): an `INSERT` without a column list and a
// `SELECT *` both see it, so it is declaration.
import type postgres from "postgres";

export type CatalogDb = postgres.Sql<{}> | postgres.TransactionSql<{}>;

/** One declared object: its reader-facing name and its normalized definition. */
export interface CatalogEntry {
  readonly key: string;
  readonly definition: string;
}

/** The difference between two catalogs, each list sorted by key. */
export interface CatalogDiff {
  /** Declared on the left only. */
  readonly onlyLeft: readonly CatalogEntry[];
  /** Declared on the right only. */
  readonly onlyRight: readonly CatalogEntry[];
  /** Declared on both, with different definitions. */
  readonly differing: readonly { readonly key: string; readonly left: string; readonly right: string }[];
}

/** Schemas no application object lives in. */
const SYSTEM_SCHEMA_FILTER = `n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'`;

/** An object an extension owns — the provider's, never the snapshot's. */
function notExtensionMember(classTable: string, oidExpr: string): string {
  return `NOT EXISTS (SELECT 1 FROM pg_depend d
    WHERE d.classid = '${classTable}'::regclass AND d.objid = ${oidExpr} AND d.deptype = 'e')`;
}

/**
 * An ACL as sorted `grantee:privilege[*]` items, grantor included.
 *
 * `aclexplode` rather than the raw `aclitem[]` text, because the text form
 * orders items by insertion history, and two databases that granted the same
 * set in a different order would read as different.
 */
function aclText(aclExpr: string): string {
  return `coalesce((
    SELECT string_agg(
      coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END
        || ' by ' || coalesce(gr.rolname, '?'),
      ', ' ORDER BY coalesce(g.rolname, 'PUBLIC'), a.privilege_type, coalesce(gr.rolname, '?'))
    FROM aclexplode(${aclExpr}) a
    LEFT JOIN pg_roles g ON g.oid = a.grantee
    LEFT JOIN pg_roles gr ON gr.oid = a.grantor
  ), '<default>')`;
}

/**
 * Each class is one query returning `(key, definition)` rows. Kept as a table
 * rather than inlined into one UNION so a failure to read one class names it.
 */
const CLASSES: readonly { readonly name: string; readonly sql: string }[] = [
  {
    // Owner and ACL as two entries, so a difference in one names itself.
    name: "schemas",
    sql: `
      SELECT 'schema ' || n.nspname AS key, 'owner=' || pg_get_userbyid(n.nspowner) AS definition
      FROM pg_namespace n
      WHERE ${SYSTEM_SCHEMA_FILTER} AND ${notExtensionMember("pg_namespace", "n.oid")}
      UNION ALL
      SELECT 'acl schema ' || n.nspname, ${aclText("n.nspacl")}
      FROM pg_namespace n
      WHERE ${SYSTEM_SCHEMA_FILTER} AND ${notExtensionMember("pg_namespace", "n.oid")}`,
  },
  {
    // Every relation kind, with the properties that live on the relation itself.
    name: "relations",
    sql: `
      SELECT CASE c.relkind
               WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' WHEN 'v' THEN 'view'
               WHEN 'm' THEN 'materialized view' WHEN 'S' THEN 'sequence' WHEN 'f' THEN 'foreign table'
               WHEN 'i' THEN 'index' WHEN 'I' THEN 'partitioned index' WHEN 'c' THEN 'composite type'
               ELSE 'relkind ' || c.relkind::text END
             || ' ' || n.nspname || '.' || c.relname AS key,
             concat_ws(' ',
               'owner=' || pg_get_userbyid(c.relowner),
               'persistence=' || c.relpersistence::text,
               'rls=' || c.relrowsecurity, 'force_rls=' || c.relforcerowsecurity,
               'replident=' || c.relreplident::text,
               'options=' || coalesce(array_to_string(c.reloptions, ','), ''),
               'tablespace=' || coalesce((SELECT spcname FROM pg_tablespace t WHERE t.oid = c.reltablespace), 'default'),
               CASE WHEN c.relispartition THEN 'partition of ' || (
                 SELECT pn.nspname || '.' || pc.relname FROM pg_inherits i
                 JOIN pg_class pc ON pc.oid = i.inhparent JOIN pg_namespace pn ON pn.oid = pc.relnamespace
                 WHERE i.inhrelid = c.oid) || ' ' || coalesce(pg_get_expr(c.relpartbound, c.oid), '') END,
               CASE WHEN c.relkind = 'p' THEN 'partition key ' || pg_get_partkeydef(c.oid) END
             ) AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${SYSTEM_SCHEMA_FILTER} AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
        AND ${notExtensionMember("pg_class", "c.oid")}`,
  },
  {
    // ACLs on relations, separately from the relation, so a grant difference
    // names itself as one rather than as a changed table.
    name: "relation acls",
    sql: `
      SELECT 'acl relation ' || n.nspname || '.' || c.relname AS key, ${aclText("c.relacl")} AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${SYSTEM_SCHEMA_FILTER} AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        AND ${notExtensionMember("pg_class", "c.oid")}`,
  },
  {
    name: "columns",
    sql: `
      SELECT 'column ' || n.nspname || '.' || c.relname || '.' || a.attname AS key,
             concat_ws(' ',
               '#' || rank() OVER (PARTITION BY c.oid ORDER BY a.attnum),
               format_type(a.atttypid, a.atttypmod),
               CASE WHEN a.attnotnull THEN 'NOT NULL' END,
               CASE WHEN a.attidentity <> '' THEN 'identity=' || a.attidentity::text END,
               CASE WHEN a.attgenerated <> '' THEN 'generated=' || a.attgenerated::text END,
               CASE WHEN ad.adbin IS NOT NULL THEN 'default ' || pg_get_expr(ad.adbin, ad.adrelid) END,
               CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN
                 'collate ' || (SELECT collname FROM pg_collation WHERE oid = a.attcollation) END,
               CASE WHEN a.attstorage <> t.typstorage THEN 'storage=' || a.attstorage::text END
             ) AS definition
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE ${SYSTEM_SCHEMA_FILTER} AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'c')
        AND a.attnum > 0 AND NOT a.attisdropped
        AND ${notExtensionMember("pg_class", "c.oid")}`,
  },
  {
    // Column-level grants (`GRANT UPDATE (col)`), one entry per column that has any.
    name: "column acls",
    sql: `
      SELECT 'acl column ' || n.nspname || '.' || c.relname || '.' || a.attname AS key,
             ${aclText("a.attacl")} AS definition
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${SYSTEM_SCHEMA_FILTER} AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
        AND ${notExtensionMember("pg_class", "c.oid")}`,
  },
  {
    name: "constraints",
    sql: `
      SELECT 'constraint ' || n.nspname || '.' || coalesce(c.relname, t.typname) || '.' || con.conname AS key,
             concat_ws(' ', con.contype::text, pg_get_constraintdef(con.oid, true),
               CASE WHEN con.condeferrable THEN 'deferrable' END,
               CASE WHEN con.condeferred THEN 'initially deferred' END,
               CASE WHEN NOT con.convalidated THEN 'not valid' END) AS definition
      FROM pg_constraint con
      JOIN pg_namespace n ON n.oid = con.connamespace
      LEFT JOIN pg_class c ON c.oid = con.conrelid
      LEFT JOIN pg_type t ON t.oid = con.contypid
      WHERE ${SYSTEM_SCHEMA_FILTER} AND ${notExtensionMember("pg_constraint", "con.oid")}`,
  },
  {
    name: "indexes",
    sql: `
      SELECT 'index ' || n.nspname || '.' || ic.relname AS key,
             pg_get_indexdef(i.indexrelid) ||
               CASE WHEN NOT i.indisvalid THEN ' INVALID' ELSE '' END ||
               CASE WHEN i.indisclustered THEN ' CLUSTERED' ELSE '' END ||
               CASE WHEN i.indisreplident THEN ' REPLICA IDENTITY' ELSE '' END AS definition
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = ic.relnamespace
      WHERE ${SYSTEM_SCHEMA_FILTER} AND ${notExtensionMember("pg_class", "ic.oid")}`,
  },
  {
    // The full reprinted definition carries the signature, return type,
    // language, volatility, security, `SET` clauses and body. The ACL is its
    // own entry, as it is for relations and schemas.
    name: "functions",
    sql: `
      SELECT 'function ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS key,
             concat_ws(' ',
               'owner=' || pg_get_userbyid(p.proowner),
               CASE WHEN p.prokind IN ('a', 'w') THEN 'aggregate ' || p.prokind::text
                    ELSE pg_get_functiondef(p.oid) END) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE ${SYSTEM_SCHEMA_FILTER} AND ${notExtensionMember("pg_proc", "p.oid")}
      UNION ALL
      SELECT 'acl function ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
             ${aclText("p.proacl")}
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE ${SYSTEM_SCHEMA_FILTER} AND ${notExtensionMember("pg_proc", "p.oid")}`,
  },
  {
    // `tgenabled` separately: CREATE TRIGGER cannot say ENABLE ALWAYS, so a
    // trigger whose firing mode was never altered reprints identically to one
    // that was, and the mode is what decides whether a replication apply fires it.
    name: "triggers",
    sql: `
      SELECT 'trigger ' || n.nspname || '.' || c.relname || '.' || tg.tgname AS key,
             pg_get_triggerdef(tg.oid, true) || ' enabled=' || tg.tgenabled::text AS definition
      FROM pg_trigger tg
      JOIN pg_class c ON c.oid = tg.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${SYSTEM_SCHEMA_FILTER} AND NOT tg.tgisinternal`,
  },
  {
    name: "policies",
    sql: `
      SELECT 'policy ' || schemaname || '.' || tablename || '.' || policyname AS key,
             concat_ws(' ', permissive, 'to', array_to_string(ARRAY(SELECT unnest(roles) ORDER BY 1), ','),
               'for', cmd, 'using', coalesce(qual, '-'), 'check', coalesce(with_check, '-')) AS definition
      FROM pg_policies
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
  },
  {
    // Rules other than the `_RETURN` rule every view carries (that one is the
    // view's definition, reprinted below).
    name: "rules",
    sql: `
      SELECT 'rule ' || schemaname || '.' || tablename || '.' || rulename AS key, definition
      FROM pg_rules
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
  },
  {
    name: "views",
    sql: `
      SELECT 'view definition ' || n.nspname || '.' || c.relname AS key, pg_get_viewdef(c.oid, true) AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${SYSTEM_SCHEMA_FILTER} AND c.relkind IN ('v', 'm') AND ${notExtensionMember("pg_class", "c.oid")}`,
  },
  {
    name: "sequences",
    sql: `
      SELECT 'sequence parameters ' || n.nspname || '.' || c.relname AS key,
             concat_ws(' ', format_type(s.seqtypid, NULL), 'start', s.seqstart, 'increment', s.seqincrement,
               'min', s.seqmin, 'max', s.seqmax, 'cache', s.seqcache, CASE WHEN s.seqcycle THEN 'cycle' END,
               'owned by ' || coalesce((
                 SELECT dn.nspname || '.' || dc.relname || '.' || da.attname
                 FROM pg_depend d
                 JOIN pg_class dc ON dc.oid = d.refobjid
                 JOIN pg_namespace dn ON dn.oid = dc.relnamespace
                 JOIN pg_attribute da ON da.attrelid = d.refobjid AND da.attnum = d.refobjsubid
                 WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                   AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
                 LIMIT 1), 'none')) AS definition
      FROM pg_sequence s
      JOIN pg_class c ON c.oid = s.seqrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${SYSTEM_SCHEMA_FILTER} AND ${notExtensionMember("pg_class", "c.oid")}`,
  },
  {
    // Enums (labels in sort order), domains (base type, nullability, default)
    // and range types. Composite types are relations and are covered above.
    name: "types",
    sql: `
      SELECT 'type ' || n.nspname || '.' || t.typname AS key,
             concat_ws(' ', 'owner=' || pg_get_userbyid(t.typowner),
               CASE t.typtype
                 WHEN 'e' THEN 'enum (' || (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder)
                                             FROM pg_enum e WHERE e.enumtypid = t.oid) || ')'
                 WHEN 'd' THEN 'domain over ' || format_type(t.typbasetype, t.typtypmod)
                               || CASE WHEN t.typnotnull THEN ' NOT NULL' ELSE '' END
                               || coalesce(' default ' || t.typdefault, '')
                 WHEN 'r' THEN 'range'
                 ELSE 'typtype ' || t.typtype::text END,
               'acl=' || ${aclText("t.typacl")}) AS definition
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE ${SYSTEM_SCHEMA_FILTER} AND t.typtype IN ('e', 'd', 'r')
        AND ${notExtensionMember("pg_type", "t.oid")}`,
  },
  {
    // Operators and casts in application schemas. The snapshot declares none
    // today; reading them means a migration that adds one (or a hand-made one
    // on a live database) is a named difference rather than an unread class.
    // A cast has no schema, so "ours" is: created after initdb (OID at or
    // above FirstNormalObjectId, 16384) and not an extension's.
    name: "operators and casts",
    sql: `
      SELECT 'operator ' || n.nspname || '.' || o.oprname || '(' || coalesce(format_type(o.oprleft, NULL), 'NONE')
               || ', ' || coalesce(format_type(o.oprright, NULL), 'NONE') || ')' AS key,
             concat_ws(' ', 'owner=' || pg_get_userbyid(o.oprowner), 'returns', format_type(o.oprresult, NULL),
               'function', o.oprcode::regprocedure::text) AS definition
      FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace
      WHERE ${SYSTEM_SCHEMA_FILTER} AND ${notExtensionMember("pg_operator", "o.oid")}
      UNION ALL
      SELECT 'cast (' || format_type(c.castsource, NULL) || ' AS ' || format_type(c.casttarget, NULL) || ')',
             concat_ws(' ', 'context=' || c.castcontext::text, 'method=' || c.castmethod::text,
               CASE WHEN c.castfunc <> 0 THEN 'function ' || c.castfunc::regprocedure::text END)
      FROM pg_cast c
      WHERE c.oid >= 16384 AND ${notExtensionMember("pg_cast", "c.oid")}`,
  },
  {
    // Publications (with their tables and schemas) and event triggers — the two
    // database-level objects a migration could create that no other class
    // here reads. A publication decides which rows leave the database; an
    // event trigger runs on every DDL statement. The snapshot declares
    // neither, so either one appearing is drift.
    name: "publications and event triggers",
    sql: `
      SELECT 'publication ' || p.pubname AS key,
             concat_ws(' ', 'owner=' || pg_get_userbyid(p.pubowner), 'all_tables=' || p.puballtables,
               'insert=' || p.pubinsert, 'update=' || p.pubupdate, 'delete=' || p.pubdelete,
               'truncate=' || p.pubtruncate, 'via_root=' || p.pubviaroot,
               'tables=' || coalesce((SELECT string_agg(pn.nspname || '.' || pc.relname, ',' ORDER BY pn.nspname, pc.relname)
                                      FROM pg_publication_rel pr JOIN pg_class pc ON pc.oid = pr.prrelid
                                      JOIN pg_namespace pn ON pn.oid = pc.relnamespace
                                      WHERE pr.prpubid = p.oid), ''),
               'schemas=' || coalesce((SELECT string_agg(pn.nspname, ',' ORDER BY pn.nspname)
                                       FROM pg_publication_namespace pns JOIN pg_namespace pn ON pn.oid = pns.pnnspid
                                       WHERE pns.pnpubid = p.oid), '')) AS definition
      FROM pg_publication p
      UNION ALL
      SELECT 'event trigger ' || e.evtname,
             concat_ws(' ', 'owner=' || pg_get_userbyid(e.evtowner), 'on', e.evtevent,
               'function', e.evtfoid::regprocedure::text, 'enabled=' || e.evtenabled::text,
               'tags=' || coalesce(array_to_string(e.evttags, ','), ''))
      FROM pg_event_trigger e
      WHERE ${notExtensionMember("pg_event_trigger", "e.oid")}`,
  },
  {
    // `ALTER DEFAULT PRIVILEGES` — what a role's FUTURE objects will be granted.
    name: "default privileges",
    sql: `
      SELECT 'default privileges for ' || pg_get_userbyid(d.defaclrole) || ' in '
               || coalesce((SELECT nspname FROM pg_namespace WHERE oid = d.defaclnamespace), '<all schemas>')
               || ' on ' || CASE d.defaclobjtype WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences'
                  WHEN 'f' THEN 'functions' WHEN 'T' THEN 'types' WHEN 'n' THEN 'schemas'
                  ELSE d.defaclobjtype::text END AS key,
             ${aclText("d.defaclacl")} AS definition
      FROM pg_default_acl d`,
  },
  {
    // COMMENT ON — pg_dump carries them into the snapshot, so a migration that
    // documents an object and a snapshot that does not are a real difference.
    name: "comments",
    sql: `
      SELECT 'comment on ' || cl.relname || ' ' || coalesce(
               CASE cl.relname
                 WHEN 'pg_class' THEN (SELECT n.nspname || '.' || c.relname
                     || CASE WHEN d.objsubid > 0 THEN '.' || (SELECT attname FROM pg_attribute
                          WHERE attrelid = c.oid AND attnum = d.objsubid) ELSE '' END
                   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE c.oid = d.objoid AND ${SYSTEM_SCHEMA_FILTER})
                 WHEN 'pg_proc' THEN (SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
                   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE p.oid = d.objoid AND ${SYSTEM_SCHEMA_FILTER})
                 -- Constraint, trigger and policy names are unique only per
                 -- owning relation (or domain), so the key carries it — the
                 -- same key shape as the object's own class above. By name
                 -- alone, a comment moved to a same-named trigger on another
                 -- table would compare equal.
                 WHEN 'pg_constraint' THEN (SELECT n.nspname || '.' || coalesce(c.relname, t.typname) || '.' || con.conname
                   FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
                   LEFT JOIN pg_class c ON c.oid = con.conrelid
                   LEFT JOIN pg_type t ON t.oid = con.contypid
                   WHERE con.oid = d.objoid AND ${SYSTEM_SCHEMA_FILTER})
                 WHEN 'pg_trigger' THEN (SELECT n.nspname || '.' || c.relname || '.' || tg.tgname
                   FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE tg.oid = d.objoid AND ${SYSTEM_SCHEMA_FILTER})
                 WHEN 'pg_type' THEN (SELECT n.nspname || '.' || t.typname
                   FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                   WHERE t.oid = d.objoid AND ${SYSTEM_SCHEMA_FILTER})
                 WHEN 'pg_policy' THEN (SELECT n.nspname || '.' || c.relname || '.' || pol.polname
                   FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE pol.oid = d.objoid AND ${SYSTEM_SCHEMA_FILTER})
                 WHEN 'pg_namespace' THEN (SELECT n.nspname FROM pg_namespace n
                   WHERE n.oid = d.objoid AND ${SYSTEM_SCHEMA_FILTER})
               END, '') AS key,
             d.description AS definition
      FROM pg_description d
      JOIN pg_class cl ON cl.oid = d.classoid
      WHERE NOT EXISTS (SELECT 1 FROM pg_depend dep
                        WHERE dep.classid = d.classoid AND dep.objid = d.objoid AND dep.deptype = 'e')
        AND NOT (cl.relname = 'pg_namespace' AND d.objoid = 'public'::regnamespace
                 AND d.description = 'standard public schema')`,
  },
];

/**
 * Read the database's catalog as sorted, OID-free `(key, definition)` entries.
 *
 * Every class is always read. There is deliberately no switch to leave one
 * out: a comparison that skips a class hides its drift instead of recording it
 * (a known difference belongs in the caller's list of causes, by name).
 *
 * Throws, naming the class, when a class query fails, and when two objects
 * collapse onto one key — a collision would let one hide the other.
 */
export async function normalizedCatalog(db: CatalogDb): Promise<CatalogEntry[]> {
  const entries = new Map<string, string>();
  for (const cls of CLASSES) {
    let rows: { key: string | null; definition: string | null }[];
    try {
      rows = (await db.unsafe(cls.sql)) as unknown as { key: string | null; definition: string | null }[];
    } catch (error) {
      throw new Error(`catalog-normalize: reading ${cls.name} failed — ${(error as Error).message}`);
    }
    for (const row of rows) {
      // A comment whose object resolved to nothing belongs to a system object
      // (every lookup above is filtered to application schemas).
      if (row.key === null || row.key.endsWith(" ")) continue;
      const definition = row.definition ?? "<null>";
      if (entries.has(row.key)) {
        throw new Error(`catalog-normalize: two ${cls.name} objects normalize to one key: ${row.key}`);
      }
      entries.set(row.key, definition);
    }
  }
  return [...entries.entries()]
    .map(([key, definition]) => ({ key, definition }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Compare two normalized catalogs by key, then by definition. */
export function diffCatalogs(left: readonly CatalogEntry[], right: readonly CatalogEntry[]): CatalogDiff {
  const l = new Map(left.map((e) => [e.key, e.definition]));
  const r = new Map(right.map((e) => [e.key, e.definition]));
  const onlyLeft = left.filter((e) => !r.has(e.key));
  const onlyRight = right.filter((e) => !l.has(e.key));
  const differing = left
    .filter((e) => r.has(e.key) && r.get(e.key) !== e.definition)
    .map((e) => ({ key: e.key, left: e.definition, right: r.get(e.key)! }));
  return { onlyLeft, onlyRight, differing };
}

/** True when the two catalogs declare exactly the same objects. */
export function catalogsEqual(diff: CatalogDiff): boolean {
  return diff.onlyLeft.length === 0 && diff.onlyRight.length === 0 && diff.differing.length === 0;
}

/**
 * One line per differing object, each naming it — the failure message of every
 * equivalence proof, so a red run says WHICH object to fix and on which side.
 */
export function describeCatalogDiff(diff: CatalogDiff, leftName: string, rightName: string): string[] {
  const clip = (s: string): string => (s.length > 400 ? `${s.slice(0, 400)}…` : s);
  return [
    ...diff.onlyLeft.map((e) => `only in ${leftName}: ${e.key} — ${clip(e.definition)}`),
    ...diff.onlyRight.map((e) => `only in ${rightName}: ${e.key} — ${clip(e.definition)}`),
    ...diff.differing.map((d) => `differs: ${d.key}\n    ${leftName}: ${clip(d.left)}\n    ${rightName}: ${clip(d.right)}`),
  ];
}
