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
// by name, OID-free, sorted, every class read on both sides — COMMENT ON
// included. backend/schema/snapshot.sql carries no comments while the
// migrations declare them; that is recorded below as cause F, comment by
// comment, not hidden by skipping the class.
//
// RECORDED DRIFT, NOT HIDDEN DRIFT. When this file was written the two sides
// differed in privileges, ownership and comments only — every table, column,
// constraint, index, function body, trigger, policy and sequence matched. The
// differences are real defects in backend/schema/grants.sql and
// backend/schema/snapshot.sql, which this package does not own. They are listed
// below as CAUSES, each naming the fix. Every cause is an EXACT record — the
// objects it covers, by name, and for a privilege cause the exact items on the
// migrated side — never a pattern: a pattern ("strip every rm_worker item")
// would also explain the next wrong grant of the same shape. The test holds the
// record to two rules:
//   1. every difference must be explained by a recorded entry, or the test
//      fails naming the object; and
//   2. every recorded ENTRY (not merely every cause) must still explain a
//      difference, or the test fails naming it — a fixed entry is deleted, never
//      left behind to excuse the next regression on that object.
// The list only shrinks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { config } from "../src/config.ts";
import { APPEND_ONLY_TABLES, LEDGER_IMMUTABLE_FAMILIES } from "../src/db/append-only-guard.ts";
import { writeManifest } from "../src/db/schema-manifest.ts";
import { bootstrapBlankDatabase, loadSnapshot } from "../src/db/schema-snapshot.ts";
import { runMigrate, type MigrateGateOptions } from "../scripts/migrate-run.ts";
import { withTargetLock } from "./support/target-lock.ts";
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
 *  It runs under the §2 target lock a tool would hold (tests/support/target-lock.ts). */
const MIGRATE_OPTIONS: MigrateGateOptions & { nonInteractive: boolean } = {
  caller: "smoke_flag",
  env: "stage",
  connection: "local",
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
  // The run requires `current_user = rm_owner` for its whole session, and a
  // database with no manifest gets its first one only after the §9.1 step 2
  // baseline — which this harness's replaying login fails by exactly cause E's
  // entries (drift this file records). So the snapshot's own manifest is put
  // in place first (the template's ledger IS the snapshot's list) and the run
  // republishes over it: reconciliation still runs, and nothing else about the
  // migrated side changes.
  await migrated.unsafe("SET ROLE rm_owner");
  const snapshotForManifest = await loadSnapshot();
  await migrated.begin((tx) => writeManifest(tx, snapshotForManifest.manifest));
  const run = await withTargetLock(urlFor(MIGRATED_DB), (lock) => runMigrate(migrated, { ...MIGRATE_OPTIONS, lock }));
  await migrated.unsafe("RESET ROLE");
  // The template already holds every migration: this run only reconciles and
  // publishes. If it applied something, the template is not "all migrations".
  expect(run.applied).toEqual([]);

  snapshotDb = connect(SNAPSHOT_DB);
  await snapshotDb.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await snapshotDb.unsafe("SET ROLE rm_owner");
  await bootstrapBlankDatabase(snapshotDb, await loadSnapshot());
  await snapshotDb.unsafe("RESET ROLE");

  migratedCatalog = await normalizedCatalog(migrated);
  snapshotCatalog = await normalizedCatalog(snapshotDb);
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
 * A known cause of difference, as an exact record. Each cause lists ENTRIES —
 * the named objects it covers — and rule 2 above is enforced per entry.
 *
 *   * `acl`   — for each recorded relation, the exact ACL items the migrated
 *               side holds and the snapshot side lacks. The cause applies only
 *               when the migrated side's items for its grantee are EXACTLY the
 *               snapshot side's plus the recorded ones, and the snapshot side
 *               has none of the recorded ones; it then removes them. After every cause has had its turn the two sides
 *               must be equal, so any other difference on the object — an added
 *               privilege, a changed one, a new grantee — still fails.
 *   * `exact` — one object, both definitions spelled out.
 *   * `onlyInMigrations` — an object the migrations declare and the snapshot
 *               does not, by key.
 */
type DriftCause =
  | {
      readonly id: string;
      readonly fix: string;
      readonly kind: "acl";
      /** The grantee whose items this cause accounts for. */
      readonly grantee: string;
      /** Relation name -> the exact `privilege` list (sorted) the migrated side
       *  grants `grantee`, as `grantee:PRIV by rm_owner` items. */
      readonly relations: ReadonlyMap<string, readonly string[]>;
    }
  | {
      readonly id: string;
      readonly fix: string;
      readonly kind: "exact";
      readonly items: readonly DriftItem[];
    }
  | {
      readonly id: string;
      readonly fix: string;
      readonly kind: "onlyInMigrations";
      readonly keys: readonly string[];
    };

const aclItems = (acl: string): string[] => (acl === "<default>" ? [] : acl.split(", "));
const joinAcl = (items: readonly string[]): string => (items.length === 0 ? "<default>" : items.join(", "));
const relationOf = (key: string): string | null => /^acl relation public\.(.+)$/.exec(key)?.[1] ?? null;

/** Tables whose DELETE the migrations revoked on purpose — the append-only set
 *  and the immutable ledgers (D53 decision 6). Cause B's record may never name
 *  one of them; a test below holds it to that. */
const DELETE_REVOKED = new Set<string>([
  ...APPEND_ONLY_TABLES,
  ...LEDGER_IMMUTABLE_FAMILIES.flatMap((family) => family.tables),
]);

// ── The exact records ────────────────────────────────────────────────────
//
// Taken from the comparison itself on the commit that introduced them, then
// written out by hand. Adding a relation, or a privilege on one, is never the
// fix for a red run here: the fix is grants.sql / snapshot.sql (see each
// cause's `fix`), after which the entry is deleted.

/** Cause B: the tables on which the migrated side keeps 0053's rm_app DELETE
 *  and the snapshot side has none. */
const RM_APP_DELETE_ONLY_IN_MIGRATIONS: readonly string[] = [
  "admin_credential", "admin_passkey", "admin_session", "admin_webauthn_challenge", "agent_revenue_daily",
  "agent_vaults", "allocation_framework", "analytics_artifacts", "analytics_runs", "analytics_stage_runs",
  "analytics_submissions", "asset_price_floors", "asset_prices", "buyback_scan_state", "buyback_swaps",
  "chain_address_floors", "chain_day_blocks", "comments", "daily_agent_snapshots", "daily_coin_snapshots",
  "daily_tvl_snapshots", "daily_wallet_snapshots", "job_runs", "job_schedules", "jobs", "lobster_coins",
  "openclaw_agents", "prices", "projects", "raw_indicator_history", "regime_indicators",
  "research_pipeline_artifacts", "research_pipeline_runs", "research_pipeline_stages", "research_pipeline_warnings",
  "research_signals", "swarm_agent_health_events", "swarm_claim_challenges", "swarm_judge_config",
  "swarm_judge_fault_injection", "swarm_member_avatars", "swarm_waitlist", "tracked_wallets",
  "vault_adapter_samples", "vault_apy", "vault_share_price_history", "vault_tvl", "wallet_aum_snapshot_runs",
  "wallet_backfill_state", "wallet_balance_sample_evidence", "wallet_balance_samples", "wallet_balances",
  "wallet_sleeve_sample_evidence", "wallet_sleeve_samples",
];

/** Cause F: every COMMENT ON the migrations declare, by the object it is on.
 *  The snapshot declares none of them. */
const COMMENTS_ONLY_IN_MIGRATIONS: readonly string[] = [
  "pg_class public.analytics_data_vintages",
  "pg_class public.analytics_ledger_runs",
  "pg_class public.analytics_overwrite_events",
  "pg_class public.analytics_parity_observations",
  "pg_class public.analytics_read_mode",
  "pg_class public.analytics_report_snapshots",
  "pg_class public.automation_tokens",
  "pg_class public.automation_tokens.holder",
  "pg_class public.automation_tokens.instance",
  "pg_class public.automation_tokens.rights",
  "pg_class public.deployment_identity",
  "pg_class public.schema_manifest",
  "pg_class public.schema_migrations.compat",
  "pg_class public.schema_migrations.metadata_version",
  "pg_class public.source_value_versions",
  "pg_class public.source_value_versions.provenance",
  "pg_class public.swarm_brief_revisions",
  "pg_class public.swarm_briefs.report_snapshot_id",
  "pg_class public.swarm_consensus_receipts",
  "pg_class public.swarm_judge_config.third_party_enabled",
  "pg_class public.swarm_judge_fault_injection",
  "pg_class public.swarm_member_keys",
  "pg_class public.swarm_members.role",
  "pg_class public.swarm_recommendations.final",
  "pg_class public.swarm_recommendations.report_snapshot_id",
  "pg_class public.swarm_recommendations.signing_key_id",
  "pg_class public.swarm_session_judgements",
  "pg_class public.swarm_session_judgements.applied",
  "pg_class public.swarm_session_judgements.applied_skipped_reason",
  "pg_class public.swarm_session_judgements.digest_scheme",
  "pg_class public.swarm_session_judgements.dropped_disagreements",
  "pg_class public.swarm_session_judgements.dropped_positions",
  "pg_class public.swarm_session_judgements.judged_by",
  "pg_class public.swarm_session_judgements.usage_cost_usd",
  "pg_class public.swarm_sessions.consensus_recorded_at",
  "pg_class public.swarm_sessions.judge_mode",
  "pg_class public.swarm_sessions.judging_deadline_at",
  "pg_class public.swarm_sessions.judging_duration_seconds",
  "pg_class public.swarm_sessions.judging_outcome",
  "pg_class public.swarm_sessions.successor_session_id",
  "pg_class public.swarm_stream_events",
  "pg_class public.swarm_stream_events.seq",
  "pg_class public.swarm_subjects.epoch_anchor",
  "pg_class public.swarm_subjects.epoch_duration_seconds",
  "pg_class public.swarm_subjects.judging_duration_seconds",
  "pg_class public.wallet_aum_snapshot_runs",
  "pg_class public.wallet_aum_snapshot_runs.producer_revision",
  "pg_class public.wallet_balance_sample_evidence",
  "pg_class public.wallet_balance_samples.snapshot_run_id",
  "pg_class public.wallet_balance_samples.strategy_nav_idle_only",
  "pg_class public.wallet_sleeve_sample_evidence",
  "pg_class public.wallet_sleeve_samples.snapshot_run_id",
  "pg_constraint public.swarm_judge_config.swarm_judge_config_mode_requires_model_check",
  "pg_proc public.rm_append_only_guard()",
];

const DATABASE_LOGIN = new URL(config.databaseUrl).username;

const CAUSES: readonly DriftCause[] = [
  {
    id: "B: 0053's rm_app DELETE survives on the ordinary tables that existed at 0053, and the snapshot never grants it",
    fix:
      "backend/migrations/0053_database_role_taxonomy.sql:146 grants rm_app DELETE on all tables; " +
      "backend/schema/grants.sql's ordinary sweep grants SELECT, INSERT, UPDATE and neither grants nor revokes " +
      "DELETE. A migrated database therefore keeps DELETE and a blank one never has it. Decide which is " +
      "intended and make grants.sql assert it both ways.",
    kind: "acl",
    grantee: "rm_app",
    relations: new Map(RM_APP_DELETE_ONLY_IN_MIGRATIONS.map((table) => [table, ["rm_app:DELETE by rm_owner"]])),
  },
  {
    id: "E: default privileges differ between the migrations and grants.sql",
    fix:
      "0016:37-38 set default privileges for the provisioning login (rm_worker DML on its future tables and " +
      "sequences), and neither grants.sql nor snapshot.sql declares any for that login. (rm_owner's own " +
      "defaults now match: snapshot.sql declares the 0053/0062 rm_worker and sequence defaults.)",
    kind: "exact",
    items: [
      {
        key: `default privileges for ${DATABASE_LOGIN} in public on sequences`,
        migrated: `rm_worker:SELECT by ${DATABASE_LOGIN}, rm_worker:USAGE by ${DATABASE_LOGIN}`,
        snapshot: null,
      },
      {
        key: `default privileges for ${DATABASE_LOGIN} in public on tables`,
        migrated: ["DELETE", "INSERT", "SELECT", "UPDATE"].map((p) => `rm_worker:${p} by ${DATABASE_LOGIN}`).join(", "),
        snapshot: null,
      },
    ],
  },
  {
    id: "F: backend/schema/snapshot.sql carries no COMMENT ON",
    fix:
      "backend/schema/snapshot.sql's header says it is a schema-only pg_dump of the migrated database, yet it " +
      "carries no COMMENT ON while the migrations declare these. Re-dump snapshot.sql with comments, or append the " +
      "COMMENT ON statements, then delete each entry the snapshot now carries.",
    kind: "onlyInMigrations",
    keys: COMMENTS_ONLY_IN_MIGRATIONS.map((object) => `comment on ${object}`),
  },
];

/** Every entry a cause records, named — the unit rule 2 is enforced on. */
function entriesOf(cause: DriftCause): string[] {
  switch (cause.kind) {
    case "acl":
      return [...cause.relations.keys()].map((relation) => `acl relation public.${relation}`);
    case "exact":
      return cause.items.map((item) => item.key);
    case "onlyInMigrations":
      return [...cause.keys];
  }
}

const entryId = (cause: DriftCause, entry: string): string => `${cause.id} :: ${entry}`;

/**
 * What the causes leave unexplained, and which recorded ENTRIES explained
 * something (as `entryId`s).
 */
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
        (cause.kind === "exact" &&
          cause.items.some((i) => i.key === item.key && i.migrated === item.migrated && i.snapshot === item.snapshot)) ||
        (cause.kind === "onlyInMigrations" && item.snapshot === null && item.migrated !== null && cause.keys.includes(item.key)),
    );
    if (exact) {
      used.add(entryId(exact, item.key));
      continue;
    }
    const relation = relationOf(item.key);
    if (relation !== null && item.migrated !== null && item.snapshot !== null) {
      let migratedItems = aclItems(item.migrated);
      const snapshotItems = aclItems(item.snapshot);
      const contributing: string[] = [];
      for (const cause of CAUSES) {
        if (cause.kind !== "acl") continue;
        const recorded = cause.relations.get(relation);
        if (recorded === undefined) continue;
        const prefix = `${cause.grantee}:`;
        const held = migratedItems.filter((i) => i.startsWith(prefix));
        const snapshotHeld = snapshotItems.filter((i) => i.startsWith(prefix));
        // The grantee's items on the migrated side are EXACTLY the snapshot
        // side's plus the recorded ones, and the snapshot side has none of the
        // recorded ones — anything else is a different difference.
        if (snapshotHeld.some((i) => recorded.includes(i))) continue;
        if (joinAcl(held) !== joinAcl([...snapshotHeld, ...recorded].sort())) continue;
        migratedItems = migratedItems.filter((i) => !recorded.includes(i));
        contributing.push(entryId(cause, item.key));
      }
      if (joinAcl(migratedItems) === item.snapshot) {
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
    expect(keys.filter((key) => !/^(acl |default privileges |schema public$|comment on )/.test(key))).toEqual([]);
  });

  test("every recorded entry still occurs — a fixed entry is deleted, never left to excuse the next regression", () => {
    const { used } = explain(diffCatalogs(migratedCatalog, snapshotCatalog));
    const stale = CAUSES.flatMap((cause) => entriesOf(cause).map((entry) => entryId(cause, entry))).filter(
      (id) => !used.has(id),
    );
    expect(stale).toEqual([]);
  });

  test("cause B never names a table whose DELETE the migrations revoked on purpose", () => {
    // Append-only tables and immutable ledgers (D53 decision 6): rm_app DELETE
    // on one of them is a finding, never a recorded drift.
    expect(RM_APP_DELETE_ONLY_IN_MIGRATIONS.filter((table) => DELETE_REVOKED.has(table))).toEqual([]);
  });

  test("comments were really read on the migrated side — cause F is not passing on a skipped class", () => {
    expect(migratedCatalog.filter((e) => e.key.startsWith("comment on ")).length).toBeGreaterThan(20);
  });

  test("RED CONTROL: a planted difference fails, and the failure names each planted object", async () => {
    // Planted inside a transaction on the migrated side and rolled back, so the
    // shared comparison above is untouched. One plant per class the causes sit
    // closest to, so a cause that over-explains would be caught here:
    //   * a column default    — a declaration class no cause touches;
    //   * a trigger's firing mode — only tgenabled differs;
    //   * rm_app DELETE on an APPEND-ONLY table — the exact item cause B
    //     records elsewhere, on a table cause B must not reach;
    //   * rm_app DELETE on an ORDINARY table cause B does not record — a
    //     pattern ("any rm_app DELETE outside the append-only set") would
    //     explain it;
    //   * rm_worker UPDATE on swarm_recommendations, where both sides now
    //     hold SELECT only (grants.sql re-asserts rm_worker's grants) — a
    //     pattern ("strip every rm_worker item") would explain it;
    //   * rm_worker ALL on a relation no cause records anything for;
    //   * a comment on an object cause F does not record;
    //   * a new index.
    let planted: DriftItem[] = [];
    await migrated
      .begin(async (tx) => {
        await tx.unsafe("ALTER TABLE jobs ALTER COLUMN priority SET DEFAULT 7");
        await tx.unsafe("ALTER TABLE schema_migrations DISABLE TRIGGER schema_migrations_append_only_row");
        await tx.unsafe("GRANT DELETE ON swarm_members TO rm_app");
        await tx.unsafe("GRANT DELETE ON analytics_read_mode TO rm_app");
        await tx.unsafe("GRANT UPDATE ON swarm_recommendations TO rm_worker");
        await tx.unsafe("GRANT ALL ON deployment_identity TO rm_worker");
        await tx.unsafe("COMMENT ON COLUMN jobs.dedupe_key IS 'planted'");
        await tx.unsafe("CREATE INDEX rm_equiv_planted_idx ON jobs (updated_at)");
        planted = explain(diffCatalogs(await normalizedCatalog(tx), snapshotCatalog)).unexplained;
        throw new RollbackPlant();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RollbackPlant)) throw error;
      });

    const message = describeItems(planted);
    expect(planted.map((item) => item.key).sort()).toEqual([
      "acl relation public.analytics_read_mode",
      "acl relation public.deployment_identity",
      "acl relation public.swarm_members",
      "acl relation public.swarm_recommendations",
      "column public.jobs.priority",
      "comment on pg_class public.jobs.dedupe_key",
      "index public.rm_equiv_planted_idx",
      "trigger public.schema_migrations.schema_migrations_append_only_row",
    ]);
    expect(message).toContain("differs: column public.jobs.priority");
    expect(message).toContain("default 7");
    expect(message).toContain("only in migrations: index public.rm_equiv_planted_idx");
    expect(message).toContain("enabled=D");
    expect(message).toContain("rm_app:DELETE");
    expect(message).toContain("rm_worker:UPDATE by rm_owner");
    expect(message).toContain("only in migrations: comment on pg_class public.jobs.dedupe_key — planted");
  });
});

/** Thrown to roll back the red control's plant; never escapes the test. */
class RollbackPlant extends Error {}
