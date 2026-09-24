// Blank + all migrations = the snapshot — the first of spec §8.4's CI proofs
// (smoke-production-spec.md §8.4, issue #1026 criterion 50).
//
// WHY THIS FILE MATTERS MORE THAN ITS SIZE. Spec §8.1 calls the snapshot
// "hand-maintained", and the repository has no generator for it. Every other
// snapshot test (schema-snapshot.test.ts) proves the snapshot BOOTSTRAPS; none
// proves it describes the same database the migrations build. Without this
// comparison a migration can land with a snapshot edit that is merely
// plausible, and the two histories — every production database, which was
// built by migrations, and every blank rehearsal, which is built from the
// snapshot — drift apart with nothing to say so.
//
// THE TWO SIDES, each built by the path real databases take:
//
//   migrated  — a copy of the suite's template, which tests/preload.ts builds
//               by applying every file in backend/migrations/ to an empty
//               database. It is then enrolled `rehearsal` by rm_owner (§4.2)
//               and given the REAL migrate run (`runMigrate`, §8.3): nothing is
//               pending, so what the run adds is the roles-and-grants
//               reconciliation and the manifest — "always, even with nothing
//               pending". No database is ever migrated without that step, so
//               comparing one that skipped it would compare a state nothing
//               ships.
//   snapshot  — an empty database owned by rm_owner, bootstrapped from
//               backend/schema/ by `bootstrapBlankDatabase`, the `--local
//               blank` path (§5). pgcrypto is installed first by the superuser
//               because it is provider-managed (the snapshot header says so).
//
// THE COMPARISON is tests/support/catalog-normalize.ts: every declared object
// by name, OID-free, sorted. COMMENT ON text is left out on this one
// comparison only, because backend/schema/snapshot.sql is dumped without
// comments (it carries none, while the migrations declare them) and §8.1 does
// not list comments among the declaration's classes. The upgrade proof in
// upgrade-from-release.test.ts compares two migrated databases and keeps them.
//
// RECORDED DRIFT, NOT HIDDEN DRIFT. When this file was written the two sides
// differed in privileges only — every table, column, constraint, index,
// function body, trigger, policy and sequence matched. The privilege
// differences are real defects in backend/schema/grants.sql and
// backend/schema/snapshot.sql, which this package does not own. They are listed
// below as CAUSES, each naming the fix, and the test holds them to two rules:
//   1. every difference must be explained by a cause, or the test fails naming
//      the object; and
//   2. every cause must still explain at least one difference, or the test
//      fails telling the reader to delete it — a fixed cause is never left
//      behind to excuse the next regression of the same shape.
// The list only shrinks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { config } from "../src/config.ts";
import { APPEND_ONLY_TABLES, LEDGER_IMMUTABLE_FAMILIES } from "../src/db/append-only-guard.ts";
import { bootstrapBlankDatabase, loadSnapshot } from "../src/db/schema-snapshot.ts";
import { runMigrate, type MigrateRunOptions } from "../scripts/migrate-run.ts";
import {
  describeCatalogDiff,
  diffCatalogs,
  normalizedCatalog,
  type CatalogDiff,
  type CatalogEntry,
} from "./support/catalog-normalize.ts";

function urlFor(database: string): string {
  const url = new URL(config.databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function connect(database: string): postgres.Sql<{}> {
  return postgres(urlFor(database), { max: 1, onnotice: () => {} });
}

/** The smoke `--migrate` caller against a rehearsal database this file owns.
 *  The lock key is a literal: the fence is not what is under test. */
const MIGRATE_OPTIONS: MigrateRunOptions = {
  caller: "smoke_flag",
  env: "stage",
  connection: "local",
  lockKey: 7726322199513611n,
  sessionLockHeld: false,
  nonInteractive: true,
};

const suffix = crypto.randomUUID().slice(0, 8);
const MIGRATED_DB = `rm_equiv_migrated_${suffix}`;
const SNAPSHOT_DB = `rm_equiv_snapshot_${suffix}`;

let migrated: postgres.Sql<{}>;
let snapshotDb: postgres.Sql<{}>;
let migratedCatalog: CatalogEntry[] = [];
let snapshotCatalog: CatalogEntry[] = [];

beforeAll(async () => {
  const admin = connect("postgres");
  try {
    await admin.unsafe(`CREATE DATABASE ${MIGRATED_DB} TEMPLATE "${process.env.RM_TEST_TEMPLATE_DB}"`);
    // OWNER rm_owner: §5's `--local blank` hands the bootstrap a database the
    // schema owner owns (see schema-snapshot.test.ts's withBlankDatabase).
    await admin.unsafe(`CREATE DATABASE ${SNAPSHOT_DB} OWNER rm_owner`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  migrated = connect(MIGRATED_DB);
  // §4.2: a restored or copied database is enrolled `rehearsal` through
  // rm_owner before any stage tool touches it.
  await migrated.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    await tx.unsafe("INSERT INTO deployment_identity (kind) VALUES ('rehearsal')");
  });
  const run = await runMigrate(migrated, MIGRATE_OPTIONS);
  // The template already holds every migration: this run only reconciles and
  // publishes. If it applied something, the template is not "all migrations".
  expect(run.applied).toEqual([]);

  snapshotDb = connect(SNAPSHOT_DB);
  await snapshotDb.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await snapshotDb.unsafe("SET ROLE rm_owner");
  await bootstrapBlankDatabase(snapshotDb, await loadSnapshot());
  await snapshotDb.unsafe("RESET ROLE");

  migratedCatalog = await normalizedCatalog(migrated, { comments: false });
  snapshotCatalog = await normalizedCatalog(snapshotDb, { comments: false });
}, 120_000);

afterAll(async () => {
  await migrated?.end({ timeout: 5 });
  await snapshotDb?.end({ timeout: 5 });
  const admin = connect("postgres");
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${MIGRATED_DB} WITH (FORCE)`);
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SNAPSHOT_DB} WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// The recorded drift
// ───────────────────────────────────────────────────────────────────────────

/** One side of one differing object; `null` when the object is absent there. */
interface DriftItem {
  readonly key: string;
  readonly migrated: string | null;
  readonly snapshot: string | null;
}

/**
 * A known cause of difference. Either it REWRITES a relation ACL (strips the
 * items the cause accounts for, from the side that has them), or it matches
 * one object EXACTLY, both definitions spelled out. A rewrite never matches a
 * whole entry by pattern: after every rewrite the two sides must be equal, so
 * any other difference on the same object still fails.
 */
type DriftCause =
  | {
      readonly id: string;
      readonly fix: string;
      readonly kind: "strip";
      /** Returns the migrated side's ACL with this cause's items removed, or
       *  `null` when the cause does not apply to this key. */
      readonly strip: (key: string, migratedAcl: string, snapshotAcl: string) => string | null;
    }
  | {
      readonly id: string;
      readonly fix: string;
      readonly kind: "exact";
      readonly items: readonly DriftItem[];
    };

const aclItems = (acl: string): string[] => (acl === "<default>" ? [] : acl.split(", "));
const joinAcl = (items: readonly string[]): string => (items.length === 0 ? "<default>" : items.join(", "));
const relationOf = (key: string): string | null => /^acl relation public\.(.+)$/.exec(key)?.[1] ?? null;

/** Tables whose DELETE the migrations revoked on purpose — the append-only set
 *  and the immutable ledgers (D53 decision 6) — so cause B must not explain a
 *  DELETE on any of them. A planted `GRANT DELETE ... TO rm_app` there is a
 *  finding, and the red control below proves it stays one. */
const DELETE_REVOKED = new Set<string>([
  ...APPEND_ONLY_TABLES,
  ...LEDGER_IMMUTABLE_FAMILIES.flatMap((family) => family.tables),
]);

const CAUSES: readonly DriftCause[] = [
  {
    id: "A: the snapshot grants rm_worker nothing",
    fix:
      "backend/schema/grants.sql:166-167 says rm_worker's grants are 'an allowlist maintained by migrations " +
      "0054/0061/0062 and are not widened here', and snapshot.sql carries no grants — so a blank bootstrap " +
      "(`--local blank`) leaves rm_worker with no privilege on any table or sequence. Carry the 0054/0061/0062/0068 " +
      "allowlist in grants.sql so reconciliation re-asserts it.",
    kind: "strip",
    strip: (key, migratedAcl, snapshotAcl) => {
      if (relationOf(key) === null) return null;
      if (aclItems(snapshotAcl).some((item) => item.startsWith("rm_worker:"))) return null;
      return joinAcl(aclItems(migratedAcl).filter((item) => !item.startsWith("rm_worker:")));
    },
  },
  {
    id: "B: 0053's rm_app DELETE survives on every ordinary table, and the snapshot never grants it",
    fix:
      "backend/migrations/0053_database_role_taxonomy.sql:146 grants rm_app DELETE on all tables; " +
      "backend/schema/grants.sql:151 grants ordinary tables SELECT, INSERT, UPDATE and neither grants nor revokes " +
      "DELETE. A migrated database therefore keeps DELETE and a blank one never has it. Decide which is " +
      "intended and make grants.sql assert it both ways.",
    kind: "strip",
    strip: (key, migratedAcl, snapshotAcl) => {
      const table = relationOf(key);
      if (table === null || DELETE_REVOKED.has(table)) return null;
      const DELETE = "rm_app:DELETE by rm_owner";
      if (aclItems(snapshotAcl).includes(DELETE)) return null;
      return joinAcl(aclItems(migratedAcl).filter((item) => item !== DELETE));
    },
  },
  {
    id: "C: the immutable-ledger trigger functions keep PUBLIC EXECUTE in the snapshot",
    fix:
      "0057/0058/0059/0060 REVOKE EXECUTE ... FROM PUBLIC on their guard functions; the snapshot declaration " +
      "excludes grants and grants.sql does not re-assert the revoke. Add it to grants.sql.",
    kind: "exact",
    items: [
      "rm_analytics_cutover_immutable()",
      "rm_analytics_output_ledger_immutable()",
      "rm_analytics_overwrite_event_immutable()",
      "rm_analytics_run_ledger_immutable()",
      "rm_capture_analytics_overwrite()",
      "rm_source_ledger_immutable()",
    ].map((fn) => ({ key: `acl function public.${fn}`, migrated: "rm_owner:EXECUTE by rm_owner", snapshot: "<default>" })),
  },
  {
    id: "D: the snapshot does not declare schema public's owner or ACL",
    fix:
      "0053 makes rm_owner the owner of schema public and revokes ALL from PUBLIC; snapshot.sql skips the " +
      "schema ('*not* creating schema, since initdb creates it'), so a blank database keeps initdb's " +
      "pg_database_owner ownership and PUBLIC USAGE. grants.sql:185 only adds USAGE. Declare both.",
    kind: "exact",
    items: [
      { key: "schema public", migrated: "owner=rm_owner", snapshot: "owner=pg_database_owner" },
      {
        key: "acl schema public",
        migrated:
          "rm_app:USAGE by rm_owner, rm_owner:CREATE by rm_owner, rm_owner:USAGE by rm_owner, " +
          "rm_readonly:USAGE by rm_owner, rm_worker:USAGE by rm_owner",
        snapshot:
          "PUBLIC:USAGE by pg_database_owner, pg_database_owner:CREATE by pg_database_owner, " +
          "pg_database_owner:USAGE by pg_database_owner, rm_app:USAGE by pg_database_owner, " +
          "rm_readonly:USAGE by pg_database_owner, rm_worker:USAGE by pg_database_owner",
      },
    ],
  },
  {
    id: "E: default privileges differ between the migrations and grants.sql",
    fix:
      "0016:37-38 set default privileges for the provisioning login (rm_worker DML on its future tables and " +
      "sequences); 0053:139-154 set rm_owner's sequence defaults and add rm_worker SELECT to its table " +
      "defaults; grants.sql:189-190 adds rm_app SELECT, INSERT, UPDATE and rm_readonly SELECT to the table " +
      "defaults and revokes nothing, so a migrated database keeps 0053's rm_worker SELECT and sequence " +
      "defaults that a blank one never gets.",
    kind: "exact",
    items: [
      {
        key: "default privileges for rm_owner in public on sequences",
        migrated: "rm_app:SELECT by rm_owner, rm_readonly:SELECT by rm_owner, rm_worker:SELECT by rm_owner",
        snapshot: null,
      },
      {
        key: "default privileges for rm_owner in public on tables",
        migrated:
          "rm_app:INSERT by rm_owner, rm_app:SELECT by rm_owner, rm_app:UPDATE by rm_owner, " +
          "rm_readonly:SELECT by rm_owner, rm_worker:SELECT by rm_owner",
        snapshot:
          "rm_app:INSERT by rm_owner, rm_app:SELECT by rm_owner, rm_app:UPDATE by rm_owner, rm_readonly:SELECT by rm_owner",
      },
      {
        key: `default privileges for ${new URL(config.databaseUrl).username} in public on sequences`,
        migrated: `rm_worker:SELECT by ${new URL(config.databaseUrl).username}, rm_worker:USAGE by ${new URL(config.databaseUrl).username}`,
        snapshot: null,
      },
      {
        key: `default privileges for ${new URL(config.databaseUrl).username} in public on tables`,
        migrated: ["DELETE", "INSERT", "SELECT", "UPDATE"]
          .map((p) => `rm_worker:${p} by ${new URL(config.databaseUrl).username}`)
          .join(", "),
        snapshot: null,
      },
    ],
  },
];

/** What the causes leave unexplained, and which causes explained something. */
function explain(diff: CatalogDiff): { unexplained: DriftItem[]; used: Set<string> } {
  const items: DriftItem[] = [
    ...diff.onlyLeft.map((e) => ({ key: e.key, migrated: e.definition, snapshot: null })),
    ...diff.onlyRight.map((e) => ({ key: e.key, migrated: null, snapshot: e.definition })),
    ...diff.differing.map((d) => ({ key: d.key, migrated: d.left, snapshot: d.right })),
  ];
  const used = new Set<string>();
  const unexplained: DriftItem[] = [];

  for (const item of items) {
    const exact = CAUSES.find(
      (cause) =>
        cause.kind === "exact" &&
        cause.items.some((i) => i.key === item.key && i.migrated === item.migrated && i.snapshot === item.snapshot),
    );
    if (exact) {
      used.add(exact.id);
      continue;
    }
    if (item.migrated !== null && item.snapshot !== null) {
      let rewritten = item.migrated;
      const contributing: string[] = [];
      for (const cause of CAUSES) {
        if (cause.kind !== "strip") continue;
        const next = cause.strip(item.key, rewritten, item.snapshot);
        if (next !== null && next !== rewritten) {
          contributing.push(cause.id);
          rewritten = next;
        }
      }
      if (rewritten === item.snapshot) {
        for (const id of contributing) used.add(id);
        continue;
      }
    }
    unexplained.push(item);
  }
  return { unexplained, used };
}

function describeItems(items: readonly DriftItem[]): string {
  return describeCatalogDiff(
    {
      onlyLeft: items.filter((i) => i.snapshot === null).map((i) => ({ key: i.key, definition: i.migrated! })),
      onlyRight: items.filter((i) => i.migrated === null).map((i) => ({ key: i.key, definition: i.snapshot! })),
      differing: items
        .filter((i) => i.migrated !== null && i.snapshot !== null)
        .map((i) => ({ key: i.key, left: i.migrated!, right: i.snapshot! })),
    },
    "migrations",
    "snapshot",
  ).join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// The proof
// ───────────────────────────────────────────────────────────────────────────

describe("blank + all migrations = the snapshot (spec §8.4)", () => {
  test("both sides were really read — a comparison of two empty lists proves nothing", () => {
    // Floors, not counts: the point is that neither side came back empty or
    // half-read, not to pin the schema's size.
    for (const catalog of [migratedCatalog, snapshotCatalog]) {
      expect(catalog.filter((e) => e.key.startsWith("table public.")).length).toBeGreaterThan(50);
      expect(catalog.filter((e) => e.key.startsWith("trigger public.")).length).toBeGreaterThan(20);
      expect(catalog.filter((e) => e.key.startsWith("function public.")).length).toBeGreaterThan(5);
      expect(catalog.filter((e) => e.key.startsWith("index public.")).length).toBeGreaterThan(50);
    }
  });

  test("every object the migrations declare, the snapshot declares identically — except the recorded causes", () => {
    const { unexplained } = explain(diffCatalogs(migratedCatalog, snapshotCatalog));
    // The message names every differing object and both of its definitions,
    // so a red run says which object to fix and on which side.
    if (unexplained.length > 0) {
      throw new Error(
        `backend/schema/ and backend/migrations/ declare ${unexplained.length} object(s) differently ` +
          `(fix the snapshot, or the migration it forgot):\n${describeItems(unexplained)}`,
      );
    }
    expect(unexplained).toEqual([]);
  });

  test("the only differences are privileges and ownership — the snapshot's tables, columns, constraints, indexes, functions, triggers, policies and sequences all match", () => {
    const diff = diffCatalogs(migratedCatalog, snapshotCatalog);
    const keys = [
      ...diff.onlyLeft.map((e) => e.key),
      ...diff.onlyRight.map((e) => e.key),
      ...diff.differing.map((d) => d.key),
    ];
    expect(keys.filter((key) => !/^(acl |default privileges |schema public$)/.test(key))).toEqual([]);
  });

  test("every recorded cause still occurs — a fixed cause is deleted, never left to excuse the next regression", () => {
    const { used } = explain(diffCatalogs(migratedCatalog, snapshotCatalog));
    const stale = CAUSES.filter((cause) => !used.has(cause.id)).map((cause) => cause.id);
    expect(stale).toEqual([]);
  });

  test("RED CONTROL: a planted difference fails, and the failure names each planted object", async () => {
    // Planted inside a transaction on the migrated side and rolled back, so the
    // shared comparison above is untouched. One plant per class the causes sit
    // closest to, so a cause that over-explains would be caught here:
    //   * a column default    — a declaration class no cause touches;
    //   * a trigger's firing mode — only tgenabled differs;
    //   * rm_app DELETE on an APPEND-ONLY table — the exact item cause B strips
    //     elsewhere, on a table cause B must not reach;
    //   * a new index.
    let planted: DriftItem[] = [];
    await migrated
      .begin(async (tx) => {
        await tx.unsafe("ALTER TABLE jobs ALTER COLUMN priority SET DEFAULT 7");
        await tx.unsafe("ALTER TABLE schema_migrations DISABLE TRIGGER schema_migrations_append_only_row");
        await tx.unsafe("GRANT DELETE ON swarm_members TO rm_app");
        await tx.unsafe("CREATE INDEX rm_equiv_planted_idx ON jobs (updated_at)");
        planted = explain(diffCatalogs(await normalizedCatalog(tx, { comments: false }), snapshotCatalog)).unexplained;
        throw new RollbackPlant();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RollbackPlant)) throw error;
      });

    const message = describeItems(planted);
    expect(planted.map((item) => item.key).sort()).toEqual([
      "acl relation public.swarm_members",
      "column public.jobs.priority",
      "index public.rm_equiv_planted_idx",
      "trigger public.schema_migrations.schema_migrations_append_only_row",
    ]);
    expect(message).toContain("differs: column public.jobs.priority");
    expect(message).toContain("default 7");
    expect(message).toContain("only in migrations: index public.rm_equiv_planted_idx");
    expect(message).toContain("enabled=D");
    expect(message).toContain("rm_app:DELETE");
  });
});

/** Thrown to roll back the red control's plant; never escapes the test. */
class RollbackPlant extends Error {}
